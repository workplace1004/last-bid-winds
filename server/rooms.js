// Rooms, seats and the auction clock. Knows nothing about sockets: a connection is any
// object with send(message) and an optional close().
import { randomBytes, randomInt } from 'node:crypto';
import {
  LOTS_BY_PLAYERS,
  canAnyoneBid,
  closeLot,
  createGame,
  currentLot,
  drawLots,
  finishGame,
  minBid,
  nextLot,
  placeBid,
  scoreGame,
} from './game.js';

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
const MAX_NAME_LENGTH = 16;
const BIDS_SHOWN = 5;

const DEFAULTS = {
  openMs: 15_000,
  bidMs: 6_000,
  soldMs: 4_000,
  graceMs: 30_000,
  idleMs: 60 * 60 * 1000,
  maxRooms: 1000,
};

const MESSAGES = {
  already_in_room: 'You are already in a room.',
  already_leading: 'You already have the top bid.',
  bad_message: 'That request was not understood.',
  bid_too_low: 'Someone bid first. Check the new price.',
  game_not_running: 'The game is not running.',
  game_over: 'The game is over.',
  game_started: 'That game has already started.',
  invalid_bid: 'That bid is not valid.',
  invalid_name: `Enter a name of 1 to ${MAX_NAME_LENGTH} characters.`,
  lot_closed: 'Too late. The hammer has fallen.',
  name_taken: 'Someone in this room already has that name.',
  need_players: `You need at least ${MIN_PLAYERS} players to start.`,
  not_enough_cash: 'You do not have enough cash for that bid.',
  not_host: 'Only the host can do that.',
  not_in_room: 'You are not in a room.',
  room_full: `That room is full (${MAX_PLAYERS} players).`,
  room_not_found: 'No room has that code. Check it and try again.',
  server_full: 'The server is full. Please try again soon.',
  session_expired: 'Your seat has ended.',
};

export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (name.length === 0 || [...name].length > MAX_NAME_LENGTH) return null;
  return name;
}

