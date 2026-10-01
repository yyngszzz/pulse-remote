#!/usr/bin/env node
/**
 * Audit what a **new conversation** does to the phone header.
 *
 *   node scripts/audit-new-session.mjs [--url http://127.0.0.1:3199] [--width 390] [--shot out.png]
 *
 * The header layout this shell installs was measured on conversations that already have
 * messages. A new conversation is a different state: no crumb title, sometimes no tab strip
 * yet, and — while the agent is working — a background-jobs chip whose label is as wide as
 * its own text ("1 个后台任务运行中" measured 226px by itself, against 202px of room beside
 * 轨迹). This reports the pieces that decide whether the chips move: whether the tab strip
 * exists, what the chips measure, whether the title row is crowded, and what actually paints
 * on top of what.
 *
 * @module dsh-remote-pulse/scripts/audit-new-session
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { mobileStylesheet } from '../lib/mobile.js';
import { mobileShellScript, mobileShellStyles } from '../lib/mobile-shell.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : String(args[at + 1] ?? fallback);
};

const base = flag('--url', process.env.PULSE_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');
const width = Number(flag('--width', '390'));
const shot = flag('--shot', '');
/** Which conversation to open first. The header only exists inside one. */
const wanted = flag('--session', 'pulse');

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
  body: JSON.stringify({ code: opened.code, label: 'audit-new-session' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

/** What the shell thinks, and what the header actually contains. */
const measure = () => {
  const debug = window.__PULSE_SHELL_DEBUG__;
  const box = node => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left), right: Math.round(rect.right),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  };
  const chain = node => {
    const out = [];
    let at = node;
    for (let depth = 0; at && depth < 4; depth += 1) {
      out.push(`${at.tagName}.${String(at.className || '').slice(0, 26)}[${box(at) ? `${box(at).width}x${box(at).height}@${box(at).left},${box(at).top}` : '?'}]`);
      at = at.parentElement;
    }
    return out;
  };
  const row = debug.headerRow();
  const header = document.querySelector('header[class*="_header"]');
  const titleRow = header ? header.querySelector('[class*="_titleRow"]') : null;
  const tabs = row ? row.tabs : (header ? header.querySelector('[class*="_tabs"]') : null);
  const items = debug.headerItems ? debug.headerItems() : [];
  const group = debug.headerGroup ? debug.headerGroup() : null;
  const rects = items.map(item => ({ kind: item.node.hasAttribute('data-pulse-header-lineage') ? '子代理' : 'chip', ...box(item.measure) }));
  const titleBox = box(titleRow);
  // Every direct child of the title row, with what it costs: this is the row that gets
  // crowded, and the one the chips are supposed to leave.
  const rowChildren = titleRow ? [...titleRow.children].map(node => ({
    tag: `${node.tagName}.${String(node.className || '').slice(0, 22)}`,
    ...box(node),
    text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28),
  })) : [];
  const usedInTitleRow = rowChildren.reduce((sum, child) => sum + (child.width || 0), 0);
  // Do the chips overlap anything that is not theirs? Asked by hit-testing the chip's own
  // centre: "it is in the right place" and "it is the thing at that point" are different.
  const overlap = items.map(item => {
    const boxed = box(item.measure);
    if (!boxed) return null;
    const at = document.elementsFromPoint(
      Math.round((boxed.left + boxed.right) / 2),
      Math.round((boxed.top + boxed.bottom) / 2),
    ) || [];
    const inside = at.slice(0, 3).map(node => `${node.tagName}.${String(node.className || '').slice(0, 22)}`);
    return { point: [Math.round((boxed.left + boxed.right) / 2), Math.round((boxed.top + boxed.bottom) / 2)], inside };
  });
  return {
    shell: debug.headerActions(),
    rowFound: Boolean(row),
    hasTabs: Boolean(tabs),
    titleRow: titleBox,
    tabs: box(tabs),
    crumbs: box(header ? header.querySelector('[class*="_crumbs"]') : null),
    group: box(group),
    items: rects,
    itemLabels: items.map(item => (item.node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26)),
    rowChildren,
    usedInTitleRow,
    titleRowOverflow: titleBox ? usedInTitleRow - titleBox.width : null,
    overlap,
    fitRoom: (() => {
      if (!tabs) return null;
      let limitLeft = 0;
      for (const node of tabs.querySelectorAll('button,[role="tab"]')) {
        if (items.some(item => item.node === node || item.node.contains(node))) continue;
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.right > limitLeft) limitLeft = r.right;
      }
      const style = getComputedStyle(tabs);
      const gap = parseFloat(style.columnGap || style.gap) || 0;
      const chips = rects.reduce((sum, chip) => sum + (chip.width || 0), 0) + (rects.length > 1 ? 6 * (rects.length - 1) : 0);
      const strip = tabs.getBoundingClientRect();
      return { gap, limitLeft, chips, room: Math.round(strip.right - (limitLeft || strip.left) - gap - 8) };
    })(),
    firstTitleRow: rowChildren.length ? rowChildren[0].text : '',
    chain: tabs ? chain(tabs) : [],
  };
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, deviceScaleFactor: 2 });
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
  console.log(`关掉了进程里下发的 ${served} 份样式表`);
  // The served shell built its own chrome and its own hamburger before this probe replaced
  // it, and `build()` runs again when the disk copy is evaluated (that is the point of the
  // re-eval). Left in place, the first copy's hamburger sits in the title row next to the new
  // one and every width measured below is a measurement of *two* shells — measured as two
  // `pulse-burger` siblings at x=20 and x=62, which is a probe artefact and not something a
  // phone ever shows. So the old chrome is taken out first.
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('[data-pulse="chrome"], [data-pulse="burger"], .pulse-burger, .pulse-diag')) {
      node.remove();
    }
    document.documentElement.classList.remove('pulse-has-sidebar', 'pulse-drawer-open', 'pulse-corner-taken');
  });
  await page.addStyleTag({ content: mobileStylesheet() });
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript());
  await new Promise(r => setTimeout(r, 1200));

  const openDrawer = async () => {
    await page.evaluate(async () => {
      const toggle = [...document.querySelectorAll('button,[role="button"],.pulse-burger')]
        .find(node => /打开侧边栏|显示侧边栏|侧边栏|Open sidebar/i.test(
          (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')));
      if (toggle) toggle.click();
      await new Promise(r => setTimeout(r, 900));
    });
  };
  const closeDrawer = async () => {
    await page.evaluate(async () => {
      const toggle = [...document.querySelectorAll('button,[role="button"]')]
        .find(node => /收起侧边栏|关闭侧边栏|Close sidebar/i.test(node.getAttribute('aria-label') || ''));
      if (toggle) toggle.click();
      await new Promise(r => setTimeout(r, 900));
    });
  };

  // What is in the drawer at all — the new-conversation control is a build detail, so it is
  // found by its text rather than by a class name that changes every build.
  await openDrawer();
  const drawer = await page.evaluate(() => [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[class*="_row"]')]
    .map(node => ({
      tag: `${node.tagName}.${String(node.className || '').slice(0, 26)}`,
      text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 34),
      label: (node.getAttribute('aria-label') || '').slice(0, 30),
      visible: node.getBoundingClientRect().height > 0,
    }))
    .filter(node => node.visible && (node.text || node.label))
    .slice(0, 40));
  if (process.env.PULSE_PRINT) {
    console.log('\n抽屉里可点的东西：');
    for (const node of drawer) console.log(`  ${node.tag} 「${node.text}」 aria=${node.label || '-'}`);
  }

  // A session header only exists inside a conversation, so one is opened first: the header
  // is the whole subject here, and the hero screen has none.
  const picked = await page.evaluate(async pattern => {
    const rows = [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const wanted = new RegExp(pattern);
    const found = rows.find(node => wanted.test(node.textContent || '')) || rows[0];
    window.__PULSE_PICKED__ = found ? (found.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '(none)';
    if (found) found.click();
    await new Promise(r => setTimeout(r, 8000));
    return window.__PULSE_PICKED__;
  }, wanted === 'warden' ? '世界|warden|逃亡' : '手机遥控|WorkBuddy|Pulse|下载');
  await closeDrawer();
  await new Promise(r => setTimeout(r, 1500));
  console.log(`\n打开的会话：${picked}`);

  const before = await page.evaluate(measure);
  console.log('\n=== 这个会话的页头');
  console.log(`  外壳状态=${before.shell} 有页签行=${before.hasTabs} 组=${before.group ? '在' : '没有'}`);
  console.log(`  标题行用掉 ${before.usedInTitleRow}px / 可用 ${before.titleRow ? before.titleRow.width : '?'}px`
    + ` → 超出 ${before.titleRowOverflow}px`);
  for (const child of before.rowChildren) {
    console.log(`    ${child.tag} ${child.width}x${child.height}@${child.left} 「${child.text}」`);
  }
  console.log(`  要搬的 chip：${before.items.map((chip, index) => `${before.itemLabels[index]}=${chip.width}px`).join(' + ') || '(没有)'}`);
  if (before.fitRoom) console.log(`  空档 ${before.fitRoom.room}px（chip 合起来 ${before.fitRoom.chips}px）`);

  const clicked = await page.evaluate(async () => {
    // The brand button in the sidebar carries aria-label 新建会话: that is "新开一个对话",
    // the state the question is about. It lands on the hero screen, which has no session
    // header at all — which is itself the answer for that half.
    const wanted = /新建会话|新会话|New session|New chat/i;
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[class*="_newSession"]')];
    const found = nodes.find(node => wanted.test((node.getAttribute('aria-label') || '') + ' '
      + (node.textContent || '')));
    window.__NEW_SESSION_PICKED__ = found
      ? `${found.tagName}.${String(found.className || '').slice(0, 24)} 「${(found.getAttribute('aria-label') || found.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26)}」`
      : '(没找到)';
    if (found) found.click();
    await new Promise(r => setTimeout(r, 2500));
    return window.__NEW_SESSION_PICKED__;
  });
  console.log(`\n点了「新建会话」：${clicked}`);
  await closeDrawer();
  await new Promise(r => setTimeout(r, 2000));

  const after = await page.evaluate(measure);
  console.log('\n=== 新对话');
  console.log(`  外壳状态=${after.shell} 有页签行=${after.hasTabs} 组=${after.group ? '在' : '没有'}`);
  console.log(`  标题行 ${after.titleRow ? `${after.titleRow.width}x${after.titleRow.height}` : '(没有)'}`
    + ` 用掉 ${after.usedInTitleRow}px → 超出 ${after.titleRowOverflow}px`);
  for (const child of after.rowChildren) {
    console.log(`    ${child.tag} ${child.width}x${child.height}@${child.left} 「${child.text}」`);
  }
  console.log(`  要搬的 chip：${after.items.map((chip, index) => `${after.itemLabels[index]}=${chip.width}px`).join(' + ') || '(没有)'}`);
  if (after.fitRoom) console.log(`  空档 ${after.fitRoom.room}px（chip 合起来 ${after.fitRoom.chips}px）`);
  for (const hit of after.overlap) {
    if (hit) console.log(`  chip 中心 ${hit.point.join(',')} 最上面的是：${hit.inside.join(' > ')}`);
  }
  console.log(`  页签行链：${after.chain.join('  ^  ')}`);

  if (shot) {
    const target = resolve(here, '..', shot);
    await page.screenshot({ path: target });
    console.log(`\n截图: ${target}`);
  }
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
