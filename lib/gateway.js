/**
 * The header that turns a host file read into a download, when we asked for one.
 *
 * The harness's own file route answers with the raw bytes and no disposition, which
 * a browser displays rather than saves. It understands no download parameter, so the
 * marker `download=1` is ours: this adds the header for exactly the requests the
 * shell generated, and for nothing else.
 *
 * This exists because the obvious alternative was wrong. Routing downloads through
 * the plugin's own artifact route restricts them to paths the agent wrote — so a file
 * built by a script, an APK for instance, answered 403 while the client could open it
 * perfectly well. Reading through the host's own route means anything the client can
 * open can also be saved, under exactly the host's own permissions.
 *
 * @param {string} url - the request URL.
 * @returns {string | null} the header value, or null when this is not our download.
 */
export function downloadDisposition(url) {
  let parsed;
  try {
    parsed = new URL(url, 'http://localhost');
  } catch {
    return null;
  }
  if (parsed.pathname !== '/api/file') return null;
  if (parsed.searchParams.get('download') !== '1') return null;
  const target = parsed.searchParams.get('path') ?? '';
  const name = target.split(/[\\/]/).pop() || 'download';
  return `attachment; filename="${name.replace(/["\\]/g, '')}"`;
}

/**
 * The loopback gateway: what turns "a phone that gets notifications" into "a
 * phone that can drive the harness".
 *
 * It forwards the phone's requests to the harness's own Web GUI on loopback,
 * carrying the credential from {@link CredentialBootstrap}, and forwards the
 * harness's responses — including the WebSocket upgrade the GUI's live session
 * needs — back to the phone.
 *
 * Header handling is the whole game, and each rule exists for a reason:
 *
 * - `host` / `origin` are rewritten to the **inner** authority. The harness's
 *   browser-session cookie is signed over the authority it observed and its
 *   `/api` fence admits loopback literals, so presenting the phone's authority
 *   would fail both checks.
 * - The phone's `cookie` is dropped and replaced by the proxy's credential. Two
 *   reasons: the phone's cookie is bound to the phone's authority and would
 *   authenticate nothing, and this keeps the harness's own credential from
 *   round-tripping through a device.
 * - `Set-Cookie` names are rewritten from the inner authority back to the
 *   phone's authority, so a cookie the harness mints mid-session is stored by
 *   the phone's browser under the name it will actually send.
 * - Responses stream rather than buffer: SSE and long-lived downloads must not
 *   be held, and a phone on a slow link must not make the desktop's harness
 *   allocate the whole body.
 *
 * What this deliberately does **not** do: it never forwards a request that
 * failed the pairing gate, and it exposes no route that can reach the harness
 * without the credential it holds server-side. An unpaired caller cannot even
 * learn whether the harness is up.
 *
 * @module dsh-remote-pulse/gateway
 */

import { request as httpRequest } from 'node:http';

/** Hop-by-hop headers that must not be copied across a proxy hop. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Rewrite a `Set-Cookie` header so the browser stores it under the authority it
 * actually used, rather than the inner loopback authority.
 *
 * @param {string} raw - the upstream header value.
 * @param {string} phoneAuthority - the authority the phone addressed.
 * @returns {string} the rewritten header value.
 */
export function rewriteSetCookie(raw, phoneAuthority) {
  if (typeof raw !== 'string' || !phoneAuthority) return raw;
  const phoneHost = phoneAuthority.split(':')[0];
  return raw.replace(/^([^=]+)=/, (whole, name) => {
    // The harness derives its cookie name from the request authority, so the
    // loopback literal in the name is exactly what has to be renamed.
    const renamed = name.trim().replace(/127\.0\.0\.1/g, phoneHost);
    return `${renamed}=`;
  });
}

/**
 * Whether a header may be forwarded to the upstream harness.
 * @param {string} name - lowercase header name.
 * @returns {boolean} true when it may be forwarded.
 */
function forwardable(name) {
  if (HOP_BY_HOP.has(name)) return false;
  // These are rewritten or replaced wholesale.
  return !['host', 'origin', 'referer', 'cookie', 'authorization', 'content-length'].includes(name);
}

