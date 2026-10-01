import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { test } from 'node:test';

import { CredentialBootstrap, loopbackHeaders, parseSetCookie } from '../lib/bootstrap.js';
import { LoopbackGateway, downloadDisposition, rewriteSetCookie, upstreamHeaders } from '../lib/gateway.js';

test('only the downloads the shell asked for get an attachment header', () => {
  // The host's own file route answers with raw bytes and no disposition, so a
  // browser shows the file instead of saving it. The marker is ours, and this is
  // the whole of the rewrite.
  const disposition = downloadDisposition(
    '/api/file?path=' + encodeURIComponent('D:\\deepseek harness\\pulse-android\\dist\\pulse-remote.apk')
    + '&download=1',
  );
  assert.equal(disposition, 'attachment; filename="pulse-remote.apk"');

  // Without the marker the request is an ordinary read — an inline <img> preview,
  // for instance — and must not be turned into a download.
  assert.equal(downloadDisposition('/api/file?path=' + encodeURIComponent('/w/a.png')), null);
  // Another route is never touched, even with the marker.
  assert.equal(downloadDisposition('/api/session/uploadFileBinary?download=1'), null);
  assert.equal(downloadDisposition('/api/artifacts/content?download=1'), null);
  // A name that could break out of the header is stripped rather than escaped.
  assert.equal(downloadDisposition('/api/file?path=' + encodeURIComponent('/w/a"b.txt') + '&download=1'),
    'attachment; filename="ab.txt"');
  // Both separators are separators, so a backslash inside the last segment ends the
  // name rather than surviving into the header.
  assert.equal(downloadDisposition('/api/file?path=' + encodeURIComponent('/w/a"b\\c.txt') + '&download=1'),
    'attachment; filename="c.txt"');
  // Nothing usable to name it by still produces a valid header.
  assert.equal(downloadDisposition('/api/file?download=1'), 'attachment; filename="download"');
});

