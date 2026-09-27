import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AccessControl } from '../lib/auth.js';
import { ArtifactIndex, readArtifact } from '../lib/artifacts.js';
import { FrameRing } from '../lib/ring.js';
import { PulseServer } from '../lib/server.js';

/** Signing key for the test's phone-session cookies. */
const SESSION_SECRET = 'test-session-secret';

/**
 * The local-operator token the harness hands the server.
 *
 * Locality cannot be inferred from the peer address here. The supported
 * deployment reaches the listener through an SSH reverse tunnel, so a remote
 * attacker and the machine's own user both arrive from 127.0.0.1; a secret that
 * only lives on the machine's filesystem is what actually separates them.
 */
const LOCAL_TOKEN = 'test-local-operator-token';

/** Headers that identify a genuine local operator. */
const LOCAL_HEADERS = { 'x-pulse-local-token': LOCAL_TOKEN };

/**
 * Sign a phone session cookie exactly as the plugin does.
 * @param {string} deviceId - the device.
 * @returns {string} the cookie value.
 */
function signSession(deviceId) {
  const payload = Buffer.from(JSON.stringify({ d: deviceId }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
}

/**
 * Verify a phone session cookie.
 *
 * Mirrors the plugin's rule in both halves: the signature must hold **and** the
 * device must still be on the roster, because a correctly signed cookie for a
 * device the user revoked must not resurrect access.
 *
 * @param {AccessControl} access - the roster to consult.
 * @param {string} cookie - the presented value.
 * @returns {string | null} the device id, or null.
 */
function verifySession(access, cookie) {
  if (typeof cookie !== 'string' || !cookie.includes('.')) return null;
  const [payload, mac] = cookie.split('.');
  if (!payload || !mac) return null;
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (mac !== expected) return null;
  try {
    const deviceId = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.d ?? null;
    return deviceId && access.devices.has(deviceId) ? deviceId : null;
  } catch {
    return null;
  }
}

/**
 * Bring up a real listener on an OS-assigned loopback port with a frame ring and
 * a decision stub, so the tests exercise the actual HTTP and SSE surface.
 */
async function harness(options = {}) {
  const access = new AccessControl();
  const ring = new FrameRing({ capacity: 100 });
  const artifacts = new ArtifactIndex();
  const decisions = [];
  const resolved = [];
  const instructed = [];
  const minted = [];
  let connected = 0;
  let disconnected = 0;

  const server = new PulseServer({
    access,
    host: '127.0.0.1',
    port: 0,
    realm: 'Pulse',
    replay: since => {
      const { frames, gap, lastSeq } = ring.since(since);
      return { frames, gap, lastSeq };
    },
    snapshot: () => ({ sessions: [{ sessionId: 's1', running: true, startedAt: Date.now() }], lastSeq: ring.lastSeq }),
    pendingDecisions: () => decisions.map(({ resolve, ...rest }) => rest),
    listArtifacts: () => artifacts.list(),
    readArtifact: path => readArtifact(artifacts, path),
    resolveDecision: (id, answer) => {
      const entry = decisions.find(candidate => candidate.id === id);
      if (!entry) return { ok: false, reason: 'unknown-or-settled' };
      resolved.push({ id, answer });
      decisions.splice(decisions.indexOf(entry), 1);
      return { ok: true, decision: { id } };
    },
    instruct: async (text, sessionId) => {
      instructed.push({ text, sessionId });
      return { ok: true, sessionId: sessionId ?? 's1' };
    },
    // The server only mints/verifies through these seams; the real signing
    // lives in the plugin, so the test supplies an equivalent.
    mintSession: deviceId => {
      const cookie = signSession(deviceId);
      minted.push(cookie);
      return cookie;
    },
    verifySession: cookie => verifySession(access, cookie),
    onPhoneConnected: () => {
      connected += 1;
    },
    onPhoneDisconnected: () => {
      disconnected += 1;
    },
    localToken: LOCAL_TOKEN,
    ...options,
  });

  const bound = await server.listen();
  const base = `http://127.0.0.1:${bound.port}`;

  /**
   * Pair one device and return its credentials.
   * @param {string} label - device label.
   * @returns {Promise<{id: string, token: string, headers: object}>} the credentials.
   */
  const pair = async label => {
    const { code } = access.openPairing();
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label }),
    });
    const body = await res.json();
    return {
      id: body.deviceId,
      token: body.token,
      headers: { authorization: `Bearer ${body.deviceId}.${body.token}` },
    };
  };

  return {
    server,
    ring,
    access,
    artifacts,
    base,
    pair,
    localHeaders: LOCAL_HEADERS,
    decisions,
    resolved,
    instructed,
    minted,
    counts: () => ({ connected, disconnected }),
    close: () => server.close(),
  };
}