/**
 * Build the upstream header bag for one proxied request.
 *
 * @param {object} options - shaping options.
 * @param {Record<string, unknown>} options.incoming - the phone's headers.
 * @param {string} options.authority - inner `host:port`.
 * @param {string | undefined} options.cookie - the proxy's credential header.
 * @returns {Record<string, string | string[]>} upstream headers.
 */
export function upstreamHeaders({ incoming, authority, cookie }) {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (!forwardable(name)) continue;
    headers[name] = value;
  }
  headers.host = authority;
  headers.origin = `http://${authority}`;
  headers.referer = `http://${authority}/`;
  headers['sec-fetch-site'] = 'same-origin';
  if (cookie) headers.cookie = cookie;
  return headers;
}

/**
 * Reverse proxy from the paired phone to the harness's loopback Web GUI.
 */
export class LoopbackGateway {
  /**
   * @param {object} options - wiring.
   * @param {import('./bootstrap.js').CredentialBootstrap} options.bootstrap - credential holder.
   * @param {string | (() => string)} options.authority - inner `host:port`. A
   *   function is resolved per request, because the harness's real port is only
   *   known once the injected `webServer` service is available.
   * @param {(message: string) => void} [options.onWarn] - diagnostics sink.
   * @param {typeof httpRequest} [options.requestImpl] - injectable for tests.
   */
  constructor(options) {
    this.bootstrap = options.bootstrap;
    this.authoritySource = options.authority;
    this.onWarn = options.onWarn ?? (() => {});
    this.requestImpl = options.requestImpl ?? httpRequest;
  }

  /**
   * The inner authority, resolved from the live service when it is a function.
   * @returns {string} `host:port`.
   */
  get authority() {
    const source = this.authoritySource;
    return typeof source === 'function' ? String(source()) : String(source);
  }

  /** @returns {string} the inner host. */
  get host() {
    return this.authority.split(':')[0];
  }

  /** @returns {number} the inner port. */
  get port() {
    return Number(this.authority.split(':')[1]) || 80;
  }

  /**
   * Proxy one HTTP request, streaming both directions.
   *
   * @param {import('node:http').IncomingMessage} req - the phone's request.
   * @param {import('node:http').ServerResponse} res - the phone's response.
   * @param {string} phoneAuthority - the authority the phone addressed.
   * @returns {Promise<void>} resolves when the response has been handed over.
   */
  async proxyHttp(req, res, phoneAuthority) {
    if (!(await this.bootstrap.ensure())) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Pulse: cannot reach the local harness (credential redemption failed)');
      return;
    }

