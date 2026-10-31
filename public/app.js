// Browser client. It shows snapshots from the server and sends player intent.
// The server makes every game decision.

const SYMBOLS = ['●', '▲', '■', '◆', '★', '✚'];
const RAISES = [10, 50, 100];
const SESSION_KEY = 'last-bid-wins-session';
const NAME_KEY = 'last-bid-wins-name';
const GOING_ONCE_MS = 4000;
const GOING_TWICE_MS = 2000;
const MAX_RECONNECT_MS = 8000;

const $ = (id) => document.getElementById(id);
const money = (amount) => `$${amount.toLocaleString('en-US')}`;

let socket = null;
let reconnectMs = 500;
let allowReconnect = true;
let state = null;
let deadline = 0;
let wasLeading = false;
let toastTimer = null;

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
  document.title = 'Last Bid Wins';
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
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
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

function render(next) {
  state = next;
  if (next.phase === 'lobby') renderLobby(next);
  else renderGame(next);
}

function renderLobby(s) {
  showScreen('lobby');
  wasLeading = false;
  document.title = 'Last Bid Wins';
  $('lobby-code').textContent = s.code;
  $('player-count').textContent = `(${s.players.length} of 6)`;

  const items = s.players.map((player) => {
    const item = document.createElement('li');
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

  const isHost = s.hostId === s.you;
  const enough = s.players.length >= 2;
  $('start').hidden = !isHost;
  $('start').disabled = !enough;
  $('start').textContent = enough ? 'Start auction' : 'Waiting for one more player…';
  $('lobby-wait').hidden = isHost;
  const host = s.players.find((player) => player.id === s.hostId);
  $('lobby-wait').textContent = `Waiting for ${host?.name ?? 'the host'} to start the auction.`;
}

function renderGame(s) {
  showScreen('game');
  const { game } = s;
  const finished = s.phase === 'finished';
  const players = new Map(s.players.map((player) => [player.id, player]));

  $('floor').hidden = finished;
  $('results').hidden = !finished;
  if (finished) renderResults(s, players);
  else renderFloor(s, players);
  renderScores(s);

  const isHost = s.hostId === s.you;
  $('again').hidden = !(finished && isHost);
  $('again-wait').hidden = !(finished && !isHost);

  deadline = performance.now() + game.msLeft;
  updateClock();

  // Browsers block vibration until the player has tapped the page.
  const leading = game.leaderId === s.you;
  const outbid = wasLeading && !leading && game.stage === 'bidding' && game.bid > 0;
  if (outbid && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(40);
  wasLeading = leading;
  document.title = outbid ? 'Outbid! - Last Bid Wins' : 'Last Bid Wins';
}

function renderFloor(s, players) {
  const { game } = s;
  const { lot } = game;
  const sold = game.stage === 'sold';
  const sale = sold ? game.sales.at(-1) : null;

  $('floor').classList.toggle('sold', sold);
  setText('lot-number', `Lot ${game.lotNumber} of ${game.lotCount}`);
  setText('lot-icon', lot.icon);
  setText('lot-name', lot.name);
  setText(
    'lot-estimate',
    sold ? `True value ${money(lot.value)}` : `Estimate ${money(lot.low)} to ${money(lot.high)}`,
  );
  $('lot-estimate').classList.toggle('revealed', sold);

  if (sold) {
    setText('price-label', sale.buyerId === null ? 'No bids' : 'Sold for');
    setText('price', sale.buyerId === null ? 'Passed' : money(sale.paid));
    setText('status', saleText(s, sale, players));
    setText('call', '');
  } else {
    setText('price-label', game.bid > 0 ? 'Top bid' : 'No bids yet');
    setText('price', money(game.bid));
    if (game.leaderId === null) setText('status', 'Who will open the bidding?');
    else if (game.leaderId === s.you) setText('status', 'You have the top bid');
    else setText('status', `${players.get(game.leaderId).name} has the top bid`);
  }
  $('status').classList.toggle('mine', game.leaderId === s.you && !sold);

  renderBidButtons(s);
  renderBidLog(s, players);
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

function renderBidLog(s, players) {
  const items = s.game.bids.map(({ playerId, amount }) => {
    const item = document.createElement('li');
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

function renderResults(s, players) {
  setText('result-text', resultText(s, players));
  $('result-text').classList.toggle('mine', s.game.result.winnerIds.includes(s.you));

  const items = s.game.sales.map((sale) => {
    const item = document.createElement('li');
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
    if (sale.buyerId === null) detail.textContent = 'No bids';
    else {
      const buyer = sale.buyerId === s.you ? 'You' : players.get(sale.buyerId).name;
      detail.textContent = `${buyer} paid ${money(sale.paid)}`;
    }
    info.append(name, detail);
    const value = document.createElement('span');
    value.className = 'log-amount';
    value.textContent = money(sale.value);
    value.title = 'True value';
    item.append(icon, info, value);
    return item;
  });
  $('history').replaceChildren(...items);
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

function renderScores(s) {
  const { game } = s;
  const rows = [...s.players]
    .sort((a, b) => game.scores[b.id].worth - game.scores[a.id].worth || a.slot - b.slot)
    .map((player) => {
      const score = game.scores[player.id];
      const item = document.createElement('li');
      item.className = `score slot-${player.slot}`;
      if (player.id === game.leaderId) item.classList.add('turn');

      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = player.id === s.you ? `${player.name} (you)` : player.name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      let detail = `Cash ${money(score.cash)}`;
      if (player.gone) detail = 'Left the auction';
      else if (!player.connected) detail = 'Offline';
      tag.textContent = detail;
      info.append(name, tag);

      if (score.lots.length > 0) {
        const won = document.createElement('span');
        won.className = 'won';
        won.textContent = score.lots.map((lot) => lot.icon).join(' ');
        won.setAttribute('aria-label', `Lots won: ${score.lots.map((lot) => lot.name).join(', ')}`);
        info.append(won);
      }

      const big = document.createElement('span');
      big.className = 'big';
      big.textContent = money(score.worth);
      big.title = 'Worth';
      big.setAttribute('aria-label', `Worth ${money(score.worth)}`);

      item.append(makeBadge(player), info, big);
      return item;
    });
  $('scores').replaceChildren(...rows);
}

function updateClock() {
  const fill = $('clock-fill');
  if (!state?.game || state.phase !== 'playing') {
    fill.style.transform = 'scaleX(0)';
    return;
  }
  const { game } = state;
  const left = Math.max(0, deadline - performance.now());
  fill.style.transform = `scaleX(${Math.min(1, left / Math.max(game.msTotal, 1))})`;
  const bidding = game.stage === 'bidding';
  const hasBid = bidding && game.bid > 0;
  fill.classList.toggle('sold', !bidding);
  fill.classList.toggle('low', hasBid && left <= GOING_ONCE_MS);
  if (bidding) setText('call', callText(game, left));
}

function callText(game, left) {
  const seconds = Math.ceil(left / 1000);
  if (game.bid === 0) return `${seconds}s to open`;
  if (left <= GOING_TWICE_MS) return 'Going twice…';
  if (left <= GOING_ONCE_MS) return 'Going once…';
  return `${seconds}s to outbid`;
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

$('name').value = storageGet(localStorage, NAME_KEY) ?? '';
const invitedCode = new URLSearchParams(location.search).get('room');
if (invitedCode) {
  $('code').value = invitedCode.slice(0, 4).toUpperCase();
  $($('name').value ? 'join' : 'name').focus();
}

setInterval(updateClock, 100);
updateHomeButtons();
connect();
