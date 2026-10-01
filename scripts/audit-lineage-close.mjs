#!/usr/bin/env node
/**
 * How does the subagent chip's list actually close?
 *
 *   node scripts/audit-lineage-close.mjs [--url http://127.0.0.1:3199]
 *
 * The phone reports the same thing twice: tapping the chip opens its list, and there is no way to
 * put it away again. Rather than guessing a fourth mechanism, this asks the client directly, in
 * order, and reports which one closes it:
 *
 *   1. Escape
 *   2. a click outside the list
 *   3. clicking the chip again
 *
 * The session is chosen by the chip's own wording in the session list ("N 个子智能体" appears there
 * while one runs), because the probe cannot be handed a Chinese regex on the command line — Windows
 * PowerShell mangles non-ASCII arguments, which is how three earlier runs picked an empty session.
 *
 * @module dsh-remote-pulse/scripts/audit-lineage-close
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

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const executablePath = process.env.PULSE_BROWSER ?? BROWSERS.find(candidate => existsSync(candidate));
if (!executablePath) {
  console.error('set PULSE_BROWSER to msedge.exe');
  process.exit(2);
}

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'audit-lineage-close' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 880, deviceScaleFactor: 2 });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13');
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 3500));

  const picked = await page.evaluate(async () => {
    const openDrawer = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /打开侧边栏|显示侧边栏/i.test(node.getAttribute('aria-label') || ''));
    if (openDrawer) openDrawer.click();
    await new Promise(r => setTimeout(r, 900));
    const rows = () => [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const matches = node => /个智能体/.test(node.textContent || '');
    let target = rows().find(matches);
    if (!target) {
      const more = [...document.querySelectorAll('button,[role="button"]')]
        .find(node => /展开其余|显示更多|Show more/i.test((node.getAttribute('aria-label') || '') + (node.textContent || '')));
      if (more) { more.click(); await new Promise(r => setTimeout(r, 800)); }
      target = rows().find(matches);
    }
    if (target) target.click();
    await new Promise(r => setTimeout(r, 9000));
    const close = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /收起侧边栏|关闭侧边栏/i.test(node.getAttribute('aria-label') || ''));
    if (close) close.click();
    await new Promise(r => setTimeout(r, 1200));
    return target ? (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '(none)';
  });
  console.log(`session: ${picked}`);

  /** Everything that could be the subagent list, visible right now. */
  const lists = () => page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[class*="ZKlsPq"], [role="menu"], [class*="_menu"]')];
    return nodes
      .filter(node => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map(node => ({
        cls: String(node.className || '').slice(0, 40),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        box: (() => { const r = node.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; })(),
      }));
  });

  const chipBox = await page.evaluate(() => {
    const slot = document.querySelector('[data-slot*="header.lineage"]');
    const chip = slot ? slot.querySelector('button') : null;
    if (!chip) return null;
    const rect = chip.getBoundingClientRect();
    return [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)];
  });
  if (!chipBox) {
    console.log('这一屏没有子代理 chip（需要一个正在运行的子代理），先停在这里');
    process.exit(0);
  }

  console.log(`before any click: ${JSON.stringify(await lists())}`);
  await page.mouse.click(chipBox[0], chipBox[1]);
  await new Promise(r => setTimeout(r, 900));
  const afterClick = await lists();
  console.log(`after tapping the chip: ${JSON.stringify(afterClick)}`);
  if (afterClick.length === 0) {
    console.log('点了 chip 也没有列表出现 —— 那"打不开"是另一个问题，先报告这个');
    process.exit(0);
  }

  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 700));
  const afterEscape = await lists();
  console.log(`after Escape: ${JSON.stringify(afterEscape)} → ${afterEscape.length === 0 ? '关掉了 ✓' : '没关掉 ✗'}`);
  if (afterEscape.length === 0) {
    console.log('\n结论：Escape 有效 —— 外壳的"点第二下关闭"就该用它');
    process.exit(0);
  }

  await page.mouse.click(200, 500);
  await new Promise(r => setTimeout(r, 700));
  const afterOutside = await lists();
  console.log(`after clicking outside: ${JSON.stringify(afterOutside)} → `
    + `${afterOutside.length === 0 ? '关掉了 ✓' : '没关掉 ✗'}`);
  if (afterOutside.length === 0) {
    console.log('\n结论：点外面有效 —— 外壳的"点第二下关闭"该用真实点击而不是合成事件');
    process.exit(0);
  }

  await page.mouse.click(chipBox[0], chipBox[1]);
  await new Promise(r => setTimeout(r, 700));
  const afterSecond = await lists();
  console.log(`after tapping the chip again: ${JSON.stringify(afterSecond)} → `
    + `${afterSecond.length === 0 ? '关掉了 ✓' : '没关掉 ✗'}`);
  console.log(afterSecond.length === 0
    ? '\n结论：再点一次就能关 —— 那外壳什么都不用做，问题在别处（比如点没落到按钮上）'
    : '\n结论：三种关法都不行 —— 外壳需要自己把这个列表藏起来（并说明代价）');
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
