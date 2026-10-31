// Browser client. It shows snapshots from the server and sends player intent.
// The server makes every game decision. Animations come from comparing a snapshot
// with the previous one, so they can never change what happens in the game.

const SYMBOLS = ['●', '▲', '■', '◆', '★', '✚'];
const RAISES = [10, 50, 100];
const SESSION_KEY = 'last-bid-wins-session';
const NAME_KEY = 'last-bid-wins-name';
const GOING_ONCE_MS = 4000;
const GOING_TWICE_MS = 2000;
const MAX_RECONNECT_MS = 8000;
const HAMMER_MS = 300; // When the gavel lands, matching the delays in style.css.
const REVEAL_MS = 900;
const CONFETTI_PIECES = 70;
const CONFETTI_COLORS = ['--accent', '--p0', '--p1', '--p3', '--p4', '--text'];

const $ = (id) => document.getElementById(id);
const money = (amount) => `$${amount.toLocaleString('en-US')}`;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let socket = null;
let reconnectMs = 500;
let allowReconnect = true;
let state = null;
let deadline = 0;
let wasLeading = false;
let toastTimer = null;
let lastCall = '';
let lobbyIds = new Set();
let resultsShown = false;
const scoreRows = new Map(); // player id -> the row's elements
const counters = new Map(); // element -> running number animation

// Storage can be unavailable in private windows, and the game must still work.
function storageGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Without storage, the player only loses automatic rejoin after a refresh.
  }
}

function getSession() {
  try {
    return JSON.parse(storageGet(sessionStorage, SESSION_KEY));
  } catch {
    return null;
  }
}