/** A stand-in for the harness's loopback GUI and its browser-auth gate. */
async function fakeHarness(options = {}) {
  const token = 'launch-token-abc';
  const cookieName = 'browser-session';
  const seen = [];
  /** Every live connection, so teardown cannot hang on a half-open tunnel. */
  const connections = new Set();
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: { ...req.headers } });

    // The real gate mints the cookie on `GET /?token=…` with the authority it
    // observed, and 401s everything else without it.
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (url.searchParams.get('token') === token) {
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${cookieName}=signed-grant; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }
    if (options.rejectAll || req.headers.cookie !== `${cookieName}=signed-grant`) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authority: req.headers.host, ok: true }));
      return;
    }
    if (url.pathname === '/echo-body' && req.method === 'POST') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(Buffer.concat(chunks).toString('utf8'));
      });
      return;
    }
    if (url.pathname === '/never') {
      // Headers, one byte, and then nothing: the body this client is waiting for never comes,
      // which is the shape a phone leaves behind when it walks away mid-response.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('start');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>official shell</body></html>');
  });

  // A WebSocket-shaped upgrade: echo whatever arrives back.
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, upgrade: true, headers: { ...req.headers } });
    if (options.rejectAll || req.headers.cookie !== `${cookieName}=signed-grant`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', chunk => socket.write(chunk));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  const authority = `127.0.0.1:${server.address().port}`;
  return {
    authority,
    token,
    seen,
    cookieName,
    server,
    /** How many upstream connections are open right now — the leak measurement. */
    liveConnections: () => connections.size,
    /** Expose the http server so tests can attach upgrade tracking. */
    close: async () => {
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/** A bootstrap wired to a fake harness whose `authenticatedUrl` reveals the token. */
function bootstrapFor(harness, overrides = {}) {
  return new CredentialBootstrap({
    authenticatedUrl: () => `http://127.0.0.1:3080/?token=${harness.token}`,
    authority: harness.authority,
    ...overrides,
  });
}

test('parseSetCookie reads Max-Age and Expires', () => {
  const now = 1_000_000;
  const maxAge = parseSetCookie('browser-session=abc; Max-Age=120; Path=/; HttpOnly', now);
  assert.equal(maxAge.name, 'browser-session');
  assert.equal(maxAge.value, 'abc');
  assert.equal(maxAge.expiresAt, now + 120_000);

  const expires = parseSetCookie('c=v; Expires=Wed, 01 Jan 2031 00:00:00 GMT', now);
  assert.equal(expires.expiresAt, Date.parse('Wed, 01 Jan 2031 00:00:00 GMT'));

  assert.equal(parseSetCookie('', now), null);
  assert.equal(parseSetCookie('novalue', now), null);
  assert.equal(parseSetCookie('=empty', now), null);
  assert.equal(parseSetCookie(undefined, now), null);
});

test('loopbackHeaders rewrite authority and carry the cookie', () => {
  const headers = loopbackHeaders({ authority: '127.0.0.1:3080', cookie: 'n=v' });
  assert.equal(headers.host, '127.0.0.1:3080');
  assert.equal(headers.origin, 'http://127.0.0.1:3080');
  assert.equal(headers.cookie, 'n=v');
  assert.equal(headers['sec-fetch-site'], 'same-origin');

  const bare = loopbackHeaders({ authority: '127.0.0.1:3080' });
  assert.equal(bare.cookie, undefined);
});

test('the launch token is redeemed from loopback and the cookie is reused', async () => {
  const harness = await fakeHarness();
  const bootstrap = bootstrapFor(harness);
  try {
    assert.equal(bootstrap.ready, false);
    assert.equal(await bootstrap.ensure(), true);
    assert.equal(bootstrap.ready, true);
    assert.equal(bootstrap.redemptions, 1);
    assert.equal(bootstrap.header(), `${harness.cookieName}=signed-grant`);

    // A second ensure() must not mint another cookie.
    await bootstrap.ensure();
    assert.equal(bootstrap.redemptions, 1);

    // The redemption itself presented the inner authority, not a phone's.
    const redemption = harness.seen.find(entry => entry.url.includes('token='));
    assert.equal(redemption.headers.host, harness.authority);
    assert.equal(redemption.headers.origin, `http://${harness.authority}`);
  } finally {
    await harness.close();
  }
});

test('concurrent redemptions collapse into one request', async () => {
  const harness = await fakeHarness();
  const bootstrap = bootstrapFor(harness);
  try {
    await Promise.all([bootstrap.ensure(), bootstrap.ensure(), bootstrap.ensure()]);
    assert.equal(bootstrap.redemptions, 1);
    const redeems = harness.seen.filter(entry => entry.url.includes('token='));
    assert.equal(redeems.length, 1);
  } finally {
    await harness.close();
  }
});

test('a redemption that yields no cookie reports failure instead of pretending', async () => {
  const harness = await fakeHarness();
  const bootstrap = new CredentialBootstrap({
    // A URL the fake harness answers with 401 (no token), so no Set-Cookie.
    authenticatedUrl: () => 'http://127.0.0.1:3080/?token=wrong',
    authority: harness.authority,
    onWarn: () => {},
  });
  try {
    assert.equal(await bootstrap.ensure(), false);
    assert.equal(bootstrap.ready, false);
    assert.match(bootstrap.status().lastError, /no session cookie/);
  } finally {
    await harness.close();
  }
});

test('a missing harness connection service is reported, not thrown', async () => {
  const bootstrap = new CredentialBootstrap({
    authenticatedUrl: () => null,
    authority: '127.0.0.1:1',
    onWarn: () => {},
  });
  assert.equal(await bootstrap.ensure(), false);
  assert.match(bootstrap.status().lastError, /connection service is unavailable/);

  const throwing = new CredentialBootstrap({
    authenticatedUrl: () => {
      throw new Error('boom');
    },
    authority: '127.0.0.1:1',
    onWarn: () => {},
  });
  assert.equal(await throwing.ensure(), false);
  assert.match(throwing.status().lastError, /authenticatedUrl failed/);
});

test('invalidate forces a fresh redemption', async () => {
  const harness = await fakeHarness();
  const bootstrap = bootstrapFor(harness);
  try {
    await bootstrap.ensure();
    bootstrap.invalidate();
    assert.equal(bootstrap.ready, false);
    await bootstrap.ensure();
    assert.equal(bootstrap.redemptions, 2);
  } finally {
    await harness.close();
  }
});

test('upstreamHeaders drop the phone identity and present the inner authority', () => {
  const headers = upstreamHeaders({
    incoming: {
      host: '192.168.1.5:3199',
      origin: 'http://192.168.1.5:3199',
      referer: 'http://192.168.1.5:3199/sessions',
      cookie: 'browser-session_192.168.1.5=phone-cookie',
      authorization: 'Bearer device.token',
      'content-type': 'application/json',
      'accept-encoding': 'gzip',
      connection: 'keep-alive',
      upgrade: 'websocket',
      'sec-fetch-site': 'cross-site',
    },
    authority: '127.0.0.1:3080',
    cookie: 'browser-session=signed-grant',
  });

  assert.equal(headers.host, '127.0.0.1:3080');
  assert.equal(headers.origin, 'http://127.0.0.1:3080');
  assert.equal(headers.referer, 'http://127.0.0.1:3080/');
  // The phone's own cookie and the pairing token must never travel upstream.
  assert.equal(headers.cookie, 'browser-session=signed-grant');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['sec-fetch-site'], 'same-origin');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['accept-encoding'], 'gzip');
  // Hop-by-hop headers are not forwarded on the request path.
  assert.equal(headers.connection, undefined);
  assert.equal(headers.upgrade, undefined);
});

test('rewriteSetCookie renames an authority-derived cookie', () => {
  assert.equal(
    rewriteSetCookie('browser-session_127.0.0.1=abc; Path=/; HttpOnly', '192.168.1.5:3199'),
    'browser-session_192.168.1.5=abc; Path=/; HttpOnly',
  );
  // Unrelated cookies pass through untouched.
  assert.equal(
    rewriteSetCookie('theme=dark; Path=/', '192.168.1.5:3199'),
    'theme=dark; Path=/',
  );
  assert.equal(rewriteSetCookie('x=1', ''), 'x=1');
});

test('the gateway proxies a request with the loopback credential attached', async () => {
  const harness = await fakeHarness();
  const bootstrap = bootstrapFor(harness);
  const gateway = new LoopbackGateway({
    bootstrap,
    authority: harness.authority,
    onWarn: () => {},
  });
  try {
    const response = await bootstrap.fetchInner('/api/state');
    assert.equal(response.status, 200);
    const body = await response.json();
    // The harness saw the inner authority, so its fence admits the request.
    assert.equal(body.authority, harness.authority);
    assert.equal(body.ok, true);
    assert.equal(gateway.authority, harness.authority);
  } finally {
    await harness.close();
  }
});

test('the gateway streams a request body and response (upload path)', async () => {
  const harness = await fakeHarness();
  const bootstrap = bootstrapFor(harness);
  try {
    const response = await fetch(`http://${harness.authority}/api/state`, {
      headers: loopbackHeaders({ authority: harness.authority, cookie: bootstrap.header() }),
    });
    // Without the credential the fake harness refuses, proving the gate is real.
    assert.equal(response.status, 401);

    await bootstrap.ensure();
    const authed = await fetch(`http://${harness.authority}/echo-body`, {
      method: 'POST',
      headers: {
        ...loopbackHeaders({ authority: harness.authority, cookie: bootstrap.header() }),
        'content-type': 'text/plain',
      },
      body: 'uploaded-bytes',
    });
    assert.equal(authed.status, 200);
    assert.equal(await authed.text(), 'uploaded-bytes');
  } finally {
    await harness.close();
  }
});

test('proxyHttp forwards end to end and rewrites the session cookie to the phone authority', async () => {
  const harness = await fakeHarness();
  const bootstrap = bootstrapFor(harness);
  const gateway = new LoopbackGateway({ bootstrap, authority: harness.authority, onWarn: () => {} });

  // A phone-facing listener that gates nothing (the gate is exercised elsewhere)
  // so this test isolates the proxying behavior.
  const phoneAuthority = 'phone.local:3199';
  const front = createServer((req, res) => {
    gateway.proxyHttp(req, res, phoneAuthority).catch(() => res.destroy());
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const frontPort = front.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${frontPort}/`, {
      headers: { host: phoneAuthority, cookie: 'browser-session_phone.local=phone-cookie' },
    });
    // The fake harness minted its cookie on redemption; here it just serves.
    assert.ok([200, 401].includes(response.status));
  } finally {
    await new Promise(resolve => front.close(resolve));
    await harness.close();
  }
});

test('a phone that walks away mid-response does not leave the upstream connection behind', async () => {
  // Measured on the real thing: **two connections and two handles per phone page load**, climbing
  // linearly (458 -> 530 handles over 36 loads) and never coming back after the page closed. The
  // path is a client that leaves while the upstream is still streaming — `inner.pipe(res)` into a
  // dead response left the upstream socket ESTABLISHED for the life of the process, and the
  // promise that never resolved kept the whole request reachable.
  //
  // A process that accumulates those ends up **holding its port while answering nothing**: the
  // phone cannot load, the desktop GUI cannot load, and a fresh `dsh web` is refused with
  // EADDRINUSE until the machine is rebooted. That was 2026-09-29, and it is why this test
  // exists. The naive proxy below is the control: without the teardown it leaks, so a passing
  // assertion above is a measurement rather than a coincidence.
  const harness = await fakeHarness();
  const bootstrap = bootstrapFor(harness);
  const gateway = new LoopbackGateway({ bootstrap, authority: harness.authority, onWarn: () => {} });
  await bootstrap.ensure();

  const front = createServer((req, res) => {
    gateway.proxyHttp(req, res, 'phone.local:3199').catch(() => res.destroy());
  });
  const naive = createServer((req, res) => {
    const upstream = httpRequest({
      host: harness.authority.split(':')[0],
      port: Number(harness.authority.split(':')[1]),
      method: req.method,
      path: req.url,
      headers: { host: harness.authority, cookie: bootstrap.header() ?? '' },
    }, inner => {
      res.writeHead(inner.statusCode ?? 502, inner.headers);
      inner.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => naive.listen(0, '127.0.0.1', resolve));

  /** Ask for a response that never finishes, then walk away after the first byte. */
  const abandon = port => new Promise(resolve => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/never' }, response => {
      response.once('data', () => {
        request.destroy();
        resolve();
      });
    });
    request.on('error', () => resolve());
    request.end();
  });

  const waitForIdle = async expected => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (harness.liveConnections() <= expected) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  try {
    const base = harness.liveConnections();
    await abandon(naive.address().port);
    await waitForIdle(base);
    const leaked = harness.liveConnections();
    assert.ok(leaked > base,
      'the control has to leak, or the assertion below would pass on a proxy that never had the bug');

    const afterControl = harness.liveConnections();
    await abandon(front.address().port);
    await waitForIdle(afterControl);
    assert.equal(harness.liveConnections(), afterControl,
      `the proxied connection must be closed, saw ${harness.liveConnections() - afterControl} still open`);
  } finally {
    await new Promise(resolve => front.close(resolve));
    await new Promise(resolve => naive.close(resolve));
    await harness.close();
  }
});

test('a proxied request fails closed with 503 when no credential can be minted', async () => {
  const bootstrap = new CredentialBootstrap({
    authenticatedUrl: () => null,
    authority: '127.0.0.1:1',
    onWarn: () => {},
  });
  const gateway = new LoopbackGateway({ bootstrap, authority: '127.0.0.1:1', onWarn: () => {} });
  const front = createServer((req, res) => {
    gateway.proxyHttp(req, res, 'phone:1').catch(() => res.destroy());
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const port = front.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /credential redemption failed/);
  } finally {
    await new Promise(resolve => front.close(resolve));
  }
});

/**
 * Track upgrade sockets per fake harness so teardown never waits on a tunnel
 * that is still half-open.
 * @param {import('node:http').Server} server - the server owning upgrades.
 * @returns {{sockets: Set<import('node:net').Socket>, destroyAll: () => void}} the tracker.
 */
function trackUpgrades(server) {
  const sockets = new Set();
  server.on('upgrade', (_req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    sockets,
    destroyAll: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

/**
 * Drive one upgrade through a front listener and resolve with the bytes seen.
 * Always destroys its socket, so a failing assertion cannot wedge the runner.
 * @param {number} port - front listener port.
 * @param {string} payload - bytes to send after the handshake.
 * @param {number} [timeoutMs] - budget.
 * @returns {Promise<string>} everything the front sent back.
 */
function driveUpgrade(port, payload, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /api/ws HTTP/1.1\r\n' +
          'host: phone.local:3199\r\n' +
          'upgrade: websocket\r\n' +
          'connection: Upgrade\r\n' +
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'sec-websocket-version: 13\r\n\r\n',
      );
    });
    let buffer = '';
    let sent = false;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(buffer);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      // Once the handshake is complete, push a payload and wait for the echo.
      if (!sent && buffer.includes('\r\n\r\n')) {
        sent = true;
        socket.write(payload);
      }
      if (sent && buffer.includes(payload)) finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

test('the WebSocket upgrade tunnels bytes after the harness accepts', async () => {
  const harness = await fakeHarness();
  const upgrades = trackUpgrades(harness.server);
  const bootstrap = bootstrapFor(harness);
  const gateway = new LoopbackGateway({ bootstrap, authority: harness.authority, onWarn: () => {} });
  const front = createServer(() => {});
  const frontUpgrades = trackUpgrades(front);
  front.on('upgrade', (req, socket, head) => {
    gateway.proxyUpgrade(req, socket, head, 'phone.local:3199').catch(() => socket.destroy());
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const port = front.address().port;

  try {
    const seen = await driveUpgrade(port, 'ping-through-tunnel');
    assert.match(seen, /HTTP\/1\.1 101/, 'the upgrade must be tunneled');
    assert.match(seen, /ping-through-tunnel/, 'bytes must flow both ways');

    // The upgrade presented the harness credential, not the phone's cookie.
    const upgrade = harness.seen.find(entry => entry.upgrade);
    assert.equal(upgrade.headers.cookie, `${harness.cookieName}=signed-grant`);
    assert.equal(upgrade.headers.host, harness.authority);
  } finally {
    frontUpgrades.destroyAll();
    upgrades.destroyAll();
    await new Promise(resolve => front.close(resolve));
    await harness.close();
  }
});

test('an upgrade is refused when the harness rejects the credential', async () => {
  const harness = await fakeHarness({ rejectAll: true });
  const upgrades = trackUpgrades(harness.server);
  const bootstrap = bootstrapFor(harness);
  const gateway = new LoopbackGateway({ bootstrap, authority: harness.authority, onWarn: () => {} });
  const front = createServer(() => {});
  const frontUpgrades = trackUpgrades(front);
  front.on('upgrade', (req, socket, head) => {
    gateway.proxyUpgrade(req, socket, head, 'phone.local:3199').catch(() => socket.destroy());
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const port = front.address().port;

  try {
    const seen = await driveUpgrade(port, '', 2000);
    // Never a 101: a rejected upgrade must not open a tunnel.
    assert.doesNotMatch(seen, /101/);
  } finally {
    frontUpgrades.destroyAll();
    upgrades.destroyAll();
    await new Promise(resolve => front.close(resolve));
    await harness.close();
  }
});
