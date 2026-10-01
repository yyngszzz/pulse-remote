#!/usr/bin/env node
/**
 * What is on an official deliverables card, and what does its dropdown offer?
 *
 *   node scripts/audit-deliverable-card.mjs [--url http://127.0.0.1:3199] [--session 教育类工程] [--width 390]
 *
 * The phone shows two controls beside each file on those cards: the shell's own 转发/下载 button and
 * the official card's dropdown (a globe glyph with a caret). The question "what is that button for,
 * and does the phone need it?" is answered by its own menu, so this opens it and reads the entries
 * — and records each entry's href/target, because "opens in a browser" and "opens in the sidebar"
 * differ exactly there.
 *
 * @module dsh-remote-pulse/scripts/audit-deliverable-card
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
  console.error('set PULSE_BROWSER to msedge.exe');
  process.exit(2);
}

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'audit-deliverable-card' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13');
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 3500));

  // A session that carries a deliverables card: the requested one, or whichever has cards.
  await page.evaluate(async pattern => {
    const openDrawer = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /打开侧边栏|显示侧边栏/i.test(node.getAttribute('aria-label') || ''));
    if (openDrawer) openDrawer.click();
    await new Promise(r => setTimeout(r, 900));
    const rows = () => [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const match = pattern === 'any' ? null : new RegExp(pattern);
    let target = match ? rows().find(node => match.test(node.textContent || '')) : null;
    if (!target && !match) target = rows()[0];
    if (!target) {
      const more = [...document.querySelectorAll('button,[role="button"]')]
        .find(node => /展开其余|显示更多|Show more/i.test((node.getAttribute('aria-label') || '') + (node.textContent || '')));
      if (more) { more.click(); await new Promise(r => setTimeout(r, 800)); }
      target = (match ? rows().find(node => match.test(node.textContent || '')) : null) ?? rows()[0];
    }
    window.__PICKED__ = target ? (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '(none)';
    if (target) target.click();
    await new Promise(r => setTimeout(r, 9000));
    const close = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /收起侧边栏|关闭侧边栏/i.test(node.getAttribute('aria-label') || ''));
    if (close) close.click();
    await new Promise(r => setTimeout(r, 1200));
  }, wanted);
  console.log(`session: ${await page.evaluate(() => window.__PICKED__)}`);

  const cards = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-presented-file]')];
    return rows.slice(0, 3).map(row => ({
      text: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      controls: [...row.querySelectorAll('button,[role="button"],a')].map(node => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          aria: (node.getAttribute('aria-label') || '').slice(0, 40),
          title: (node.getAttribute('title') || '').slice(0, 40),
          text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16),
          href: node.getAttribute('href') ? String(node.getAttribute('href')).slice(0, 60) : '',
          target: node.getAttribute('target') || '',
          pulse: node.hasAttribute('data-pulse-deliverable') ? 'ours' : 'official',
          size: [Math.round(rect.width), Math.round(rect.height)],
        };
      }),
    }));
  });
  if (cards.length === 0) {
    console.log('这一屏没有交付卡片（换一个会话，或用 --session 指定带文件的会话）');
  }
  for (const card of cards) {
    console.log(`\ncard: ${card.text}`);
    for (const control of card.controls) {
      console.log(`  ${control.pulse} ${control.tag} ${control.size[0]}x${control.size[1]}`
        + ` aria="${control.aria}" title="${control.title}" text="${control.text}"`
        + `${control.href ? ` href=${control.href}` : ''}${control.target ? ` target=${control.target}` : ''}`);
    }
  }

  // The official dropdown's own menu, opened on the first card that has one.
  const opened2 = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('[data-presented-file]')]
      .find(candidate => [...candidate.querySelectorAll('button,[role="button"]')]
        .some(node => !node.hasAttribute('data-pulse-deliverable')));
    if (!row) return '(no card with an official control)';
    const control = [...row.querySelectorAll('button,[role="button"]')]
      .find(node => !node.hasAttribute('data-pulse-deliverable'));
    control.click();
    await new Promise(r => setTimeout(r, 1200));
    const menus = [...document.querySelectorAll('[role="menu"],[class*="_popover"],[class*="_menu"],[class*="_dropdown"]')]
      .filter(node => node.getBoundingClientRect().width > 0);
    return menus.map(menu => ({
      cls: String(menu.className || '').slice(0, 40),
      items: [...menu.querySelectorAll('button,[role="menuitem"],a,li')].map(item => ({
        text: (item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        aria: (item.getAttribute('aria-label') || '').slice(0, 40),
        href: item.getAttribute('href') ? String(item.getAttribute('href')).slice(0, 70) : '',
        target: item.getAttribute('target') || '',
      })),
    }));
  });
  console.log(`\n官方下拉菜单：${JSON.stringify(opened2, null, 2)}`);
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
