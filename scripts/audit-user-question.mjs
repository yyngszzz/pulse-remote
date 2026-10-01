#!/usr/bin/env node
/**
 * Audit the ask_user_question UI on a phone viewport.
 *
 *   node scripts/audit-user-question.mjs [--url http://127.0.0.1:3199] [--session 自动剪辑]
 *                                        [--width 390] [--shot out.png]
 *
 * The question interface takes over the chat **editor**: while a question is pending the
 * composer is replaced by a card with the options, a pager and a submit action. On the phone
 * the transcript shows the pending tool row ("提问 · 等待回答") while the editor still looks
 * like an ordinary composer, so either the card is rendered somewhere off screen, or it was
 * never mounted, or something of ours covers it. This reports which, by putting the editor's
 * own subtree, the pending row's subtree and the geometry of both on the record.
 *
 * @module dsh-remote-pulse/scripts/audit-user-question
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
const wanted = flag('--session', '');

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
  body: JSON.stringify({ code: opened.code, label: 'audit-user-question' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

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
  await page.addStyleTag({ content: mobileStylesheet() });
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript());
  await new Promise(r => setTimeout(r, 1200));

  await page.evaluate(async () => {
    const toggle = [...document.querySelectorAll('button,[role="button"],.pulse-burger')]
      .find(node => /打开侧边栏|显示侧边栏|侧边栏|Open sidebar/i.test(
        (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')));
    if (toggle) toggle.click();
    await new Promise(r => setTimeout(r, 900));
  });
  const picked = await page.evaluate(async pattern => {
    const rows = () => [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const match = pattern ? new RegExp(pattern) : null;
    const find = () => (match ? rows().find(node => match.test(node.textContent || '')) : null);
    let found = find() || (match ? null : rows()[0]);
    // The drawer lists only a few conversations and hides the rest behind an overflow row
    // ("展开其余 N 个会话"): without opening it, a pattern for an older conversation silently
    // falls back to the first row — measured, and it quietly measured the wrong session.
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
    await new Promise(r => setTimeout(r, 1200));
  });
  console.log(`会话：${picked}`);

  // Wait for a question to actually be pending, so "it is not rendered" cannot be confused
  // with "there was nothing to render": the state arrives over the client's own RPC after the
  // session loads, and a probe that measures immediately reports the calm state.
  const waiting = await page.evaluate(async () => {
    const pendingish = () => {
      const text = document.body.innerText || '';
      const row = /等待回答/.test(text);
      const takeover = /跳过此问题|提交|其他答案/.test(text);
      return { row, takeover, composer: /发消息或创建任务|描述你想要构建的内容/.test(text) };
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seen = pendingish();
      if (seen.row || seen.takeover) return { seen, seconds: attempt * 2 };
      await new Promise(r => setTimeout(r, 2000));
    }
    return { seen: pendingish(), seconds: 40, timedOut: true };
  });
  console.log(`等提问出现：${waiting.seconds} 秒`
    + `（页面上有「等待回答」=${waiting.seen.row}，输入框被接管=${waiting.seen.takeover}，`
    + `还是普通输入框=${waiting.seen.composer}）`);

  const report = await page.evaluate(() => {
    const box = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        left: Math.round(rect.left), right: Math.round(rect.right),
        top: Math.round(rect.top), bottom: Math.round(rect.bottom),
        width: Math.round(rect.width), height: Math.round(rect.height),
      };
    };
    const describe = node => {
      const style = getComputedStyle(node);
      return {
        tag: `${node.tagName}.${String(node.className || '').slice(0, 30)}`,
        box: box(node),
        display: style.display,
        position: style.position,
        overflow: style.overflow,
        maxHeight: style.maxHeight,
        height: style.height,
        zIndex: style.zIndex,
        opacity: style.opacity,
        visibility: style.visibility,
        transform: style.transform,
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    };

    // The pending tool row, by its own words rather than by a class name.
    const pending = [...document.querySelectorAll('*')]
      .filter(node => node.children.length <= 2 && /等待回答/.test(node.textContent || ''))
      .pop() || null;
    const chain = [];
    for (let at = pending; at && chain.length < 8; at = at.parentElement) chain.push(describe(at));

    // The editor: whatever holds the composer. The question UI replaces this, so its contents
    // are the evidence for "it was never mounted" versus "it is here but invisible".
    const editorish = [...document.querySelectorAll('[class*="_composer"],[class*="_editor"],[class*="_dock"],[class*="_input"]')]
      .map(describe)
      .filter(entry => entry.box && entry.box.height > 0)
      .slice(0, 12);

    // Anything the question UI would bring: options, a pager, a submit/skip action.
    const controls = [...document.querySelectorAll('button,[role="radio"],[role="option"],[role="checkbox"],input,textarea')]
      .map(node => ({ ...describe(node), label: (node.getAttribute('aria-label') || '').slice(0, 30) }))
      .filter(entry => entry.box && entry.box.height > 0)
      .slice(0, 40);

    const onScreen = [...document.querySelectorAll('body *')]
      .filter(node => node.children.length === 0 && (node.textContent || '').trim())
      .filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
      })
      .map(node => {
        const rect = node.getBoundingClientRect();
        return `${String(node.className || node.tagName).slice(0, 26)} ${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)} :: ${(node.textContent || '').trim().slice(0, 26)}`;
      })
      .slice(-30);

    return {
      pendingFound: Boolean(pending),
      pendingHtml: pending ? pending.outerHTML.slice(0, 900) : '',
      chain,
      editorish,
      controls,
      onScreen,
      clamped: window.__PULSE_SHELL_DEBUG__ ? window.__PULSE_SHELL_DEBUG__.clamped() : -1,
      shellState: window.__PULSE_SHELL_DEBUG__ ? window.__PULSE_SHELL_DEBUG__.headerActions() : '(没有外壳)',
      messages: document.querySelectorAll('[class*="_message"],[class*="_turn"]').length,
    };
  });

  console.log(`\n待回答那一行：${report.pendingFound ? '找到了' : '没找到'}`);
  if (report.pendingHtml) console.log(`  它的 HTML：${report.pendingHtml}`);
  console.log('\n它的祖先链（内 → 外）：');
  for (const entry of report.chain) {
    console.log(`  ${entry.tag} ${entry.box ? `${entry.box.width}x${entry.box.height}@${entry.box.left},${entry.box.top}` : '?'}`
      + ` display=${entry.display} pos=${entry.position} overflow=${entry.overflow} max-h=${entry.maxHeight}`
      + ` opacity=${entry.opacity} visibility=${entry.visibility} transform=${entry.transform || '-'}`);
  }

  console.log('\n编辑器/输入区的候选节点：');
  for (const entry of report.editorish) {
    console.log(`  ${entry.tag} ${entry.box ? `${entry.box.width}x${entry.box.height}@${entry.box.left},${entry.box.top}` : '?'}`
      + ` overflow=${entry.overflow} :: ${entry.text}`);
  }

  console.log('\n屏幕上的按钮/输入（前 40 个）：');
  for (const entry of report.controls) {
    console.log(`  ${entry.tag} ${entry.box ? `${entry.box.width}x${entry.box.height}@${entry.box.left},${entry.box.top}` : '?'}`
      + ` label=${entry.label || '-'} :: ${entry.text}`);
  }

  console.log(`\n外壳状态=${report.shellState} 我们钳过的浮层=${report.clamped} 消息块=${report.messages}`);
  console.log('\n屏幕最下方 30 个叶子节点：');
  for (const line of report.onScreen) console.log(`  ${line}`);

  if (shot) {
    const target = resolve(here, '..', shot);
    await page.screenshot({ path: target });
    console.log(`\n截图: ${target}`);
  }
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
