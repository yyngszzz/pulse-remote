/**
 * Device pairing and access control for the phone surface.
 *
 * Security posture, stated plainly because this surface can approve tool calls
 * on the user's machine:
 *
 * - The phone surface is served by its own listener that defaults to loopback.
 *   Nothing here makes the desktop GUI's API reachable; only the distilled
 *   frame stream, the pending-decision queue, and the instruction endpoint.
 * - Every request outside loopback needs a device token. Tokens are stored as
 *   salted scrypt hashes: a leaked settings file does not hand over a live
 *   credential.
 * - Pairing is a short-lived, single-use code. It is consumed on first success,
 *   so an observed QR code cannot be replayed.
 * - Comparison is constant-time, and repeated failures lock the source address
 *   with a sliding window, so guessing is not a strategy.
 *
 * @module dsh-remote-pulse/auth
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

/** Sliding-window rate limiter over arbitrary string keys. */
export class RateLimiter {
  /**
   * @param {object} [options] - tuning.
   * @param {number} [options.windowMs] - window length.
   * @param {number} [options.max] - allowed hits per window.
   * @param {() => number} [options.now] - clock.
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.max = options.max ?? 30;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, number[]>} hit timestamps by key. */
    this.hits = new Map();
  }

  /**
   * Record a hit and report whether the key is still within budget.
   * @param {string} key - the throttling key.
   * @returns {boolean} true when allowed, false when rate-limited.
   */
  hit(key) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter(at => at > cutoff);
    list.push(now);
    this.hits.set(key, list);
    return list.length <= this.max;
  }

  /**
   * Whether the key is currently blocked, without recording a hit.
   * @param {string} key - the throttling key.
   * @returns {boolean} true when blocked.
   */
  blocked(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter(at => at > cutoff);
    return list.length >= this.max;
  }

  /** @returns {void} */
  reset() {
    this.hits.clear();
  }
}

/**
 * Hash a secret with a per-record salt, so two identical tokens do not collide
 * in storage and a stolen file cannot be compared against a dictionary.
 * @param {string} secret - the plaintext secret.
 * @param {string} [salt] - existing salt to reuse.
 * @returns {string} `scrypt:<salt>:<hash>`.
 */
export function hashSecret(secret, salt) {
  const useSalt = salt ?? randomBytes(16).toString('hex');
  const derived = scryptSync(String(secret), useSalt, 32).toString('hex');
  return `scrypt:${useSalt}:${derived}`;
}

/**
 * Constant-time verification of a secret against a stored hash.
 * @param {string} secret - the presented plaintext.
 * @param {string} stored - a value produced by {@link hashSecret}.
 * @returns {boolean} whether they match.
 */
