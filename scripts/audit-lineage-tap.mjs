#!/usr/bin/env node
/**
 * Audit: does tapping the subagent count chip actually open its panel?
 *
 *   node scripts/audit-lineage-tap.mjs [--url http://127.0.0.1:3199] [--session warden]
 *                                      [--taps 8] [--hold 70] [--jitter 0]
 *                                      [--churn] [--churn-ms 80]
 *
 * The chip is React's node and this shell moves it into the tab strip, so the client's own
 * re-renders put it back into the crumb row — 33px higher. A tap is a sequence that spans
 * frames, and a target that moves in the middle of one loses the click: that is what
 * "sometimes it opens, sometimes it does not" looks like from the phone. This reports the
 * success rate under conditions a thumb actually produces:
 *
 *   --hold     how long the finger stays down (a real tap is 60-120ms, not instantaneous)
 *   --jitter   how far it wanders, in px, because a browser may read a moving touch as a
 *              scroll and take the click away
 *   --churn    forces the client's re-insert at a fixed rate, which is the variable under
 *              test: with it, these taps failed four times in five before the pre-paint
 *              correction in lib/mobile-shell.js, and twelve in twelve succeeded after it,
 *              with the chip pulled back into the crumb row every 16ms
 *
 * The move log at the end is part of the answer, not decoration: it says who moved the chip
 * where, which is the difference between "the shell places it wrongly" and "the client and
 * the shell are taking turns".
 *
 * @module pulse-remote/scripts/audit-lineage-tap
 */

