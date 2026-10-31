# Last Bid Wins: Architecture and Workflow

## 1. Game rules

Goal: **finish with the highest worth** (cash left + true value of the lots you won).

1. Everyone starts with $1,000. Everyone's cash is public.
2. Lots are auctioned one at a time. Each shows an estimate, such as $100-$300. Its **true value stays secret** until the hammer falls.
3. Anyone can bid at any moment, in steps of $10, up to their cash. You cannot outbid yourself.
4. A lot opens with 15 seconds on the clock. **Every bid resets the clock to 6 seconds.**
5. When the clock runs out, the last bid wins: that player pays their bid and keeps the lot. A lot with no bids passes unsold.
6. After each lot, its true value is shown to everyone for 4 seconds, then the next lot opens.
7. After the last lot, the highest worth wins. Tie: most cash left. If that matches too, the winners share the win.

| Players | Lots |
|---|---|
| 2 | 6 |
| 3 | 7 |
| 4 | 8 |
| 5 | 9 |
| 6 | 10 |

The tension comes from three things: paying more than a lot is worth loses money, holding cash back scores just as well as spending it, and a late bid can steal a lot from a player who thought they had it.

## 2. System overview

```
 Phone / laptop browsers                 Node.js server (one process)
+------------------------+              +-------------------------------+
| public/app.js          |   WebSocket  | server/index.js               |
|  - shows the snapshot  | <----------> |  HTTP files, sockets, limits  |
|  - sends player intent |              |             |                 |
+------------------------+              | server/rooms.js               |
                                        |  rooms, seats, auction clock  |
                                        |             |                 |
                                        | server/game.js                |
                                        |  pure rules, no I/O           |
                                        +-------------------------------+
```

### Key decisions

| Decision | Reason |
|---|---|
| **The server decides everything** | Clients only ask ("bid 130"), so a modified browser cannot cheat. |
| **Hidden values never leave the server early** | The snapshot sends `value: null` while bidding and never sends future lots, so reading network traffic reveals nothing. |
| **Bids are absolute amounts, not "+10"** | If two players tap at once, the second gets `bid_too_low` instead of silently paying more than the amount on their button. |
| **Arrival order at the server decides** | A bid counts if it is processed before the hammer timer runs. There is one clear rule and no client timestamps to forge. |
| **Full snapshot after every change** | There is no sync logic to get wrong. A reconnecting player just gets the latest snapshot. |
| **Animations come from comparing snapshots** | The client compares each snapshot with the previous one, so effects stay visual only, a reconnect does not replay them, and `prefers-reduced-motion` can turn them off. |
| **Time left is sent, not a clock time** | Wrong clocks on players' devices cannot affect the countdown. |
| **Randomness is passed into `game.js`** | The rules stay pure, so tests can use fixed lots and values. |
| **Layers: `game` -> `rooms` -> `index`** | Each layer can be tested alone. |
| **Plain JavaScript, no build step, one dependency (`ws`)** | Few moving parts to deploy or debug. |
| **Rooms stay in memory** | Games last about 5 minutes, so no database is needed. The trade-offs are one server process only, and a restart ends running games. |
| **Own folder and own `package.json`** | This game deploys and runs without touching Territory Grab. |

## 3. Files

```
server/game.js      Rules: lot catalog, bids, hammer, worth, winner
server/rooms.js     Room codes, players, host, auction clock, reconnects
server/index.js     Static files, WebSocket, rate limits, heartbeat
public/index.html   Screens: home, lobby, game
public/style.css    Responsive layout and player colors
public/app.js       Connection, reconnect, drawing, input
test/               Rules, room and real-socket tests
render.yaml         Deployment settings for Render
```

## 4. State machines

Room:

```
          create / join             host starts          last lot done
 (none) ----------------> LOBBY ----------------> PLAYING ------------> FINISHED
                            ^                                               |
                            +------------------ host: play again -----------+
```

