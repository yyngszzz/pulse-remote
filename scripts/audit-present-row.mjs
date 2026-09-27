#!/usr/bin/env node
/**
 * Throwaway probe: does the delivered-file row still work after the history is loaded?
 *
 *   node scripts/tmp-probe-present-row.mjs [--url http://127.0.0.1:3199] [--ua web|phone]
 *
 * The client renders the last turn plus a 加载更早 button, which is the state a phone
 * comes back to after its WebView reloads. So this clicks that button, finds the turn
 * that delivered the APK, and reports both halves of the official UI:
 *
 *   * the turn-tail deliverables card (`[data-presented-file]`, `_menuAnchor`), which is
 *     built from live turn events rather than from the transcript;
 *   * the `present` tool row (`_paths`), which is transcript data.
 *
 * It also reports what our injector put on each, which is the only way to tell "the
 * client never rendered it" from "our control was missing".
 */

import { existsSync } from 'node:fs';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { mobileStylesheet } from '../lib/mobile.js';
import { deliverableActionsScript, mobileShellScript, mobileShellStyles } from '../lib/mobile-shell.js';

const args = process.argv.slice(2);
const base = (args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://127.0.0.1:3199').replace(/\/+$/, '');
const phone = args.includes('--ua') && args[args.indexOf('--ua') + 1] === 'phone';
/** Apply the real mobile layer, which is the only thing the phone has that the PC does not. */
const layer = args.includes('--layer');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const executablePath = process.env.PULSE_BROWSER ?? BROWSERS.find(candidate => existsSync(candidate));

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'probe-present-row' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

try {
  const page = await browser.newPage();
  await page.setViewport(phone
    ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { width: 1400, height: 900 });
  await page.setUserAgent(phone
    ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2500));
  if (layer) {
    await page.addStyleTag({ content: mobileStylesheet() });
    await page.addStyleTag({ content: mobileShellStyles() });
    await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript());
  }
  // The page already runs the plugin's own snapshot of this script; re-running ours is
  // how the working tree gets measured instead of what the server has cached.
  await page.evaluate(() => { window.__PULSE_DELIVERABLES__ = false; });
  await page.evaluate(source => { window.eval(source); }, deliverableActionsScript());
  await page.evaluate(async () => {
    // At phone width the official client tucks the session list behind a hamburger, so
    // it has to be opened before a session row exists to click.
    const toggle = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /打开侧边栏|显示侧边栏|侧边栏|Open sidebar|menu/i.test(
        (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')));
    if (toggle && document.querySelectorAll('[class*="_sessionRow"]').length === 0) {
      toggle.click();
      await new Promise(r => setTimeout(r, 900));
    }
    const rows = [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const picked = rows.find(node => /手机遥控|WorkBuddy|Pulse|下载/.test(node.textContent || '')) || rows[0];
    window.__PULSE_PICKED__ = picked ? (picked.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '(none)';
    if (picked) picked.click();
  });
  await new Promise(r => setTimeout(r, 9000));
  console.log('会话:', await page.evaluate(() => window.__PULSE_PICKED__));

  // Load the earlier turns — the state the phone is in after its WebView reloads.
  const history = await page.evaluate(async () => {
    const clicks = [];
    for (let round = 0; round < 4; round += 1) {
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .find(node => /^加载更早$/.test((node.textContent || '').trim()));
      if (!button) break;
      button.click();
      clicks.push(round);
      await new Promise(r => setTimeout(r, 2500));
    }
    return { clicks: clicks.length, turns: [...new Set([...document.querySelectorAll('[data-chat-turn]')]
      .map(node => node.getAttribute('data-chat-turn')))].length };
  });
  console.log('加载更早:', JSON.stringify(history));

  const dump = await page.evaluate(async () => {
    const findLabel = () => [...document.querySelectorAll('*')]
      .filter(node => node.children.length === 0 && /^已交付$/.test((node.textContent || '').trim()));
    const rows = [];
    const collect = () => {
      for (const leaf of findLabel()) {
        const row = leaf.closest('[data-disclosure-row]') || leaf.closest('[class*="_row"]') || leaf.parentElement;
        if (!row || rows.some(entry => entry.node === row)) continue;
        rows.push({
          node: row,
          className: String(row.className || ''),
          text: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
          ours: [...row.querySelectorAll('[data-pulse-deliverable]')].map(node => ({
            text: (node.textContent || '').trim(),
            source: node.getAttribute('data-pulse-deliverable-path'),
            href: node.getAttribute('href'),
            inRow: node.parentElement === row,
          })),
        });
      }
    };
    const scan = () => {
      for (const node of document.querySelectorAll('*')) {
        const style = getComputedStyle(node);
        if (!/auto|scroll/.test(style.overflowY) || node.scrollHeight <= node.clientHeight + 40) continue;
        if (!node.querySelector('[data-disclosure-row]')) continue;
        node.scrollTop = node.scrollHeight;
      }
    };
    scan();
    await new Promise(r => setTimeout(r, 600));
    collect();
    const scroller = [...document.querySelectorAll('*')].find(node => {
      const style = getComputedStyle(node);
      return /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40
        && node.querySelector('[data-disclosure-row]');
    });
    for (let step = 0; step < 60 && scroller && scroller.scrollTop > 4; step += 1) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.8);
      await new Promise(r => setTimeout(r, 260));
      collect();
    }

    const cards = [...document.querySelectorAll('[data-presented-file]')].map(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        case: node.getAttribute('data-presented-file'),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        box: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        // Off the right edge is the phone-specific failure worth ruling out: a card laid
        // out wider than the viewport exists in the DOM and is invisible on screen.
        withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1,
        ours: [...node.querySelectorAll('[data-pulse-deliverable]')].map(control => {
          const box = control.getBoundingClientRect();
          return {
            text: (control.textContent || '').trim(),
            href: control.getAttribute('href'),
            visible: box.width > 0 && box.height > 0,
            box: `${Math.round(box.width)}x${Math.round(box.height)}@${Math.round(box.left)},${Math.round(box.top)}`,
          };
        }),
      };
    });
    return {
      hits: rows.map(({ node, ...rest }) => rest),
      turns: [...new Set([...document.querySelectorAll('[data-chat-turn]')]
        .map(node => node.getAttribute('data-chat-turn')))],
      cards,
      viewport: window.innerWidth + 'x' + window.innerHeight,
    };
  });

  console.log('turns rendered:', dump.turns.join(', '));
  console.log('viewport:', dump.viewport);
  console.log('deliverables card:', JSON.stringify(dump.cards, null, 2));
  for (const hit of dump.hits) {
    console.log('\n=== ROW.' + hit.className);
    console.log('text: ' + hit.text);
    console.log('ours: ' + JSON.stringify(hit.ours, null, 2));
  }
  if (dump.hits.length === 0) console.log('没有找到「已交付」这一行');
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
