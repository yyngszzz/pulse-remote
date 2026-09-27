#!/usr/bin/env node
/**
 * What browser engine does the official client actually require?
 *
 *   node scripts/verify-engine-floor.mjs [pulseBaseUrl]
 *
 * The Android shell loads the official client in a WebView, so any modern syntax
 * in the shell or its bundles is a hard floor on the phone's WebView version. A
 * phone below that floor shows a **blank screen with no error anywhere** — the
 * client throws on its first line and nothing tells the user why.
 *
 * The floor is therefore a real, measurable property of a deployment, not a
 * guess: this script measures it from the bytes the server actually serves and
 * compares it against the number baked into the Android app
 * (`../pulse-android/build.json`). When the harness is upgraded and starts using
 * newer syntax, this reports it here — instead of it being discovered as a blank
 * screen on someone's phone.
 *
 * Read-only: it pairs a device to read through the gate, then revokes it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localHeaders } from './local-operator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const base = (args.find(argument => !argument.startsWith('--')) ?? process.env.PULSE_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');
const localBase = (process.env.PULSE_LOCAL_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

/**
 * Feature → the Chrome major version that first shipped it.
 *
 * Only features that would *throw* or silently change behaviour on an older
 * engine are listed; a feature that merely degrades is not a floor.
 */
const FEATURES = [
  ['Array.fromAsync', /Array\s*\.\s*fromAsync/, 121],
  ['Promise.withResolvers', /Promise\s*\.\s*withResolvers/, 119],
  ['Object.groupBy', /Object\s*\.\s*groupBy/, 117],
  ['RegExp unicode sets /v', /\/\[[^\]]*\]\/[a-z]*v[a-z]*/, 112],
  ['String.prototype.isWellFormed', /\.\s*isWellFormed\s*\(/, 111],
  ['structuredClone', /structuredClone\s*\(/, 98],
  ['Array.prototype.findLast', /\.\s*findLast\s*\(/, 97],
  ['Object.hasOwn', /Object\s*\.\s*hasOwn\s*\(/, 93],
  ['Array.prototype.at', /\.\s*at\s*\(\s*-/, 92],
  ['RegExp match indices /d', /\/[a-z]*d[a-z]*[gimsuy]*[,;)]/, 90],
  ['top-level await', /^\s*await\s/m, 89],
  ['logical assignment ??=', /\?\?=/, 85],
  ['String.replaceAll', /\.replaceAll\s*\(/, 85],
  ['WeakRef', /new\s+WeakRef\s*\(/, 84],
  ['optional chaining ?.', /\?\.[a-zA-Z_$[]/, 80],
  ['nullish coalescing ??', /[^?]\?\?[^?=]/, 80],
  ['private class fields', /#[a-zA-Z_$][\w$]*\s*[=;]/, 74],
];

/**
 * Find every feature present in a source and the highest version required.
 * @param {string} text - the source.
 * @returns {{floor: number, hits: Array<{name: string, version: number}>}} the finding.
 */
function analyse(text) {
  const hits = [];
  for (const [name, pattern, version] of FEATURES) {
    if (pattern.test(text)) hits.push({ name, version });
  }
  hits.sort((a, b) => b.version - a.version);
  return { floor: hits.length ? hits[0].version : 0, hits };
}

console.log(`官方客户端引擎下限检测  base=${base}`);
console.log('');

// ---- read the shell through the gate -----------------------------------------

const opened = await fetch(`${localBase}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const pairResponse = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'engine-floor' }),
});
const paired = await pairResponse.json();
const cookie = (pairResponse.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';

let floor = 0;
let worst = null;

try {
  const shell = await fetch(`${base}/`, { headers: { cookie } }).then(r => r.text());
  const shellResult = analyse(shell);
  console.log(`  外壳 HTML      : Chrome ${shellResult.floor}+   (${shellResult.hits.slice(0, 3).map(h => h.name).join(', ')})`);
  if (shellResult.floor > floor) {
    floor = shellResult.floor;
    worst = { where: '外壳 HTML', hit: shellResult.hits[0] };
  }

  // Bundle URLs are taken verbatim from the shell: the loader's path form is not
  // guessable, and a wrong guess is indistinguishable from "nothing to see".
  const urls = [...new Set([...shell.matchAll(/(?:src|href)="(\/plugins\/[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&')))];
  console.log(`  客户端包       : 发现 ${urls.length} 个 URL`);
  for (const url of urls) {
    const response = await fetch(`${base}${url}`, { headers: { cookie } });
    if (!response.ok) continue;
    const result = analyse(await response.text());
    const label = url.replace('/plugins/??', '').split(',')[0].split('/')[0];
    console.log(`    ${label.padEnd(46)} Chrome ${result.floor}+`);
    if (result.floor > floor) {
      floor = result.floor;
      worst = { where: label, hit: result.hits[0] };
    }
  }
} finally {
  await fetch(`${localBase}/api/local/devices/${paired.deviceId}`, { method: 'DELETE', headers: localHeaders() });
}

// ---- compare with what the app demands ---------------------------------------

const buildConfig = join(here, '..', '..', 'pulse-android', 'build.json');
let declared = null;
if (existsSync(buildConfig)) {
  try {
    declared = Number(JSON.parse(readFileSync(buildConfig, 'utf8')).requiredChrome) || null;
  } catch {
    declared = null;
  }
}

console.log('');
console.log(`  实测下限       : Chrome ${floor}+`);
if (worst) console.log(`  卡住它的是     : ${worst.hit.name}（${worst.where}）`);
if (declared) console.log(`  App 里声明的   : Chrome ${declared}+`);

let failed = 0;
if (floor === 0) {
  console.log('  ⚠ 一个特征都没匹配到，说明检测规则和官方产物已经脱节，请更新 FEATURES');
  failed += 1;
}
if (declared && floor > declared) {
  console.log('');
  console.log(`  ✗ 官方客户端现在需要 Chrome ${floor}+，而 App 只检查到 ${declared}。`);
  console.log('    手机上会白屏。把 pulse-android/build.json 的 requiredChrome 改成 ' + floor + ' 并重新构建。');
  failed += 1;
} else if (declared && floor < declared) {
  console.log('');
  console.log(`  ⚠ App 声明的下限（${declared}）高于实测（${floor}），可能把能用的手机挡在外面。`);
}
if (floor > 0 && !declared) {
  console.log('  （没找到 pulse-android/build.json，只报告实测值）');
}

console.log('');
console.log(failed === 0 ? '一致' : `${failed} 项需要注意`);
process.exitCode = failed === 0 ? 0 : 1;
