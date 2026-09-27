#!/usr/bin/env node
/**
 * Audit every scroll container in a live conversation for touch-scroll traps.
 *
 *   node scripts/audit-gestures.mjs [--url http://127.0.0.1:3199] [--session <id>]
 *
 * ## Why this exists
 *
 * The reported symptom was "once the conversation is scrolled to a wide table,
 * it stops scrolling up and down". That is a gesture-routing symptom, and its
 * cause is always one of a small set of CSS facts about the element under the
 * finger — never about the element's appearance. So this prints those facts for
 * every scroller on the page rather than describing the layout:
 *
 *   * `touch-action` — `pan-x` or `none` on a horizontally scrollable box is the
 *     classic way a wide table swallows vertical swipes;
 *   * `overscroll-behavior` — `contain`/`none` stops a flick from chaining to the
 *     conversation once the inner box hits its edge;
 *   * which axis each box actually overflows on, and by how much.
 *
 * It also prints the official stylesheet's own gesture rules, because the answer
 * is often there rather than in our layer.
 *
 * @module pulse-remote/scripts/audit-gestures
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';

const args = process.argv.slice(2);

/**
 * Read a flag's value.
 * @param {string} name - flag name.
 * @param {string} fallback - value when absent.
 * @returns {string} the value.
 */
function flag(name, fallback) {
  const at = args.indexOf(name);
  return at === -1 ? fallback : String(args[at + 1] ?? fallback);
}

const base = flag('--url', process.env.PULSE_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');
const sessionId = flag('--session', '');
const dumpAll = args.includes('--all');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
].filter(Boolean);

const executablePath = process.env.PULSE_BROWSER ?? BROWSERS.find(candidate => existsSync(candidate));
if (!executablePath) {
  console.error('找不到 Chromium 系浏览器。设 PULSE_BROWSER 指向 msedge.exe / chrome.exe。');
  process.exit(2);
}

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'gesture-audit' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setCookie({ name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1), domain: new URL(base).hostname, path: '/' });
  // Disarm the shell the running plugin injects, so what is measured is the
  // official client plus whatever the source on disk adds (installed below).
  await page.evaluateOnNewDocument(() => { window.__PULSE_SHELL__ = true; });
  await page.goto(`${base}/${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 2500));

  // ---- official stylesheet gesture rules -----------------------------------

  const hrefs = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute('href')));
  console.log(`官方样式表 ${hrefs.length} 张：`);
  for (const href of hrefs) {
    const css = await fetch(new URL(href, base).href, { headers: { cookie } }).then(r => r.text());
    const blocks = css.split('}').map(block => block.trim())
      .filter(block => /touch-action|overscroll-behavior|overflow-scrolling/.test(block));
    console.log(`  ${href}  len=${css.length}  手势相关规则 ${blocks.length} 条`);
    for (const block of blocks) console.log(`     ${block.replace(/\s+/g, ' ').slice(0, 200)}}`);
  }

  // ---- every scroll container the conversation actually has ----------------

  const scrollers = await page.evaluate((includeAll) => {
    const nodes = [...document.querySelectorAll('*')].filter(node => {
      const style = getComputedStyle(node);
      const scrollable = /(auto|scroll|overlay)/.test(style.overflowX + style.overflowY);
      const overflows = node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
      return includeAll ? scrollable || overflows : overflows;
    });
    return nodes.slice(0, 40).map(node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        cls: String(node.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 2).join(' ')
          || node.tagName.toLowerCase(),
        tag: node.tagName.toLowerCase(),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        overflow: `${style.overflowX}/${style.overflowY}`,
        touchAction: style.touchAction,
        overscroll: `${style.overscrollBehaviorX}/${style.overscrollBehaviorY}`,
        scrollableX: node.scrollWidth - node.clientWidth,
        scrollableY: node.scrollHeight - node.clientHeight,
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      };
    });
  }, dumpAll);

  console.log('');
  console.log(`页面上会滚动的盒子（${scrollers.length} 个）：`);
  for (const box of scrollers) {
    console.log(`  ${box.cls} <${box.tag}> ${box.w}x${box.h} overflow=${box.overflow} touch-action=${box.touchAction} overscroll=${box.overscroll} 可滚 x=${box.scrollableX} y=${box.scrollableY}`);
    if (box.text) console.log(`      文字: ${box.text}`);
  }

  const suspicious = scrollers.filter(box => box.touchAction !== 'auto' || box.overscroll !== 'auto/auto');
  console.log('');
  if (suspicious.length) {
    console.log('非默认手势设置的盒子（就是会吞手势的嫌疑人）：');
    for (const box of suspicious) {
      console.log(`  ${box.cls} touch-action=${box.touchAction} overscroll=${box.overscroll}`);
    }
  } else {
    console.log('没有盒子的 touch-action / overscroll-behavior 被改过。');
  }
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
