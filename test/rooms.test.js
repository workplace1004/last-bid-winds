import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { RoomManager, cleanName } from '../server/rooms.js';

const OPEN = 15_000;
const BID = 6_000;
const SOLD = 4_000;
const GRACE = 30_000;

function client() {
  const inbox = [];
  return {
    inbox,
    closed: false,
    send(message) {
      // A real socket serializes at once, so copy to catch later changes to shared state.
      inbox.push(JSON.parse(JSON.stringify(message)));
    },
    close() {
      this.closed = true;
    },
    last(type = 'state') {
      return inbox.findLast((message) => message.type === type);
    },
  };
}

let manager;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  manager = new RoomManager();
});

afterEach(() => {
  manager.shutdown();
  mock.timers.reset();
});

function makeRoom(count = 2) {
  const clients = [];
  const host = client();
  manager.handle(host, { type: 'create', name: 'P1' });
  clients.push(host);
  const { code } = host.last('joined');
  for (let i = 2; i <= count; i += 1) {
    const other = client();
    manager.handle(other, { type: 'join', code, name: `P${i}` });
    clients.push(other);
  }
  return { code, clients, room: manager.rooms.get(code) };
}

function startGame(count = 2) {
  const made = makeRoom(count);
  manager.handle(made.clients[0], { type: 'start' });
  return made;
}

test('names are cleaned and limited', () => {
  assert.equal(cleanName('  Ann   B  '), 'Ann B');
  assert.equal(cleanName('A\u0000n​n'), 'Ann');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName('x'.repeat(17)), null);
  assert.equal(cleanName(42), null);
});

test('create and join give each player a seat, and tokens stay private', () => {
  const { clients, code } = makeRoom(2);
  assert.match(code, /^[A-Z]{4}$/);
  const [a, b] = clients;
  assert.notEqual(a.last('joined').token, b.last('joined').token);
  assert.equal(b.last().players.length, 2);
  assert.equal(b.last().you, 2);
  assert.ok(!JSON.stringify(b.last()).includes(a.last('joined').token));
});

test('joining fails with a clear code for each problem', () => {
  const { code, clients } = makeRoom(2);
  const other = client();
  manager.handle(other, { type: 'join', code: 'ZZZZ', name: 'X' });
  assert.equal(other.last('error').code, 'room_not_found');
  manager.handle(other, { type: 'join', code, name: 'p1' });
  assert.equal(other.last('error').code, 'name_taken');
  manager.handle(other, { type: 'join', code, name: '' });
  assert.equal(other.last('error').code, 'invalid_name');
  manager.handle(clients[0], { type: 'create', name: 'Again' });
  assert.equal(clients[0].last('error').code, 'already_in_room');
});

test('a room is full at 6 and closed once started', () => {
  const { code, clients } = makeRoom(6);
  const late = client();
  manager.handle(late, { type: 'join', code, name: 'Late' });
  assert.equal(late.last('error').code, 'room_full');

  manager.handle(clients[0], { type: 'start' });
  manager.handle(late, { type: 'join', code, name: 'Late' });
  assert.equal(late.last('error').code, 'game_started');
});

test('only the host can start, and only with 2 players', () => {
  const solo = makeRoom(1);
  manager.handle(solo.clients[0], { type: 'start' });
  assert.equal(solo.clients[0].last('error').code, 'need_players');

  const { clients } = makeRoom(2);
  manager.handle(clients[1], { type: 'start' });
  assert.equal(clients[1].last('error').code, 'not_host');
});

test('the number of lots follows the number of players', () => {
  for (const [players, lots] of [[2, 6], [3, 7], [4, 8], [5, 9], [6, 10]]) {
    const { clients } = startGame(players);
    assert.equal(clients[0].last().game.lotCount, lots);
  }
});

