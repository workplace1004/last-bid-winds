// HTTP and WebSocket entry point. Game decisions live in rooms.js and game.js.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DEFAULT_PORT = 3002;

// A fixed list, so a request path can never reach any other file.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const MAX_MESSAGE_BYTES = 1024;
const MESSAGES_PER_SECOND = 20;
const ROOM_ATTEMPTS_PER_MINUTE = 20;
const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 60_000;

async function handleHttp(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const entry = STATIC_FILES[pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Not found');
    return;
  }

  try {
    const body = await readFile(join(PUBLIC_DIR, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error('Could not read static file', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
}

// Other websites must not be able to open sockets to this server from a visitor's browser.
function isAllowedOrigin(req) {
  const { origin } = req.headers;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function createLimiter() {
  let tokens = MESSAGES_PER_SECOND;
  let refilledAt = Date.now();
  let roomAttempts = 0;
  let attemptsSince = Date.now();

  return {
    allowMessage() {
      const now = Date.now();
      tokens = Math.min(
        MESSAGES_PER_SECOND,
        tokens + ((now - refilledAt) / 1000) * MESSAGES_PER_SECOND,
      );
      refilledAt = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    allowRoomAttempt() {
      const now = Date.now();
      if (now - attemptsSince >= 60_000) {
        roomAttempts = 0;
        attemptsSince = now;
      }
      roomAttempts += 1;
      return roomAttempts <= ROOM_ATTEMPTS_PER_MINUTE;
    },
  };
}

function handleSocket(socket, manager) {
  const conn = {
    send(message) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
  const limiter = createLimiter();
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, 'Text only');
      return;
    }
    if (!limiter.allowMessage()) {
      conn.send({ type: 'error', code: 'rate_limited', message: 'Too many requests. Slow down.' });
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      message = null;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      conn.send({ type: 'error', code: 'bad_message', message: 'That request was not understood.' });
      return;
    }
    const isRoomAttempt = message.type === 'join' || message.type === 'resume';
    if (isRoomAttempt && !limiter.allowRoomAttempt()) {
      conn.send({
        type: 'error',
        code: 'rate_limited',
        message: 'Too many attempts. Wait a minute and try again.',
      });
      return;
    }
    try {
      manager.handle(conn, message);
    } catch (error) {
      console.error('Failed to handle message', error);
      conn.send({ type: 'error', code: 'server_error', message: 'Something went wrong.' });
    }
  });

  socket.on('close', () => manager.disconnect(conn));
  socket.on('error', (error) => console.error('Socket error', error.message));
}

export function startServer({ port = DEFAULT_PORT, host = '0.0.0.0', roomOptions } = {}) {
  const manager = new RoomManager(roomOptions);
  const server = createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      console.error('Request failed', error);
      res.destroy();
    });
  });
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: ({ req }) => isAllowedOrigin(req),
  });
  wss.on('connection', (socket) => handleSocket(socket, manager));

  // Finds connections that vanished without closing, such as a phone losing signal.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
      } else {
        socket.isAlive = false;
        socket.ping();
      }
    }
  }, HEARTBEAT_MS);
  const sweeper = setInterval(() => manager.sweep(), SWEEP_MS);

  const close = () =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      manager.shutdown();
      for (const socket of wss.clients) socket.terminate();
      wss.close(() => server.close(() => resolve()));
    });

  return new Promise((resolve, reject) => {
    // The WebSocket server repeats HTTP server errors, so this is where a busy port arrives.
    wss.on('error', (error) => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      reject(error);
    });
    server.listen(port, host, () => {
      resolve({ port: server.address().port, manager, close });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const app = await startServer({ port }).catch((error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    console.error(`Port ${port} is already in use. Stop the other server, or set the PORT variable.`);
    process.exit(1);
  });
  console.log(`Last Bid Wins is running at http://localhost:${app.port}`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
