/**
 * Run the REAL pairing page in a simulated browser and report what actually
 * happens when the submit button is pressed.
 *
 * This exists because the server-side API can be perfectly healthy while the
 * page in front of it is broken: a client-side exception, a mis-bound listener,
 * or a request that never leaves all look identical to a user ("nothing
 * happens") and are invisible to an HTTP-level test. The page's own JavaScript
 * is loaded verbatim from the running server, so this exercises the shipped
 * artifact rather than a copy.
 *
 * Usage: node scripts/drive-pairing-page.mjs [localPulseUrl]
 */

import { JSDOM, VirtualConsole } from 'jsdom';

import { localHeaders } from './local-operator.mjs';

const localBase = (process.argv[2] ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');
const PUBLIC_ORIGIN = 'https://203.0.113.10';

const report = [];
const log = (...parts) => {
  const line = parts.join(' ');
  report.push(line);
  console.log(line);
};

// ---- mint a real pairing code -------------------------------------------------

const minted = await fetch(`${localBase}/api/local/pairing`, {
  method: 'POST',
  headers: localHeaders(),
}).then(r => r.json());
log(`pairing code minted: ${minted.code}`);

// ---- load the real page --------------------------------------------------------

const pageUrl = `${PUBLIC_ORIGIN}/?code=${minted.code}`;
const html = await fetch(`${localBase}/`).then(r => r.text());
const script = await fetch(`${localBase}/pulse.js`).then(r => r.text());
log(`loaded: html ${html.length} chars, pulse.js ${script.length} chars`);

const consoleErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => consoleErrors.push(`jsdomError: ${error.message}`));
virtualConsole.on('error', (...args) => consoleErrors.push(`console.error: ${args.join(' ')}`));

const dom = new JSDOM(html, {
  url: pageUrl,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

// ---- record every request the page attempts ------------------------------------

const requests = [];

/**
 * Cookies the page has been given, so later requests carry them.
 *
 * Without this the driver is not a browser: pairing sets a session cookie, the
 * page then asks `/api/whoami` whether that cookie actually stuck, and a shim
 * with no jar answers "no" every time -- reporting a cookie failure that only
 * exists in the harness.
 */
const jar = new Map();

// A fetch shim that forwards to the real listener and records the attempt, so a
// request that is constructed but never sent is distinguishable from one that
// was sent and rejected.
window.fetch = async (input, init = {}) => {
  const target = typeof input === 'string' ? input : input.url;
  const absolute = new URL(target, pageUrl).href;
  const headers = { ...(init.headers ?? {}) };
  if (jar.size > 0) {
    headers.cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const entry = {
    target,
    absolute,
    method: (init.method ?? 'GET').toUpperCase(),
    status: null,
    error: null,
    sentCookie: headers.cookie ?? null,
  };
  requests.push(entry);
  try {
    // Always talk to the local listener; only the request's shape matters here.
    const rewritten = absolute.replace(PUBLIC_ORIGIN, localBase);
    const response = await fetch(rewritten, { ...init, headers });
    entry.status = response.status;
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      const at = pair.indexOf('=');
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    entry.body = await response.clone().text();
    return response;
  } catch (error) {
    entry.error = error.message;
    throw error;
  }
};

// jsdom already provides localStorage for this origin; the recorded storage is
// read back from it at the end.

// ---- run the page script -------------------------------------------------------

try {
  window.eval(script);
  log('pulse.js evaluated without throwing');
} catch (error) {
  log(`SCRIPT THREW: ${error.message}`);
}

// DOMContentLoaded already fired for the parsed document; fire it for the
// listener path the script expects.
try {
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
} catch (error) {
  log(`DOMContentLoaded dispatch threw: ${error.message}`);
}
await new Promise(resolve => setTimeout(resolve, 150));

// ---- inspect the gate before any interaction -----------------------------------

const codeInput = window.document.getElementById('pair-code');
const submit = window.document.getElementById('pair-submit');
const errorNode = window.document.getElementById('pair-error');
log(`gate has #pair-code: ${Boolean(codeInput)}, #pair-submit: ${Boolean(submit)}, #pair-error: ${Boolean(errorNode)}`);
log(`autofilled value: ${JSON.stringify(codeInput ? codeInput.value : null)}`);

// ---- press the button ----------------------------------------------------------

const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
if (submit) {
  submit.dispatchEvent(clickEvent);
  log('clicked #pair-submit');
}
await new Promise(resolve => setTimeout(resolve, 1200));

// ---- report --------------------------------------------------------------------

log('');
log('=== requests the page attempted ===');
if (requests.length === 0) {
  // A click on a submit button inside a form triggers submit only if the event
  // path is complete; try the form directly so the two are distinguishable.
  log('  (none) -- dispatching form submit directly to test the handler');
  const form = window.document.getElementById('pair-form');
  if (form) {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}
for (const request of requests) {
  log(`  ${request.method} ${request.target} -> ${request.status ?? request.error ?? 'NO RESULT'}`);
  if (request.sentCookie) log(`      cookie: ${request.sentCookie.slice(0, 60)}`);
  if (request.body) log(`      body: ${request.body.slice(0, 200)}`);
}

log('');
log('=== verdict ===');
// The two things a user would actually notice. A paired device that still shows
// an error is the failure this driver exists to catch: pairing would appear to
// have failed even though the credential was accepted and stored.
const pairPosts = requests.filter(entry => entry.method === 'POST' && entry.target === '/api/pair');
const succeeded = pairPosts.some(entry => entry.status === 200);
const stored = Boolean(window.localStorage.getItem('pulse.device.v1'));
const errorNode_ = window.document.getElementById('pair-error');
const visibleError = errorNode_ && !errorNode_.hidden && errorNode_.textContent ? errorNode_.textContent : '';
log(`  pairing accepted      : ${succeeded}`);
log(`  credential stored     : ${stored}`);
log(`  pair requests made    : ${pairPosts.length} (a racing tap must not add one)`);
log(`  error shown to user   : ${visibleError ? `YES -- ${visibleError}` : 'no'}`);
if (!succeeded) log('  RESULT: FAIL -- the page never paired');
else if (!stored) log('  RESULT: FAIL -- paired but no credential was stored');
else if (pairPosts.length > 1) log('  RESULT: FAIL -- the one-shot code was spent more than once');
else if (visibleError) log('  RESULT: FAIL -- a successful pairing is painted as a failure');
else log('  RESULT: PASS');

log('');
log('=== page state after the attempt ===');
log(`  #pair-code value : ${JSON.stringify(codeInput ? codeInput.value : null)}`);
log(`  #pair-error text : ${JSON.stringify(errorNode ? errorNode.textContent : null)}`);
log(`  #pair-error hidden: ${errorNode ? errorNode.hidden : null}`);
log(`  submit disabled  : ${submit ? submit.disabled : null}`);
log(`  localStorage pulse key: ${JSON.stringify(window.localStorage.getItem('pulse.device.v1'))}`);

log('');
log('=== console/jsdom errors ===');
if (consoleErrors.length === 0) log('  (none)');
for (const error of consoleErrors) log(`  ${error}`);