import { existsSync } from 'node:fs';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { mobileStylesheet } from '../lib/mobile.js';
import { mobileShellScript, mobileShellStyles } from '../lib/mobile-shell.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : String(args[at + 1] ?? fallback);
};
const base = flag('--url', process.env.PULSE_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');
const session = flag('--session', 'warden');
const taps = Number(flag('--taps', '8'));

/** Mimic the client re-inserting the chip while the finger is on it. */
const churn = args.includes('--churn');
const churnMs = Number(flag('--churn-ms', '80'));
/** How long the finger stays down, in ms. A real tap is ~60-120ms, not instantaneous. */
const hold = Number(flag('--hold', '70'));
/** How far the finger wanders during the tap, in px. */
const jitter = Number(flag('--jitter', '0'));

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
  body: JSON.stringify({ code: opened.code, label: 'trace-tap' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13');
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2500));
  const served = await page.evaluate(() => {
    let disabled = 0;
    for (const style of document.querySelectorAll('style')) {
      if (style.textContent && style.textContent.includes('[data-pulse-')) {
        style.disabled = true;
        disabled += 1;
      }
    }
    return disabled;
  });
  console.log(`disabled ${served} served stylesheet(s)`);
  await page.addStyleTag({ content: mobileStylesheet() });
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript());
  await page.evaluate(wanted => {
    window.__PULSE_WANTED__ = wanted;
    // ---- the move log -------------------------------------------------------
    //
    // Every childList change that touches the lineage slot, with the parent it landed in.
    // "The client put it back" and "we moved it" are the same DOM event; the parent is the
    // only thing that tells them apart.
    window.__MOVES__ = [];
    const starts = performance.now();
    const name = node => {
      if (!node || node.nodeType !== 1) return null;
      if (node.matches && node.matches('[data-slot*="header.lineage"]')) return 'lineage';
      if (node.matches && node.matches('[class*="_headerActions"]')) return 'actions';
      return null;
    };
    const where = node => {
      if (!node || !node.parentElement) return '(none)';
      if (node.parentElement.hasAttribute('data-pulse-header-group')) return 'group';
      return String(node.parentElement.className || node.parentElement.tagName).slice(0, 24) || '(empty class)';
    };
    new MutationObserver(records => {
      for (const record of records) {
        for (const kind of [...record.addedNodes].map(name).filter(Boolean)) {
          window.__MOVES__.push({ t: Math.round(performance.now() - starts), what: kind, into: where(record.target) });
        }
        for (const kind of [...record.removedNodes].map(name).filter(Boolean)) {
          window.__MOVES__.push({ t: Math.round(performance.now() - starts), what: kind, into: 'out of ' + where(record.target) });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, session);
  await page.evaluate(async () => {
    const toggle = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /打开侧边栏|显示侧边栏|侧边栏|Open sidebar|menu/i.test(
        (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')));
    if (toggle && document.querySelectorAll('[class*="_sessionRow"]').length === 0) {
      toggle.click();
      await new Promise(r => setTimeout(r, 900));
    }
    const rows = [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const pattern = window.__PULSE_WANTED__ === 'warden' ? /世界|warden|逃亡/ : /手机遥控|WorkBuddy|Pulse|下载/;
    const picked = rows.find(node => pattern.test(node.textContent || '')) || rows[0];
    window.__PULSE_PICKED__ = picked ? (picked.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '(none)';
    if (picked) picked.click();
  });
  await new Promise(r => setTimeout(r, 9000));
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /收起侧边栏|关闭侧边栏|Close sidebar/i.test(node.getAttribute('aria-label') || ''));
    if (toggle) toggle.click();
  });
  await new Promise(r => setTimeout(r, 1200));
  console.log('session:', await page.evaluate(() => window.__PULSE_PICKED__));

  const state = await page.evaluate(() => {
    const debug = window.__PULSE_SHELL_DEBUG__;
    const row = debug.headerRow();
    const slot = row && row.lineage;
    const trigger = slot ? slot.querySelector('button') : null;
    return {
      shell: debug.headerActions(),
      inGroup: Boolean(slot && debug.headerGroup() && slot.parentElement === debug.headerGroup()),
      label: trigger ? (trigger.textContent || '').trim().slice(0, 20) : '',
    };
  });
  console.log('shell state:', JSON.stringify(state));

  const cdp = await page.createCDPSession();
  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (jitter > 0) {
      await new Promise(r => setTimeout(r, Math.round(hold / 2)));
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x + jitter, y: y + jitter }],
      });
      await new Promise(r => setTimeout(r, Math.max(1, hold - Math.round(hold / 2))));
    } else {
      await new Promise(r => setTimeout(r, hold));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  const findTrigger = () => page.evaluate(() => {
    const debug = window.__PULSE_SHELL_DEBUG__;
    const row = debug.headerRow();
    const slot = (row && row.lineage) || document.querySelector('[data-slot*="header.lineage"]');
    const trigger = slot ? slot.querySelector('button') : null;
    if (!trigger) return { missing: true, row: Boolean(row) };
    const rect = trigger.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      via: row && row.lineage ? 'headerRow' : 'selector',
    };
  });

  const panelOpen = () => page.evaluate(() => [...document.querySelectorAll('[class*="ZKlsPq_menu"]')]
    .some(node => node.getBoundingClientRect().height > 40));

  if (churn) {
    await page.evaluate(ms => {
      const home = () => document.querySelector('[class*="_crumbSeg"]')
        || document.querySelector('[class*="_crumbs"]');
      window.__CHURN__ = window.setInterval(() => {
        const slot = document.querySelector('[data-slot*="header.lineage"]');
        const target = home();
        if (slot && target && slot.parentElement !== target) target.appendChild(slot);
      }, ms);
    }, churnMs);
    console.log(`churn: moving the chip back to the title row every ${churnMs}ms`);
  }

  const results = [];
  // What the browser actually delivered to the chip, per tap. "It did not open" has several
  // shapes — no click at all, a mouseover that was cancelled by a mouseout, a click that
  // landed on the strip — and they need different fixes.
  await page.evaluate(() => {
    window.__EV__ = [];
    const record = type => document.addEventListener(type, event => {
      const node = event.target;
      const chip = node && node.closest ? node.closest('[data-slot*="header.lineage"]') : null;
      window.__EV__.push({
        type,
        t: Math.round(performance.now()),
        chip: Boolean(chip),
      });
    }, true);
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mouseover',
      'mouseout', 'mousedown', 'mouseup', 'click']) record(type);
  });
  for (let attempt = 1; attempt <= taps; attempt += 1) {
    // Close it the way a finger does: mouseout (what the hover popover listens for) plus a
    // tap on empty strip. Removing React's node by hand would leave React holding a node it
    // thinks is somewhere else.
    await page.evaluate(() => {
      const slot = document.querySelector('[data-slot*="header.lineage"]');
      const root = slot && slot.firstElementChild;
      if (root) {
        root.dispatchEvent(new MouseEvent('mouseout', {
          bubbles: true, cancelable: true, relatedTarget: document.body,
        }));
      }
    });
    await tap(170, 66);
    await new Promise(r => setTimeout(r, 700));
    const closed = !(await panelOpen());
    const target = await findTrigger();
    if (target.missing) {
      results.push({ attempt, missing: true });
      process.stdout.write(`  #${attempt}: trigger not found (headerRow=${target.row})\n`);
      continue;
    }
    await tap(target.x, target.y);
    await new Promise(r => setTimeout(r, 900));
    const openedNow = await panelOpen();
    const events = await page.evaluate(() => {
      const seen = window.__EV__.slice();
      window.__EV__ = [];
      return seen.map(event => `${event.type}${event.chip ? '(chip)' : ''}`);
    });
    results.push({ attempt, at: target, opened: openedNow, closed, events });
    process.stdout.write(`  #${attempt} tap (${target.x},${target.y}) ${target.w}x${target.h}`
      + ` via ${target.via} (closed before=${closed}) -> ${openedNow ? 'OPENED' : 'did not open'}`
      + `\n        events: ${events.join(' ')}\n`);
  }
  if (churn) await page.evaluate(() => { window.clearInterval(window.__CHURN__); });

  const answered = results.filter(result => !result.missing);
  const openedCount = answered.filter(result => result.opened).length;
  console.log(`\nopened ${openedCount}/${answered.length}`
    + ` (hold=${hold}ms jitter=${jitter}px churn=${churn ? churnMs + 'ms' : 'off'})`);

  const moves = await page.evaluate(() => window.__MOVES__);
  const summary = new Map();
  for (const move of moves) {
    const key = `${move.what} -> ${move.into}`;
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  console.log('\nmoves of the chip during the run:');
  for (const [key, count] of [...summary.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x  ${key}`);
  }
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
