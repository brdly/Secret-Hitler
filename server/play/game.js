'use strict';

var CommonConsts = require.main.require('./common/constants');
var CommonGame = require.main.require('./common/game');

var SeedRandom = require('seedrandom');

var DB = require.main.require('./server/tools/db');
var Utils = require.main.require('./server/tools/utils');

var Socket = require.main.require('./server/connect/io');

var Player = require.main.require('./server/play/player');

//LOCAL

var MINIMUM_GAME_SIZE = Utils.TESTING ? 3 : 5;

var games = [];

var Game = function(size, privateGame) {
	this.gid = Utils.uid();
	this.maxSize = size;
	this.private = privateGame;

	this.generator = new SeedRandom(this.gid);
	this.players = [];
	this.playersState = {};
	this.history = [];
	this.turn = {};

	this.enactedLiberal = 0;
	this.enactedFascist = 0;
	this.electionTracker = 0;

	this.started = false;
	this.finished = false;

	this.autoTimer = null;
	this.scheduledStart = null;

	this.startIndex = null;
	this.playerCount = null;
	this.currentCount = null;
	this.policyDeck = null;
	this.hitlerUid = null;
	this.power = null;

	this.positionIndex = null;
	this.specialPresident = null;
	this.presidentIndex = null;

	var game = this;
	games.push(this);

	DB.insert('games', {id: this.gid, version: CommonConsts.COMPATIBLE_VERSION});

//PRIVATE

	this.random = function(max) {
		return Utils.rngInt(this.generator, max);
	};

	this.shuffle = function(array) {
		return Utils.randomize(this.generator, array);
	};

	this.shufflePolicyDeck = function() {
		this.policyDeck = [];

		var cardsRemaining = 17 - this.enactedFascist - this.enactedLiberal;
		var liberalsRemaining = 6 - this.enactedLiberal;
		for (var i = 0; i < cardsRemaining; ++i) {
			this.policyDeck[i] = i < liberalsRemaining ? CommonConsts.LIBERAL : CommonConsts.FASCIST;
		}
		this.policyDeck = this.shuffle(this.policyDeck);
	};

//POLICIES

	this.peekPolicies = function() {
		return this.policyDeck.slice(0, 3);
	};

	this.getTopPolicies = function(count) {
		if (!count) {
			count = 3;
		}
		var policies = this.policyDeck.splice(0, count);
		if (this.policyDeck.length < 3) {
			this.shufflePolicyDeck();
		}
		return policies;
	};

	this.getTopPolicy = function() {
		return this.getTopPolicies(1)[0];
	};

//LOBBY

	this.emit = function(name, data) {
		Socket.io().to(this.gid).emit(name, data);
	};

	this.emitExcept = function(exceptUid, name, data) {
		this.players.forEach(function(puid) {
			if (puid != exceptUid) {
				Player.emitTo(puid, name, data);
			}
		});
	};

	this.emitAction = function(name, data, secret) {
		data.action = name;
		if (this.finished) {
			var roles = [];
			this.players.forEach(function(uid, index) {
				roles[index] = game.playerState(uid, 'allegiance');
			});
			data.roles = roles;
		}
		if (secret) {
			var tuid = secret.target;
			this.emitExcept(tuid, 'game action', data);
			data.secret = secret;
			Player.emitTo(tuid, 'game action', data);
		} else {
			this.emit('game action', data);
		}
		return data;
	};

	this.gameData = function(perspectiveUid) {
		var sendHistory = this.history;
		var sendPlayers = [];
		var showFascists;
		if (perspectiveUid) {
			var perspectiveAllegiance = this.playerState(perspectiveUid, 'allegiance');
			showFascists = perspectiveAllegiance == 1 || (perspectiveAllegiance == 2 && this.playerCount <= 6);
		}
		this.players.forEach(function(uid, index) {
			var player = Player.get(uid);
			var playerData = {
				uid: uid,
				name: player.name,
				index: index,
			};
			if (perspectiveUid) {
				var playerAllegiance = game.playerState(uid, 'allegiance');
				if (perspectiveUid == uid || (showFascists && playerAllegiance > 0)) {
					playerData.allegiance = playerAllegiance;
				}
			}
			sendPlayers[index] = playerData;
		});
		return {
			gid: this.gid,
			started: this.started,
			maxSize: this.maxSize,
			startIndex: this.startIndex,
			startTime: this.scheduledStart,

			players: sendPlayers,
			history: sendHistory,
			private: this.private,
		};
	};

	this.resetAutostart = function() {
		this.cancelAutostart();

		if (this.enoughToStart()) {
			var startDelay = Utils.TESTING ? 3 : 30;
			this.scheduledStart = Utils.now() + startDelay;

			this.autoTimer = setTimeout(function() {
				game.start();
			}, startDelay * 1000);
		}

		this.emit('lobby game data', this.gameData());
	};

	this.cancelAutostart = function() {
		if (this.autoTimer) {
			clearTimeout(this.autoTimer);
			this.autoTimer = null;
			this.scheduledStart = null;
		}
	};

	this.emitStartPerspective = function(uid) {
 		Player.emitTo(uid, 'lobby game data', this.gameData(uid));
	};

	this.start = function() {
		if (this.started) {
			return;
		}

		var startingPlayerIds = this.players.slice();
		var removed;
		startingPlayerIds.forEach(function(puid) {
			var player = Player.get(puid);
			var playerGame = player.game;
			if (!playerGame || playerGame.gid != game.gid) {
				removed = puid;
				game.remove(player);
			}
		});
		if (!this.enoughToStart()) {
			console.error(game.gid, 'Start sequence interrupted', startingPlayerIds, removed);
			this.resetAutostart();
			return;
		}

		this.cancelAutostart();

		this.started = true;
		this.playerCount = this.players.length;
		this.currentCount = this.playerCount;
		this.startIndex = this.random(this.playerCount);
		this.positionIndex = this.startIndex;
		this.presidentIndex = this.positionIndex;
		this.shufflePolicyDeck();

		var playerIdData = this.players.join(',');
		DB.update('games', "id = '"+this.gid+"'", {state: 1, started_at: Utils.now(), start_index: this.startIndex, player_count: this.playerCount, player_ids: playerIdData});
		DB.updatePlayers(this.players, 'started', this.gid, true);

		// Assign Fascists
		var facistsCount = Math.ceil(this.playerCount / 2) - 1;
		var fascistIndicies = [2];
		for (var i = 1; i < this.playerCount; ++i) {
			fascistIndicies[i] = i < facistsCount ? 1 : 0;
		}
		fascistIndicies = this.shuffle(fascistIndicies);
		this.players.forEach(function(puid, pidx) {
			var allegiance = fascistIndicies[pidx];
			game.playerState(puid, 'allegiance', allegiance);
			if (allegiance == 2) {
				game.hitlerUid = puid;
			}
		});

		// Emit
		this.players.forEach(function(puid) {
			game.emitStartPerspective(puid);
		});
	};

	this.getFascistPower = function() {
		return CommonGame.getFascistPower(this.enactedFascist, this.playerCount);
	};

//STATE

	this.advanceTurn = function() {
		if (this.finished) {
			return;
		}
		this.turn = {};
		if (this.specialPresident != null) {
			this.presidentIndex = this.specialPresident;
			this.specialPresident = null;
		} else {
			this.positionIndex = CommonGame.getNextPresident(this.playerCount, this.players, this.positionIndex, this.playersState);
			this.presidentIndex = this.positionIndex;
		}
		this.power = null;
	};

	this.failedElection = function() {
		++this.electionTracker;
		var forcedPolicy;
		if (this.electionTracker >= 3) {
			this.electionTracker = 0;
			this.presidentElect = null;
			this.chancellorElect = null;
			forcedPolicy = this.getTopPolicy();
			this.enactPolicy(forcedPolicy, false);
		}
		this.advanceTurn();
		return forcedPolicy;
	};

	this.finish = function(liberals, method) {
		if (!this.finished) {
			console.log(game.gid, 'FIN', liberals, method);

			var activePlayers = [];
			this.players.forEach(function(puid) {
				if (!game.playerState(puid, 'quit')) {
					activePlayers.push(puid);
				}
			});
			DB.updatePlayers(activePlayers, 'finished', null, true);

			this.finished = true;
			DB.update('games', "id = '"+this.gid+"'", {state: 2, finished_at: Utils.now(), history: JSON.stringify(this.history), enacted_liberal: this.enactedLiberal, enacted_fascist: this.enactedFascist, liberal_victory: liberals, win_method: method});
			this.removeSelf();
		}
	};

	this.enactPolicy = function(policy, byVote) {
		var fascistPower;
		this.electionTracker = 0;
		if (policy == CommonConsts.LIBERAL) {
			++this.enactedLiberal;
			if (this.enactedLiberal >= CommonConsts.LIBERAL_POLICIES_REQUIRED) {
				this.finish(true, 'policy');
				return;
			}
		} else {
			++this.enactedFascist;
			if (this.enactedFascist >= CommonConsts.FASCIST_POLICIES_REQUIRED) {
				this.finish(false, 'policy');
				return;
			}
			fascistPower = this.getFascistPower();
		}
		if (byVote) {
			if (fascistPower) {
				this.power = fascistPower;
			} else {
				this.advanceTurn();
			}
		}
		return fascistPower;
	};

//PLAYERS

	this.playerState = function(puid, key, value) {
		var state = this.playersState[puid];
		if (state && key) {
			if (value == undefined) {
				return state[key];
			}
			state[key] = value;
		}
		return state;
	};

	this.addPlayer = function(socket) {
		var uid = socket.uid;
		socket.leave('lobby');
		socket.join(this.gid);
		socket.game = this;

		var playerState = this.playerState(uid);
		if (!playerState) {
			var index = this.players.length;
			this.players[index] = uid;
			this.playersState[uid] = {index: index};
		} else {
			playerState.quit = false;
		}

		if (this.started) {
			this.emitStartPerspective(uid);
		} else if (this.isFull()) {
			this.start();
		} else {
			this.resetAutostart();
		}
	};

	this.kill = function(uid, quitting) {
		var playerState = this.playerState(uid);
		if (playerState && !playerState.killed) {
			if (quitting) {
				playerState.quit = true;
				DB.updatePlayers([uid], 'quit', null, !this.finished);
			}
			playerState.killed = true;
			this.currentCount -= 1;

			if (this.isHitler(uid)) {
				this.finish(true, quitting ? 'hitler quit' : 'hitler');
			} else if (this.currentCount <= 2) {
				this.removeSelf();
			}
			return true;
		}
	};

	this.removeSelf = function() {
		this.cancelAutostart();

		var gid = this.gid;
		games = games.filter(function(g) {
			return g.gid != gid;
		});
		if (!this.finished) {
			DB.query("DELETE FROM games WHERE id = '"+gid+"'");
		}
	};

	this.disconnect = function(socket) {
		if (!this.started || this.finished) {
			this.remove(socket);
		} else {
			this.playerState(socket.uid, 'disconnected', true);
		}
	};

	this.remove = function(socket) {
		socket.leave(this.gid);

		var uid = socket.uid;
		var playerState = this.playerState(uid);
		if (!playerState || playerState.quit) {
			return false;
		}
		if (this.started) {
			playerState.quit = true;
			this.kill(uid, true);
		} else {
			this.players = this.players.filter(function(puid) {
				return puid != uid;
			});
			delete this.playersState[uid];
			if (this.players.length == 0) {
				this.removeSelf();
			} else {
				this.players.forEach(function(puid, pidx) {
					game.playerState(puid, 'index', pidx);
				});
			}
		}
		socket.game = null;

		if (!this.started) {
			this.resetAutostart();
		}
		return true;
	};

//HELPERS

	this.isChancellor = function(uid) {
		return uid == this.turn.chancellor;
	};

	this.isPresident = function(uid) {
		return this.playerState(uid, 'index') == this.presidentIndex;
	};

	this.isHitler = function(uid) {
		return uid == this.hitlerUid;
	};

	this.enoughToStart = function() {
		return this.players.length >= MINIMUM_GAME_SIZE;
	};

	this.isFull = function() {
		return this.players.length >= this.maxSize;
	};

	this.isOpen = function() {
		return !this.started && !this.isFull();
	};

	return this;
};

Game.games = function() {
	return games;
};

Game.get = function(gid) {
	for (var gidx in games) {
		var game = games[gidx];
		if (game.gid == gid) {
			return game;
		}
	}
};

module.exports = Game;
