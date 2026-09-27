/**
 * The generated client artifacts must be valid JavaScript.
 *
 * `lib/ui.js` and `lib/push.js` build the phone's script and service worker by
 * interpolating into template literals. That makes the *generated* string the
 * artifact that actually ships, and it is a different thing from the module that
 * builds it: a stray backtick or an unbalanced brace inside the template is
 * invisible to a reader of `lib/ui.js` but is a syntax error on the phone.
 *
 * This has already happened once — a comment containing a backtick closed the
 * enclosing template literal early — so the artifact is compiled here rather
 * than trusted.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { pushWorkerScript } from '../lib/push.js';
import { mobileShellScript } from '../lib/mobile-shell.js';
import { gateHtml, indexHtml, manifestJson, pulseScript, pulseStylesheet } from '../lib/ui.js';

/**
 * Compile a script and report the failure rather than throwing.
 * @param {string} source - the script text.
 * @returns {string | null} an error message, or null when it compiles.
 */
function compileError(source) {
  try {
    // Compiling is what matters; running would need a DOM and a network.
    new vm.Script(source, { filename: 'generated.js' });
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

test('the phone client script compiles', () => {
  const source = pulseScript();
  assert.ok(source.length > 1000, `suspiciously short: ${source.length}`);
  const error = compileError(source);
  assert.equal(error, null, `generated client script does not parse: ${error}`);
});

test('the push worker compiles', () => {
  const source = pushWorkerScript();
  assert.ok(source.length > 500, `suspiciously short: ${source.length}`);
  const error = compileError(source);
  assert.equal(error, null, `generated worker does not parse: ${error}`);
});

test('the mobile shell script compiles', () => {
  // Every generated artifact gets this check, not just the ones that existed when
  // the guard was written: the shell was added later and immediately acquired the
  // same truncated-by-a-backtick bug, which nothing but this would have named.
  const source = mobileShellScript();
  assert.ok(typeof source === 'string', `must return a string, got ${typeof source}`);
  assert.ok(source.length > 1000, `suspiciously short: ${source.length}`);
  const error = compileError(source);
  assert.equal(error, null, `generated mobile shell does not parse: ${error}`);
  assert.ok(/\)\(\);\s*$/.test(source.trim()), 'the shell should end with its IIFE call');
});

test('the generated script is not terminated early by a stray backtick', () => {
  // The exact failure mode: a backtick inside a template-literal comment ends
  // the literal, so the tail of the script becomes module-level source.
  const source = pulseScript();
  const error = compileError(source);
  assert.equal(error, null, 'a backtick inside the template literal truncates the script');
  // A truncated script loses its IIFE tail.
  assert.ok(/\)\(\);\s*$/.test(source.trim()), 'the client script should end with its IIFE call');
});

test('the phone client offers forwarding, and only the phone client does', () => {
  const source = pulseScript();
  // The share sheet is the phone's way to pass a file on: WeChat and QQ are one
  // tap away, whereas a Downloads folder is several steps and hard to find again.
  // A browser has no share sheet, so the action is gated on the app's own marker
  // in the user agent rather than shown to everyone and doing nothing there.
  assert.ok(source.includes('share=1'), 'the forward link must be built');
  assert.ok(source.includes('转发'), 'and labelled');
  // The served script must still parse: the regex in it is written with a doubled
  // backslash, and a single one would be swallowed by the template literal here
  // and ship as /PulseApp// — which is how this assertion came to exist.
  assert.equal(compileError(source), null, 'the forward link must not break the script');
  assert.match(source, /PulseApp\\\//, 'gated on the app marker in the user agent');
});

test('the generated pages and manifest are well formed', () => {
  assert.equal(compileError(pulseScript()), null);
  for (const [name, html] of [
    ['gateHtml', gateHtml({ realm: 'Pulse', exposed: true })],
    ['indexHtml', indexHtml({ realm: 'Pulse', exposed: true })],
  ]) {
    assert.ok(html.startsWith('<!doctype html>'), `${name} should start with a doctype`);
    assert.ok(html.includes('</html>'), `${name} should be closed`);
    assert.ok(!/undefined|null/.test(html.match(/<title>[^<]*<\/title>/)?.[0] ?? ''), `${name} title should be set`);
  }

  const css = pulseStylesheet();
  assert.ok(css.includes('{') && css.includes('}'), 'stylesheet should have rules');
  assert.equal(css.includes('</style'), false);

  const manifest = JSON.parse(manifestJson({ realm: 'Pulse' }));
  assert.equal(manifest.display, 'standalone');
  assert.equal(typeof manifest.name, 'string');
});

test('a realm containing markup cannot escape the page', () => {
  // The realm is user configuration and is interpolated into HTML.
  const hostile = '<script>alert(1)</script>';
  const html = gateHtml({ realm: hostile, exposed: false });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'gate page must escape the realm');
  const console_ = indexHtml({ realm: hostile, exposed: false });
  assert.ok(!console_.includes('<script>alert(1)</script>'), 'console must escape the realm');
  // The stylesheet is static and carries no configuration.
  assert.equal(pulseStylesheet().includes(hostile), false);
});