test('true values stay hidden until the hammer, and future lots are never sent', () => {
  const { clients, room } = startGame(2);
  const [a, b] = clients;
  manager.handle(a, { type: 'bid', amount: 10 });

  for (const message of [...a.inbox, ...b.inbox]) {
    if (message.type !== 'state' || !message.game) continue;
    assert.equal(message.game.lot.value, null);
    assert.equal(message.game.lots, undefined);
    assert.deepEqual(Object.keys(message.game.lot).sort(), ['high', 'icon', 'low', 'name', 'value']);
    for (const future of room.game.lots.slice(1)) {
      assert.ok(!JSON.stringify(message).includes(future.name));
    }
  }

  mock.timers.tick(BID);
  assert.equal(a.last().game.stage, 'sold');
  assert.equal(a.last().game.lot.value, room.game.lots[0].value);
});

test('each bid resets the clock, so a late bid steals the lot', () => {
  const { clients } = startGame(2);
  const [a, b] = clients;
  assert.equal(a.last().game.msLeft, OPEN);

  manager.handle(a, { type: 'bid', amount: 10 });
  assert.equal(a.last().game.msLeft, BID);
  mock.timers.tick(BID - 1);
  assert.equal(a.last().game.stage, 'bidding');

  manager.handle(b, { type: 'bid', amount: 20 });
  assert.equal(b.last().game.msLeft, BID);
  mock.timers.tick(BID - 1);
  assert.equal(a.last().game.stage, 'bidding', 'the old hammer timer must be gone');

  mock.timers.tick(1);
  assert.equal(a.last().game.stage, 'sold');
  assert.equal(a.last().game.sales[0].buyerId, 2);
  assert.equal(a.last().game.scores[2].cash, 980);
  assert.equal(a.last().game.scores[1].cash, 1000);
});

test('a lot with no bids passes when the opening clock ends, then the next opens', () => {
  const { clients } = startGame(2);
  const [a] = clients;
  mock.timers.tick(OPEN);
  assert.equal(a.last().game.stage, 'sold');
  assert.equal(a.last().game.sales[0].buyerId, null);
  mock.timers.tick(SOLD);
  assert.equal(a.last().game.stage, 'bidding');
  assert.equal(a.last().game.lotNumber, 2);
  assert.equal(a.last().game.msLeft, OPEN);
});

test('a bad bid only reaches the bidder and does not touch the clock', () => {
  const { clients } = startGame(2);
  const [a, b] = clients;
  manager.handle(a, { type: 'bid', amount: 100 });
  mock.timers.tick(1000);
  const before = b.inbox.length;
  manager.handle(b, { type: 'bid', amount: 100 });
  assert.equal(b.last('error').code, 'bid_too_low');
  assert.equal(b.inbox.length, before + 1);
  assert.equal(a.last().game.bids.length, 1);
  mock.timers.tick(BID - 1000);
  assert.equal(a.last().game.stage, 'sold', 'the rejected bid did not reset the clock');
});

test('bids during the reveal or outside a game are refused', () => {
  const { clients } = startGame(2);
  const [a] = clients;
  mock.timers.tick(OPEN);
  manager.handle(a, { type: 'bid', amount: 10 });
  assert.equal(a.last('error').code, 'lot_closed');

  const lobby = makeRoom(2);
  manager.handle(lobby.clients[0], { type: 'bid', amount: 10 });
  assert.equal(lobby.clients[0].last('error').code, 'game_not_running');

  const stranger = client();
  manager.handle(stranger, { type: 'bid', amount: 10 });
  assert.equal(stranger.last('error').code, 'not_in_room');
});

test('an all-in nobody can top ends the lot at once', () => {
  const { clients } = startGame(2);
  const [a] = clients;
  manager.handle(a, { type: 'bid', amount: 1000 });
  assert.equal(a.last().game.stage, 'sold');
  assert.equal(a.last().game.scores[1].cash, 0);
});

