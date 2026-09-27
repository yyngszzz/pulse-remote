#!/usr/bin/env node
/**
 * Verify the narrow-screen layer is actually live, and still anchored.
 *
 *   node scripts/verify-mobile-layer.mjs [pulseBaseUrl] [--insecure]
 *
 * Two questions, both of which can silently go wrong:
 *
 *   1. **Is the stylesheet in the served document?** A `{kind:'style'}` row that
 *      the renderer drops leaves no error anywhere — the phone just looks
 *      cramped, exactly as before.
 *   2. **Do the official class prefixes still exist?** The official sheet is CSS
 *      modules, so a hash change is invisible to substring selectors (good) but
 *      a *rename* is silent (bad). Every anchor the layer depends on is checked
 *      against the CSS the shell actually references, and a missing one is
 *      reported as drift rather than discovered by eye on a phone.
 *
 * Read-only: it pairs a device to read the shell through the gate, then revokes
 * it.
 */

import { localHeaders } from './local-operator.mjs';
import { MOBILE_ANCHORS, mobileStylesheet } from '../lib/mobile.js';
import { pulseScript } from '../lib/ui.js';
import { deliverableActionsScript, fileLinkActionsScript, mobileShellScript, mobileShellStyles, previewActionsScript, ATTACH_LABELS, SHELL_ANCHORS } from '../lib/mobile-shell.js';

const args = process.argv.slice(2);
if (args.includes('--insecure')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('warn: TLS verification disabled (--insecure)');
}

const base = (args.find(argument => !argument.startsWith('--')) ?? process.env.PULSE_BASE ?? 'http://127.0.0.1:3199').replace(
  /\/+$/,
  '',
);
const localBase = (process.env.PULSE_LOCAL_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

const results = [];
/**
 * Record a check.
 * @param {string} name - what was checked.
 * @param {boolean} ok - whether it passed.
 * @param {string} detail - evidence.
 * @returns {void}
 */
function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
}

/** Marker the injected sheet carries, so its presence is unambiguous. */
const MARKER = 'Pulse mobile layer';

// ---- pair a throwaway device so the shell can be read through the gate ------

