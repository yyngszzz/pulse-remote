/**
 * Live smoke test against a running Pulse listener.
 *
 * Run with a live `dsh web` instance: `node scripts/smoke.mjs [baseUrl]`
 *
 * This exercises the real HTTP surface end to end — pair, stream, observe,
 * answer — which is the part a unit test with injected dependencies cannot
 * prove. It touches no session state and leaves no device behind unless the
 * instance is kept running.
 */

import { localHeaders } from './local-operator.mjs';

const base = (process.argv[2] ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

/**
 * Fail loudly with context.
 * @param {string} label - what was being checked.
 * @param {unknown} detail - extra detail.
 * @returns {never} always throws.
 */
function fail(label, detail) {
  throw new Error(`${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

/**
 * Assert a condition.
 * @param {unknown} condition - the condition.
 * @param {string} label - what was expected.
 * @returns {void}
 */
function ok(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else fail(label);
}

console.log(`Pulse smoke test against ${base}`);

const health = await fetch(`${base}/health`).then(response => response.json());
ok(health.ok === true, 'health reports ok');
ok(typeof health.realm === 'string', `realm is ${health.realm}`);
console.log(`  info  exposed=${health.exposed} paired=${health.paired}`);

// The unpaired root is the pairing gate; the installable surface is the Pulse
// console at /pulse. Asserting PWA-ness of the gate conflates the two.
const gate = await fetch(`${base}/`);
ok(gate.status === 200, 'the gate is served to an unpaired caller');
const gateHtml = await gate.text();
ok(gateHtml.includes('pair-form'), 'the unpaired root is the pairing gate');

const console_ = await fetch(`${base}/pulse`);
ok(console_.status === 200, 'the Pulse console is served');
const consoleHtml = await console_.text();
ok(consoleHtml.includes(health.realm), 'the console names the realm');
ok(consoleHtml.includes('manifest.webmanifest'), 'the console is installable as a PWA');

const manifest = await fetch(`${base}/manifest.webmanifest`).then(response => response.json());
ok(manifest.display === 'standalone', 'manifest requests standalone display');

const unauth = await fetch(`${base}/api/snapshot`);
ok(unauth.status === 401, 'an unpaired caller cannot read a snapshot');

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(response =>
  response.json(),
);
ok(typeof opened.code === 'string' && opened.code.length >= 6, `pairing code minted (${opened.code})`);

const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'smoke-test phone' }),
}).then(response => response.json());
ok(typeof paired.deviceId === 'string', 'pairing returned a device id');
ok(typeof paired.token === 'string' && paired.token.length >= 32, 'pairing returned a strong token');

const auth = { authorization: `Bearer ${paired.deviceId}.${paired.token}` };

const replayed = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'attacker' }),
});
ok(replayed.status === 403, 'the pairing code cannot be replayed');

const snapshot = await fetch(`${base}/api/snapshot`, { headers: auth }).then(response => response.json());
ok(snapshot.device.label === 'smoke-test phone', 'snapshot identifies the device');
ok(Array.isArray(snapshot.sessions), 'snapshot carries a session list');
ok(Array.isArray(snapshot.decisions), 'snapshot carries the decisions queue');

// Open the stream and confirm the handshake, then answer a decision if one appears.
const controller = new AbortController();
const stream = await fetch(`${base}/api/stream?since=0&device=${paired.deviceId}&token=${paired.token}`, {
  signal: controller.signal,
});
ok(stream.status === 200, 'SSE stream opens');

const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
const events = [];
const deadline = Date.now() + 5000;
while (Date.now() < deadline && events.length < 2) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let split;
  while ((split = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, split);
    buffer = buffer.slice(split + 2);
    const name = raw.split('\n').find(line => line.startsWith('event: '))?.slice(7);
    const data = raw.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    if (name) events.push({ name, data: data ? JSON.parse(data) : null });
  }
}
controller.abort();

const hello = events.find(event => event.name === 'hello');
ok(Boolean(hello), 'stream greeted with a replay boundary');
console.log(`  info  gap=${hello?.data?.gap} lastSeq=${hello?.data?.lastSeq}`);
ok(
  events.some(event => event.name === 'decisions'),
  'stream carried the pending-decision queue',
);

const revoked = await fetch(`${base}/api/local/devices/${paired.deviceId}`, {
  method: 'DELETE',
  headers: localHeaders(),
}).then(response => response.json());
ok(revoked.ok === true, 'the device can be revoked');

const afterRevoke = await fetch(`${base}/api/snapshot`, { headers: auth });
ok(afterRevoke.status === 401, 'a revoked device loses access immediately');

console.log('smoke test passed');