test('when nobody has cash, the remaining lots pass and the game still ends', () => {
  const { clients, room } = startGame(2);
  const [a] = clients;
  room.game.cash[1] = 0;
  room.game.cash[2] = 0;
  mock.timers.tick(OPEN); // Lot 1 passes on the clock.
  for (let lot = 2; lot <= 6; lot += 1) {
    mock.timers.tick(SOLD);
    assert.equal(a.last().game.lotNumber, lot);
    assert.equal(a.last().game.stage, 'sold');
    assert.equal(a.last().game.lot.value, room.game.lots[lot - 1].value);
  }
  mock.timers.tick(SOLD);
  assert.equal(a.last().phase, 'finished');
  assert.deepEqual(a.last().game.result, { winnerIds: [1, 2], reason: 'draw' });
});

test('a full game reaches a result, and play again returns to the lobby', () => {
  const { clients } = startGame(2);
  const [a, b] = clients;
  for (let lot = 1; lot <= 6; lot += 1) {
    manager.handle(lot % 2 ? a : b, { type: 'bid', amount: 10 });
    mock.timers.tick(BID);
    mock.timers.tick(SOLD);
  }
  assert.equal(a.last().phase, 'finished');
  assert.equal(a.last().game.sales.length, 6);
  assert.equal(a.last().game.msLeft, 0);

  manager.handle(b, { type: 'playAgain' });
  assert.equal(b.last('error').code, 'not_host');
  manager.handle(a, { type: 'playAgain' });
  assert.equal(a.last().phase, 'lobby');
  assert.equal(a.last().game, null);

  manager.handle(a, { type: 'start' });
  assert.equal(a.last().phase, 'playing');
  assert.equal(a.last().game.scores[1].cash, 1000, 'cash resets for the new game');
});

test('a dropped player resumes with their token and keeps their top bid', () => {
  const { clients, code } = startGame(2);
  const [a, b] = clients;
  const { token } = a.last('joined');
  manager.handle(a, { type: 'bid', amount: 40 });
  manager.disconnect(a);
  assert.equal(b.last().players[0].connected, false);
  assert.equal(b.last().game.leaderId, 1);

  const back = client();
  manager.handle(back, { type: 'resume', code, token });
  assert.equal(back.last('joined').playerId, 1);
  assert.equal(back.last().you, 1);
  assert.equal(b.last().players[0].connected, true);
  assert.equal(back.last().game.leaderId, 1);
});

test('the clock does not wait for a disconnected leader, who still pays', () => {
  const { clients } = startGame(2);
  const [a, b] = clients;
  manager.handle(a, { type: 'bid', amount: 40 });
  manager.disconnect(a);
  mock.timers.tick(BID);
  assert.equal(b.last().game.sales[0].buyerId, 1);
  assert.equal(b.last().game.scores[1].cash, 960);
});

test('a bad resume token is refused', () => {
  const { code } = makeRoom(2);
  const other = client();
  manager.handle(other, { type: 'resume', code, token: 'nope' });
  assert.equal(other.last('error').code, 'session_expired');
  manager.handle(other, { type: 'resume', code, token: null });
  assert.equal(other.last('error').code, 'session_expired');
});

test('resuming in a second tab replaces the first', () => {
  const { clients, code } = makeRoom(2);
  const [a] = clients;
  const second = client();
  manager.handle(second, { type: 'resume', code, token: a.last('joined').token });
  assert.ok(a.last('replaced'));
  assert.equal(a.closed, true);
  manager.disconnect(a);
  assert.equal(second.last().players[0].connected, true, 'the old socket closing changes nothing');
});

test('host passes on when the host drops, and comes back as a player', () => {
  const { clients, code } = makeRoom(3);
  const [a, b] = clients;
  const { token } = a.last('joined');
  manager.disconnect(a);
  assert.equal(b.last().hostId, 2);
  const back = client();
  manager.handle(back, { type: 'resume', code, token });
  assert.equal(back.last().hostId, 2);
});

test('offline players leave the lobby after the grace period', () => {
  const { clients } = makeRoom(2);
  const [a, b] = clients;
  manager.disconnect(b);
  assert.equal(a.last().players.length, 2);
  mock.timers.tick(GRACE);
  assert.equal(a.last().players.length, 1);
});