/**
 * Open a persistent SSE reader. The reader must outlive individual event reads:
 * one TCP chunk routinely carries several events, and re-acquiring a reader per
 * event would discard the rest of the buffer.
 * @param {ReadableStream<Uint8Array>} stream - the response body.
 * @returns {{next: (name: string, timeoutMs?: number) => Promise<object>}} the reader.
 */
function sseReader(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    /**
     * Wait for the next event of a given name.
     * @param {string} name - the event name.
     * @param {number} [timeoutMs] - how long to wait.
     * @returns {Promise<object>} the parsed data.
     */
    async next(name, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const lines = raw.split('\n');
          const eventLine = lines.find(line => line.startsWith('event: '));
          const dataLine = lines.find(line => line.startsWith('data: '));
          if (eventLine?.slice(7) === name) return dataLine ? JSON.parse(dataLine.slice(6)) : {};
        }
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before "${name}" arrived`);
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error(`timed out waiting for "${name}"`);
    },
  };
}

test('the root is a pairing gate, and the console lives at /pulse', async () => {
  const h = await harness();
  try {
    // An unpaired root must not hand out the console that assumes a credential.
    const gate = await fetch(`${h.base}/`);
    assert.equal(gate.status, 200);
    assert.match(gate.headers.get('content-type'), /text\/html/);
    const gateHtml = await gate.text();
    assert.match(gateHtml, /<title>连接 Pulse<\/title>/);
    assert.match(gateHtml, /id="pair-form"/);
    assert.doesNotMatch(gateHtml, /id="composer"/, 'the gate must not expose the console');

    const console = await fetch(`${h.base}/pulse`);
    assert.equal(console.status, 200);
    const consoleHtml = await console.text();
    assert.match(consoleHtml, /<title>Pulse<\/title>/);
    assert.match(consoleHtml, /href="\/"/, 'the console links into the full interface');

    assert.equal((await fetch(`${h.base}/pulse.js`)).status, 200);
    assert.equal((await fetch(`${h.base}/pulse.css`)).status, 200);
    assert.equal((await fetch(`${h.base}/sw.js`)).status, 200);

    const manifest = await (await fetch(`${h.base}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, 'Pulse');
    assert.equal(manifest.display, 'standalone');

    const health = await (await fetch(`${h.base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.exposed, false);
    assert.equal(health.paired, 0);
  } finally {
    await h.close();
  }
});

test('pairing mints a signed session cookie that authenticates later requests', async () => {
  const h = await harness();
  try {
    const { code } = h.access.openPairing();
    const paired = await fetch(`${h.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'cookie-phone' }),
    });
    assert.equal(paired.status, 200);
    const body = await paired.json();
    const setCookie = paired.headers.get('set-cookie');
    assert.match(setCookie, /pulse_session=/);
    assert.match(setCookie, /HttpOnly/);

    // The official GUI's own requests carry only the cookie, so the cookie
    // alone must be sufficient authority.
    const snapshot = await fetch(`${h.base}/api/snapshot`, {
      headers: { cookie: setCookie.split(';')[0] },
    });
    assert.equal(snapshot.status, 200);
    const data = await snapshot.json();
    assert.equal(data.device.label, 'cookie-phone');

    // A tampered cookie is refused.
    const [name, value] = setCookie.split(';')[0].split('=');
    const forged = await fetch(`${h.base}/api/snapshot`, {
      headers: { cookie: `${name}=${value.slice(0, -4)}AAAA` },
    });
    assert.equal(forged.status, 401);

    // A correctly signed cookie for a revoked device must not resurrect access.
    h.access.revoke(body.deviceId);
    const afterRevoke = await fetch(`${h.base}/api/snapshot`, {
      headers: { cookie: setCookie.split(';')[0] },
    });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await h.close();
  }
});

