import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATALOG,
  LOTS_BY_PLAYERS,
  START_CASH,
  canAnyoneBid,
  closeLot,
  createGame,
  drawLots,
  finishGame,
  minBid,
  nextLot,
  placeBid,
  scoreGame,
} from '../server/game.js';

const lot = (value, name = 'Lot') => ({ name, icon: 'x', low: 0, high: 1000, value });

function sellLot(game, playerId, amount, activeIds = game.playerIds) {
  if (playerId !== null) assert.equal(placeBid(game, playerId, amount), null);
  closeLot(game);
  nextLot(game, activeIds);
}

test('every catalog estimate is valid and there are enough lots for any game', () => {
  assert.ok(CATALOG.length >= Math.max(...Object.values(LOTS_BY_PLAYERS)));
  for (const item of CATALOG) {
    assert.ok(item.low < item.high, item.name);
    assert.equal((item.high - item.low) % 10, 0, item.name);
  }
});

test('drawn lots are unique and their values stay inside the estimate', () => {
  for (let run = 0; run < 200; run += 1) {
    const lots = drawLots(10, (n) => Math.floor(Math.random() * n));
    assert.equal(new Set(lots.map((item) => item.name)).size, 10);
    for (const item of lots) {
      assert.ok(item.value >= item.low && item.value <= item.high, item.name);
      assert.equal(item.value % 10, 0, item.name);
    }
  }
});

test('drawing reaches both ends of an estimate', () => {
  const [lowest] = drawLots(1, () => 0);
  assert.equal(lowest.value, lowest.low);
  const [highest] = drawLots(1, (n) => n - 1);
  assert.equal(highest.value, highest.high);
});

test('games need a supported player count', () => {
  assert.throws(() => createGame([1], [lot(10)]));
  assert.throws(() => createGame([1, 2, 3, 4, 5, 6, 7], [lot(10)]));
});

test('a valid bid becomes the top bid and raises the minimum', () => {
  const game = createGame([1, 2], [lot(100)]);
  assert.equal(minBid(game), 10);
  assert.equal(placeBid(game, 1, 50), null);
  assert.equal(game.bid, 50);
  assert.equal(game.leaderId, 1);
  assert.equal(minBid(game), 60);
  assert.equal(game.cash[1], START_CASH, 'cash only moves when the hammer falls');
});

test('illegal bids are refused and change nothing', () => {
  const game = createGame([1, 2], [lot(100)]);
  placeBid(game, 1, 50);
  assert.equal(placeBid(game, 1, 100), 'already_leading');
  assert.equal(placeBid(game, 2, 50), 'bid_too_low');
  assert.equal(placeBid(game, 2, 10), 'bid_too_low');
  assert.equal(placeBid(game, 2, 65), 'invalid_bid');
  assert.equal(placeBid(game, 2, START_CASH + 10), 'not_enough_cash');
  for (const bad of ['100', 100.5, null, undefined, NaN, Infinity, [100], {}]) {
    assert.equal(placeBid(game, 2, bad), 'invalid_bid', String(bad));
  }
  assert.equal(game.bid, 50);
  assert.equal(game.leaderId, 1);
  assert.equal(game.bids.length, 1);
});

test('zero and negative bids are refused', () => {
  const game = createGame([1, 2], [lot(100)]);
  assert.equal(placeBid(game, 1, 0), 'bid_too_low');
  assert.equal(placeBid(game, 1, -10), 'bid_too_low');
});

test('a player can bid all of their cash', () => {
  const game = createGame([1, 2], [lot(100)]);
  assert.equal(placeBid(game, 1, START_CASH), null);
});

test('the last bidder pays only their own bid and takes the lot', () => {
  const game = createGame([1, 2], [lot(300, 'Vase'), lot(100)]);
  placeBid(game, 1, 100);
  placeBid(game, 2, 200);
  closeLot(game);
  assert.equal(game.stage, 'sold');
  assert.equal(game.cash[1], START_CASH);
  assert.equal(game.cash[2], START_CASH - 200);
  assert.deepEqual(game.sales[0], { name: 'Vase', icon: 'x', value: 300, buyerId: 2, paid: 200 });
  assert.equal(scoreGame(game)[2].worth, START_CASH - 200 + 300);
  assert.equal(scoreGame(game)[1].worth, START_CASH);
});