test('leaving in a game keeps the bid standing, and the leaver cannot win or return', () => {
  const { clients, code } = startGame(3);
  const [a, b, c] = clients;
  const token = c.last('joined').token;
  manager.handle(c, { type: 'bid', amount: 40 });
  manager.handle(c, { type: 'leave' });
  assert.ok(c.last('left'));
  assert.equal(a.last().phase, 'playing');
  assert.equal(a.last().game.leaderId, 3);

  const back = client();
  manager.handle(back, { type: 'resume', code, token });
  assert.equal(back.last('error').code, 'session_expired');

  mock.timers.tick(BID);
  assert.equal(a.last().game.scores[3].cash, 960);
  for (let lot = 2; lot <= 7; lot += 1) {
    mock.timers.tick(SOLD);
    mock.timers.tick(OPEN);
  }
  mock.timers.tick(SOLD);
  assert.equal(a.last().phase, 'finished');
  assert.ok(!a.last().game.result.winnerIds.includes(3));
  assert.ok(b.last().game.result.winnerIds.length >= 1);
});

test('a departure ends the lot if the remaining players cannot raise', () => {
  const { clients, room } = startGame(3);
  const [a, b, c] = clients;
  room.game.cash[2] = 0;
  manager.handle(a, { type: 'bid', amount: 40 });
  assert.equal(a.last().game.stage, 'bidding');
  manager.handle(c, { type: 'leave' });
  assert.equal(b.last().game.stage, 'sold');
  assert.equal(b.last().game.sales[0].buyerId, 1);
});

test('the last active player wins by walkover and the open lot is cancelled', () => {
  const { clients } = startGame(2);
  const [a, b] = clients;
  manager.handle(b, { type: 'bid', amount: 40 });
  manager.handle(b, { type: 'leave' });
  assert.equal(a.last().phase, 'finished');
  assert.deepEqual(a.last().game.result, { winnerIds: [1], reason: 'walkover' });
  assert.equal(a.last().game.sales.length, 0);

  mock.timers.tick(OPEN + SOLD);
  assert.equal(a.last().phase, 'finished', 'no timer may fire after the walkover');
});

test('an offline player becomes gone after the grace period, then can return', () => {
  const { clients, code } = startGame(3);
  const [a, , c] = clients;
  const { token } = c.last('joined');
  manager.disconnect(c);
  mock.timers.tick(GRACE);
  assert.equal(a.last().players[2].gone, true);

  const back = client();
  manager.handle(back, { type: 'resume', code, token });
  assert.equal(a.last().players[2].gone, false);
  assert.equal(back.last().you, 3);
});

test('the room is deleted once everybody has gone, and timers stop', () => {
  const { clients, code } = startGame(2);
  const [a, b] = clients;
  manager.handle(a, { type: 'leave' });
  manager.handle(b, { type: 'leave' });
  assert.equal(manager.rooms.has(code), false);
  mock.timers.tick(OPEN + SOLD + GRACE);

  const other = startGame(2);
  manager.disconnect(other.clients[0]);
  manager.disconnect(other.clients[1]);
  mock.timers.tick(GRACE);
  assert.equal(manager.rooms.has(other.code), false);
});

test('idle rooms are swept, and players are told', () => {
  const { clients, code } = makeRoom(2);
  mock.timers.tick(60 * 60 * 1000);
  manager.sweep();
  assert.equal(manager.rooms.has(code), false);
  assert.ok(clients[0].last('room_closed'));
});

test('the room cap is enforced', () => {
  const small = new RoomManager({ maxRooms: 1 });
  small.handle(client(), { type: 'create', name: 'A' });
  const late = client();
  small.handle(late, { type: 'create', name: 'B' });
  assert.equal(late.last('error').code, 'server_full');
  small.shutdown();
});

test('every error code has a readable message', () => {
  const { clients } = startGame(2);
  const [a] = clients;
  manager.handle(a, { type: 'bid', amount: 2000 });
  manager.handle(a, { type: 'bid', amount: 15 });
  manager.handle(a, { type: 'nope' });
  for (const message of a.inbox.filter((item) => item.type === 'error')) {
    assert.equal(typeof message.message, 'string', message.code);
  }
});