function setSession(session) {
  storageSet(sessionStorage, SESSION_KEY, session ? JSON.stringify(session) : null);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}/ws`);
  showConnection(state || getSession() ? 'Reconnecting…' : 'Connecting to the server…');
  updateHomeButtons();

  socket.addEventListener('open', () => {
    reconnectMs = 500;
    showConnection(null);
    updateHomeButtons();
    const session = getSession();
    if (session) send({ type: 'resume', code: session.code, token: session.token });
  });

  socket.addEventListener('message', (event) => {
    handleMessage(JSON.parse(event.data));
  });

  socket.addEventListener('close', () => {
    updateHomeButtons();
    if (!allowReconnect) return;
    showConnection(state || getSession() ? 'Reconnecting…' : 'Connecting to the server…');
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  toast('Not connected yet. Try again in a moment.');
  return false;
}

function handleMessage(message) {
  switch (message.type) {
    case 'joined':
      setSession({ code: message.code, token: message.token });
      history.replaceState(null, '', location.pathname);
      break;
    case 'state':
      render(message);
      break;
    case 'error':
      if (message.code === 'session_expired') {
        endSeat('That game has ended.');
      } else {
        toast(message.message);
      }
      break;
    case 'left':
      endSeat(null);
      break;
    case 'room_closed':
      endSeat('The room closed.');
      break;
    case 'replaced':
      allowReconnect = false;
      state = null;
      showConnection('This game is now open in another tab. Refresh to play here.');
      break;
    default:
      break;
  }
}

function endSeat(notice) {
  setSession(null);
  state = null;
  wasLeading = false;
  lobbyIds = new Set();
  document.title = 'Last Bid Wins';
  if ($('help').open) $('help').close();
  showScreen('home');
  if (notice) toast(notice);
}

function showScreen(name) {
  for (const id of ['home', 'lobby', 'game']) $(id).hidden = id !== name;
}

function showConnection(text) {
  $('connection').hidden = !text;
  $('connection').textContent = text ?? '';
}

function updateHomeButtons() {
  const open = socket?.readyState === WebSocket.OPEN;
  $('create').disabled = !open;
  $('join').disabled = !open;
}

function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.classList.remove('leaving');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.add('leaving');
    box.addEventListener(
      'animationend',
      () => {
        if (box.classList.contains('leaving')) box.hidden = true;
      },
      { once: true },
    );
  }, 3500);
}

function makeBadge(player) {
  const badge = document.createElement('span');
  badge.className = `badge slot-${player.slot}`;
  badge.textContent = SYMBOLS[player.slot];
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

function setText(id, text) {
  // Only write on change, so screen readers do not re-announce it ten times a second.
  if ($(id).textContent !== text) $(id).textContent = text;
}

// Plays a one-shot animation class, restarting it if it is already running.
function play(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  const finish = (event) => {
    if (event.target !== element) return;
    element.classList.remove(className);
    element.removeEventListener('animationend', finish);
  };
  element.addEventListener('animationend', finish);
}

function stopCount(element) {
  const running = counters.get(element);
  if (!running) return;
  clearTimeout(running.timer);
  cancelAnimationFrame(running.frame);
  counters.delete(element);
}

// Counts a number up or down on screen. The last frame always shows the exact value.
function countTo(element, from, to, format, ms, delay = 0) {
  stopCount(element);
  if (reducedMotion() || from === to) {
    element.textContent = format(to);
    return;
  }
  const running = { timer: null, frame: 0 };
  counters.set(element, running);
  element.textContent = format(from);
  running.timer = setTimeout(() => {
    const start = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - start) / ms);
      if (progress === 1) {
        counters.delete(element);
        element.textContent = format(to);
        return;
      }
      const eased = 1 - (1 - progress) ** 3;
      element.textContent = format(Math.round((from + (to - from) * eased) / 10) * 10);
      running.frame = requestAnimationFrame(step);
    };
    running.frame = requestAnimationFrame(step);
  }, delay);
}

// Skips the write while a number is counting, because the count ends on the same value.
function setLive(id, text) {
  if (!counters.has($(id))) setText(id, text);
}

function render(next) {
  const prev = state;
  state = next;
  if (next.phase === 'lobby') renderLobby(next);
  else renderGame(next, prev);
}

function renderLobby(s) {
  showScreen('lobby');
  wasLeading = false;
  document.title = 'Last Bid Wins';
  $('lobby-code').textContent = s.code;
  $('player-count').textContent = `(${s.players.length} of 6)`;

  const items = s.players.map((player) => {
    const item = document.createElement('li');
    if (!lobbyIds.has(player.id)) item.classList.add('enter');
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player.name;
    item.append(makeBadge(player), name);
    const tags = [];
    if (player.id === s.you) tags.push('you');
    if (player.id === s.hostId) tags.push('host');
    if (!player.connected) tags.push('offline');
    if (tags.length > 0) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tags.join(', ');
      item.append(tag);
    }
    return item;
  });
  $('lobby-players').replaceChildren(...items);
  lobbyIds = new Set(s.players.map((player) => player.id));

  const isHost = s.hostId === s.you;
  const enough = s.players.length >= 2;
  $('start').hidden = !isHost;
  $('start').disabled = !enough;
  $('start').textContent = enough ? 'Start auction' : 'Waiting for one more player…';
  $('lobby-wait').hidden = isHost;
  const host = s.players.find((player) => player.id === s.hostId);
  $('lobby-wait').textContent = `Waiting for ${host?.name ?? 'the host'} to start the auction.`;
}

function resetGameView() {
  for (const id of ['price', 'lot-estimate']) stopCount($(id));
  for (const row of scoreRows.values()) stopCount(row.big);
  scoreRows.clear();
  $('scores').replaceChildren();
  $('pips').replaceChildren();
  resultsShown = false;
}

function renderGame(s, prev) {
  showScreen('game');
  const { game } = s;
  const prevGame = prev?.code === s.code ? prev.game : null;
  if (!prevGame) resetGameView();

  const finished = s.phase === 'finished';
  const players = new Map(s.players.map((player) => [player.id, player]));

  $('floor').hidden = finished;
  $('results').hidden = !finished;
  $('live-bids').hidden = finished;
  renderPips(game);
  if (finished) renderResults(s, players, prev);
  else renderFloor(s, players, prevGame);
  renderScores(s, prevGame);

  const isHost = s.hostId === s.you;
  $('again').hidden = !(finished && isHost);
  $('again-wait').hidden = !(finished && !isHost);

  deadline = performance.now() + game.msLeft;
  updateClock();

  // Browsers block vibration until the player has tapped the page.
  const leading = game.leaderId === s.you;
  const outbid = wasLeading && !leading && game.stage === 'bidding' && game.bid > 0;
  if (outbid && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(40);
  if (outbid) play($('stage'), 'outbid');
  wasLeading = leading;
  document.title = outbid ? 'Outbid! - Last Bid Wins' : 'Last Bid Wins';
}

function renderPips(game) {
  const box = $('pips');
  if (box.children.length !== game.lotCount) {
    const pips = Array.from({ length: game.lotCount }, () => {
      const pip = document.createElement('span');
      return pip;
    });
    box.replaceChildren(...pips);
  }
  [...box.children].forEach((pip, index) => {
    const sale = game.sales[index];
    let tone = '';
    if (sale) tone = sale.buyerId === null ? 'passed' : 'sold';
    else if (index === game.lotNumber - 1 && !game.result) tone = 'current';
    pip.className = `pip ${tone}`;
  });
  box.setAttribute('aria-label', `Lot ${game.lotNumber} of ${game.lotCount}`);
}

function renderFloor(s, players, prevGame) {
  const { game } = s;
  const { lot } = game;
  const sold = game.stage === 'sold';
  const sale = sold ? game.sales.at(-1) : null;
  const newLot = Boolean(prevGame) && prevGame.lotNumber !== game.lotNumber;
  const hammerNow = Boolean(prevGame) && sold && (newLot || prevGame.stage !== 'sold');
  const sameLot = Boolean(prevGame) && !newLot && prevGame.stage === 'bidding';
  const newBid = sameLot && game.bid > prevGame.bid;

  if (newLot) {
    stopCount($('price'));
    stopCount($('lot-estimate'));
    play($('lot'), 'lot-in');
  }

  $('floor').classList.toggle('sold', sold);
  $('stage').classList.toggle('leading', !sold && game.leaderId === s.you);
  setText('lot-number', `Lot ${game.lotNumber} of ${game.lotCount}`);
  setText('lot-icon', lot.icon);
  setText('lot-name', lot.name);

  renderEstimate(game, sale, hammerNow);
  if (sold) {
    setText('price-label', sale.buyerId === null ? 'No bids' : 'Sold for');
    stopCount($('price'));
    setText('price', sale.buyerId === null ? 'Passed' : money(sale.paid));
    setText('status', saleText(s, sale, players));
    setText('call', '');
  } else {
    setText('price-label', game.bid > 0 ? 'Top bid' : 'No bids yet');
    if (newBid) {
      countTo($('price'), prevGame.bid, game.bid, money, 240);
      play($('price'), 'bump');
      floatBid(s, players, game.bid - prevGame.bid);
    } else {
      setLive('price', money(game.bid));
    }
    if (game.leaderId === null) setText('status', 'Who will open the bidding?');
    else if (game.leaderId === s.you) setText('status', 'You have the top bid');
    else setText('status', `${players.get(game.leaderId).name} has the top bid`);
  }

  const gain = sale && sale.buyerId !== null ? sale.value - sale.paid : 0;
  $('status').classList.toggle('mine', !sold && game.leaderId === s.you);
  $('status').classList.toggle('gain', gain > 0);
  $('status').classList.toggle('loss', gain < 0);

  if (hammerNow) playHammer(sale);
  else if (sold) setStamp(sale);

  renderBidButtons(s);
  renderBidLog(s, players, newBid);
}

function renderEstimate(game, sale, hammerNow) {
  const box = $('lot-estimate');
  const { lot } = game;
  const gain = sale && sale.buyerId !== null ? sale.value - sale.paid : 0;
  box.classList.toggle('revealed', Boolean(sale));
  box.classList.toggle('gain', gain > 0);
  box.classList.toggle('loss', gain < 0);
  if (!sale) {
    setLive('lot-estimate', `Estimate ${money(lot.low)} to ${money(lot.high)}`);
    return;
  }
  const format = (value) => `True value ${money(value)}`;
  if (hammerNow) countTo(box, 0, lot.value, format, REVEAL_MS, HAMMER_MS);
  else setLive('lot-estimate', format(lot.value));
}

function setStamp(sale) {
  const stamp = $('stamp');
  const passed = sale.buyerId === null;
  setText('stamp', passed ? 'PASSED' : 'SOLD');
  stamp.classList.toggle('passed', passed);
}

function playHammer(sale) {
  setStamp(sale);
  play($('gavel'), 'swing');
  play($('ring'), 'burst');
  play($('stamp'), 'slam');
  play($('stage'), 'hit');
}

function floatBid(s, players, raise) {
  const bidder = players.get(s.game.leaderId);
  const label = document.createElement('span');
  label.className = `float slot-${bidder.slot}`;
  label.setAttribute('aria-hidden', 'true');
  label.textContent = `+${money(raise)}`;
  label.addEventListener('animationend', () => label.remove());
  $('price').parentElement.append(label);
}

function saleText(s, sale, players) {
  if (sale.buyerId === null) return `It was worth ${money(sale.value)}.`;
  const buyer = sale.buyerId === s.you ? 'You' : players.get(sale.buyerId).name;
  const gain = sale.value - sale.paid;
  if (gain > 0) return `${buyer} gained ${money(gain)} on this lot!`;
  if (gain < 0) return `${buyer} overpaid by ${money(-gain)}.`;
  return `${buyer} paid exactly what it was worth.`;
}

function renderBidButtons(s) {
  const { game } = s;
  const box = $('bid-buttons');
  if (box.children.length === 0) {
    const options = [...RAISES.map((raise) => ({ raise })), { allIn: true }];
    const buttons = options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = option.allIn ? 'bid allin' : 'bid';
      const label = document.createElement('span');
      label.textContent = option.allIn ? 'All in' : `+${option.raise}`;
      const amount = document.createElement('small');
      button.append(label, amount);
      // The amount comes from the latest snapshot, and it is what the button shows.
      button.addEventListener('click', () => {
        const value = bidAmount(option);
        if (value !== null) send({ type: 'bid', amount: value });
      });
      button.bidOption = option;
      return button;
    });
    box.replaceChildren(...buttons);
  }

  const cash = game.scores[s.you].cash;
  const open = game.stage === 'bidding';
  const leading = game.leaderId === s.you;
  for (const button of box.children) {
    const value = bidAmount(button.bidOption);
    button.lastChild.textContent = money(value);
    button.disabled = !open || leading || value < game.minBid || value > cash;
  }

  let note = '';
  if (open && !leading && cash < game.minBid) note = `You have ${money(cash)}, not enough to bid.`;
  else if (open) note = `You have ${money(cash)} to spend.`;
  setText('bid-note', note);
}

function bidAmount(option) {
  if (!state?.game) return null;
  const { game } = state;
  if (option.allIn) return game.scores[state.you].cash;
  return game.bid + option.raise;
}

function renderBidLog(s, players, newBid) {
  const items = s.game.bids.map(({ playerId, amount }, index) => {
    const item = document.createElement('li');
    if (newBid && index === 0) item.classList.add('new');
    const player = players.get(playerId);
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = playerId === s.you ? 'You' : player.name;
    const value = document.createElement('span');
    value.className = 'log-amount';
    value.textContent = money(amount);
    item.append(makeBadge(player), name, value);
    return item;
  });
  $('bid-log').replaceChildren(...items);
}

function renderResults(s, players, prev) {
  if (resultsShown) return;
  resultsShown = true;
  setText('result-text', resultText(s, players));
  $('result-text').classList.toggle('mine', s.game.result.winnerIds.includes(s.you));

  const items = s.game.sales.map((sale, index) => {
    const item = document.createElement('li');
    item.style.setProperty('--i', index);
    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = sale.icon;
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = sale.name;
    const detail = document.createElement('span');
    detail.className = 'tag';
    const value = document.createElement('span');
    value.className = 'history-value';
    value.textContent = money(sale.value);
    value.title = 'True value';
    if (sale.buyerId === null) detail.textContent = 'No bids';
    else {
      const buyer = sale.buyerId === s.you ? 'You' : players.get(sale.buyerId).name;
      detail.textContent = `${buyer} paid ${money(sale.paid)}`;
      const gain = sale.value - sale.paid;
      const change = document.createElement('small');
      change.textContent = `${gain < 0 ? '-' : '+'}${money(Math.abs(gain))}`;
      change.className = gain < 0 ? 'loss-text' : 'gain-text';
      value.append(change);
    }
    info.append(name, detail);
    item.append(icon, info, value);
    return item;
  });
  $('history').replaceChildren(...items);

  // Only a game that ends on screen celebrates, not a page reloaded afterwards.
  if (prev?.phase === 'playing' && s.game.result.winnerIds.includes(s.you)) throwConfetti();
}

function throwConfetti() {
  if (reducedMotion()) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < CONFETTI_PIECES; i += 1) {
    const piece = document.createElement('i');
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.setProperty('--color', `var(${color})`);
    piece.style.setProperty('--time', `${2 + Math.random() * 1.6}s`);
    piece.style.setProperty('--delay', `${Math.random() * 0.6}s`);
    piece.style.setProperty('--drift', `${Math.round(Math.random() * 160 - 80)}px`);
    piece.style.setProperty('--spin', `${Math.round(Math.random() * 900 - 450)}deg`);
    box.append(piece);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 4500);
}

function resultText(s, players) {
  const { result, scores } = s.game;
  const worth = money(scores[result.winnerIds[0]].worth);
  const iWon = result.winnerIds.includes(s.you);
  const winner = iWon ? 'You win' : `${players.get(result.winnerIds[0]).name} wins`;
  if (result.reason === 'draw') {
    const names = result.winnerIds.map((id) => players.get(id).name).join(' and ');
    return `It's a tie! ${names} share the win with ${worth}.`;
  }
  if (result.reason === 'walkover') return `${winner}! Everyone else left the auction.`;
  if (result.reason === 'tiebreak') return `${winner}! Tied at ${worth}, decided by most cash left.`;
  return `${winner} with a worth of ${worth}!`;
}

