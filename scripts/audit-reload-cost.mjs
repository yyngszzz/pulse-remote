#!/usr/bin/env node
/**
 * What does one phone page load cost the server, and does it come back?
 *
 *   node scripts/audit-reload-cost.mjs [--url http://127.0.0.1:3199] [--loads 10]
 *
 * The question behind this: on 2026-09-29 the instance started at 15:37 stopped answering while
 * still holding port 3080 — phone unreachable, desktop GUI unloadable, a fresh `dsh web` failing
 * with EADDRINUSE until the machine was rebooted. The only piece added in that window that makes
 * the *client* ask the server for something on its own is the shell's boot-id poll and its
 * one-reload-per-five-minutes recovery, so "does a page load leak?" is worth measuring rather
 * than arguing about.
 *
 * This script drives the loads. The counters that matter — handles, working set, established
 * sockets — are read from outside, around it, because they belong to the server process and not
 * to the page:
 *
 *   $before = Get-Process -Id <dsh pid>
 *   node scripts/audit-reload-cost.mjs --loads 10
 *   $after = Get-Process -Id <dsh pid>
 *
 * @module dsh-remote-pulse/scripts/audit-reload-cost
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
const loads = Number(flag('--loads', '10'));
const settleMs = Number(flag('--settle', '2500'));

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
  body: JSON.stringify({ code: opened.code, label: 'audit-reload-cost' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

const health = () => fetch(`${base}/health`).then(r => r.json()).catch(() => null);

try {
  console.log(`起始 /health: ${JSON.stringify(await health())}`);
  const times = [];
  for (let index = 1; index <= loads; index += 1) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13');
    await page.setCookie({
      name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
      domain: new URL(base).hostname, path: '/',
    });
    const started = Date.now();
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise(r => setTimeout(r, settleMs));
    // The shell from disk, so this measures the current build rather than whatever the running
    // plugin snapshotted (which is what the phone gets — both are reported by verify-mobile-layer).
    await page.addStyleTag({ content: mobileStylesheet() }).catch(() => {});
    await page.addStyleTag({ content: mobileShellStyles() }).catch(() => {});
    await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript()).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    const state = await page.evaluate(() => {
      const debug = window.__PULSE_SHELL_DEBUG__;
      return debug ? debug.boot() : null;
    }).catch(() => null);
    times.push(Date.now() - started);
    await page.close();
    console.log(`  第 ${index} 次加载：${times[times.length - 1]}ms，外壳开机自检=${JSON.stringify(state)}`);
  }
  console.log(`\n加载耗时：最短 ${Math.min(...times)}ms，最长 ${Math.max(...times)}ms，`
    + `平均 ${Math.round(times.reduce((sum, value) => sum + value, 0) / times.length)}ms`);
  await new Promise(r => setTimeout(r, 2000));
  console.log(`结束 /health: ${JSON.stringify(await health())}`);
  console.log('（句柄/工作集/连接数要在这条命令外面用 PowerShell 前后各取一次——它们属于服务器进程）');
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
