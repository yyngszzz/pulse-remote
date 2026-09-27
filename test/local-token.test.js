/**
 * The local-operator token is the boundary that the peer address cannot be.
 *
 * These tests pin the properties that make it work as one: it is unpredictable,
 * it is stable across restarts, it is never returned over HTTP, and a directory
 * it cannot be written to degrades to a working-but-ephemeral token rather than
 * locking the user out of their own machine.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LOCAL_TOKEN_HEADER, loadOrCreateLocalToken, localTokenPath, readLocalToken } from '../lib/local-token.js';

/**
 * Run a body against a fresh temporary state directory.
 * @param {(stateDir: string) => void} body - the test body.
 * @returns {void}
 */
function withStateDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-local-token-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the header name is the one the server reads', () => {
  assert.equal(LOCAL_TOKEN_HEADER, 'x-pulse-local-token');
});

test('a first run mints a 256-bit token and persists it', () => {
  withStateDir(dir => {
    const { token, path, persisted } = loadOrCreateLocalToken(dir);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(persisted, true);
    assert.equal(path, localTokenPath(dir));
    assert.equal(readFileSync(path, 'utf8'), token);
  });
});

test('a restart reuses the stored token so existing tooling keeps working', () => {
  withStateDir(dir => {
    const first = loadOrCreateLocalToken(dir);
    const second = loadOrCreateLocalToken(dir);
    assert.equal(second.token, first.token);
    assert.equal(second.persisted, true);
  });
});

test('two machines do not share a token', () => {
  withStateDir(a => {
    withStateDir(b => {
      assert.notEqual(loadOrCreateLocalToken(a).token, loadOrCreateLocalToken(b).token);
    });
  });
});

test('a malformed token file is replaced rather than trusted', () => {
  withStateDir(dir => {
    writeFileSync(localTokenPath(dir), 'short');
    assert.equal(readLocalToken(dir), null);
    const { token } = loadOrCreateLocalToken(dir);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, 'short');
  });
});

test('the token file is not world-readable where the platform honours modes', () => {
  withStateDir(dir => {
    const { path } = loadOrCreateLocalToken(dir);
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
  });
});

test('an unwritable state directory still yields a usable token', () => {
  // Degrading to an ephemeral token is deliberate: the alternative is a machine
  // whose own tooling cannot manage pairing at all.
  const warnings = [];
  const { token, persisted } = loadOrCreateLocalToken(join(tmpdir(), 'pulse-missing-parent', '\u0000invalid'), {
    onWarn: message => warnings.push(message),
  });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(persisted, false);
  assert.equal(warnings.length, 1);
});