export class RoomManager {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.rooms = new Map();
    this.seats = new Map(); // connection -> { room, player }
  }

  // Entry point for every client message.
  handle(conn, message) {
    const type = message?.type;
    switch (type) {
      case 'create':
        return this.#create(conn, message);
      case 'join':
        return this.#join(conn, message);
      case 'resume':
        return this.#resume(conn, message);
      case 'start':
      case 'bid':
      case 'playAgain':
      case 'leave': {
        const seat = this.seats.get(conn);
        if (!seat) return this.#fail(conn, 'not_in_room');
        seat.room.lastActivity = Date.now();
        if (type === 'start') return this.#start(conn, seat);
        if (type === 'bid') return this.#bid(conn, seat, message.amount);
        if (type === 'playAgain') return this.#playAgain(conn, seat);
        return this.#leave(conn, seat);
      }
      default:
        return this.#fail(conn, 'bad_message');
    }
  }

  disconnect(conn) {
    const seat = this.seats.get(conn);
    if (!seat) return;
    this.seats.delete(conn);
    const { room, player } = seat;
    if (player.conn !== conn) return;

    player.conn = null;
    player.graceTimer = setTimeout(() => this.#expire(room, player), this.options.graceMs);
    this.#ensureHost(room);
    this.#broadcast(room);
  }

  // Removes rooms nobody has acted in for a long time.
  sweep() {
    const cutoff = Date.now() - this.options.idleMs;
    for (const room of this.rooms.values()) {
      if (room.lastActivity <= cutoff) this.#destroy(room, true);
    }
  }

  shutdown() {
    for (const room of this.rooms.values()) this.#destroy(room, true);
  }

  #create(conn, { name: rawName }) {
    if (this.seats.has(conn)) return this.#fail(conn, 'already_in_room');
    const name = cleanName(rawName);
    if (!name) return this.#fail(conn, 'invalid_name');
    if (this.rooms.size >= this.options.maxRooms) return this.#fail(conn, 'server_full');

    const room = {
      code: this.#newCode(),
      phase: 'lobby',
      players: [],
      hostId: null,
      nextPlayerId: 1,
      game: null,
      clockTimer: null,
      clockDeadline: 0,
      clockTotal: 0,
      lastActivity: Date.now(),
    };
    this.rooms.set(room.code, room);
    this.#seat(conn, room, name);
  }

  #join(conn, { code: rawCode, name: rawName }) {
    if (this.seats.has(conn)) return this.#fail(conn, 'already_in_room');
    const name = cleanName(rawName);
    if (!name) return this.#fail(conn, 'invalid_name');
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return this.#fail(conn, 'room_not_found');
    if (room.phase !== 'lobby') return this.#fail(conn, 'game_started');
    if (room.players.length >= MAX_PLAYERS) return this.#fail(conn, 'room_full');

    const lowered = name.toLowerCase();
    if (room.players.some((player) => player.name.toLowerCase() === lowered)) {
      return this.#fail(conn, 'name_taken');
    }
    room.lastActivity = Date.now();
    this.#seat(conn, room, name);
  }

  #resume(conn, { code, token }) {
    if (this.seats.has(conn)) return this.#fail(conn, 'already_in_room');
    const room = typeof code === 'string' ? this.rooms.get(code) : null;
    const player =
      room && typeof token === 'string'
        ? room.players.find((candidate) => candidate.token === token)
        : null;
    if (!player) return this.#fail(conn, 'session_expired');

    if (player.conn) {
      const old = player.conn;
      this.seats.delete(old);
      old.send({ type: 'replaced' });
      old.close?.();
    }
    clearTimeout(player.graceTimer);
    player.conn = conn;
    player.gone = false;
    this.seats.set(conn, { room, player });
    room.lastActivity = Date.now();
    this.#ensureHost(room);
    conn.send({ type: 'joined', code: room.code, token: player.token, playerId: player.id });
    this.#broadcast(room);
  }

  #start(conn, { room, player }) {
    if (room.hostId !== player.id) return this.#fail(conn, 'not_host');
    if (room.phase !== 'lobby') return this.#fail(conn, 'game_started');
    if (room.players.length < MIN_PLAYERS) return this.#fail(conn, 'need_players');

    const lots = drawLots(LOTS_BY_PLAYERS[room.players.length], randomInt);
    room.game = createGame(
      room.players.map((candidate) => candidate.id),
      lots,
    );
    room.phase = 'playing';
    this.#runClock(room, this.options.openMs);
    this.#broadcast(room);
  }

  #bid(conn, { room, player }, amount) {
    if (room.phase !== 'playing') return this.#fail(conn, 'game_not_running');
    const error = placeBid(room.game, player.id, amount);
    if (error) return this.#fail(conn, error);

    if (canAnyoneBid(room.game, this.#activeIds(room))) {
      this.#runClock(room, this.options.bidMs);
    } else {
      this.#hammer(room);
      return;
    }
    this.#broadcast(room);
  }

  #playAgain(conn, { room, player }) {
    if (room.hostId !== player.id) return this.#fail(conn, 'not_host');
    if (room.phase !== 'finished') return this.#fail(conn, 'game_not_running');
    room.players = room.players.filter((candidate) => !candidate.gone);
    room.game = null;
    room.phase = 'lobby';
    this.#broadcast(room);
  }

  #leave(conn, { room, player }) {
    this.seats.delete(conn);
    clearTimeout(player.graceTimer);
    player.conn = null;
    player.token = null; // The seat cannot be resumed after leaving on purpose.
    conn.send({ type: 'left' });
    this.#markGone(room, player);
  }

  #expire(room, player) {
    if (player.conn || !this.rooms.has(room.code)) return;
    this.#markGone(room, player);
  }

  #markGone(room, player) {
    if (room.phase === 'lobby') {
      room.players = room.players.filter((candidate) => candidate !== player);
    } else {
      player.gone = true;
    }
    if (room.players.every((candidate) => candidate.gone)) {
      this.#destroy(room, false);
      return;
    }
    this.#ensureHost(room);
    if (room.phase === 'playing') {
      const active = this.#activeIds(room);
      if (active.length < MIN_PLAYERS) {
        clearTimeout(room.clockTimer);
        finishGame(room.game, active, true);
        room.phase = 'finished';
      } else if (room.game.stage === 'bidding' && !canAnyoneBid(room.game, active)) {
        this.#hammer(room);
        return;
      }
    }
    this.#broadcast(room);
  }

  #seat(conn, room, name) {
    const used = new Set(room.players.map((player) => player.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    const player = {
      id: room.nextPlayerId,
      name,
      slot,
      token: randomBytes(16).toString('hex'),
      conn,
      gone: false,
      graceTimer: null,
    };
    room.nextPlayerId += 1;
    room.players.push(player);
    this.seats.set(conn, { room, player });
    this.#ensureHost(room);
    conn.send({ type: 'joined', code: room.code, token: player.token, playerId: player.id });
    this.#broadcast(room);
  }

  #ensureHost(room) {
    const host = room.players.find((player) => player.id === room.hostId);
    if (host?.conn) return;
    const next = room.players.find((player) => player.conn);
    if (next) room.hostId = next.id;
  }

  #activeIds(room) {
    return room.players.filter((player) => !player.gone).map((player) => player.id);
  }

  // One timer drives the auction. What it does next depends on the stage when it fires.
  #runClock(room, ms) {
    clearTimeout(room.clockTimer);
    room.clockDeadline = Date.now() + ms;
    room.clockTotal = ms;
    room.clockTimer = setTimeout(() => this.#clockExpired(room), ms);
  }

  #clockExpired(room) {
    if (room.phase !== 'playing') return;
    if (room.game.stage === 'bidding') this.#hammer(room);
    else this.#advance(room);
  }

  #hammer(room) {
    closeLot(room.game);
    this.#runClock(room, this.options.soldMs);
    this.#broadcast(room);
  }

  #advance(room) {
    const active = this.#activeIds(room);
    nextLot(room.game, active);
    if (room.game.result) {
      room.phase = 'finished';
      clearTimeout(room.clockTimer);
    } else if (canAnyoneBid(room.game, active)) {
      this.#runClock(room, this.options.openMs);
    } else {
      // Everybody is out of cash, so this lot can only pass. Show it, then move on.
      closeLot(room.game);
      this.#runClock(room, this.options.soldMs);
    }
    this.#broadcast(room);
  }

  #broadcast(room) {
    const base = this.#snapshot(room);
    for (const player of room.players) {
      player.conn?.send({ ...base, you: player.id });
    }
  }

  #snapshot(room) {
    let game = null;
    if (room.game) {
      const { lots, lotIndex, stage, bid, leaderId, bids, sales, result } = room.game;
      const playing = room.phase === 'playing';
      const { name, icon, low, high, value } = currentLot(room.game);
      game = {
        lotNumber: lotIndex + 1,
        lotCount: lots.length,
        stage,
        // A lot's true value must stay on the server until the hammer falls.
        lot: { name, icon, low, high, value: stage === 'bidding' ? null : value },
        bid,
        leaderId,
        minBid: minBid(room.game),
        bids: bids.slice(-BIDS_SHOWN).reverse(),
        msLeft: playing ? Math.max(0, room.clockDeadline - Date.now()) : 0,
        msTotal: playing ? room.clockTotal : 0,
        scores: scoreGame(room.game),
        sales,
        result,
      };
    }
    return {
      type: 'state',
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map(({ id, name, slot, conn, gone }) => ({
        id,
        name,
        slot,
        connected: Boolean(conn),
        gone,
      })),
      game,
    };
  }

  #destroy(room, notify) {
    clearTimeout(room.clockTimer);
    for (const player of room.players) {
      clearTimeout(player.graceTimer);
      if (player.conn) {
        this.seats.delete(player.conn);
        if (notify) player.conn.send({ type: 'room_closed' });
      }
    }
    this.rooms.delete(room.code);
  }

  #newCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  #fail(conn, code) {
    conn.send({ type: 'error', code, message: MESSAGES[code] });
  }
}
