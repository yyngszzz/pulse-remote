/**
 * Live verification of the phone remote.
 *
 * Run with a live `dsh web` instance: `node scripts/verify-remote.mjs [baseUrl]`
 *
 * It answers the only question that matters for this product: can a paired
 * phone actually reach and drive the real harness GUI? That means proving, over
 * real HTTP, that
 *
 *   1. an unpaired caller gets the pairing gate and never the GUI;
 *   2. pairing mints a session cookie and the official shell comes back through
 *      the proxy — with the GUI's own assets and API reachable behind it;
 *   3. the harness's own credential is never handed to the phone;
 *   4. revoking the device shuts the door immediately.
 */

import { localHeaders } from './local-operator.mjs';

const base = (process.argv[2] ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

/**
 * The origin used for local-operator calls.
 *
 * Management is a *different* origin from the phone's, by design: a request
 * that reaches Pulse through the public edge is refused the management subtree
 * even when it carries the correct token, because a token alone would make the
 * tunnel a transport for administration. So pairing is driven against the
 * loopback listener directly.
 */
const localBase = (
  process.env.PULSE_LOCAL_BASE ??
  (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(base) ? base : 'http://127.0.0.1:3199')
).replace(/\/+$/, '');

let failures = 0;

// A self-signed deployment (an IP with no domain) is a supported setup, so
// verification has to be able to talk to one. This is opt-in and prints a
// warning rather than being the default.
if (base.startsWith('https:')) {
  if (process.env.PULSE_INSECURE_TLS !== '1' && process.argv.includes('--insecure')) {
    process.env.PULSE_INSECURE_TLS = '1';
  }
  if (process.env.PULSE_INSECURE_TLS === '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log('  warn  TLS verification disabled (--insecure) for a self-signed host');
  }
}

/**
 * Assert a condition and report it.
 * @param {unknown} condition - the condition.
 * @param {string} label - what was expected.
 * @param {unknown} [detail] - extra context on failure.
 * @returns {void}
 */
function ok(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  }
}

console.log(`Pulse remote verification against ${base}`);

const health = await fetch(`${base}/health`).then(response => response.json());
ok(health.ok === true, 'the Pulse listener is up');
console.log(`  info realm=${health.realm} exposed=${health.exposed} paired=${health.paired}`);

// ---- 1. an unpaired caller is stopped at the gate --------------------------

const gate = await fetch(`${base}/`);
const gateBody = await gate.text();
ok(gate.status === 200, 'the unpaired root answers');
ok(/id="pair-form"/.test(gateBody), 'the unpaired root is the pairing gate');
ok(!/__DSH_BOOT__/.test(gateBody), 'the unpaired root does not leak the harness shell');

const unpairedAsset = await fetch(`${base}/assets/does-not-matter.js`);
ok(unpairedAsset.status === 401, 'an unpaired asset request is refused', unpairedAsset.status);

// ---- 1b. the management subtree is unreachable through the public edge ------
//
// The regression check for the tunnel-shaped hole. With `ssh -R` in play a
// remote caller's socket address is 127.0.0.1, so a fence built on the peer
// address would let any stranger mint a pairing code and then pair a device of
// their own. This sends the *correct* local token to the public origin, so a
// pass proves the refusal does not depend on the token being absent.

if (localBase !== base) {
  console.log(`  info local management origin = ${localBase}`);
  const stolenCode = await fetch(`${base}/api/local/pairing`, {
    method: 'POST',
    headers: localHeaders({ optional: true }),
  });
  ok(stolenCode.status === 403, 'the public edge refuses to mint a pairing code', stolenCode.status);

  const stolenRoster = await fetch(`${base}/api/local/devices`, {
    headers: localHeaders({ optional: true }),
  });
  ok(stolenRoster.status === 403, 'the public edge refuses the device roster', stolenRoster.status);

  const stolenStatus = await fetch(`${base}/api/local/status`, {
    headers: localHeaders({ optional: true }),
  });
  ok(stolenStatus.status === 403, 'the public edge refuses the local status view', stolenStatus.status);
}

// ---- 2. pair, then reach the real GUI --------------------------------------

const opened = await fetch(`${localBase}/api/local/pairing`, {
  method: 'POST',
  headers: localHeaders(),
}).then(response => response.json());
ok(typeof opened.code === 'string', `pairing code minted (${opened.code})`);

const pairResponse = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'verify-remote' }),
});
const paired = await pairResponse.json();
ok(pairResponse.status === 200, 'pairing succeeded', paired);
const setCookie = pairResponse.headers.get('set-cookie') ?? '';
const sessionCookie = setCookie.split(';')[0];
ok(/pulse_session=/.test(sessionCookie), 'pairing minted a phone session cookie');
ok(/HttpOnly/.test(setCookie), 'the session cookie is HttpOnly');