function makeScoreRow(player) {
  const item = document.createElement('li');
  item.className = `score slot-${player.slot}`;
  const rank = document.createElement('span');
  rank.className = 'rank';
  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('span');
  name.className = 'player-name';
  const tag = document.createElement('span');
  tag.className = 'tag';
  const won = document.createElement('span');
  won.className = 'won';
  info.append(name, tag, won);
  const big = document.createElement('span');
  big.className = 'big';
  big.title = 'Worth';
  item.append(rank, makeBadge(player), info, big);
  return { item, rank, name, tag, won, big, worth: null, lots: 0 };
}

function renderScores(s, prevGame) {
  const { game } = s;
  const box = $('scores');
  const sorted = [...s.players].sort(
    (a, b) => game.scores[b.id].worth - game.scores[a.id].worth || a.slot - b.slot,
  );

  // Rows stay in place between snapshots, so a change of rank can glide to its new position.
  const tops = new Map();
  for (const [id, row] of scoreRows) tops.set(id, row.item.getBoundingClientRect().top);

  let rank = 0;
  let rankWorth = null;
  sorted.forEach((player, index) => {
    const score = game.scores[player.id];
    let row = scoreRows.get(player.id);
    if (!row) {
      row = makeScoreRow(player);
      scoreRows.set(player.id, row);
    }
    if (score.worth !== rankWorth) {
      rank = index + 1;
      rankWorth = score.worth;
    }
    row.rank.textContent = rank;
    row.item.classList.toggle('turn', player.id === game.leaderId);
    row.item.classList.toggle('winner', Boolean(game.result?.winnerIds.includes(player.id)));
    row.name.textContent = player.id === s.you ? `${player.name} (you)` : player.name;
    let detail = `Cash ${money(score.cash)}`;
    if (player.gone) detail = 'Left the auction';
    else if (!player.connected) detail = 'Offline';
    row.tag.textContent = detail;
    row.won.setAttribute('aria-label', `Lots won: ${score.lots.map((lot) => lot.name).join(', ')}`);
    row.won.hidden = score.lots.length === 0;
    if (score.lots.length !== row.lots) {
      const icons = score.lots.map((lot, lotIndex) => {
        const icon = document.createElement('span');
        icon.textContent = lot.icon;
        if (prevGame && lotIndex >= row.lots) icon.className = 'new';
        return icon;
      });
      row.won.replaceChildren(...icons);
      row.lots = score.lots.length;
    }
    if (row.worth !== score.worth) {
      if (prevGame && row.worth !== null) {
        countTo(row.big, row.worth, score.worth, money, REVEAL_MS, HAMMER_MS);
        play(row.item, score.worth > row.worth ? 'up' : 'down');
      } else {
        stopCount(row.big);
        row.big.textContent = money(score.worth);
      }
      row.worth = score.worth;
    }
    row.big.setAttribute('aria-label', `Worth ${money(score.worth)}`);
  });

  const order = sorted.map((player) => scoreRows.get(player.id).item);
  const moved = order.some((item, index) => box.children[index] !== item);
  if (!moved) return;
  box.replaceChildren(...order);
  if (reducedMotion()) return;
  for (const player of sorted) {
    const { item } = scoreRows.get(player.id);
    const before = tops.get(player.id);
    if (before === undefined) continue;
    const shift = before - item.getBoundingClientRect().top;
    if (shift !== 0) {
      item.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], {
        duration: 500,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
    }
  }
}