test('whoami distinguishes a session cookie from a device token', async () => {
  const h = await harness();
  try {
    const { code } = h.access.openPairing();
    const paired = await fetch(`${h.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'whoami' }),
    });
    const body = await paired.json();
    const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0];

    // With the cookie: the browser stored it, which is what the GUI depends on.
    const viaCookie = await fetch(`${h.base}/api/whoami`, { headers: { cookie } });
    assert.equal(viaCookie.status, 200);
    const cookieInfo = await viaCookie.json();
    assert.equal(cookieInfo.ok, true);
    assert.equal(cookieInfo.credential, 'session-cookie');
    assert.equal(cookieInfo.cookieReceived, true);
    assert.equal(cookieInfo.device.label, 'whoami');

    // With the token only: the app can still talk, but the cookie is missing —
    // exactly the state that makes a paired phone bounce back to the gate.
    const viaToken = await fetch(`${h.base}/api/whoami`, {
      headers: { authorization: `Bearer ${body.deviceId}.${body.token}` },
    });
    const tokenInfo = await viaToken.json();
    assert.equal(tokenInfo.credential, 'device-token');
    assert.equal(tokenInfo.cookieReceived, false);
  } finally {
    await h.close();
  }
});

test('an unpaired caller cannot use whoami', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.base}/api/whoami`)).status, 401);
  } finally {
    await h.close();
  }
});

test('a paired caller reaches the gateway instead of a 404', async () => {
  const proxied = [];
  const h = await harness({
    gateway: {
      proxyHttp: async (req, res) => {
        proxied.push(req.url);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>official shell</body></html>');
      },
      proxyUpgrade: async () => {},
    },
  });
  try {
    const device = await h.pair('phone');
    const shell = await fetch(`${h.base}/`, { headers: device.headers });
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /official shell/);

    // Any unclaimed path is the GUI's, not a Pulse 404.
    const asset = await fetch(`${h.base}/assets/index-abc.js`, { headers: device.headers });
    assert.equal(asset.status, 200);
    assert.deepEqual(proxied, ['/', '/assets/index-abc.js']);

    // An unpaired caller never reaches the gateway.
    const unpaired = await fetch(`${h.base}/assets/index-abc.js`);
    assert.equal(unpaired.status, 401);
    assert.equal(proxied.length, 2);
  } finally {
    await h.close();
  }
});

