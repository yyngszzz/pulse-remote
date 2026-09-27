/**
 * The pairing page's own behaviour, exercised in a real DOM.
 *
 * The server-side API can be perfectly healthy while the page in front of it is
 * broken, and "nothing happens" or "it says the code expired even though I got
 * in" are both invisible to an HTTP-level test. These run the shipped gate page
 * and client script verbatim against a real listener.
 *
 * The regression this file exists for: a scanned link auto-submits on load, so a
 * tap that races it used to spend the one-shot code twice and paint a failure
 * message over a pairing that had actually succeeded.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { JSDOM, VirtualConsole } from 'jsdom';

import { AccessControl } from '../lib/auth.js';
import { PulseServer } from '../lib/server.js';
import { gateHtml, pulseScript } from '../lib/ui.js';

/** The local-operator token the gate harness hands the server. */
const LOCAL_TOKEN = 'test-local-operator-token';

/** Signing key for the harness's phone-session cookies. */
const SESSION_SECRET = 'test-session-secret';

/** How long to let the page's promise chain settle. */
const SETTLE_MS = 250;

/** How long a condition is given before it counts as a failure. */
const WAIT_MS = 5000;

/**
 * Wait until a condition holds, instead of for a fixed time.
 *
 * `settle()` is enough for "nothing happened", but not for "the request finished": in a
 * full-suite run the loopback round trip can outlast the settle budget, and the assertion
 * then reads `pairPosts()[0].status` before the fetch has resolved — measured as
 * `undefined !== 200` in two tests at once, which looks like a broken pairing page and is
 * nothing but a busy machine. Polling keeps every assertion below exactly as strict (a
 * second POST still shows up as a length of 2) while removing the load sensitivity.
 *
 * @param {() => boolean} condition - polled every few milliseconds.
 * @param {string} what - what is being waited for, for the failure message.
 * @returns {Promise<void>} resolves once it holds, throws after the budget.
 */