const opened = await fetch(`${localBase}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r =>
  r.json(),
);
const pairResponse = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'verify-mobile' }),
});
const paired = await pairResponse.json();
const cookie = (pairResponse.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
record('配对成功', pairResponse.status === 200, `status=${pairResponse.status} device=${paired.deviceId}`);

try {
  const shellResponse = await fetch(`${base}/`, { headers: { cookie } });
  const html = await shellResponse.text();
  record('拿到官方外壳', shellResponse.status === 200 && /__DSH_BOOT__/.test(html), `len=${html.length}`);

  // ---- 1. is the sheet in the document? ------------------------------------

  const headEnd = html.indexOf('</head>');
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const inHead = head.includes(MARKER);
  const anywhere = html.includes(MARKER);

  record('窄屏样式表已注入', anywhere, anywhere ? 'found' : 'NOT FOUND — the style row was dropped');
  record('样式表在 <head> 内', inHead, inHead ? 'before </head>' : 'present but not in head (FOUC)');

  if (anywhere) {
    // The rendered sheet must still be scoped, not accidentally global.
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]);
    const sheet = styleBlocks.find(block => block.includes(MARKER)) ?? '';
    record('样式表未被截断', /@media \(max-width: \d+px\)/.test(sheet), `sheet len=${sheet.length}`);
    record('每个断点都在', (sheet.match(/@media/g) ?? []).length >= 3, `${(sheet.match(/@media/g) ?? []).length} media queries`);
    record('没有越界的 </style', !/<\/style/i.test(sheet.replace(/<\/style>$/i, '')), 'contract respected');

    // Comparing only the injected script is not enough to say the process is
    // current: a change to a stylesheet leaves the script byte-identical while
    // the phone keeps the old rules. Both rows are therefore compared, and the
    // served text is compared rather than merely searched for markers.
    const currentSheet = mobileStylesheet();
    const sheetCurrent = sheet.trim() === currentSheet.trim();
    record('运行中的进程下发的窄屏样式是磁盘上这份', sheetCurrent,
      sheetCurrent ? `len=${currentSheet.length}，一致` : `进程里是 len=${sheet.length}，磁盘上是 len=${currentSheet.length}`);

    const shellSheet = styleBlocks.find(block => block.includes('pulse-burger')) ?? '';
    const currentShellSheet = mobileShellStyles();
    const shellSheetCurrent = shellSheet.trim() === currentShellSheet.trim();
    record('运行中的进程下发的外壳样式是磁盘上这份', shellSheetCurrent,
      shellSheetCurrent ? `len=${currentShellSheet.length}，一致` : `进程里是 len=${shellSheet.length}，磁盘上是 len=${currentShellSheet.length}`);
    if (!sheetCurrent || !shellSheetCurrent) {
      console.log('');
      console.log('  ⚠ 有样式表还没生效：webserver 注入的内容是插件进程启动时定格的，');
      console.log('    重启 DSH 之后手机才会拿到这份改动。真浏览器验证不受影响：');
      console.log('    node scripts/verify-mobile-shell.mjs');
      console.log('');
    }
  }

  // ---- 2. do the anchors still exist? --------------------------------------

  const cssHrefs = [...new Set([...html.matchAll(/href="([^"]*\.css[^"]*)"/g)].map(match => match[1]))];
  record('外壳引用了样式表', cssHrefs.length > 0, cssHrefs.join(', '));

  let allCss = '';
  for (const href of cssHrefs) {
    try {
      const css = await fetch(new URL(href, `${base}/`).href, { headers: { cookie } }).then(r => r.text());
      allCss += `\n${css}`;
      record(`  拉取 ${href}`, true, `len=${css.length}`);
    } catch (error) {
      record(`  拉取 ${href}`, false, String(error?.message ?? error));
    }
  }

  const missing = MOBILE_ANCHORS.filter(anchor => !allCss.includes(anchor.prefix));
  record(
    `官方类名锚点全部命中（${MOBILE_ANCHORS.length} 个）`,
    missing.length === 0,
    missing.length === 0
      ? MOBILE_ANCHORS.map(anchor => anchor.prefix).join(' ')
      : `MISSING: ${missing.map(anchor => `${anchor.prefix} (${anchor.purpose})`).join('; ')}`,
  );

  if (missing.length > 0) {
    console.log('');
    console.log('  漂移了：官方改了这些类名，对应规则已经不再生效。更新 lib/mobile.js 的 MOBILE_ANCHORS。');
  }

  // ---- 3. is the mobile shell actually being served? ------------------------

  // The shell is a second pair of rows (its own stylesheet and script), and it is
  // the half that turns the sidebar into a drawer. A row the renderer drops leaves
  // no error anywhere, so its presence is asserted rather than assumed.
  const shellScript = html.includes('__PULSE_SHELL__');
  const shellCss = html.includes('pulse-burger');
  record('移动外壳脚本已下发', shellScript, shellScript ? 'found' : 'NOT FOUND — 插件还没重启，或那一行被丢了');
  record('移动外壳样式已下发', shellCss, shellCss ? 'found' : 'NOT FOUND');

  if (shellScript) {
    const scriptBlock = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1])
      .find(block => block.includes('__PULSE_SHELL__')) ?? '';
    record('外壳脚本位于 body', scriptBlock.length > 0, `len=${scriptBlock.length}`);

    // The webserver inject payload is captured when the plugin loads, so a
    // long-running DSH keeps serving the shell as it looked at process start.
    // Comparing against the source on disk is the only check that distinguishes
    // "the shell is broken" from "this process is serving an older build" — and
    // an anchor-by-anchor check reports the second as five unrelated failures.
    const current = mobileShellScript();
    const identical = scriptBlock === current;
    record(
      '运行中的进程下发的是磁盘上这份外壳',
      identical,
      identical
        ? `len=${current.length}，一致`
        : `进程里是 len=${scriptBlock.length}，磁盘上是 len=${current.length} → 需要重启 DSH 才会生效`,
    );
    if (!identical) {
      console.log('');
      console.log('  ⚠ 下面这些锚点检查针对的是进程里的旧外壳，失败只说明「该重启了」，');
      console.log('    不代表磁盘上的代码有问题。真浏览器验证不受影响：');
      console.log('    node scripts/verify-mobile-shell.mjs');
      console.log('');
    }

    // Every anchor the shell needs, checked against the bytes the phone receives.
    for (const anchor of SHELL_ANCHORS) {
      record(`  外壳锚点 ${anchor.prefix}`, scriptBlock.includes(anchor.prefix) || html.includes(anchor.prefix), anchor.purpose);
    }
    // The attach control is found by accessible name; the labels must survive.
    const labelsPresent = ATTACH_LABELS.filter(label => scriptBlock.includes(label));
    record(
      '添加入口的可访问名已内置',
      labelsPresent.length >= 3,
      labelsPresent.join(' / '),
    );
    record('外壳脚本没有越界闭合', !/<\/script/i.test(scriptBlock), 'contract respected');
  }

  // ---- 4. is the process serving the client it has on disk? -----------------
  //
  // The console page at /pulse is generated per request, which makes it look live
  // — but it is generated by a function loaded into memory when the plugin started,
  // so editing lib/ui.js changes nothing until a restart. That is exactly how the
  // forward action was written, tested, and still absent from what the phone got.
  const servedClient = await fetch(`${base}/pulse.js`, { headers: { cookie } }).then(r => r.text());
  const currentClient = pulseScript();
  const clientCurrent = servedClient === currentClient;
  record('运行中的进程下发的手机客户端是磁盘上这份', clientCurrent,
    clientCurrent
      ? `len=${currentClient.length}，一致`
      : `进程里是 len=${servedClient.length}，磁盘上是 len=${currentClient.length} → 需要重启 DSH 才会生效`);
  // Every injected row is captured when the plugin loads, so a row that changed is
  // served in its old form. Comparing each one is the difference between "the button
  // now points at the host file route" and "the running process still points at the
  // allowlist that answered 403". The shell script can be byte-identical while a
  // separate row like this one is stale, which is exactly how it slipped past.
  for (const [label, marker, current] of [
    ['交付卡片按钮', '__PULSE_DELIVERABLES__', deliverableActionsScript()],
    ['预览头部按钮', '__PULSE_PREVIEW__', previewActionsScript()],
    ['会话文件链接按钮', '__PULSE_FILE_LINKS__', fileLinkActionsScript()],
  ]) {
    const servedRow = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1])
      .find(block => block.includes(marker)) ?? '';
    const same = servedRow === current;
    record(`运行中的进程下发的${label}是磁盘上这份`, same,
      same
        ? `len=${current.length}，一致`
        : `进程里是 len=${servedRow.length}，磁盘上是 len=${current.length} → 需要重启 DSH 才会生效`);
  }

  // The whole set, not just the rows this build still has.
  //
  // Comparing each expected row catches a row that changed, and says nothing about a
  // row that was *deleted*: after the sidebar's「文件与下载」entry was removed the
  // disk had six rows and the running process kept serving seven, with every check
  // above still green — including the byte-for-byte comparisons. So the marker set
  // itself is the assertion, and a leftover row is named.
  const expectedMarkers = [
    // The host-mode script is the one row that is not a `= true` guard: it assigns an
    // object, so it is read from the served text directly below.
    '__PULSE_SHELL__', // the mobile shell
    '__PULSE_DELIVERABLES__', // the deliverables card action
    '__PULSE_PREVIEW__', // the opened file's header action
    '__PULSE_FILE_LINKS__', // the transcript file-link action
  ].sort();
  // The marker is the row's own idempotence guard (`window.__X__ = true`), not any
  // `__X__` in the text: the shell also publishes `window.__PULSE_SHELL_DEBUG__ = {…}`
  // for the probes, and a looser match counted that as a row of its own.
  const guardPattern = /window\.(__[A-Z][A-Z_]*__)\s*=\s*true/g;
  const servedMarkers = [...new Set(
    [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
      .flatMap(match => [...match[1].matchAll(guardPattern)].map(found => found[1])),
  )].sort();
  const absent = expectedMarkers.filter(marker => !servedMarkers.includes(marker));
  const leftover = servedMarkers.filter(marker => !expectedMarkers.includes(marker));
  record('运行中的进程下发的注入行，正好是磁盘上这些（多一行少一行都报出来）',
    absent.length === 0 && leftover.length === 0 && html.includes('__DSH_REMOTE_PULSE__'),
    absent.length || leftover.length || !html.includes('__DSH_REMOTE_PULSE__')
      ? `${absent.length ? `少了 ${absent.join(' ')}` : ''}`
        + `${leftover.length ? ` 多了 ${leftover.join(' ')} → 需要重启 DSH` : ''}`
        + `${html.includes('__DSH_REMOTE_PULSE__') ? '' : ' 少了主机模式那一条'}`
      : `${servedMarkers.length + 1} 行：__DSH_REMOTE_PULSE__ ${servedMarkers.join(' ')}`);

  if (!clientCurrent) {
    console.log('');
    console.log('  ⚠ /pulse.js 虽然是每次请求现生成的，但用的是插件启动时载入内存的那份函数，');
    console.log('    所以改了 lib/ui.js 同样要重启 DSH，不会自己生效。');
    console.log('');
  }
} finally {
  await fetch(`${localBase}/api/local/devices/${paired.deviceId}`, { method: 'DELETE', headers: localHeaders() });
}

// ---- report -----------------------------------------------------------------

console.log(`Pulse 窄屏适配层验证  base=${base}`);
console.log('');
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? `   (${result.detail})` : ''}`);
}
console.log('');
console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
