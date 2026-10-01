#!/usr/bin/env node
/**
 * Why are the header chips in the title row on the phone right now?
 *
 *   node scripts/audit-served-chips.mjs [--url http://127.0.0.1:3199] [--width 390] [--session 自动剪辑]
 *
 * This one deliberately injects **nothing**: every other probe replaces the served shell with
 * the build on disk so it can test the working tree, which means none of them can answer "what
 * is the phone actually running, and what did it decide". This asks the served page itself, so
 * the answer is the phone's own.
 *
 * It reports the shell's decision (`state.headerActions`), the arithmetic behind it (the last
 * tab's right edge, the strip's gap, the chips' widths, the room left), the title row's children
 * with their widths, and any page error — because "the chips did not move" has several causes
 * and they need different fixes.
 *
 * @module dsh-remote-pulse/scripts/audit-served-chips
 */

import { existsSync } from 'node:fs';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : String(args[at + 1] ?? fallback);
};

const base = flag('--url', process.env.PULSE_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');
const width = Number(flag('--width', '390'));
const wanted = flag('--session', 'any');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const executablePath = process.env.PULSE_BROWSER ?? BROWSERS.find(candidate => existsSync(candidate));
if (!executablePath) {
  console.error('找不到 Chromium 系浏览器。设 PULSE_BROWSER 指向 msedge.exe。');
  process.exit(2);
}

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'audit-served-chips' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error && error.message ? error.message : error).slice(0, 200)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 160)}`);
  });
  await page.setViewport({ width, height: 844, deviceScaleFactor: 2 });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13');
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 3000));

  // Which build is the phone running? The debug handle's keys are the fingerprint of a build.
  const build = await page.evaluate(() => {
    const debug = window.__PULSE_SHELL_DEBUG__;
    if (!debug) return { shell: '(没有外壳)' };
    return {
      shell: '有',
      keys: Object.keys(debug).sort().join(','),
      hasBootPoll: typeof debug.pollBoot === 'function',
      hasZoomLock: typeof debug.lockViewportScale === 'function',
      hasReloadFloor: typeof debug.mayReload === 'function',
      hasPrePaintHold: typeof debug.holdHeaderPlacement === 'function',
    };
  });
  console.log(`外壳指纹：${JSON.stringify(build, null, 2)}`);

  await page.evaluate(async () => {
    const toggle = [...document.querySelectorAll('button,[role="button"],.pulse-burger')]
      .find(node => /打开侧边栏|显示侧边栏|侧边栏|Open sidebar/i.test(
        (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')));
    if (toggle) toggle.click();
    await new Promise(r => setTimeout(r, 900));
  });
  const picked = await page.evaluate(async pattern => {
    const rows = () => [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const match = pattern === 'any' ? null : new RegExp(pattern);
    const find = () => (match ? rows().find(node => match.test(node.textContent || '')) : null);
    let found = find() || (match ? null : rows()[0]);
    for (let attempt = 0; !found && attempt < 4; attempt += 1) {
      const more = [...document.querySelectorAll('button,[role="button"]')]
        .find(node => /展开其余|显示更多|更多会话|Show more|Expand/i.test(
          (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')));
      if (!more) break;
      more.click();
      await new Promise(r => setTimeout(r, 700));
      found = find();
    }
    found = found || rows()[0];
    window.__PULSE_PICKED__ = found ? (found.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44) : '(none)';
    if (found) found.click();
    await new Promise(r => setTimeout(r, 9000));
    return window.__PULSE_PICKED__;
  }, wanted);
  await page.evaluate(async () => {
    const toggle = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /收起侧边栏|关闭侧边栏|Close sidebar/i.test(node.getAttribute('aria-label') || ''));
    if (toggle) toggle.click();
    await new Promise(r => setTimeout(r, 1500));
  });
  console.log(`会话：${picked}`);

  const report = await page.evaluate(() => {
    const debug = window.__PULSE_SHELL_DEBUG__;
    const boxOf = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        left: Math.round(rect.left), right: Math.round(rect.right),
        top: Math.round(rect.top), bottom: Math.round(rect.bottom),
        width: Math.round(rect.width), height: Math.round(rect.height),
      };
    };
    const row = debug && debug.headerRow ? debug.headerRow() : null;
    const items = debug && debug.headerItems ? debug.headerItems() : [];
    const tabs = row ? row.tabs : null;
    const strip = tabs ? tabs.getBoundingClientRect() : null;
    const style = tabs ? getComputedStyle(tabs) : null;
    const gap = style ? (parseFloat(style.columnGap || style.gap) || 0) : null;
    let limitLeft = 0;
    const tabLabels = [];
    if (tabs) {
      for (const node of tabs.querySelectorAll('button,[role="tab"]')) {
        const rect = node.getBoundingClientRect();
        tabLabels.push(`「${(node.textContent || '').trim().slice(0, 8)}」${Math.round(rect.width)}px@${Math.round(rect.left)}-${Math.round(rect.right)}`);
        if (items.some(item => item.node === node || item.node.contains(node))) continue;
        if (rect.width > 0 && rect.right > limitLeft) limitLeft = rect.right;
      }
    }
    const measured = items.map(item => {
      const rect = item.measure.getBoundingClientRect();
      return {
        text: (item.node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22),
        width: Math.round(rect.width),
        inGroup: Boolean(debug.headerGroup && debug.headerGroup() && item.node.parentElement === debug.headerGroup()),
        parent: item.node.parentElement ? String(item.node.parentElement.className || '').slice(0, 20) : '(无)',
      };
    });
    const counted = measured.filter(entry => entry.width > 0);
    const chips = counted.reduce((sum, entry) => sum + entry.width, 0) + (counted.length > 1 ? 6 * (counted.length - 1) : 0);
    const titleRow = document.querySelector('header [class*="_titleRow"]');
    return {
      state: debug ? debug.headerActions() : '(没有外壳)',
      width: window.innerWidth,
      strip: boxOf(tabs),
      gap,
      limitLeft,
      tabLabels,
      room: strip ? Math.round(strip.right - (limitLeft || strip.left) - (gap || 0) - 8) : null,
      chips,
      measured,
      titleRow: titleRow ? [...titleRow.children].map(node => ({
        cls: String(node.className || '').slice(0, 22),
        ...boxOf(node),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      })) : [],
      crumbs: boxOf(document.querySelector('header [class*="_crumbs"]')),
      group: boxOf(document.querySelector('[data-pulse-header-group]')),
      bodyWidth: document.body.clientWidth,
      rightbar: (() => {
        const node = document.querySelector('[class*="_rightbarCol"]');
        return node ? boxOf(node) : null;
      })(),
    };
  });

  console.log(`\n外壳决定：${report.state}`);
  console.log(`视口 ${report.width}px，body ${report.bodyWidth}px，右栏 ${report.rightbar ? `${report.rightbar.width}px` : '没有'}`);
  console.log(`页签行 ${report.strip ? `${report.strip.left}..${report.strip.right} (${report.strip.width}px)` : '(没有)'}，gap=${report.gap}`);
  console.log(`页签：${report.tabLabels.join('  ')}`);
  console.log(`最后一个页签右边=${report.limitLeft}，空档=${report.room}px，要搬的 chip 合起来=${report.chips}px`);
  console.log('要搬的 chip：');
  for (const entry of report.measured) {
    console.log(`  ${entry.width}px 「${entry.text}」 在组里=${entry.inGroup} 父=${entry.parent}`);
  }
  console.log('标题行的孩子：');
  for (const child of report.titleRow) {
    console.log(`  ${child.cls} ${child.width}x${child.height}@${child.left} 「${child.text}」`);
  }
  console.log(`标题容器 ${report.crumbs ? `${report.crumbs.width}px` : '(没有)'}，我们的组=${report.group ? `${report.group.width}px@${report.group.left}` : '没有'}`);
  console.log(`页面错误：${errors.length ? errors.slice(0, 5).join(' | ') : '无'}`);
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