// The phone now behaves like the official client: cookie only, no headers.
const shell = await fetch(`${base}/`, { headers: { cookie: sessionCookie } });
const shellBody = await shell.text();
ok(shell.status === 200, 'the paired root answers', shell.status);

// The decisive assertion: this is the real harness GUI, not a reimplementation.
// The shells are large and boot-tagged; the pairing gate is neither.
ok(/__DSH_BOOT__/.test(shellBody), 'the paired root serves the real harness GUI shell');
ok(shellBody.length > 5000, 'the served shell is the full harness document', shellBody.length);
ok(!/id="pair-form"/.test(shellBody), 'the paired root is not the pairing gate');
if (!/__DSH_BOOT__/.test(shellBody)) console.log(`  info shell head: ${shellBody.slice(0, 300)}`);

// The GUI's own API must work through the proxy, cookie only.
const innerApi = await fetch(`${base}/api/settings`, { headers: { cookie: sessionCookie } });
ok(
  innerApi.status !== 401 && innerApi.status !== 403,
  'the harness API is reachable through the proxy',
  innerApi.status,
);
console.log(`  info /api/settings -> ${innerApi.status}`);

// ---- 3. the harness credential never reaches the phone ---------------------

ok(!/browser-session_?127\.0\.0\.1/.test(setCookie), 'the harness session cookie is not forwarded');
ok(
  ![...shell.headers.entries()].some(([name, value]) => name === 'set-cookie' && /127\.0\.0\.1/.test(value)),
  'no loopback-named cookie is handed to the phone',
);

// ---- 4. Pulse's own layer still works, and revocation is immediate ---------

const console_ = await fetch(`${base}/pulse`, { headers: { cookie: sessionCookie } });
ok(console_.status === 200, 'the Pulse console is still served');
const snapshot = await fetch(`${base}/api/snapshot`, { headers: { cookie: sessionCookie } }).then(response =>
  response.json(),
);
ok(snapshot.device?.label === 'verify-remote', 'the snapshot identifies this device');
ok(Array.isArray(snapshot.artifacts), 'the snapshot carries the artifact list');

// ---- 4b. the artifact centre -----------------------------------------------
//
// The content route serves file bytes, so the property to prove is that a path
// the agent did not produce is refused over the real deployment — not merely in
// a unit test with an injected index.

const artifacts = await fetch(`${base}/api/artifacts`, { headers: { cookie: sessionCookie } }).then(response =>
  response.json(),
);
ok(Array.isArray(artifacts.artifacts), 'the artifact list is reachable by a paired phone', artifacts);

const artifactUnauth = await fetch(`${base}/api/artifacts`);
ok(artifactUnauth.status === 401, 'an unpaired caller cannot list artifacts', artifactUnauth.status);

const stolen = await fetch(
  `${base}/api/artifacts/content?path=${encodeURIComponent('/etc/passwd')}`,
  { headers: { cookie: sessionCookie } },
);
ok(stolen.status === 403, 'a file the agent did not produce is refused', stolen.status);
const stolenBody = await stolen.text();
ok(!/root:x:/.test(stolenBody), 'the refusal carries no file content');

const traversal = await fetch(
  `${base}/api/artifacts/content?path=${encodeURIComponent('../../../../etc/passwd')}`,
  { headers: { cookie: sessionCookie } },
);
ok(traversal.status === 403, 'a traversing path is refused', traversal.status);

const noPath = await fetch(`${base}/api/artifacts/content`, { headers: { cookie: sessionCookie } });
ok(noPath.status === 403, 'a missing path parameter is refused rather than defaulted', noPath.status);

const revoked = await fetch(`${localBase}/api/local/devices/${paired.deviceId}`, {
  method: 'DELETE',
  headers: localHeaders(),
}).then(response => response.json());
ok(revoked.ok === true, 'the device can be revoked');

const afterRevokeShell = await fetch(`${base}/`, { headers: { cookie: sessionCookie } });
const afterRevokeBody = await afterRevokeShell.text();
ok(/id="pair-form"/.test(afterRevokeBody), 'a revoked device falls back to the pairing gate');
ok(
  !/__DSH_BOOT__/.test(afterRevokeBody),
  'a revoked device can no longer reach the harness GUI',
);

const afterRevokeApi = await fetch(`${base}/api/settings`, { headers: { cookie: sessionCookie } });
ok(afterRevokeApi.status === 401, 'a revoked device cannot call the harness API', afterRevokeApi.status);

console.log(failures === 0 ? '\nverification passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