test('a lot with no bids passes unsold', () => {
  const game = createGame([1, 2], [lot(300), lot(100)]);
  closeLot(game);
  assert.equal(game.sales[0].buyerId, null);
  assert.equal(game.cash[1], START_CASH);
  assert.equal(game.cash[2], START_CASH);
  assert.equal(scoreGame(game)[1].lots.length, 0);
});

test('no bids are accepted between the hammer and the next lot', () => {
  const game = createGame([1, 2], [lot(300), lot(100)]);
  closeLot(game);
  assert.equal(placeBid(game, 1, 10), 'lot_closed');
});

test('closing twice does not charge twice', () => {
  const game = createGame([1, 2], [lot(300), lot(100)]);
  placeBid(game, 1, 100);
  closeLot(game);
  closeLot(game);
  assert.equal(game.cash[1], START_CASH - 100);
  assert.equal(game.sales.length, 1);
});

test('the next lot starts with a clean slate', () => {
  const game = createGame([1, 2], [lot(300), lot(100)]);
  sellLot(game, 1, 100);
  assert.equal(game.lotIndex, 1);
  assert.equal(game.stage, 'bidding');
  assert.equal(game.bid, 0);
  assert.equal(game.leaderId, null);
  assert.deepEqual(game.bids, []);
  assert.equal(placeBid(game, 1, 10), null, 'the last buyer may bid again');
});

test('next lot does nothing while a lot is still open', () => {
  const game = createGame([1, 2], [lot(300), lot(100)]);
  nextLot(game, [1, 2]);
  assert.equal(game.lotIndex, 0);
});

test('canAnyoneBid looks only at active players other than the leader', () => {
  const game = createGame([1, 2, 3], [lot(300)]);
  assert.equal(canAnyoneBid(game, [1, 2, 3]), true);
  placeBid(game, 1, START_CASH);
  assert.equal(canAnyoneBid(game, [1, 2, 3]), false, 'nobody can top an all-in');

  const other = createGame([1, 2, 3], [lot(300)]);
  placeBid(other, 1, 100);
  assert.equal(canAnyoneBid(other, [1]), false);
  assert.equal(canAnyoneBid(other, [1, 3]), true);
  other.cash[3] = 100;
  assert.equal(canAnyoneBid(other, [1, 3]), false, 'cash must cover the next step');
});

test('the highest worth wins, counting true values rather than prices', () => {
  const game = createGame([1, 2], [lot(500), lot(10)]);
  sellLot(game, 1, 100); // Player 1 gains 400.
  sellLot(game, 2, 500); // Player 2 loses 490.
  assert.deepEqual(game.result, { winnerIds: [1], reason: 'worth' });
  assert.equal(game.stage, 'finished');
  assert.equal(scoreGame(game)[1].worth, 1400);
  assert.equal(scoreGame(game)[2].worth, 510);
});

test('unspent cash can beat a player who overpaid', () => {
  const game = createGame([1, 2], [lot(100)]);
  sellLot(game, 2, 300);
  assert.deepEqual(game.result, { winnerIds: [1], reason: 'worth' });
});

test('tied worth is decided by most cash', () => {
  const game = createGame([1, 2], [lot(200), lot(10)]);
  sellLot(game, 1, 200); // Worth stays 1000, cash falls to 800.
  sellLot(game, null);
  assert.deepEqual(game.result, { winnerIds: [2], reason: 'tiebreak' });
});

test('matching worth and cash share the win', () => {
  const game = createGame([1, 2, 3], [lot(200), lot(200), lot(10)]);
  sellLot(game, 1, 100);
  sellLot(game, 2, 100);
  sellLot(game, 3, 500);
  assert.deepEqual(game.result, { winnerIds: [1, 2], reason: 'draw' });
});

test('players who left cannot win', () => {
  const game = createGame([1, 2, 3], [lot(500)]);
  sellLot(game, 3, 10, [1, 2]);
  assert.deepEqual(game.result, { winnerIds: [1, 2], reason: 'draw' });
});

test('a walkover cancels the open lot and refunds nothing because nothing was charged', () => {
  const game = createGame([1, 2], [lot(500), lot(100)]);
  placeBid(game, 2, 300);
  finishGame(game, [1], true);
  assert.deepEqual(game.result, { winnerIds: [1], reason: 'walkover' });
  assert.equal(game.cash[2], START_CASH);
  assert.equal(game.sales.length, 0);
  assert.equal(placeBid(game, 1, 10), 'game_over');
});