Joining is only allowed in the lobby, and a room holds up to 6 players.

One lot, while the room is `PLAYING`:

```
                  bid (clock back to 6s)
                     +-------+
                     v       |
 next lot ------> BIDDING ---+
    ^                |
    |                | clock runs out, or nobody left can afford a bid
    |                v
    +------------- SOLD (true value shown for 4s)
```

## 5. Workflows

### Create and join
1. The host enters a name and creates a room. The server returns a 4-letter code and a secret seat token.
2. Friends use the code or the shared link (`/?room=ABCD`).
3. The host starts the game once at least 2 players are present.
4. The server draws the lots with their secret values.

### A bid
1. The client sends `{type:"bid", amount}`.
2. The server checks that the lot is open, the player is not already leading, and the amount is a multiple of $10, at least the current bid + $10, and within their cash.
3. If it fails, only that player gets an error, and the game state does not change.
4. If it passes, the bid is recorded and the clock resets to 6 seconds. If nobody else can afford to raise, the hammer falls at once.
5. Everyone receives a new snapshot.

Cash only leaves a player's balance when the hammer falls. They can only lead one lot at a time, so a bid can never exceed what they can pay.

### The hammer
1. The clock timer fires on the server. The leader pays and takes the lot, or the lot passes unsold.
2. The stage becomes `sold`, the snapshot now includes the true value, and a 4-second timer starts.
3. The next lot opens, or the game finishes and the winner is decided.

### Connection loss

The auction never waits. The clock keeps running for everybody else.

| Situation | What happens |
|---|---|
| Connection drops | The seat is kept, and the token lets the browser tab return automatically. |
| Leader goes offline or leaves | Their bid stands. If it wins, they pay for the lot. |
| Offline over 30 seconds, in the lobby | The player is removed. |
| Offline over 30 seconds, in a game | The player is marked gone: they cannot win unless they return, and they do not hold up the clock. |
| Player presses Leave | Same as above, but they cannot return. |
| Only one player not gone | The game ends at once and that player wins (`walkover`). The open lot is cancelled. |
| Host offline or gone | The next connected player becomes host. |
| Everybody gone | The room is deleted. |
| No player action for 1 hour | The room is deleted. |

## 6. Messages

Client to server:

| Type | Fields |
|---|---|
| `create` | `name` |
| `join` | `code`, `name` |
| `resume` | `code`, `token` |
| `start`, `playAgain`, `leave` | none |
| `bid` | `amount` |

Server to client:

| Type | Meaning |
|---|---|
| `joined` | Seat details: `code`, `token`, `playerId` |
| `state` | The full room snapshot, personalized with `you` |
| `error` | `code` and a readable `message` |
| `left`, `room_closed`, `replaced` | The seat ended, for the reason in the name |

`state.game` holds: `lotNumber`, `lotCount`, `stage`, `lot` (with `value: null` until sold), `bid`, `leaderId`, `minBid`, `bids` (latest first), `msLeft`, `msTotal`, `scores`, `sales`, `result`.

## 7. Security and limits

- All input is validated on the server, and names are cleaned and limited to 16 characters.
- Names are drawn with `textContent`, so they cannot inject HTML.
- Seat tokens are random, go only to their owner, and never appear in snapshots.
- Messages are limited to 1 KB, with a per-connection rate limit, a join attempt limit and a cap on rooms.
- Sockets from other websites are refused by an Origin check.
- Only a fixed list of files is served, which prevents path traversal.

## 8. Testing

| Level | What it proves |
|---|---|
| `test/game.test.js` | Rules: bid validation, hammer, worth, ties, lot drawing |
| `test/rooms.test.js` | Lobby, clock resets, hidden values, leavers and reconnects, using a fake clock |
| `test/server.test.js` | A full game over real WebSockets, plus limits and file serving |
| Browser check | Real browser sessions, including phone size |

## 9. Running

```
npm install
npm test
npm start        # http://localhost:3002 (or the PORT variable)
```