test('an unpaired caller is refused on every data endpoint', async () => {
  const h = await harness();
  try {
    for (const path of ['/api/snapshot', '/api/decisions', '/api/stream']) {
      const res = await fetch(`${h.base}${path}`);
      assert.equal(res.status, 401, `${path} must require a device token`);
      const body = await res.json();
      // A caller that presents nothing is told it presented nothing; that is
      // also why it does not burn a brute-force strike (see auth.test.js).
      assert.equal(body.error, 'no-credentials');
    }
    const post = await fetch(`${h.base}/api/instruct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(post.status, 401);
  } finally {
    await h.close();
  }
});

test('an unknown route is a 404 with a clear body', async () => {
  const h = await harness();
  try {
    const device = await h.pair('phone');
    const res = await fetch(`${h.base}/api/nope`, { headers: device.headers });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not-found');
  } finally {
    await h.close();
  }
});

test('pairing mints a working credential and refuses a replayed code', async () => {
  const h = await harness();
  try {
    const { code } = h.access.openPairing();
    const first = await fetch(`${h.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: '我的手机' }),
    });
    assert.equal(first.status, 200);
    const { deviceId, token } = await first.json();
    assert.ok(deviceId && token);

    const replay = await fetch(`${h.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'attacker' }),
    });
    assert.equal(replay.status, 403);
    assert.equal((await replay.json()).error, 'no-open-pairing');

    const snapshot = await fetch(`${h.base}/api/snapshot`, {
      headers: { authorization: `Bearer ${deviceId}.${token}` },
    });
    assert.equal(snapshot.status, 200);
    const body = await snapshot.json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.device.label, '我的手机');
  } finally {
    await h.close();
  }
});

test('a malformed pairing request is rejected without crashing', async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'internal');
    // The listener is still healthy afterwards.
    assert.equal((await fetch(`${h.base}/health`)).status, 200);
  } finally {
    await h.close();
  }
});

test('the SSE stream replays missed frames and then carries live ones', async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    const device = await h.pair('phone');
    // Two frames the phone has not seen.
    h.ring.push({ sessionId: 's1', kind: 'activity', text: '读取 a.ts', ts: Date.now(), severity: 0 });
    h.ring.push({ sessionId: 's1', kind: 'activity', text: '读取 b.ts', ts: Date.now(), severity: 0 });

    const res = await fetch(`${h.base}/api/stream?since=0&device=${device.id}&token=${device.token}`, {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const sse = sseReader(res.body);
    const hello = await sse.next('hello');
    assert.equal(hello.gap, false);
    assert.equal(hello.lastSeq, 2);

    const first = await sse.next('frame');
    assert.equal(first.text, '读取 a.ts');
    assert.equal(first.seq, 1);

    const second = await sse.next('frame');
    assert.equal(second.text, '读取 b.ts');
    assert.equal(second.seq, 2);

    // A frame published after the stream opened must arrive live.
    h.server.broadcast(
      h.ring.push({ sessionId: 's1', kind: 'activity', text: '执行命令 npm test', ts: Date.now(), severity: 0 }),
    );
    const live = await sse.next('frame');
    assert.equal(live.text, '执行命令 npm test');
    assert.equal(live.seq, 3);
  } finally {
    controller.abort();
    await h.close();
  }
});

test('the initial decisions snapshot is pushed on connect', async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    const device = await h.pair('phone');
    h.decisions.push({ id: 'd1', type: 'approval', sessionId: 's1', title: '允许？', options: [], state: 'pending' });
    const res = await fetch(`${h.base}/api/stream?since=0&device=${device.id}&token=${device.token}`, {
      signal: controller.signal,
    });
    const sse = sseReader(res.body);
    await sse.next('hello');
    const decisions = await sse.next('decisions');
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].id, 'd1');
  } finally {
    controller.abort();
    await h.close();
  }
});

test('a reader behind the retained window is told about the gap', async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    const device = await h.pair('phone');
    for (let i = 0; i < 150; i += 1) {
      h.ring.push({ sessionId: 's1', kind: 'activity', text: `f${i}`, ts: Date.now(), severity: 0 });
    }
    const res = await fetch(`${h.base}/api/stream?since=1&device=${device.id}&token=${device.token}`, {
      signal: controller.signal,
    });
    const sse = sseReader(res.body);
    const hello = await sse.next('hello');
    assert.equal(hello.gap, true);
  } finally {
    controller.abort();
    await h.close();
  }
});

test('phone presence is tracked for the decision gate', async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    const device = await h.pair('phone');
    assert.equal(h.server.hasLivePhone, false);
    const res = await fetch(`${h.base}/api/stream?since=0&device=${device.id}&token=${device.token}`, {
      signal: controller.signal,
    });
    await sseReader(res.body).next('hello');
    assert.equal(h.server.hasLivePhone, true);
    assert.equal(h.counts().connected, 1);
    controller.abort();
    // Give the server a tick to observe the close.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(h.server.hasLivePhone, false);
    assert.equal(h.counts().disconnected, 1);
  } finally {
    controller.abort();
    await h.close();
  }
});

test('the decision queue is listed and a phone answer is recorded', async () => {
  const h = await harness();
  try {
    const device = await h.pair('phone');
    h.decisions.push({
      id: 'd1',
      type: 'approval',
      sessionId: 's1',
      title: '允许执行 npm publish？',
      options: ['allowed-once', 'rejected'],
      state: 'pending',
    });

    const list = await (await fetch(`${h.base}/api/decisions`, { headers: device.headers })).json();
    assert.equal(list.decisions.length, 1);
    assert.equal(list.decisions[0].title, '允许执行 npm publish？');

    const resolved = await fetch(`${h.base}/api/decisions/resolve`, {
      method: 'POST',
      headers: { ...device.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'd1', answer: { outcome: 'allowed-once' } }),
    });
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).ok, true);
    assert.deepEqual(h.resolved, [{ id: 'd1', answer: { outcome: 'allowed-once' } }]);

    // Answering twice is a conflict, not a silent success.
    const again = await fetch(`${h.base}/api/decisions/resolve`, {
      method: 'POST',
      headers: { ...device.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'd1', answer: { outcome: 'rejected' } }),
    });
    assert.equal(again.status, 409);
  } finally {
    await h.close();
  }
});

test('an instruction is delivered to the target session', async () => {
  const h = await harness();
  try {
    const device = await h.pair('phone');
    const res = await fetch(`${h.base}/api/instruct`, {
      method: 'POST',
      headers: { ...device.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '把测试跑一遍', sessionId: 's1' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(h.instructed, [{ text: '把测试跑一遍', sessionId: 's1' }]);
  } finally {
    await h.close();
  }
});

test('an empty instruction is refused before it reaches the agent', async () => {
  const h = await harness();
  try {
    const device = await h.pair('phone');
    const res = await fetch(`${h.base}/api/instruct`, {
      method: 'POST',
      headers: { ...device.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(res.status, 400);
    assert.equal(h.instructed.length, 0);
  } finally {
    await h.close();
  }
});

test('a revoked device loses access on its next request', async () => {
  const h = await harness();
  try {
    const device = await h.pair('phone');
    assert.equal((await fetch(`${h.base}/api/snapshot`, { headers: device.headers })).status, 200);
    h.access.revoke(device.id);
    const after = await fetch(`${h.base}/api/snapshot`, { headers: device.headers });
    assert.equal(after.status, 401);
  } finally {
    await h.close();
  }
});

test('the local operator token manages pairing and the device roster', async () => {
  const h = await harness();
  try {
    const opened = await fetch(`${h.base}/api/local/pairing`, { method: 'POST', headers: h.localHeaders });
    assert.equal(opened.status, 200);
    const { code } = await opened.json();
    assert.equal(typeof code, 'string');
    assert.equal(h.access.pairingOpen, true);

    const status = await (await fetch(`${h.base}/api/local/status`, { headers: h.localHeaders })).json();
    assert.equal(status.pairingOpen, true);
    assert.equal(status.exposed, false);

    const paired = await fetch(`${h.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'desk-phone' }),
    });
    if (paired.status !== 200) {
      // Surface the server's own explanation rather than a bare status diff.
      throw new Error(`pair failed: ${paired.status} ${await paired.text()}`);
    }
    const { deviceId } = await paired.json();

    const roster = await (await fetch(`${h.base}/api/local/devices`, { headers: h.localHeaders })).json();
    assert.equal(roster.devices.length, 1);
    assert.equal(roster.devices[0].label, 'desk-phone');

    const revoked = await (
      await fetch(`${h.base}/api/local/devices/${deviceId}`, { method: 'DELETE', headers: h.localHeaders })
    ).json();
    assert.equal(revoked.ok, true);
    assert.equal(
      (await (await fetch(`${h.base}/api/local/devices`, { headers: h.localHeaders })).json()).devices.length,
      0,
    );
  } finally {
    await h.close();
  }
});