function updateClock() {
  const fill = $('clock-fill');
  if (!state?.game || state.phase !== 'playing') {
    fill.style.transform = 'scaleX(0)';
    setCall('');
    return;
  }
  const { game } = state;
  const left = Math.max(0, deadline - performance.now());
  fill.style.transform = `scaleX(${Math.min(1, left / Math.max(game.msTotal, 1))})`;
  const bidding = game.stage === 'bidding';
  const hasBid = bidding && game.bid > 0;
  fill.classList.toggle('sold', !bidding);
  fill.classList.toggle('low', hasBid && left <= GOING_ONCE_MS);
  if (!bidding) {
    setCall('');
    return;
  }
  setText('call', callText(game, left));
  let call = '';
  if (hasBid && left <= GOING_TWICE_MS) call = 'twice';
  else if (hasBid && left <= GOING_ONCE_MS) call = 'once';
  setCall(call);
}

function setCall(call) {
  if (call === lastCall) return;
  lastCall = call;
  const box = $('call');
  box.classList.toggle('once', call === 'once');
  box.classList.toggle('twice', call === 'twice');
  if (call) play(box, 'pop');
  if (call) $('stage').dataset.call = call;
  else delete $('stage').dataset.call;
}

function callText(game, left) {
  const seconds = Math.ceil(left / 1000);
  if (game.bid === 0) return `${seconds}s to open`;
  if (left <= GOING_TWICE_MS) return 'Going twice…';
  if (left <= GOING_ONCE_MS) return 'Going once…';
  return `${seconds}s to outbid`;
}

