/**
 * The phone surface: one small HTTP listener that carries the distilled frame
 * stream, the decisions queue, and instructions back to the running agent.
 *
 * Deliberate scope: this is not a reverse proxy and it does not expose the
 * desktop GUI's API. It serves four things — a PWA, an SSE stream of distilled
 * frames, the pending-decision queue, and a single instruction endpoint. An
 * attacker who defeats the device token gets a read-only activity feed and the
 * ability to answer questions the agent itself asked; they do not get the
 * harness API, the filesystem, or the settings plane.
 *
 * @module pulse-remote/server
 */

import { createServer } from 'node:http';

import {
  ACCESS_DENIED,
  gateHtml,
  indexHtml,
  manifestJson,
  pulseScript,
  pulseStylesheet,
} from './ui.js';
import { pushWorkerScript } from './push.js';
import { LOCAL_TOKEN_HEADER } from './local-token.js';
import { constantTimeEqual } from './auth.js';

/** How often an idle SSE connection emits a comment to hold NAT mappings open. */
const HEARTBEAT_MS = 20_000;

/** Requests larger than this are refused before any body is read. */
const MAX_BODY_BYTES = 64 * 1024;

/** Name of the signed cookie a paired phone uses after its first exchange. */
const SESSION_COOKIE = 'pulse_session';

/** Paths served by Pulse itself rather than proxied to the harness GUI. */
const PULSE_PATHS = new Set([
  '/pulse',
  '/pulse.css',
  '/pulse.js',
  '/health',
  '/manifest.webmanifest',
  '/sw.js',
]);

/** Pulse's own JSON endpoints, which sit in front of the proxied `/api` tree. */
const PULSE_API = new Set([
  '/api/snapshot',
  '/api/stream',
  '/api/decisions',
  '/api/decisions/resolve',
  '/api/instruct',
  '/api/artifacts',
  '/api/artifacts/content',
]);

/**
 * Every listener this process has created, so a shutdown path (or a test
 * teardown) can close them all without having to find them first.
 * @type {Set<PulseServer>}
 */
const liveListeners = new Set();

/**
 * Close every listener this module created.
 * @returns {Promise<number>} how many were closed.
 */
export async function closeAllListeners() {
  const listeners = [...liveListeners];
  liveListeners.clear();
  await Promise.all(
    listeners.map(listener =>
      listener.close().catch(() => {
        /* already closed */
      }),
    ),
  );
  return listeners.length;
}

/**
 * Whether a remote address is the local machine.
 *
 * This is a *deployment* question, not a security boundary: the supported
 * deployment reaches this listener over an SSH reverse tunnel, so an internet
 * caller's socket address is also `127.0.0.1`. Treat it as a cheap filter that
 * makes a misconfigured bind fail closed — never as proof of locality. The
 * local-operator token is what actually proves locality.
 *
 * @param {string | undefined} address - `req.socket.remoteAddress`.
 * @returns {boolean} true for loopback forms.
 */
export function isLoopbackAddress(address) {
  if (!address) return false;
  const value = String(address);
  if (value === '::1' || value === '127.0.0.1') return true;
  if (value.startsWith('127.')) return true;
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1
  if (value.startsWith('::ffff:')) return isLoopbackAddress(value.slice(7));
  return false;
}

/**
 * The client address reported by the trusted edge proxy, or an empty string.
 *
 * The **last** hop is the one the edge appended, which makes this robust to
 * either nginx spelling: `proxy_set_header X-Forwarded-For $remote_addr`
 * overwrites with the true peer, while `$proxy_add_x_forwarded_for` appends the
 * true peer to whatever the client sent. Reading the last hop yields the true
 * peer either way, so a caller cannot forge a loopback value by sending one.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string} the last forwarded hop, or '' when the header is absent.
 */
export function edgeForwardedFor(req) {
  const raw = String(req.headers['x-forwarded-for'] ?? '').trim();
  if (!raw) return '';
  const hops = raw
    .split(',')
    .map(hop => hop.trim())
    .filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : '';
}

