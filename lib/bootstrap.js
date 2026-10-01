/**
 * Loopback credential bootstrap ??the piece that lets a paired phone drive the
 * real DeepSeek Harness Web GUI.
 *
 * The official GUI is gated by a browser-session cookie: an HMAC-signed,
 * authority-bound token minted when a browser presents the process launch token
 * at `GET /?token=??. The launch token itself is a process secret that
 * `connection.authenticatedUrl()` discloses once, to the machine's own user.
 *
 * That gives this plugin a sanctioned, non-privileged path:
 *
 * 1. Ask the harness for its own root URL bearing the launch token.
 * 2. Redeem it **from loopback**, rewriting `Host`/`Origin` to the inner
 *    authority, so the minted cookie is bound to exactly the authority the
 *    proxy will keep presenting.
 * 3. Hold that cookie in memory and attach it to every proxied request.
 *
 * Two properties matter and are asserted in tests:
 *
 * - **The launch token never reaches the phone.** Only this process sees a
 *   token-bearing URL; the browser only ever receives the signed cookie.
 * - **A revoked device gets nothing.** The credential is reused server-side and
 *   is never handed out, so the pairing gate in front of it is the only way in.
 *
 * @module dsh-remote-pulse/bootstrap
 */

/** Refresh a little before the real expiry so a request never races it. */
const REFRESH_MARGIN_MS = 60_000;

/** The launch-token query parameter the harness expects. */
const TOKEN_QUERY = 'token';

/**
 * Parse one `Set-Cookie` header value into its name/value and deadline.
 * @param {string} raw - the header value.
 * @param {number} now - current time.
 * @returns {{name: string, value: string, expiresAt: number} | null} the parsed cookie.
 */
export function parseSetCookie(raw, now) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const segments = raw.split(';');
  const first = segments[0];
  const at = first.indexOf('=');
  if (at <= 0) return null;
  const name = first.slice(0, at).trim();
  const value = first.slice(at + 1).trim();
  if (!name || !value) return null;

  let expiresAt = now + 30 * 24 * 60 * 60_000;
  for (const segment of segments.slice(1)) {
    const [rawKey, ...rest] = segment.split('=');
    const key = rawKey.trim().toLowerCase();
    const attribute = rest.join('=').trim();
    if (key === 'max-age') {
      const seconds = Number(attribute);
      if (Number.isFinite(seconds)) expiresAt = now + Math.max(0, seconds) * 1000;
    } else if (key === 'expires') {
      const parsed = Date.parse(attribute);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }
  return { name, value, expiresAt };
}

/**
 * Build the header bag for a loopback request to the harness.
 *
 * `host` and `origin` are rewritten to the inner authority because the cookie
 * the harness mints is signed over the authority it observed ??presenting a
 * phone's authority would produce a cookie that authenticates nothing.
 *
 * @param {object} options - request shaping.
 * @param {string} options.authority - inner `host:port` authority.
 * @param {string} [options.cookie] - cookie header to present.
 * @returns {Record<string, string>} headers.
 */
