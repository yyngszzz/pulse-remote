import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AccessControl,
  RateLimiter,
  constantTimeEqual,
  hashSecret,
  pairingCode,
  verifySecret,
} from '../lib/auth.js';

test('failed pairing attempts are limited by the identity the caller supplies', () => {
  const ac = new AccessControl({ maxFailures: 2 });
  ac.openPairing();
  assert.equal(ac.pair({ code: 'WRONGXXX', source: '203.0.113.9' }).reason, 'bad-code');
  assert.equal(ac.pair({ code: 'WRONGXXX', source: '203.0.113.9' }).reason, 'bad-code');
  assert.equal(ac.pair({ code: 'WRONGXXX', source: '203.0.113.9' }).reason, 'locked');
  // The lock is per-identity, so one caller's guessing cannot deny service to
  // everyone else. Behind the tunnel this is the whole point: every socket is
  // loopback, so keying on the socket would put the internet in one bucket.
  const { code } = ac.openPairing();
  assert.equal(ac.pair({ code, source: '198.51.100.7' }).ok, true);
});

test('a caller cannot spray device tokens without being locked out', () => {
  const ac = new AccessControl({ maxFailures: 3 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(ac.authenticate({ id: 'ghost', token: 'x', source: '198.51.100.7' }).ok, false);
  }
  assert.equal(ac.authenticate({ id: 'ghost', token: 'x', source: '198.51.100.7' }).reason, 'locked');
});

test('presenting no credentials is not counted as a failed guess', () => {
  // A paired phone authenticates with its session cookie and carries no bearer
  // credentials at all. Counting that as a failure locked out every honest
  // device after a handful of requests.
  const ac = new AccessControl({ maxFailures: 2 });
  for (let i = 0; i < 50; i += 1) {
    const result = ac.authenticate({ id: '', token: '', source: '127.0.0.1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-credentials');
  }
  // The bucket is still empty, so a real device can still authenticate.
  ac.openPairing();
  const { code } = ac.openPairing();
  const paired = ac.pair({ code, source: '127.0.0.1' });
  assert.equal(paired.ok, true);
  assert.equal(ac.authenticate({ id: paired.id, token: paired.token, source: '127.0.0.1' }).ok, true);
});

test('hashSecret never stores the plaintext and verifies only the right secret', () => {
  const stored = hashSecret('s3cret-token');
  assert.match(stored, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(stored.includes('s3cret-token'), false);
  assert.equal(verifySecret('s3cret-token', stored), true);
  assert.equal(verifySecret('s3cret-tokeN', stored), false);
  assert.equal(verifySecret('', stored), false);
});

test('hashSecret salts every record so identical secrets differ in storage', () => {
  const a = hashSecret('same');
  const b = hashSecret('same');
  assert.notEqual(a, b);
  assert.equal(verifySecret('same', a), true);
  assert.equal(verifySecret('same', b), true);
});

test('verifySecret rejects malformed stored values instead of throwing', () => {
  assert.equal(verifySecret('x', 'not-a-hash'), false);
  assert.equal(verifySecret('x', 'scrypt:only:two'), false);
  assert.equal(verifySecret('x', 'bcrypt:a:b'), false);
  assert.equal(verifySecret('x', undefined), false);
  assert.equal(verifySecret(undefined, hashSecret('x')), false);
});

test('pairingCode avoids characters that are misread aloud', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = pairingCode();
    assert.equal(code.length, 8);
    assert.doesNotMatch(code, /[O0I1]/);
  }
});

test('constantTimeEqual compares content, not just length', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('pairing succeeds once and the code is then consumed', () => {
  const ac = new AccessControl();
  const { code } = ac.openPairing();
  assert.equal(ac.pairingOpen, true);

  const first = ac.pair({ code, label: '我的手机', source: '1.2.3.4' });
  assert.equal(first.ok, true);
  assert.equal(ac.pairingOpen, false);

  const replay = ac.pair({ code, label: 'attacker', source: '5.6.7.8' });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'no-open-pairing');
});

test('the pairing code is case-insensitive and trimmed', () => {
  const ac = new AccessControl();
  const { code } = ac.openPairing();
  const result = ac.pair({ code: `  ${code.toLowerCase()}  `, source: '1.1.1.1' });
  assert.equal(result.ok, true);
});

test('an expired pairing code is refused', () => {
  let now = 1000;
  const ac = new AccessControl({ now: () => now, pairingTtlMs: 5000 });
  const { code } = ac.openPairing();
  now += 5001;
  assert.equal(ac.pairingOpen, false);
  assert.equal(ac.pair({ code, source: '1.1.1.1' }).reason, 'no-open-pairing');
});

test('a wrong pairing code counts toward the lockout', () => {
  const ac = new AccessControl({ maxFailures: 3 });
  ac.openPairing();
  assert.equal(ac.pair({ code: 'WRONGXXX', source: '9.9.9.9' }).reason, 'bad-code');
  assert.equal(ac.pair({ code: 'WRONGXXX', source: '9.9.9.9' }).reason, 'bad-code');
  assert.equal(ac.pair({ code: 'WRONGXXX', source: '9.9.9.9' }).reason, 'bad-code');
  // Fourth attempt is refused before the code is even examined.
  const locked = ac.pair({ code: 'WRONGXXX', source: '9.9.9.9' });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked');
  assert.equal(ac.failures.blocked('9.9.9.9'), true);
});

test('a valid token authenticates and refreshes last-seen', () => {
  let now = 1000;
  const ac = new AccessControl({ now: () => now });
  const { code } = ac.openPairing();
  const paired = ac.pair({ code, label: 'phone', source: '1.1.1.1' });
  assert.equal(paired.ok, true);

  now += 60_000;
  const auth = ac.authenticate({ id: paired.id, token: paired.token, source: '1.1.1.1' });
  assert.equal(auth.ok, true);
  assert.equal(auth.device.lastSeenAt, now);
});

test('a wrong or missing token is refused', () => {
  const ac = new AccessControl();
  const { code } = ac.openPairing();
  const paired = ac.pair({ code, source: '1.1.1.1' });
  assert.equal(ac.authenticate({ id: paired.id, token: 'wrong', source: '1.1.1.1' }).ok, false);
  assert.equal(ac.authenticate({ id: paired.id, token: paired.token, source: '1.1.1.1' }).ok, true);
  assert.equal(ac.authenticate({ id: 'ghost', token: paired.token, source: '1.1.1.1' }).reason, 'unknown-device');
  assert.equal(ac.authenticate({ id: paired.id, source: '1.1.1.1' }).ok, false);
});

test('revoking a device invalidates its token at once', () => {
  const ac = new AccessControl();
  const { code } = ac.openPairing();
  const paired = ac.pair({ code, source: '1.1.1.1' });
  assert.equal(ac.revoke(paired.id), true);
  assert.equal(ac.revoke(paired.id), false);
  assert.equal(ac.authenticate({ id: paired.id, token: paired.token, source: '1.1.1.1' }).ok, false);
  assert.equal(ac.roster().length, 0);
});

test('revokeAll clears every device', () => {
  const ac = new AccessControl();
  for (let i = 0; i < 3; i += 1) {
    const { code } = ac.openPairing();
    assert.equal(ac.pair({ code, source: `10.0.0.${i}` }).ok, true);
  }
  assert.equal(ac.roster().length, 3);
  assert.equal(ac.revokeAll(), 3);
  assert.equal(ac.roster().length, 0);
});

test('the device limit is enforced', () => {
  const ac = new AccessControl({ maxDevices: 1 });
  const first = ac.openPairing();
  assert.equal(ac.pair({ code: first.code, source: 'a' }).ok, true);
  const second = ac.openPairing();
  assert.equal(ac.pair({ code: second.code, source: 'b' }).reason, 'device-limit');
});

test('round-tripping persistence keeps tokens working and stores no plaintext', () => {
  const ac = new AccessControl();
  const { code } = ac.openPairing();
  const paired = ac.pair({ code, label: 'iphone', source: '1.1.1.1' });

  const document = ac.toJSON();
  const serialized = JSON.stringify(document);
  assert.equal(serialized.includes(paired.token), false);

  const restored = new AccessControl();
  assert.equal(restored.load(document), 1);
  assert.equal(restored.authenticate({ id: paired.id, token: paired.token, source: '1.1.1.1' }).ok, true);
  assert.equal(restored.roster()[0].label, 'iphone');
});

test('load ignores malformed records instead of trusting them', () => {
  const ac = new AccessControl();
  assert.equal(ac.load({ devices: [{ id: 'ok', tokenHash: hashSecret('t') }, { id: 'bad' }, null, 'nope'] }), 1);
  assert.equal(ac.load(null), 0);
  assert.equal(ac.load({}), 0);
});

test('RateLimiter allows up to the budget then blocks within the window', () => {
  let now = 0;
  const limiter = new RateLimiter({ max: 3, windowMs: 1000, now: () => now });
  assert.equal(limiter.hit('k'), true);
  assert.equal(limiter.hit('k'), true);
  assert.equal(limiter.hit('k'), true);
  assert.equal(limiter.hit('k'), false);
  assert.equal(limiter.blocked('k'), true);
  now += 1001;
  assert.equal(limiter.blocked('k'), false);
  assert.equal(limiter.hit('k'), true);
});

test('RateLimiter keeps keys independent', () => {
  const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
  assert.equal(limiter.hit('a'), true);
  assert.equal(limiter.hit('a'), false);
  assert.equal(limiter.hit('b'), true);
});