/**
 * The identity to rate-limit a caller by.
 *
 * Behind the tunnel every socket is loopback, so the socket address would put
 * the whole internet in one bucket (and one attacker's guesses would lock out
 * the legitimate user). The edge proxy's view of the peer is per-client, so it
 * is preferred whenever it is present.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {string} source - the socket address.
 * @returns {string} the rate-limit key.
 */
export function clientIdentity(req, source) {
  return edgeForwardedFor(req) || source;
}

/**
 * Read and parse a JSON body with a hard size ceiling.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} [limit] - maximum bytes.
 * @returns {Promise<object>} the parsed body, or `{}` when empty.
 * @throws {Error} with `code = 'too-large'` or `code = 'bad-json'`.
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('request body too large');
        error.code = 'too-large';
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        const error = new Error('request body is not valid JSON');
        error.code = 'bad-json';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Send a small text/asset response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {string} contentType - MIME type.
 * @param {string} body - the body.
 * @returns {void}
 */
function sendText(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Extract the presented device credentials from a request.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {{id: string, token: string}} the credentials.
 */
export function deviceCredentials(req) {
  const header = String(req.headers.authorization ?? '');
  if (header.startsWith('Bearer ')) {
    const raw = header.slice(7).trim();
    const at = raw.indexOf('.');
    if (at > 0) return { id: raw.slice(0, at), token: raw.slice(at + 1) };
    return { id: '', token: raw };
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = url.searchParams.get('device') ?? '';
  const token = url.searchParams.get('token') ?? '';
  return { id, token };
}

/**
 * Read the phone session cookie from a request.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string} the cookie value, or an empty string.
 */
export function sessionCookieOf(req) {
  const header = String(req.headers.cookie ?? '');
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === SESSION_COOKIE) return segment.slice(at + 1).trim();
  }
  return '';
}

/**
 * The phone-facing server.
 */
export class PulseServer {
  /**
   * @param {object} options - wiring.
   * @param {import('./auth.js').AccessControl} options.access - pairing and devices.
   * @param {(since: number) => {frames: Array<object>, gap: boolean}} options.replay - frame replay.
   * @param {() => object} options.snapshot - current machine/session state.
   * @param {() => Array<object>} options.pendingDecisions - queued decisions.
   * @param {(id: string, answer: object) => {ok: boolean, reason?: string}} options.resolveDecision - answer a decision.
   * @param {(text: string, sessionId?: string) => Promise<object>} options.instruct - send an instruction to an agent.
   * @param {() => void} [options.onPhoneConnected] - first live phone arrived.
   * @param {() => void} [options.onPhoneDisconnected] - last live phone left.
   * @param {string} [options.host] - bind address; loopback by default.
   * @param {number} [options.port] - bind port.
   * @param {string} [options.realm] - display name for the surface.
   * @param {import('./gateway.js').LoopbackGateway} [options.gateway] - proxies the official GUI when present.
   * @param {() => Promise<boolean>} [options.ensureCredential] - mints the loopback credential on demand.
   * @param {(deviceId: string, phoneAuthority: string) => string} [options.mintSession] - signs a phone session cookie.
   * @param {(cookie: string) => string | null} [options.verifySession] - resolves a session cookie to a device id.
   * @param {string} [options.localToken] - proves a caller is a process on this machine.
   * @param {() => Array<object>} [options.listArtifacts] - recorded produced files.
   * @param {(path: string) => object} [options.readArtifact] - read one recorded file.
   */
  constructor(options) {
    this.access = options.access;
    this.replay = options.replay;
    this.snapshot = options.snapshot;
    this.pendingDecisions = options.pendingDecisions ?? (() => []);
    this.resolveDecision = options.resolveDecision ?? (() => ({ ok: false, reason: 'disabled' }));
    this.instruct = options.instruct ?? (async () => ({ ok: false, reason: 'unsupported' }));
    /**
     * The recorded artifacts, and a reader bound to the same allowlist. Both are
     * supplied by the plugin so the server never has to know how a path was
     * produced — and, more importantly, so the content route cannot be handed a
     * path the plugin did not record.
     * @type {() => Array<object>}
     */
    this.listArtifacts = options.listArtifacts ?? (() => []);
    /** @type {(path: string) => object} */
    this.readArtifact = options.readArtifact ?? (() => ({ ok: false, reason: 'disabled' }));
    this.gateway = options.gateway ?? null;
    /** @type {import('./push.js').PushChannel | null} lock-screen delivery */
    this.push = options.push ?? null;
    this.ensureCredential = options.ensureCredential ?? (async () => false);
    this.mintSession = options.mintSession ?? (() => '');
    this.verifySession = options.verifySession ?? (() => null);
    /**
     * The local-operator secret. When it is absent the management subtree is
     * closed outright: a server that cannot tell a local operator from a tunnel
     * must refuse both, because refusing the operator is recoverable and
     * admitting a stranger is not.
     * @type {string}
     */
    this.localToken = String(options.localToken ?? '');
    this.onPhoneConnected = options.onPhoneConnected ?? (() => {});
    this.onPhoneDisconnected = options.onPhoneDisconnected ?? (() => {});
    /**
     * Called when a device is revoked, so subscriptions tied to it can be
     * purged. Revocation has to reach the lock screen too: leaving them behind
     * would let a removed phone keep receiving task content.
     * @type {(deviceId: string) => void}
     */
    this.onDeviceRevoked = options.onDeviceRevoked ?? (() => {});
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 3199;
    this.realm = options.realm ?? 'Pulse';

    /** @type {Set<import('node:http').ServerResponse>} live SSE responses. */
    this.streams = new Set();
    /** @type {Set<import('node:net').Socket>} every accepted socket, for shutdown. */
    this.sockets = new Set();
    /** @type {Set<string>} device ids currently streaming. */
    this.connected = new Set();
    /** @type {import('node:http').Server | null} the listener. */
    this.server = null;
    // Registered at construction, not at listen(): a test that fails before its
    // cleanup must still be able to close this, and a shutdown path should not
    // have to hunt for listeners it owns.
    liveListeners.add(this);
  }