async function waitFor(condition, what) {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Sign a phone session cookie the way the plugin does.
 * @param {string} deviceId - the device.
 * @returns {string} the cookie value.
 */
function signSession(deviceId) {
  const payload = Buffer.from(JSON.stringify({ d: deviceId }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
}

/**
 * Bring up a real listener and a real gate page wired to it.
 *
 * The session seams matter here: without them the server would set an empty
 * session cookie, and the page's cookie check would report a failure that has
 * nothing to do with the page's own logic.
 *
 * @returns {Promise<object>} the harness.
 */
async function gateHarness() {
  const access = new AccessControl();
  const server = new PulseServer({
    access,
    host: '127.0.0.1',
    port: 0,
    realm: 'Pulse',
    replay: () => ({ frames: [], gap: false, lastSeq: 0 }),
    snapshot: () => ({ sessions: [] }),
    mintSession: deviceId => signSession(deviceId),
    verifySession: cookie => {
      if (typeof cookie !== 'string' || !cookie.includes('.')) return null;
      const [payload, mac] = cookie.split('.');
      if (!payload || !mac) return null;
      if (mac !== createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')) return null;
      try {
        const deviceId = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.d ?? null;
        return deviceId && access.devices.has(deviceId) ? deviceId : null;
      } catch {
        return null;
      }
    },
    localToken: LOCAL_TOKEN,
  });
  const bound = await server.listen();
  return { access, server, base: `http://127.0.0.1:${bound.port}`, close: () => server.close() };
}

/**
 * Await a short settle period.
 * @returns {Promise<void>} resolves after the page has had time to react.
 */
function settle() {
  return new Promise(resolve => setTimeout(resolve, SETTLE_MS));
}

/**
 * Load the shipped gate page in jsdom against a real listener.
 *
 * The fetch shim carries a minimal cookie jar, because that is what a browser
 * does: the pairing response sets the session cookie and every later request —
 * including the `whoami` the page uses to confirm the cookie took — travels
 * with it.
 *
 * @param {string} base - the listener origin.
 * @param {object} [options] - tuning.
 * @param {string} [options.code] - a pairing code to put in the URL.
 * @returns {Promise<object>} the page handle.
 */
async function openGate(base, options = {}) {
  const pageUrl = options.code ? `${base}/?code=${encodeURIComponent(options.code)}` : `${base}/`;
  const requests = [];
  const pageErrors = [];
  const cookies = new Map();

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    // jsdom has no navigation implementation; the gate navigates to '/' once
    // paired, which is not a page error.
    if (!/Not implemented: navigation/.test(error.message)) pageErrors.push(error.message);
  });
  virtualConsole.on('error', (...args) => pageErrors.push(args.join(' ')));

  const dom = new JSDOM(gateHtml({ realm: 'Pulse', exposed: true }), {
    url: pageUrl,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  window.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    const absolute = new URL(target, pageUrl).href;
    const headers = { ...(init.headers ?? {}) };
    if (cookies.size > 0) {
      headers.cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const entry = { method: String(init.method ?? 'GET').toUpperCase(), path: new URL(absolute).pathname };
    requests.push(entry);
    const response = await fetch(absolute, { ...init, headers });
    entry.status = response.status;
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      const at = pair.indexOf('=');
      if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return response;
  };

  window.eval(pulseScript());
  // The document is already past 'loading' in jsdom, so the script's own
  // readyState check takes the direct `init()` branch.
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  }
  await settle();

  return {
    window,
    requests,
    pageErrors,
    code: () => window.document.getElementById('pair-code'),
    error: () => window.document.getElementById('pair-error'),
    submit: () => window.document.getElementById('pair-submit'),
    paired: () => window.localStorage.getItem('pulse.device.v1'),
    pairPosts: () => requests.filter(entry => entry.method === 'POST' && entry.path === '/api/pair'),
    close: () => window.close(),
  };
}

test('a scanned link pairs once, without a racing tap showing a false failure', async () => {
  const h = await gateHarness();
  try {
    const { code } = h.access.openPairing();
    const page = await openGate(h.base, { code });
    try {
      // The page auto-submits because the code rode the URL.
      await waitFor(() => page.pairPosts().length > 0, 'the scanned link to submit');
      assert.equal(page.pairPosts().length, 1, 'the scanned link submits exactly once');
      await waitFor(() => page.pairPosts()[0].status !== undefined, 'the pairing response');
      assert.equal(page.pairPosts()[0].status, 200);
      await waitFor(() => page.paired() !== null, 'the device credential to be stored');
      assert.ok(page.paired(), 'the device credential is stored');

      // Now the user taps the button anyway -- slow network, or a second tap.
      const button = page.submit();
      button?.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle();

      assert.equal(
        page.pairPosts().length,
        1,
        'a tap that races the auto-submit must not spend the code again',
      );
      // The decisive user-visible assertion: no failure text over a success.
      const error = page.error();
      assert.ok(
        !error || error.hidden || !error.textContent,
        `a successful pairing must not be painted as a failure (saw ${JSON.stringify(error?.textContent)})`,
      );
    } finally {
      page.close();
    }
  } finally {
    await h.close();
  }
});

test('a manually entered code pairs when the button is pressed', async () => {
  const h = await gateHarness();
  try {
    const { code } = h.access.openPairing();
    const page = await openGate(h.base);
    try {
      assert.equal(page.pairPosts().length, 0, 'nothing is submitted before the user acts');
      page.code().value = code;
      page.submit().dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitFor(
        () => page.pairPosts().length > 0 && page.pairPosts()[0].status !== undefined,
        'the pressed button to pair',
      );

      assert.equal(page.pairPosts().length, 1);
      assert.equal(page.pairPosts()[0].status, 200);
      assert.ok(page.paired(), 'the device credential is stored');
      const info = JSON.parse(page.paired());
      assert.equal(typeof info.id, 'string');
      assert.equal(typeof info.token, 'string');
    } finally {
      page.close();
    }
  } finally {
    await h.close();
  }
});

test('a wrong code reports the server reason and still allows a retry', async () => {
  const h = await gateHarness();
  try {
    const { code } = h.access.openPairing();
    const page = await openGate(h.base);
    try {
      page.code().value = 'WRONGXXX';
      page.submit().dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitFor(
        () => page.pairPosts().length > 0 && page.pairPosts()[0].status !== undefined,
        'the wrong code to be refused',
      );

      assert.equal(page.pairPosts().length, 1);
      assert.equal(page.pairPosts()[0].status, 403);
      assert.equal(page.paired(), null, 'a failed pairing stores nothing');
      assert.equal(page.error().hidden, false, 'the failure is shown');
      assert.ok(page.error().textContent.length > 0);

      // A corrected code must still work: the guard is released on failure.
      page.code().value = code;
      page.submit().dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitFor(
        () => page.pairPosts().length > 1 && page.pairPosts()[1].status !== undefined,
        'the retry to pair',
      );

      assert.equal(page.pairPosts().length, 2, 'the retry is allowed through');
      assert.equal(page.pairPosts()[1].status, 200);
      assert.ok(page.paired(), 'the corrected code pairs');
    } finally {
      page.close();
    }
  } finally {
    await h.close();
  }
});

test('the gate page loads without a script error even when controls are missing', async () => {
  const h = await gateHarness();
  try {
    const page = await openGate(h.base);
    try {
      // The console and the gate share one script; a binding for an element the
      // gate does not have must be skipped, not thrown. A throw here is what
      // previously killed the submit listener and made the button do nothing.
      assert.deepEqual(page.pageErrors, []);
    } finally {
      page.close();
    }
  } finally {
    await h.close();
  }
});