test('the management subtree refuses a caller with no local operator token', async () => {
  const h = await harness();
  try {
    // The peer address here *is* loopback — as it also is for every request
    // that arrives through the reverse tunnel. A loopback peer must therefore
    // not be sufficient on its own.
    const res = await fetch(`${h.base}/api/local/pairing`, { method: 'POST' });
    assert.equal(res.status, 403);
    // The decisive assertion: no code was minted, so there is nothing to steal.
    // A 403 that still opened pairing would be worse than no gate at all.
    assert.equal(h.access.pairingOpen, false);
  } finally {
    await h.close();
  }
});

test('the management subtree refuses a wrong local operator token', async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/api/local/pairing`, {
      method: 'POST',
      headers: { 'x-pulse-local-token': 'not-the-token' },
    });
    assert.equal(res.status, 403);
    assert.equal(h.access.pairingOpen, false);
  } finally {
    await h.close();
  }
});

test('the management subtree refuses a request that crossed the edge proxy', async () => {
  const h = await harness();
  try {
    // This is the shape of the real attack: the edge overwrites X-Forwarded-For
    // with the true peer, so a public value proves the request came through the
    // tunnel even though its socket is loopback — and it must be refused even
    // when the token is correct, because a leaked token would otherwise be
    // usable from anywhere.
    const res = await fetch(`${h.base}/api/local/pairing`, {
      method: 'POST',
      headers: { ...h.localHeaders, 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(res.status, 403);
    assert.equal(h.access.pairingOpen, false);
  } finally {
    await h.close();
  }
});

test('a forged loopback hop cannot smuggle a request past the edge check', async () => {
  const h = await harness();
  try {
    // An attacker who sends their own X-Forwarded-For gains nothing: the edge
    // appends the true peer, and the last hop is the one that counts.
    const res = await fetch(`${h.base}/api/local/pairing`, {
      method: 'POST',
      headers: { ...h.localHeaders, 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
    });
    assert.equal(res.status, 403);
    assert.equal(h.access.pairingOpen, false);
  } finally {
    await h.close();
  }
});

test('a loopback X-Forwarded-For does not disqualify the local operator', async () => {
  const h = await harness();
  try {
    // A local reverse proxy on the machine itself is a legitimate setup.
    const res = await fetch(`${h.base}/api/local/pairing`, {
      method: 'POST',
      headers: { ...h.localHeaders, 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});

test('every management route is gated, not only pairing', async () => {
  const h = await harness();
  try {
    const routes = [
      ['/api/local/status', 'GET'],
      ['/api/local/devices', 'GET'],
      ['/api/local/devices', 'DELETE'],
      ['/api/local/devices/abc', 'DELETE'],
      ['/api/local/pairing', 'DELETE'],
      ['/api/local', 'GET'],
    ];
    for (const [path, method] of routes) {
      const res = await fetch(`${h.base}${path}`, { method });
      assert.equal(res.status, 403, `${method} ${path} must be gated`);
    }
    // The guidance names the header and the file, which is intentional; the
    // secret itself must never appear.
    const body = await (await fetch(`${h.base}/api/local/devices`)).text();
    assert.ok(!body.includes(LOCAL_TOKEN), 'a refusal must not echo the local token');
  } finally {
    await h.close();
  }
});

test('a server with no local token closes the management subtree entirely', async () => {
  const h = await harness({ localToken: '' });
  try {
    // Fail closed: a server that cannot distinguish a local operator from a
    // tunnel admits nobody.
    const res = await fetch(`${h.base}/api/local/pairing`, {
      method: 'POST',
      headers: { 'x-pulse-local-token': '' },
    });
    assert.equal(res.status, 403);
    assert.equal(h.access.pairingOpen, false);
  } finally {
    await h.close();
  }
});

test('a body over the size ceiling is refused', async () => {
  const h = await harness();
  try {
    const device = await h.pair('phone');
    const res = await fetch(`${h.base}/api/instruct`, {
      method: 'POST',
      headers: { ...device.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(70_000) }),
    }).catch(() => ({ status: 0 }));
    // Either an explicit rejection or a destroyed socket; never a 200.
    assert.notEqual(res.status, 200);
  } finally {
    await h.close();
  }
});

test('broadcast reaches every live stream and survives one dropping', async () => {
  const h = await harness();
  const controllers = [new AbortController(), new AbortController()];
  try {
    const a = await h.pair('a');
    const b = await h.pair('b');
    const streamA = await fetch(`${h.base}/api/stream?since=0&device=${a.id}&token=${a.token}`, {
      signal: controllers[0].signal,
    });
    const streamB = await fetch(`${h.base}/api/stream?since=0&device=${b.id}&token=${b.token}`, {
      signal: controllers[1].signal,
    });
    await sseReader(streamA.body).next('hello');
    await sseReader(streamB.body).next('hello');
    assert.equal(h.server.hasLivePhone, true);

    const frame = h.ring.push({ sessionId: 's1', kind: 'activity', text: 'both', ts: Date.now(), severity: 0 });
    assert.equal(h.server.broadcast(frame), 2);

    controllers[0].abort();
    await new Promise(resolve => setTimeout(resolve, 250));
    const later = h.ring.push({ sessionId: 's1', kind: 'activity', text: 'one', ts: Date.now(), severity: 0 });
    assert.equal(h.server.broadcast(later), 1);
  } finally {
    controllers.forEach(controller => controller.abort());
    await h.close();
  }
});

// ---- artifacts ---------------------------------------------------------------

/**
 * Run a body against a temp directory holding one real artifact.
 * @param {(dir: string, file: string, h: object, device: object) => Promise<void>} body - the body.
 * @returns {Promise<void>} resolves when done.
 */
async function withArtifact(body) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-server-artifacts-'));
  const file = join(dir, 'report.md');
  writeFileSync(file, '# report\nline two\n');
  const h = await harness();
  try {
    h.artifacts.record({ path: file, tool: 'write', sessionId: 's1' });
    const device = await h.pair('phone');
    await body(dir, file, h, device);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the artifact list requires a device and reports what was produced', async () => {
  await withArtifact(async (dir, file, h, device) => {
    const unpaired = await fetch(`${h.base}/api/artifacts`);
    assert.equal(unpaired.status, 401);

    const list = await (await fetch(`${h.base}/api/artifacts`, { headers: device.headers })).json();
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0].path, file);
    assert.equal(list.artifacts[0].name, 'report.md');
    assert.equal(list.artifacts[0].kind, 'text');
    assert.equal(typeof list.artifacts[0].at, 'number');
    assert.ok(dir.length > 0);
  });
});

test('artifact content is served only for a path the agent produced', async () => {
  await withArtifact(async (dir, file, h, device) => {
    const served = await fetch(`${h.base}/api/artifacts/content?path=${encodeURIComponent(file)}`, {
      headers: device.headers,
    });
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /text\/plain/);
    assert.equal(await served.text(), '# report\nline two\n');
    // A preview must never be stale, and a text file must not be sniffed into
    // something executable.
    assert.match(served.headers.get('cache-control'), /no-store/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(served.headers.get('content-disposition'), /^inline/);

    // The decisive assertion: a real, readable file that the agent did not
    // produce is refused. Traversal is not filtered here — it is unreachable,
    // because the route only opens paths already in the index.
    const real = join(dir, 'other.md');
    writeFileSync(real, 'not produced by the agent');
    const refused = await fetch(`${h.base}/api/artifacts/content?path=${encodeURIComponent(real)}`, {
      headers: device.headers,
    });
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.error, 'not-an-artifact');
    assert.ok(!(await Promise.resolve(JSON.stringify(body))).includes('not produced by the agent'));

    // A traversing spelling of the served path is likewise not in the index.
    const traversal = `${file}/../../etc/passwd`;
    const blocked = await fetch(`${h.base}/api/artifacts/content?path=${encodeURIComponent(traversal)}`, {
      headers: device.headers,
    });
    assert.equal(blocked.status, 403);
  });
});

test('a missing path parameter is refused, not treated as the root', async () => {
  await withArtifact(async (dir, file, h, device) => {
    assert.ok(dir.length > 0 && file.length > 0);
    const res = await fetch(`${h.base}/api/artifacts/content`, { headers: device.headers });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'not-an-artifact');
  });
});

test('a download request is handed over as an attachment, never inline', async () => {
  await withArtifact(async (dir, file, h, device) => {
    assert.ok(dir.length > 0);
    const res = await fetch(`${h.base}/api/artifacts/content?path=${encodeURIComponent(file)}&download=1`, {
      headers: device.headers,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    // Even an inline text preview runs in a fully sandboxed context: an artifact
    // is agent output, and agent output is untrusted markup.
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
  });
});

test('a recorded file that vanished answers 404, not a stale body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-server-gone-'));
  const h = await harness();
  try {
    const file = join(dir, 'gone.txt');
    writeFileSync(file, 'x');
    h.artifacts.record({ path: file, tool: 'write' });
    const device = await h.pair('phone');
    rmSync(file);
    const res = await fetch(`${h.base}/api/artifacts/content?path=${encodeURIComponent(file)}`, {
      headers: device.headers,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'missing');
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stream greets with the artifact list alongside the decisions', async () => {
  await withArtifact(async (dir, file, h, device) => {
    assert.ok(dir.length > 0 && file.length > 0);
    const controller = new AbortController();
    const stream = await fetch(`${h.base}/api/stream?since=0`, {
      headers: device.headers,
      signal: controller.signal,
    });
    const reader = sseReader(stream.body);
    try {
      // The reader discards events it is not waiting for, so these are read in
      // the order the server writes them.
      const decisionsEvent = await reader.next('decisions', 4000);
      assert.ok(Array.isArray(decisionsEvent.decisions));
      const artifactsEvent = await reader.next('artifacts', 4000);
      assert.equal(artifactsEvent.artifacts.length, 1);
      assert.equal(artifactsEvent.artifacts[0].path, file);
    } finally {
      controller.abort();
    }
  });
});

test('a new artifact is pushed to live streams without a reload', async () => {
  await withArtifact(async (dir, file, h, device) => {
    const controller = new AbortController();
    const stream = await fetch(`${h.base}/api/stream?since=0`, {
      headers: device.headers,
      signal: controller.signal,
    });
    const reader = sseReader(stream.body);
    try {
      await reader.next('artifacts', 4000);
      const extra = join(dir, 'second.md');
      writeFileSync(extra, 'second');
      h.artifacts.record({ path: extra, tool: 'write' });
      assert.equal(h.server.broadcastArtifacts(), 1);
      const update = await reader.next('artifacts', 4000);
      assert.equal(update.artifacts.length, 2);
      assert.equal(update.artifacts[0].name, 'second.md');
    } finally {
      controller.abort();
    }
  });
});