  /**
   * Whether any phone is connected and able to answer.
   * @returns {boolean} true when at least one stream is live.
   */
  get hasLivePhone() {
    return this.streams.size > 0;
  }

  /**
   * Whether the listener is bound to every interface, i.e. reachable from a phone.
   * @returns {boolean} true when not loopback-only.
   */
  get exposed() {
    return this.host !== '127.0.0.1' && this.host !== '::1' && this.host !== 'localhost';
  }

  /**
   * Start listening.
   * @returns {Promise<{host: string, port: number}>} the bound address.
   */
  async listen() {
    if (this.server) return { host: this.host, port: this.port };
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch(error => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: String(error?.message ?? error) });
        else res.end();
      });
    });
    // SSE connections are long-lived; an idle timeout would sever them.
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 70_000;

    // Track sockets explicitly. `server.close()` waits for every open
    // connection, and this listener holds SSE streams and proxied WebSockets by
    // design, so a bounded shutdown needs its own handle on them.
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    // The official GUI's live session rides a WebSocket. Upgrades are gated by
    // the same credential as HTTP, checked here rather than inside the gateway
    // so an unpaired socket is refused before any upstream connection exists.
    this.server.on('upgrade', (req, socket, head) => {
      const source = String(socket.remoteAddress ?? 'unknown');
      const credentials = deviceCredentials(req);
      const auth = this.access.authenticate({ ...credentials, source });
      const sessionDeviceId = auth.ok ? null : this.verifySession(sessionCookieOf(req));
      if (!auth.ok && !sessionDeviceId) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      if (!this.gateway) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        return;
      }
      this.gateway
        .proxyUpgrade(req, socket, head, String(req.headers.host ?? 'localhost'))
        .catch(() => socket.destroy());
    });

    await new Promise((resolve, reject) => {
      const onError = error => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });

    const address = this.server.address();
    if (address && typeof address === 'object') this.port = address.port;
    // The listener must never be the reason a process stays alive. An idle SSE
    // or proxied WebSocket connection is held open by design, and `server.close()`
    // waits for those; unref'ing means a shutting-down harness (or a test runner)
    // is not blocked by a client that has not noticed yet. A running service is
    // unaffected: anything else keeping the process busy still does.
    this.server.unref?.();
    return { host: this.host, port: this.port };
  }

  /**
   * Stop listening and drop every stream.
   *
   * Bounded on purpose: `server.close()` waits for every open connection, and
   * this listener holds long-lived SSE streams and proxied WebSockets by design.
   * A phone in a tunnel can keep one open indefinitely, so shutdown destroys
   * whatever is left after a grace period instead of waiting forever.
   *
   * @returns {Promise<void>} resolves once fully closed.
   */
  async close() {
    for (const res of this.streams) {
      try {
        res.end();
      } catch {
        /* the socket is already gone */
      }
    }
    this.streams.clear();
    this.connected.clear();
    const server = this.server;
    this.server = null;
    liveListeners.delete(this);
    if (!server) return;

    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(() => {
        // Forcing the close is correct here: the process is shutting down and a
        // half-open client must not be able to delay it.
        for (const socket of this.sockets) {
          try {
            socket.destroy();
          } catch {
            /* already gone */
          }
        }
        this.sockets.clear();
        try {
          server.closeAllConnections?.();
        } catch {
          /* older Node */
        }
        finish();
      }, 1000);
      deadline.unref?.();
      server.close(() => {
        this.sockets.clear();
        finish();
      });
    });
  }

  /**
   * Broadcast one frame to every live phone stream.
   * @param {object} frame - a distilled frame with `seq`.
   * @returns {number} how many streams received it.
   */
  broadcast(frame) {
    const payload = `event: frame\ndata: ${JSON.stringify(frame)}\n\n`;
    let sent = 0;
    for (const res of this.streams) {
      try {
        res.write(payload);
        sent += 1;
      } catch {
        this.streams.delete(res);
      }
    }
    return sent;
  }

  /**
   * Notify live streams that the pending-decision queue changed.
   * @returns {number} how many streams received the notice.
   */
  broadcastDecisions() {
    const payload = `event: decisions\ndata: ${JSON.stringify({ decisions: this.pendingDecisions() })}\n\n`;
    let sent = 0;
    for (const res of this.streams) {
      try {
        res.write(payload);
        sent += 1;
      } catch {
        this.streams.delete(res);
      }
    }
    return sent;
  }

  /**
   * Notify live streams that the artifact list changed.
   *
   * The list only ever grows from agent activity, so a phone that is already
   * open learns about a new file without polling.
   * @returns {number} how many streams received the notice.
   */
  broadcastArtifacts() {
    const payload = `event: artifacts\ndata: ${JSON.stringify({ artifacts: this.listArtifacts() })}\n\n`;
    let sent = 0;
    for (const res of this.streams) {
      try {
        res.write(payload);
        sent += 1;
      } catch {
        this.streams.delete(res);
      }
    }
    return sent;
  }

  /**
   * Whether a request may use the local management subtree.
   *
   * Three gates, of which only the token is a secret. The address checks are
   * defence in depth: they catch a bind that was widened by accident, and a
   * request that crossed the edge proxy, without either being something an
   * attacker can satisfy.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {boolean} loopback - whether the socket peer is loopback.
   * @returns {string | null} a denial reason, or null when the caller is local.
   */
  #localDenial(req, loopback) {
    if (!loopback) return 'not-loopback';
    // A request that reached us through the edge proxy is a remote caller by
    // definition, whatever its socket says. This is what actually closes the
    // tunnel-shaped hole; the token closes the rest.
    const forwarded = edgeForwardedFor(req);
    if (forwarded && !isLoopbackAddress(forwarded)) return 'edge-proxied';
    if (!this.localToken) return 'no-token';
    const presented = String(req.headers[LOCAL_TOKEN_HEADER] ?? '').trim();
    if (!presented || !constantTimeEqual(presented, this.localToken)) return 'bad-token';
    return null;
  }

  /**
   * Route one request.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves when the response is handled.
   */
  async #handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method ?? 'GET').toUpperCase();
    const source = String(req.socket.remoteAddress ?? 'unknown');
    const loopback = isLoopbackAddress(source);
    // Rate-limit by what the edge saw, not by the socket: behind the tunnel
    // every caller shares one loopback address.
    const identity = clientIdentity(req, source);
    const phoneAuthority = String(req.headers.host ?? 'localhost');

    // Resolve the caller once, from either credential form: the pairing token
    // (bootstrap) or the signed session cookie (everything after).
    const credentials = deviceCredentials(req);
    const tokenAuth = this.access.authenticate({ ...credentials, source: identity });
    const sessionDeviceId = tokenAuth.ok ? null : this.verifySession(sessionCookieOf(req));
    const device = tokenAuth.ok
      ? tokenAuth.device
      : sessionDeviceId
        ? { id: sessionDeviceId, label: this.access.devices.get(sessionDeviceId)?.label ?? '手机' }
        : null;

    // The root is the harness GUI once paired, and the pairing page before that.
    // Serving the GUI shell to an unpaired caller would leak nothing directly,
    // but it would advertise the surface; the pairing page is the honest answer.
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      if (device && this.gateway) {
        await this.gateway.proxyHttp(req, res, phoneAuthority);
        return;
      }
      sendText(res, 200, 'text/html', gateHtml({ realm: this.realm, exposed: this.exposed }));
      return;
    }
    if (method === 'GET' && path === '/pulse') {
      sendText(res, 200, 'text/html', indexHtml({ realm: this.realm, exposed: this.exposed }));
      return;
    }
    if (method === 'GET' && (path === '/pulse.js' || path === '/app.js')) {
      // no-store while the surface is still being iterated: a phone must never
      // run last week's client against this week's server.
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(pulseScript()),
        'cache-control': 'no-store, must-revalidate',
        'x-content-type-options': 'nosniff',
      });
      res.end(pulseScript());
      return;
    }
    if (method === 'GET' && (path === '/pulse.css' || path === '/app.css')) {
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'content-length': Buffer.byteLength(pulseStylesheet()),
        'cache-control': 'no-store, must-revalidate',
        'x-content-type-options': 'nosniff',
      });
      res.end(pulseStylesheet());
      return;
    }
    if (method === 'GET' && path === '/manifest.webmanifest') {
      sendText(res, 200, 'application/manifest+json', manifestJson({ realm: this.realm }));
      return;
    }
    if (method === 'GET' && path === '/sw.js') {
      // The push worker, not an offline shell: a cached service worker is the
      // classic way a deployed fix never reaches a device, so it is explicitly
      // uncacheable, and it installs no fetch handler.
      const worker = pushWorkerScript();
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(worker),
        'cache-control': 'no-store, must-revalidate',
        // A push worker must be allowed to control the whole origin scope.
        'service-worker-allowed': '/',
        'x-content-type-options': 'nosniff',
      });
      res.end(worker);
      return;
    }

    // Lock-screen notifications. The public key is not a secret; the
    // subscription it produces is a capability and is stored per device.
    if (path === '/api/push/key' && method === 'GET') {
      sendJson(res, 200, {
        supported: Boolean(this.push),
        ready: Boolean(this.push?.ready),
        publicKey: this.push?.publicKey ?? null,
      });
      return;
    }
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        ok: true,
        realm: this.realm,
        exposed: this.exposed,
        paired: this.access.roster().length,
        phones: this.streams.size,
        pendingDecisions: this.pendingDecisions().length,
        pairingOpen: this.access.pairingOpen,
        push: this.push?.status() ?? null,
      });
      return;
    }

    // The machine's own tooling manages pairing and the roster. Locality is
    // proven by a filesystem secret, not by the peer address — see
    // `local-token.js` for why the address cannot be trusted here.
    if (path === '/api/local' || path.startsWith('/api/local/')) {
      // Pulse owns this subtree outright — it must never reach the proxy,
      // because these are the endpoints that manage pairing itself.
      const denial = this.#localDenial(req, loopback);
      if (denial) {
        sendJson(res, 403, {
          error: denial,
          message:
            denial === 'not-loopback'
              ? '配对管理只能在本机操作'
              : '本机管理需要在请求头中携带本机管理令牌（x-pulse-local-token）。' +
                '令牌文件位于 DSH_HOME/remote-pulse/local-token；' +
                '可用 scripts/pair-qr.mjs 自动读取。',
        });
        return;
      }
      if (path === '/api/local/status' && method === 'GET') {
        sendJson(res, 200, {
          exposed: this.exposed,
          host: this.host,
          port: this.port,
          pairingOpen: this.access.pairingOpen,
          pairingExpiresAt: this.access.pairing?.expiresAt ?? null,
          devices: this.access.roster(),
          phones: this.streams.size,
        });
        return;
      }
      if (path === '/api/local/pairing' && method === 'POST') {
        const { code, expiresAt } = this.access.openPairing();
        sendJson(res, 200, { code, expiresAt });
        return;
      }
      if (path === '/api/local/pairing' && method === 'DELETE') {
        this.access.closePairing();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/api/local/devices' && method === 'GET') {
        sendJson(res, 200, { devices: this.access.roster() });
        return;
      }
      if (path.startsWith('/api/local/devices/') && method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/api/local/devices/'.length));
        const revoked = this.access.revoke(id);
        if (revoked) this.onDeviceRevoked(id);
        sendJson(res, 200, { ok: revoked });
        return;
      }
      if (path === '/api/local/devices' && method === 'DELETE') {
        for (const record of this.access.roster()) this.onDeviceRevoked(record.id);
        sendJson(res, 200, { revoked: this.access.revokeAll() });
        return;
      }
      sendJson(res, 404, { error: 'not-found', message: `没有这个本机接口：${path}` });
      return;
    }

    // Pairing is the one unauthenticated write: rate-limited, single-use, and
    // gated by the short-lived code only the desktop can mint. A successful
    // pairing also mints the signed session cookie, because the official GUI is
    // a plain browser client that cannot attach an Authorization header to its
    // own asset and RPC requests.
    if (path === '/api/pair' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = this.access.pair({
        code: body.code,
        label: body.label,
        source: identity,
      });
      if (!result.ok) {
        sendJson(res, result.reason === 'locked' ? 429 : 403, {
          error: result.reason,
          message: ACCESS_DENIED[result.reason] ?? '配对失败',
        });
        return;
      }
      const cookie = this.mintSession(result.id, phoneAuthority);
      res.setHeader(
        'set-cookie',
        `${SESSION_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 3600}`,
      );
      sendJson(res, 200, { deviceId: result.id, token: result.token, session: cookie });
      return;
    }

    // Everything below needs a live device, by either credential form.
    if (!device) {
      const reason = tokenAuth.reason ?? 'unknown-device';
      if (reason === 'unknown-device' && sessionDeviceId !== null) {
        // A cookie signed correctly but naming a revoked device: drop it so the
        // phone returns to the pairing page instead of looping on a dead session.
        res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
      }
      sendJson(res, reason === 'locked' ? 429 : 401, {
        error: reason,
        message: ACCESS_DENIED[reason] ?? '设备未授权',
      });
      return;
    }

    if (path === '/api/snapshot' && method === 'GET') {
      sendJson(res, 200, {
        ...this.snapshot(),
        decisions: this.pendingDecisions(),
        device: { id: device.id, label: device.label },
      });
      return;
    }

    // Diagnostics endpoint: the phone needs to be able to tell whether the
    // browser actually stored and returned its session cookie, because when it
    // does not, the symptom is indistinguishable from "the code was wrong" --
    // the device looks paired locally yet every request lands back on the gate.
    if (path === '/api/whoami' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        device: { id: device.id, label: device.label },
        credential: tokenAuth.ok ? 'device-token' : 'session-cookie',
        cookieReceived: Boolean(sessionCookieOf(req)),
        cookieName: SESSION_COOKIE,
      });
      return;
    }

    if (path === '/api/stream' && method === 'GET') {
      this.#openStream(req, res, url);
      return;
    }

    if (path === '/api/decisions' && method === 'GET') {
      sendJson(res, 200, { decisions: this.pendingDecisions() });
      return;
    }

    if (path === '/api/decisions/resolve' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = this.resolveDecision(String(body.id ?? ''), body.answer ?? {});
      sendJson(res, result.ok ? 200 : 409, result);
      this.broadcastDecisions();
      return;
    }

    // ---- artifacts ----------------------------------------------------------

    if (path === '/api/artifacts' && method === 'GET') {
      sendJson(res, 200, { artifacts: this.listArtifacts() });
      return;
    }

    // Serving file bytes is the one dangerous route here. The requested path is
    // never treated as an instruction: it is only honoured when it is already in
    // the recorded index, i.e. when the harness itself just produced it. There is
    // therefore no code path that opens a path chosen by the caller, which is a
    // stronger guarantee than validating one.
    if (path === '/api/artifacts/content' && method === 'GET') {
      const requested = url.searchParams.get('path') ?? '';
      const result = this.readArtifact(requested);
      if (!result.ok) {
        sendJson(res, result.reason === 'not-an-artifact' ? 403 : 404, {
          error: result.reason,
          message:
            result.reason === 'not-an-artifact'
              ? '只能读取 agent 刚生成的文件'
              : '这个文件读不到了（可能已被移动或删除）',
        });
        return;
      }
      const download = url.searchParams.get('download') === '1';
      const filename = requested.split(/[\\/]/).pop() ?? 'artifact';
      res.writeHead(200, {
        'content-type': result.contentType,
        'content-length': result.body.length,
        // Previews must never be stale: the agent may rewrite the file at any
        // moment, and a cached preview would show the previous version.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // Anything not rendered inline is handed over as a download, and an
        // SVG or HTML preview is never allowed to run as this origin.
        'content-disposition': `${download || result.kind === 'binary' ? 'attachment' : 'inline'}; filename="${filename.replace(/["\\]/g, '')}"`,
        'content-security-policy': "default-src 'none'; sandbox",
      });
      res.end(result.body);
      return;
    }

    if (path === '/api/instruct' && method === 'POST') {
      const body = await readJsonBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendJson(res, 400, { error: 'empty', message: '指令不能为空' });
        return;
      }
      const result = await this.instruct(text, body.sessionId ? String(body.sessionId) : undefined);
      sendJson(res, result.ok === false ? 409 : 200, result);
      return;
    }

    // ---- lock-screen notifications ------------------------------------------

    if (path === '/api/push/subscribe' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!this.push) {
        sendJson(res, 503, { error: 'push-unavailable', message: '本部署未启用 Web Push' });
        return;
      }
      const result = this.push.subscribe({
        subscription: body.subscription,
        deviceId: device.id,
        label: device.label,
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (path === '/api/push/unsubscribe' && method === 'POST') {
      const body = await readJsonBody(req);
      const removed = this.push ? this.push.unsubscribe(body.endpoint) : false;
      sendJson(res, 200, { ok: removed });
      return;
    }

    if (path === '/api/push/status' && method === 'GET') {
      sendJson(res, 200, {
        ...(this.push?.status() ?? { ready: false, subscriptions: 0 }),
        mine: (this.push?.roster() ?? []).filter(row => row.deviceId === device.id).length,
      });
      return;
    }

    // Everything else that belongs to the official GUI — its assets, its RPC
    // channel, its downloads — is proxied verbatim. This is the "same as the
    // desktop" path: the phone runs the real client, so it gains every feature
    // the desktop has without this plugin tracking the GUI's routes.
    if (this.gateway) {
      await this.gateway.proxyHttp(req, res, phoneAuthority);
      return;
    }

    sendJson(res, 404, { error: 'not-found', message: `没有这个接口：${path}` });
  }

  /**
   * Attach an SSE stream with replay, gap reporting, and heartbeats.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {URL} url - the parsed request URL.
   * @returns {void}
   */
  #openStream(req, res, url) {
    const sinceRaw = Number(url.searchParams.get('since') ?? '0');
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    const firstPhone = this.streams.size === 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Defensive: this stream is never meant to be buffered by a proxy.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const missed = this.replay(since);
    res.write(`event: hello\ndata: ${JSON.stringify({ gap: missed.gap, lastSeq: missed.lastSeq })}\n\n`);
    for (const frame of missed.frames) {
      res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
    }
    res.write(`event: decisions\ndata: ${JSON.stringify({ decisions: this.pendingDecisions() })}\n\n`);
    // The artifact list is part of the initial state too, so a phone that
    // reconnects does not have to ask for it separately.
    res.write(`event: artifacts\ndata: ${JSON.stringify({ artifacts: this.listArtifacts() })}\n\n`);

    this.streams.add(res);
    if (firstPhone) this.onPhoneConnected();

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    /** @returns {void} */
    const cleanup = () => {
      clearInterval(heartbeat);
      if (!this.streams.delete(res)) return;
      if (this.streams.size === 0) this.onPhoneDisconnected();
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }
}

export default PulseServer;