function clockLoop() {
  updateClock();
  requestAnimationFrame(clockLoop);
}

function currentName() {
  const name = $('name').value.trim();
  if (!name) {
    toast('Enter your name first.');
    $('name').focus();
    return null;
  }
  storageSet(localStorage, NAME_KEY, name);
  return name;
}

async function shareInvite() {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied.');
  } catch {
    toast(`Share this link: ${url}`);
  }
}

// One copy of the rules fills the home screen, the lobby and the in-game help.
for (const slot of document.querySelectorAll('[data-rules]')) {
  slot.append($('rules-template').content.cloneNode(true));
}

$('create').addEventListener('click', () => {
  const name = currentName();
  if (name) send({ type: 'create', name });
});

function joinRoom() {
  const name = currentName();
  if (!name) return;
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Enter the 4-letter room code.');
    $('code').focus();
    return;
  }
  send({ type: 'join', code, name });
}

$('join').addEventListener('click', joinRoom);
$('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoom();
});
$('name').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if ($('code').value.trim()) joinRoom();
  else $('create').click();
});
$('share').addEventListener('click', shareInvite);
$('start').addEventListener('click', () => send({ type: 'start' }));
$('again').addEventListener('click', () => send({ type: 'playAgain' }));
$('lobby-leave').addEventListener('click', () => send({ type: 'leave' }));
$('game-leave').addEventListener('click', () => {
  const running = state?.phase === 'playing';
  if (!running || confirm('Leave this auction? You will not be able to return.')) {
    send({ type: 'leave' });
  }
});
$('help-open').addEventListener('click', () => $('help').showModal());
$('help-close').addEventListener('click', () => $('help').close());
$('help').addEventListener('click', (event) => {
  if (event.target === $('help')) $('help').close();
});

$('name').value = storageGet(localStorage, NAME_KEY) ?? '';
const invitedCode = new URLSearchParams(location.search).get('room');
if (invitedCode) {
  $('code').value = invitedCode.slice(0, 4).toUpperCase();
  $($('name').value ? 'join' : 'name').focus();
}

updateHomeButtons();
connect();
requestAnimationFrame(clockLoop);