export function verifySecret(secret, stored) {
  if (typeof stored !== 'string' || typeof secret !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  let actual;
  try {
    actual = scryptSync(secret, salt, 32).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Characters used for pairing codes: unambiguous when read aloud or typed. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generate a human-transcribable pairing code.
 * @param {number} [length] - code length.
 * @returns {string} the code.
 */
export function pairingCode(length = 8) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Generate an opaque device token.
 * @returns {string} a 256-bit hex token.
 */
export function deviceToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Device/pairing state. Persistence is the caller's business.
 *
 * ## On addresses
 *
 * This class deliberately knows nothing about loopback. It rate-limits by
 * whatever identity the caller supplies, because the *meaning* of an address is
 * a deployment question that belongs to the server: the supported deployment
 * arrives through an SSH reverse tunnel, where a remote attacker and the
 * machine's own user are both `127.0.0.1`. An earlier exemption for loopback
 * callers therefore disabled brute-force protection entirely in production,
 * while doing nothing for anyone else.
 */
export class AccessControl {
  /**
   * @param {object} [options] - tuning.
   * @param {() => number} [options.now] - clock.
   * @param {number} [options.pairingTtlMs] - how long a pairing code lives.
   * @param {number} [options.maxFailures] - failures before an address is locked.
   * @param {number} [options.failureWindowMs] - failure window.
   * @param {number} [options.maxDevices] - paired devices allowed at once.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    // Long enough for the realistic path: copy the link out of a chat app,
    // switch to a real browser, and type the code. Five minutes is routinely
    // too short for that, and an expired code looks exactly like a broken one.
    this.pairingTtlMs = options.pairingTtlMs ?? 30 * 60_000;
    this.maxDevices = options.maxDevices ?? 12;
    /** @type {{code: string, expiresAt: number}|null} the live pairing code. */
    this.pairing = null;
    /** @type {Map<string, object>} device id → record. */
    this.devices = new Map();
    this.failures = new RateLimiter({
      windowMs: options.failureWindowMs ?? 15 * 60_000,
      max: options.maxFailures ?? 8,
      now: this.now,
    });
  }

  /**
   * Mint a fresh pairing code, invalidating any previous one.
   * @returns {{code: string, expiresAt: number}} the code and its deadline.
   */
  openPairing() {
    const expiresAt = this.now() + this.pairingTtlMs;
    const code = pairingCode();
    this.pairing = { code, expiresAt };
    return { code, expiresAt };
  }

  /**
   * Whether a usable pairing code is currently open.
   * @returns {boolean} true when open.
   */
  get pairingOpen() {
    return Boolean(this.pairing) && this.pairing.expiresAt > this.now();
  }

  /** @returns {void} */
  closePairing() {
    this.pairing = null;
  }

  /**
   * Exchange a pairing code for a device token. The code is single-use.
   * @param {object} request - `{code, label, source}`.
   * @returns {{ok: true, id: string, token: string}|{ok: false, reason: string}} the result.
   */
  pair(request) {
    const source = String(request.source ?? 'unknown');
    if (this.failures.blocked(source)) return { ok: false, reason: 'locked' };
    const open = this.pairing;
    if (!open || open.expiresAt <= this.now()) return { ok: false, reason: 'no-open-pairing' };
    const presented = String(request.code ?? '').trim().toUpperCase();
    if (!constantTimeEqual(presented, open.code)) {
      this.failures.hit(source);
      return { ok: false, reason: 'bad-code' };
    }
    if (this.devices.size >= this.maxDevices) return { ok: false, reason: 'device-limit' };

    const id = randomBytes(9).toString('hex');
    const token = deviceToken();
    const record = {
      id,
      label: String(request.label ?? '').slice(0, 80) || '手机',
      tokenHash: hashSecret(token),
      createdAt: this.now(),
      lastSeenAt: this.now(),
      revokedAt: null,
    };
    this.devices.set(id, record);
    // A pairing code is one shot: a screenshot of the QR is worthless after use.
    this.closePairing();
    return { ok: true, id, token };
  }

  /**
   * Authenticate a presented device token.
   * @param {object} request - `{id, token, source}`.
   * @returns {{ok: true, device: object}|{ok: false, reason: string}} the result.
   */
  authenticate(request) {
    const source = String(request.source ?? 'unknown');
    const id = String(request.id ?? '');
    const token = String(request.token ?? '');
    // Presenting nothing is not a guess. A paired phone authenticates with its
    // session cookie and carries no bearer credentials at all, so counting this
    // as a failure would lock every honest device out after a few requests.
    if (!id && !token) return { ok: false, reason: 'no-credentials' };
    if (this.failures.blocked(source)) return { ok: false, reason: 'locked' };
    const record = this.devices.get(id);
    if (!record || record.revokedAt) {
      this.failures.hit(source);
      return { ok: false, reason: 'unknown-device' };
    }
    if (!verifySecret(token, record.tokenHash)) {
      this.failures.hit(source);
      return { ok: false, reason: 'bad-token' };
    }
    record.lastSeenAt = this.now();
    return { ok: true, device: record };
  }

  /**
   * Revoke one device immediately.
   * @param {string} id - device id.
   * @returns {boolean} whether a live device was revoked.
   */
  revoke(id) {
    const record = this.devices.get(id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = this.now();
    this.devices.delete(id);
    return true;
  }

  /**
   * Revoke every device.
   * @returns {number} how many were revoked.
   */
  revokeAll() {
    const count = this.devices.size;
    this.devices.clear();
    return count;
  }

  /** @returns {Array<object>} the device roster, safe for display. */
  roster() {
    return [...this.devices.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(record => ({
        id: record.id,
        label: record.label,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
      }));
  }

  /**
   * Serialize for persistence. Only hashes are stored, never tokens.
   * @returns {object} the state document.
   */
  toJSON() {
    return {
      version: 1,
      devices: [...this.devices.values()].map(record => ({
        id: record.id,
        label: record.label,
        tokenHash: record.tokenHash,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
      })),
    };
  }

  /**
   * Restore from a persisted document.
   * @param {object} document - a value previously returned by {@link toJSON}.
   * @returns {number} how many devices were restored.
   */
  load(document) {
    this.devices.clear();
    const rows = Array.isArray(document?.devices) ? document.devices : [];
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || typeof row.tokenHash !== 'string') continue;
      this.devices.set(row.id, {
        id: row.id,
        label: String(row.label ?? '手机'),
        tokenHash: row.tokenHash,
        createdAt: Number(row.createdAt) || this.now(),
        lastSeenAt: Number(row.lastSeenAt) || this.now(),
        revokedAt: null,
      });
    }
    return this.devices.size;
  }
}

/**
 * Compare two strings without leaking length-independent timing.
 * @param {string} a - first value.
 * @param {string} b - second value.
 * @returns {boolean} whether they are equal.
 */
export function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export default AccessControl;
