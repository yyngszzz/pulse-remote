/**
 * The local-operator token: proof that a caller is a process on this machine,
 * rather than a request that merely *arrived* as if it were.
 *
 * ## Why the peer address is not enough
 *
 * Pulse's supported deployment reaches this listener through an SSH reverse
 * tunnel (`ssh -R 3199:127.0.0.1:3199`) because the phone cannot route to a
 * home machine. The consequence is that **every** request through that tunnel
 * arrives from `127.0.0.1`, exactly like a genuine local process. A fence built
 * on `req.socket.remoteAddress` therefore admits the entire internet, and the
 * management subtree would let any stranger mint a pairing code and then pair a
 * device of their own.
 *
 * The fix is a secret that a tunnel cannot fabricate and that is never sent
 * over HTTP to a browser: a random token stored on the machine's filesystem,
 * readable only by the machine's user. Local tooling reads the file and presents
 * the token in a header; a remote caller has no way to obtain it.
 *
 * The token is deliberately **never** served by any HTTP route and never
 * rendered into a page. A page that carried it would hand it straight to the
 * tunnel.
 *
 * @module pulse-remote/local-token
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The header a local operator presents. */
export const LOCAL_TOKEN_HEADER = 'x-pulse-local-token';

/** Token shape: 32 random bytes, hex. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Path of the local-operator token inside the plugin's state directory.
 * @param {string} stateDir - the plugin state directory.
 * @returns {string} the absolute path.
 */
export function localTokenPath(stateDir) {
  return join(stateDir, 'local-token');
}

/**
 * Read the local-operator token, if one has been minted.
 * @param {string} stateDir - the plugin state directory.
 * @returns {string | null} the token, or null when absent or malformed.
 */
export function readLocalToken(stateDir) {
  try {
    const raw = readFileSync(localTokenPath(stateDir), 'utf8').trim();
    return TOKEN_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Read the on-disk local-operator token, minting and persisting one on first
 * use.
 *
 * Persisted rather than per-process so that a restart does not invalidate the
 * token a user's own scripts already hold, matching how the session key is
 * handled.
 *
 * @param {string} stateDir - the plugin state directory.
 * @param {object} [options] - tuning.
 * @param {(message: string) => void} [options.onWarn] - surfaced failures.
 * @returns {{token: string, path: string, persisted: boolean}} the token.
 */
export function loadOrCreateLocalToken(stateDir, options = {}) {
  const path = localTokenPath(stateDir);
  const existing = readLocalToken(stateDir);
  if (existing) return { token: existing, path, persisted: true };

  const token = randomBytes(32).toString('hex');
  try {
    mkdirSync(stateDir, { recursive: true });
    // Owner-only where the platform honours it. On Windows the mode is largely
    // advisory and the file inherits the user profile's ACL, which is still
    // scoped to the user.
    writeFileSync(path, token, { mode: 0o600 });
    return { token, path, persisted: true };
  } catch (error) {
    options.onWarn?.(
      `[remote-pulse] 本机管理令牌无法写入（${path}）：${error?.message ?? error}。` +
        '本机管理接口本次仍可使用，但重启后令牌会变化。',
    );
    // A token that could not be persisted still works for this process; the
    // management surface stays usable instead of silently locking the user out
    // of their own machine.
    return { token, path, persisted: false };
  }
}