    const headers = upstreamHeaders({
      incoming: req.headers,
      authority: this.authority,
      cookie: this.bootstrap.header(),
    });
    // A proxied browser request is same-origin with itself; keep the length the
    // phone declared so uploads are not truncated.
    if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];

    // Asked for before the response is handed over, because the header has to be
    // set before the first byte is written — and it can be, without buffering.
    const disposition = downloadDisposition(req.url);

    await new Promise(resolve => {
      // One settle path, called from every way this can end. A promise that never resolves
      // leaks more than a socket: it keeps the request, its response and the upstream
      // connection reachable for the life of the process.
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let upstream = null;
      upstream = this.requestImpl(
        { host: this.host, port: this.port, method: req.method, path: req.url, headers },
        inner => {
          const out = { ...inner.headers };
          delete out.connection;
          delete out['keep-alive'];
          if (disposition) out['content-disposition'] = disposition;
          const cookies = inner.headers['set-cookie'];
          if (cookies) {
            out['set-cookie'] = (Array.isArray(cookies) ? cookies : [cookies]).map(value =>
              rewriteSetCookie(value, phoneAuthority),
            );
          }
          if (inner.statusCode === 401) {
            // The credential went stale mid-flight; drop it so the next request
            // re-mints rather than looping on a dead cookie.
            this.bootstrap.invalidate();
          }
          res.writeHead(inner.statusCode ?? 502, out);
          inner.pipe(res);
          inner.on('end', done);
          // An upstream that dies mid-response has to take the phone's side with it, or the
          // phone waits forever for a body that stopped coming.
          inner.on('aborted', () => {
            res.destroy();
            upstream.destroy();
            done();
          });
          inner.on('error', () => {
            res.destroy();
            upstream.destroy();
            done();
          });
        },
      );

      upstream.on('error', error => {
        this.onWarn(`[remote-pulse] upstream error: ${error?.message ?? error}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('Pulse: the local harness did not answer');
        } else {
          res.destroy();
        }
        done();
      });

      // A client that leaves mid-response takes the upstream with it. Without this the
      // upstream connection stays ESTABLISHED for the life of the process: measured on the
      // real thing, two connections and two handles per phone page load, climbing linearly
      // (458 -> 530 over 36 loads) and never coming back after the page is closed. That is how
      // a process ends up **holding its port while answering nothing**, which is exactly the
      // 2026-09-29 outage: phone unreachable, GUI unloadable, `dsh web` refused with EADDRINUSE
      // until the machine was rebooted.
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
        done();
      });
      // ... and the same for a request body that never finished arriving.
      req.on('error', () => {
        upstream.destroy();
        done();
      });
      req.on('close', () => {
        if (!req.readableEnded) upstream.destroy();
        done();
      });

      // Preserve the request body, including streamed uploads.
      req.pipe(upstream);
    });
  }

  /**
   * Proxy a WebSocket upgrade. The GUI's live session rides this, so a silent
   * failure here shows up as a GUI that renders but never updates.
   *
   * @param {import('node:http').IncomingMessage} req - the upgrade request.
   * @param {import('node:stream').Duplex} socket - the phone's raw socket.
   * @param {Buffer} head - any bytes already read.
   * @param {string} phoneAuthority - the authority the phone addressed.
   * @returns {Promise<void>} resolves once the tunnel is established or refused.
   */
  async proxyUpgrade(req, socket, head, phoneAuthority) {
    if (!(await this.bootstrap.ensure())) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }

    const headers = upstreamHeaders({
      incoming: req.headers,
      authority: this.authority,
      cookie: this.bootstrap.header(),
    });
    // `forwardable` strips hop-by-hop headers, but the upgrade handshake IS
    // those headers; they must be restored explicitly or Node never treats the
    // request as an upgrade and the harness never sees one.
    headers.connection = 'Upgrade';
    headers.upgrade = String(req.headers.upgrade ?? 'websocket');

    const upstream = this.requestImpl({
      host: this.host,
      port: this.port,
      method: req.method,
      path: req.url,
      headers,
    });

    upstream.on('upgrade', (inner, innerSocket, innerHead) => {
      const lines = [`HTTP/1.1 ${inner.statusCode ?? 101} ${inner.statusMessage ?? 'Switching Protocols'}`];
      for (const [name, value] of Object.entries(inner.headers)) {
        if (value === undefined) continue;
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (innerHead?.length) socket.write(innerHead);
      if (head?.length) innerSocket.write(head);

      // The tunnel is opaque from here: pump bytes and stop interpreting.
      innerSocket.pipe(socket);
      socket.pipe(innerSocket);
      const teardown = () => {
        innerSocket.destroy();
        socket.destroy();
      };
      innerSocket.on('error', teardown);
      socket.on('error', teardown);
      innerSocket.on('close', () => socket.destroy());
      socket.on('close', () => innerSocket.destroy());
    });

    // A refused upgrade arrives as an ordinary response, not an error.
    upstream.on('response', inner => {
      const lines = [`HTTP/1.1 ${inner.statusCode ?? 502} ${inner.statusMessage ?? 'Bad Gateway'}`];
      for (const [name, value] of Object.entries(inner.headers)) {
        if (value === undefined) continue;
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      inner.pipe(socket);
      // The same discipline the upgrade path has: whoever finishes first takes the other down.
      // This branch used to end at `pipe`, so a refused upgrade leaked both sockets — the same
      // shape of leak as the one measured at two connections per page load.
      inner.on('close', () => socket.destroy());
      inner.on('error', () => socket.destroy());
      socket.on('close', () => inner.destroy());
    });

    upstream.on('error', error => {
      this.onWarn(`[remote-pulse] upgrade failed: ${error?.message ?? error}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    socket.on('error', () => upstream.destroy());
    // An upgrade carries no body, but the request is only flushed once `end()`
    // is called; without it the handshake is created and never sent.
    upstream.end();
    void phoneAuthority;
  }
}

export default LoopbackGateway;
