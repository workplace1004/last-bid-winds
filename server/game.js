// Pure game rules. No timers or sockets, and randomness is passed in, so every rule is easy to test.

export const START_CASH = 1000;
export const BID_STEP = 10;

const VALUE_STEP = 10;

export const LOTS_BY_PLAYERS = {
  2: 6,
  3: 7,
  4: 8,
  5: 9,
  6: 10,
};

// Wide estimates are gambles, and narrow ones are safe. Every limit is a multiple of VALUE_STEP.
export const CATALOG = [
  { name: 'Silver Spoon', icon: '🥄', low: 40, high: 120 },
  { name: 'Chess Set', icon: '♟️', low: 40, high: 180 },
  { name: 'Old Map', icon: '🗺️', low: 60, high: 200 },
  { name: 'Vintage Camera', icon: '📷', low: 60, high: 220 },
  { name: 'Telescope', icon: '🔭', low: 80, high: 260 },
  { name: 'Old Guitar', icon: '🎸', low: 90, high: 280 },
  { name: 'Antique Clock', icon: '🕰️', low: 100, high: 300 },
  { name: 'Ancient Vase', icon: '🏺', low: 100, high: 450 },
  { name: 'Violin', icon: '🎻', low: 120, high: 400 },
  { name: 'Golden Trophy', icon: '🏆', low: 150, high: 350 },
  { name: 'Oil Painting', icon: '🖼️', low: 150, high: 500 },
  { name: 'Ruby Ring', icon: '💍', low: 200, high: 500 },
  { name: 'Royal Crown', icon: '👑', low: 300, high: 700 },
  { name: 'Diamond', icon: '💎', low: 400, high: 900 },
  { name: 'Crystal Ball', icon: '🔮', low: 50, high: 600 },
  { name: 'Mystery Box', icon: '🎁', low: 10, high: 800 },
];

// randomInt(n) must return a whole number from 0 to n - 1.
export function drawLots(count, randomInt) {
  const pool = [...CATALOG];
  const lots = [];
  for (let i = 0; i < count; i += 1) {
    const [item] = pool.splice(randomInt(pool.length), 1);
    const steps = (item.high - item.low) / VALUE_STEP;
    lots.push({ ...item, value: item.low + randomInt(steps + 1) * VALUE_STEP });
  }
  return lots;
}

export function createGame(playerIds, lots) {
  if (!LOTS_BY_PLAYERS[playerIds.length]) {
    throw new Error(`Unsupported player count: ${playerIds.length}`);
  }
  const cash = {};
  for (const id of playerIds) cash[id] = START_CASH;
  return {
    playerIds: [...playerIds],
    cash,
    lots,
    lotIndex: 0,
    stage: 'bidding',
    bid: 0,
    leaderId: null,
    bids: [],
    sales: [],
    result: null,
  };
}

export function currentLot(game) {
  return game.lots[game.lotIndex];
}

export function minBid(game) {
  return game.bid + BID_STEP;
}

// Returns an error code, or null when the bid was applied.
export function placeBid(game, playerId, amount) {
  if (game.result) return 'game_over';
  if (game.stage !== 'bidding') return 'lot_closed';
  if (playerId === game.leaderId) return 'already_leading';
  if (!Number.isInteger(amount) || amount % BID_STEP !== 0) return 'invalid_bid';
  if (amount < minBid(game)) return 'bid_too_low';
  if (amount > game.cash[playerId]) return 'not_enough_cash';

  game.bid = amount;
  game.leaderId = playerId;
  game.bids.push({ playerId, amount });
  return null;
}

// False means waiting on the clock is pointless, because the bidding cannot change.
export function canAnyoneBid(game, activeIds) {
  return activeIds.some((id) => id !== game.leaderId && game.cash[id] >= minBid(game));
}

// The hammer falls: the leader pays and takes the lot, or it passes unsold.
export function closeLot(game) {
  if (game.result || game.stage !== 'bidding') return;
  const lot = currentLot(game);
  if (game.leaderId !== null) game.cash[game.leaderId] -= game.bid;
  game.sales.push({
    name: lot.name,
    icon: lot.icon,
    value: lot.value,
    buyerId: game.leaderId,
    paid: game.bid,
  });
  game.stage = 'sold';
}

// Opens the next lot, or finishes the game after the last one.
export function nextLot(game, activeIds) {
  if (game.result || game.stage !== 'sold') return;
  if (game.lotIndex === game.lots.length - 1) {
    finishGame(game, activeIds);
    return;
  }
  game.lotIndex += 1;
  game.stage = 'bidding';
  game.bid = 0;
  game.leaderId = null;
  game.bids = [];
}

// Only active players can win. A walkover ends the game at once and cancels any open lot.
export function finishGame(game, activeIds, walkover = false) {
  game.stage = 'finished';
  game.bid = 0;
  game.leaderId = null;
  game.bids = [];
  game.result = walkover ? { winnerIds: [...activeIds], reason: 'walkover' } : decideResult(game, activeIds);
}

export function scoreGame(game) {
  const scores = {};
  for (const id of game.playerIds) {
    const lots = game.sales.filter((sale) => sale.buyerId === id);
    const collected = lots.reduce((sum, sale) => sum + sale.value, 0);
    scores[id] = {
      cash: game.cash[id],
      collected,
      worth: game.cash[id] + collected,
      lots,
    };
  }
  return scores;
}

function decideResult(game, activeIds) {
  const scores = scoreGame(game);
  const bestWorth = Math.max(...activeIds.map((id) => scores[id].worth));
  const richest = activeIds.filter((id) => scores[id].worth === bestWorth);
  if (richest.length === 1) return { winnerIds: richest, reason: 'worth' };

  const bestCash = Math.max(...richest.map((id) => scores[id].cash));
  const winnerIds = richest.filter((id) => scores[id].cash === bestCash);
  return { winnerIds, reason: winnerIds.length > 1 ? 'draw' : 'tiebreak' };
}