export function loopbackHeaders({ authority, cookie }) {
  const headers = {
    host: authority,
    origin: `http://${authority}`,
    referer: `http://${authority}/`,
    // A trusted same-origin signal, so the harness's cross-site write fence
    // admits the proxied request exactly as it would admit the desktop tab.
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'user-agent': 'dsh-remote-pulse/0.1 (loopback proxy)',
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

/**
 * Holds the loopback browser-session credential for the life of the process.
 */
export class CredentialBootstrap {
  /**
   * @param {object} options - wiring.
   * @param {() => string | null} options.authenticatedUrl - returns the harness
   *   root URL bearing the process launch token, or null when unavailable.
   * @param {string | (() => string)} options.authority - inner `host:port` to
   *   present. A function is resolved per use, because the harness's real port
   *   is only known once the injected `webServer` service is available, while
   *   this holder is constructed earlier.
   * @param {() => number} [options.now] - clock, injectable for tests.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {(message: string) => void} [options.onWarn] - diagnostics sink.
   */
  constructor(options) {
    this.authenticatedUrl = options.authenticatedUrl;
    this.authoritySource = options.authority;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onWarn = options.onWarn ?? (() => {});

    /** @type {{name: string, value: string, expiresAt: number} | null} */
    this.cookie = null;
    /** @type {Promise<boolean> | null} an in-flight redemption, so callers coalesce. */
    this.inFlight = null;
    /** How many times the credential has been minted, for diagnostics. */
    this.redemptions = 0;
    /** The last failure, surfaced in status output. */
    this.lastError = null;
  }

  /**
   * The inner authority, resolved from the live service when it is a function.
   * @returns {string} `host:port`.
   */
  get authority() {
    const source = this.authoritySource;
    return typeof source === 'function' ? String(source()) : String(source);
  }

  /** @returns {boolean} whether a live credential is held. */
  get ready() {
    return this.cookie !== null && this.cookie.expiresAt - REFRESH_MARGIN_MS > this.now();
  }

  /**
   * The cookie header to present, or undefined when none is held.
   * @returns {string | undefined} the `Cookie` header value.
   */
  header() {
    return this.cookie ? `${this.cookie.name}=${this.cookie.value}` : undefined;
  }

  /**
   * Ensure a live credential is held, redeeming one when necessary.
   *
   * Concurrent callers share a single redemption, so a burst of proxied
   * requests after a restart mints one cookie rather than a dozen.
   *
   * @returns {Promise<boolean>} whether a credential is now usable.
   */
  async ensure() {
    if (this.ready) return true;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#redeem().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Redeem the launch token from loopback and capture the minted cookie.
   * @returns {Promise<boolean>} whether redemption succeeded.
   */
  async #redeem() {
    let url;
    try {
      url = this.authenticatedUrl();
    } catch (error) {
      this.lastError = `authenticatedUrl failed: ${error?.message ?? error}`;
      this.onWarn(`[remote-pulse] ${this.lastError}`);
      return false;
    }
    if (!url) {
      this.lastError = 'the harness connection service is unavailable';
      this.onWarn(`[remote-pulse] ${this.lastError}`);
      return false;
    }

    // Present the token ourselves against the inner authority. The harness
    // answers 303 + Set-Cookie, which is exactly the exchange a first desktop
    // visit performs ??no private API is involved.
    const redeemUrl = new URL(url);
    redeemUrl.protocol = 'http:';
    redeemUrl.hostname = this.authority.split(':')[0];
    const port = this.authority.split(':')[1];
    if (port) redeemUrl.port = port;
    redeemUrl.pathname = '/';

    try {
      const response = await this.fetchImpl(redeemUrl.href, {
        method: 'GET',
        redirect: 'manual',
        headers: loopbackHeaders({ authority: this.authority }),
      });

      const raw = response.headers.getSetCookie?.() ?? [];
      const allCookies = raw.length > 0 ? raw : [response.headers.get('set-cookie')].filter(Boolean);
      for (const value of allCookies) {
        const parsed = parseSetCookie(value, this.now());
        if (!parsed) continue;
        this.cookie = parsed;
        this.redemptions += 1;
        this.lastError = null;
        return true;
      }

      this.lastError = `no session cookie in the redemption response (HTTP ${response.status})`;
      this.onWarn(`[remote-pulse] ${this.lastError}`);
      return false;
    } catch (error) {
      this.lastError = `redemption request failed: ${error?.message ?? error}`;
      this.onWarn(`[remote-pulse] ${this.lastError}`);
      return false;
    }
  }

  /**
   * Read the harness's served shell through this credential.
   *
   * Used both as a liveness probe and to hand the shell to a phone, so the
   * proxy never needs to guess the inner routes.
   *
   * @param {string} path - inner request path including any query.
   * @returns {Promise<Response | null>} the upstream response, or null on failure.
   */
  async fetchInner(path) {
    if (!(await this.ensure())) return null;
    try {
      return await this.fetchImpl(`http://${this.authority}${path}`, {
        method: 'GET',
        headers: loopbackHeaders({ authority: this.authority, cookie: this.header() }),
      });
    } catch (error) {
      this.lastError = `proxied request failed: ${error?.message ?? error}`;
      return null;
    }
  }

  /** @returns {void} drop the credential so the next request re-mints it. */
  invalidate() {
    this.cookie = null;
  }

  /** @returns {object} status for diagnostics. */
  status() {
    return {
      ready: this.ready,
      redemptions: this.redemptions,
      cookieName: this.cookie?.name ?? null,
      expiresAt: this.cookie?.expiresAt ?? null,
      lastError: this.lastError,
    };
  }
}

export { TOKEN_QUERY, REFRESH_MARGIN_MS };
export default CredentialBootstrap;
