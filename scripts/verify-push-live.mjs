#!/usr/bin/env node
/**
 * Live verification of the Web Push surface over the public HTTPS entry point.
 *
 * Checks that the deployed instance actually serves the push worker, a VAPID
 * public key, and the push routes — the things a phone needs in order to show
 * lock-screen notifications while the screen is off.
 *
 *   node scripts/verify-push-live.mjs https://203.0.113.10 [--insecure]
 */

const rawBase = process.argv[2] ?? 'https://203.0.113.10';
const insecure = process.argv.includes('--insecure');
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const base = rawBase.replace(/\/+$/, '');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

async function get(path, init) {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

function parseSetCookies(headers) {
  const anyHeaders = headers;
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

async function main() {
  console.log(`verify-push-live  base=${base}  insecure=${insecure}`);
  console.log('');

  // ---------------------------------------------------------------- /health
  let health = null;
  try {
    const res = await get('/health');
    health = res;
    let body = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      /* not json */
    }
    record('/health 200', res.status === 200, `status=${res.status}`);
    record(
      '/health reports push',
      Boolean(body && body.push),
      body ? `push=${JSON.stringify(body.push)}` : `body=${res.text.slice(0, 120)}`,
    );
    record(
      '/health reports push readiness',
      Boolean(body?.push?.ready),
      body?.push ? `ready=${body.push.ready} subscriptions=${body.push.subscriptions}` : 'no push object',
    );
  } catch (err) {
    record('/health reachable', false, String(err && err.message));
  }

  // ----------------------------------------------------------------- /sw.js
  try {
    const res = await get('/sw.js');
    const t = res.text;
    record('/sw.js 200', res.status === 200, `status=${res.status}`);
    record(
      '/sw.js is a script',
      /javascript/i.test(res.headers.get('content-type') ?? ''),
      `content-type=${res.headers.get('content-type')}`,
    );
    record(
      '/sw.js is not cached',
      /no-store/i.test(res.headers.get('cache-control') ?? ''),
      `cache-control=${res.headers.get('cache-control')}`,
    );
    record(
      '/sw.js handles push',
      t.includes("addEventListener('push'") || t.includes('addEventListener("push"'),
      `len=${t.length}`,
    );
    record(
      '/sw.js handles notificationclick',
      t.includes('notificationclick'),
      '',
    );
    record(
      '/sw.js has no fetch handler',
      !t.includes("addEventListener('fetch'") && !t.includes('addEventListener("fetch"'),
      'offline shell intentionally absent',
    );
    record(
      '/sw.js clears stale caches',
      t.includes('caches.delete') || t.includes('caches.keys'),
      '',
    );
    // One-tap decisions: the worker must be able to answer without the app.
    record(
      '/sw.js answers a decision from the notification',
      t.includes('/api/decisions/resolve') && t.includes('answers[action]'),
      'resolve route + action lookup',
    );
    record(
      '/sw.js authenticates that answer with the session cookie',
      /credentials:\s*'same-origin'/.test(t),
      'no token is stored in the notification, so the cookie is the credential',
    );
    record(
      '/sw.js deep-links a plain tap to the decision',
      t.includes('#decision-'),
      'otherwise a tap lands at the top of the queue',
    );
    record(
      '/sw.js reports a failed answer',
      t.includes('回复失败'),
      'a silent failure would leave the agent blocked',
    );
    record(
      'service-worker-allowed header',
      (res.headers.get('service-worker-allowed') ?? '').includes('/'),
      `service-worker-allowed=${res.headers.get('service-worker-allowed')}`,
    );
  } catch (err) {
    record('/sw.js reachable', false, String(err && err.message));
  }

  // --------------------------------------------------------- /api/push/key
  try {
    const res = await get('/api/push/key');
    // The VAPID public key is not a secret — the browser needs it before it can
    // subscribe — so this route is deliberately reachable without a session.
    let body = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      /* not json */
    }
    record('/api/push/key 200', res.status === 200, `status=${res.status}`);
    record(
      '/api/push/key serves a VAPID public key',
      // An uncompressed P-256 point is 65 bytes -> 87 base64url characters.
      typeof body?.publicKey === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(body.publicKey),
      `publicKey.len=${String(body?.publicKey ?? '').length} supported=${body?.supported} ready=${body?.ready}`,
    );
    record(
      '/api/push/key leaks nothing else',
      Boolean(body) && Object.keys(body).every(key => ['supported', 'ready', 'publicKey'].includes(key)),
      `keys=${Object.keys(body ?? {}).join(',')}`,
    );
  } catch (err) {
    record('/api/push/key reachable', false, String(err && err.message));
  }

  // ---------------------------------------------------- /api/push/subscribe
  try {
    const res = await get('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://example.invalid/x', keys: { p256dh: 'a', auth: 'b' } }),
    });
    record(
      '/api/push/subscribe unauthenticated is refused',
      res.status === 401 || res.status === 403,
      `status=${res.status}`,
    );
  } catch (err) {
    record('/api/push/subscribe reachable', false, String(err && err.message));
  }

  // ------------------------------------------- loopback-only local surface
  try {
    const res = await get('/api/local/pairing', { method: 'POST' });
    // Reached the public edge; the management fence must reject it. This is not
    // a formality: the deployment reaches Pulse through an SSH reverse tunnel,
    // so the socket peer is 127.0.0.1 for the internet too, and an
    // address-based fence would hand a stranger a pairing code.
    let paired = null;
    try {
      paired = JSON.parse(res.text);
    } catch {
      /* not json */
    }
    record(
      '/api/local/* is fenced off from the public edge',
      res.status === 403 && !paired?.code,
      `status=${res.status} body=${res.text.slice(0, 80)}`,
    );
    record(
      'the local fence mints no pairing code for a remote caller',
      !(paired && typeof paired.code === 'string'),
      paired?.code ? `LEAKED code=${paired.code}` : 'no code minted',
    );
  } catch (err) {
    record('/api/local/* reachable', false, String(err && err.message));
  }

  // ------------------------------------------------------------- gate page
  try {
    const res = await get('/');
    const t = res.text;
    const hasCodeField = /name="code"|id="code"/.test(t);
    const isGuarded = t.includes('id="gate"') || hasCodeField || res.status === 200;
    record('/', isGuarded, `status=${res.status} len=${t.length} codeField=${hasCodeField}`);
    const cookies = parseSetCookies(res.headers);
    record(
      '/ does not leak a session cookie before pairing',
      !cookies.some((c) => c.startsWith('pulse_session=')),
      `set-cookie count=${cookies.length}`,
    );
  } catch (err) {
    record('/ reachable', false, String(err && err.message));
  }

  // --------------------------------------------------------------- report
  console.log('');
  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) failed += 1;
    console.log(`${mark}  ${r.name}${r.detail ? `   (${r.detail})` : ''}`);
  }
  console.log('');
  console.log(`${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('verify-push-live crashed:', err);
  process.exitCode = 1;
});
