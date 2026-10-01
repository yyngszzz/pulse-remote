#!/usr/bin/env node
/**
 * Verify the download-or-forward control the shell adds to a file path in a tool row.
 *
 *   node scripts/verify-file-link-action.mjs [--url http://127.0.0.1:3199] [--shot out.png]
 *
 * ## Why this probe opens a real conversation
 *
 * The other two injections read a path out of the markup — the deliverables card's
 * accessible name, the files tree's `data-files-path`. This one cannot: the row prints
 * a *display* path relative to the workspace, and the absolute path only exists as a
 * React prop on the component. So the interesting question is not "does the injector
 * append an element" but "does it recover the right file", and only the real
 * transcript can answer that.
 *
 * The probe therefore does both:
 *
 *   * a planted fixture with hand-made fiber props, which pins the resolution rules
 *     down — the prop, the `cwd` fallback, an absolute display path, and the two ways
 *     it must refuse (a prop naming a different file, and no props at all);
 *   * the live conversation, where every injected link is checked against the text of
 *     the row it sits in, and the whole conversation is checked for links that were
 *     left undecorated.
 *
 * The second half needs a session with tool rows in it. That is the user's actual
 * situation rather than a convenience: if the probe ever finds links and decorates
 * none of them, that is the failure worth knowing about.
 *
 * @module dsh-remote-pulse/scripts/verify-file-link-action
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { fileLinkActionsScript, mobileShellStyles } from '../lib/mobile-shell.js';

const here = dirname(fileURLToPath(import.meta.url));
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
const shot = flag('--shot', '');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const executablePath = process.env.PULSE_BROWSER ?? BROWSERS.find(candidate => existsSync(candidate));
if (!executablePath) {
  console.error('找不到 Chromium 系浏览器。设 PULSE_BROWSER 指向 msedge.exe。');
  process.exit(2);
}

/**
 * A file that ships with the plugin, so the link can be fetched to prove it downloads.
 *
 * Derived from this probe's own location: a hardcoded path from the author's machine made
 * the check pass only there, which hid the fact that the probe needed a particular
 * checkout layout to mean anything.
 */
const SAMPLE = resolve(here, '..', 'lib', 'mobile-shell.js');

const results = [];
/** Checks that could not run, and why — reported as `--`, never as a pass. */
const skips = [];
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

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'file-link-action' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

/**
 * Load the client with this shell's script installed.
 *
 * @param {string} userAgent - the user agent to present.
 * @param {number} width - viewport width.
 * @returns {Promise<import('puppeteer-core').Page>} the tab.
 */
async function prepare(userAgent, width) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2, isMobile: width <= 900, hasTouch: true });
  await page.setUserAgent(userAgent);
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.evaluateOnNewDocument(() => { window.__PULSE_FILE_LINKS__ = true; });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => { window.__PULSE_FILE_LINKS__ = false; });
  // The stylesheet from disk, not the one a long-running process happens to serve.
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => {
    window.__PULSE_FILE_LINK_SOURCE__ = source;
    window.eval(source);
  }, fileLinkActionsScript());
  await new Promise(r => setTimeout(r, 500));
  return page;
}

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.9';

/**
 * Plant file links whose React props say what the real component says.
 *
 * @param {import('puppeteer-core').Page} page - the tab.
 * @returns {Promise<object>} what the injector did with them.
 */
const plant = page => page.evaluate(sample => {
  // A fiber chain is only a linked list of objects with `memoizedProps`, so a
  // hand-made one exercises exactly the code path the real one does.
  const fiberWith = props => {
    const head = { memoizedProps: props, return: null };
    return head;
  };
  const cases = [
    // The prop names the same file the row prints: use it, and ignore a decoy cwd.
    { id: 'prop', html: '<button type="button" class="Zz_fileLink">mobile-shell.js</button>',
      props: { filePath: sample, cwd: 'D:\\elsewhere' } },
    // No prop path, but the workspace it is relative to: join them.
    { id: 'cwd', html: '<button type="button" class="Zz_fileLink">lib\\ui.js</button>',
      props: { cwd: 'D:\\deepseek harness\\dsh-remote-pulse' } },
    // The row printed an absolute path already.
    { id: 'absolute', html: '<button type="button" class="Zz_fileLink">' + sample + '</button>',
      props: {} },
    // The prop names a different file while a workspace is known: the prop is not
    // this row's, so it is dropped and the workspace is used instead of trusting it.
    { id: 'disagree', html: '<button type="button" class="Zz_fileLink">other.js</button>',
      props: { filePath: sample, cwd: 'D:\\deepseek harness' } },
    // The prop names a different file and there is nothing to resolve against: refuse.
    { id: 'refuse', html: '<button type="button" class="Zz_fileLink">lib\\ui.js</button>',
      props: { filePath: sample } },
    // No props at all.
    { id: 'noprops', html: '<button type="button" class="Zz_fileLink">lib\\ui.js</button>', props: null },
    // A line number suffix must not defeat the comparison.
    { id: 'line', html: '<button type="button" class="Zz_fileLink">mobile-shell.js:42</button>',
      props: { filePath: sample } },
  ];

  const host = document.createElement('div');
  host.id = 'pulse-link-fixture';
  host.setAttribute('style', 'position:fixed;left:8px;top:60px;width:340px;z-index:9999;'
    + 'padding:8px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff)');
  for (const item of cases) {
    const row = document.createElement('div');
    row.className = 'Zz_row';
    row.innerHTML = item.html;
    host.appendChild(row);
  }
  document.body.appendChild(host);

  // The fiber key has to look like React's, because that is what the injector looks
  // for; the value is ours.
  const keys = ['prop', 'cwd', 'absolute', 'disagree', 'refuse', 'noprops', 'line'];
  keys.forEach((id, index) => {
    const button = host.children[index].querySelector('button');
    const props = cases[index].props;
    if (props) button['__reactFiber$fixture'] = fiberWith(props);
  });

  window.__PULSE_FILE_LINKS__ = false;
  window.eval(window.__PULSE_FILE_LINK_SOURCE__ || '');
  window.__PULSE_FILE_LINKS__ = true;

  const read = id => {
    const row = host.children[keys.indexOf(id)];
    const action = row.querySelector('[data-pulse-file-link-action]');
    return action ? action.getAttribute('href') : '';
  };
  return {
    prop: read('prop'),
    cwd: read('cwd'),
    absolute: read('absolute'),
    disagree: read('disagree'),
    refuse: read('refuse'),
    noprops: read('noprops'),
    line: read('line'),
    insideRow: Boolean(host.querySelector('[class*="_fileLink"] + [data-pulse-file-link-action]')),
    label: (host.querySelector('[data-pulse-file-link-action]') || {}).textContent || '',
  };
}, SAMPLE);

/**
 * Count what happened in the live conversation.
 *
 * @param {import('puppeteer-core').Page} page - the tab.
 * @returns {Promise<object>} the tally.
 */
const live = page => page.evaluate(() => {
  // The planted fixture uses the same class, so it is excluded here — otherwise the
  // tally below would be counting the test's own markup as the user's conversation.
  const links = [...document.querySelectorAll('button[class*="_fileLink"]')]
    .filter(button => !button.closest('#pulse-link-fixture'));
  const decorated = links.filter(button => {
    const next = button.nextElementSibling;
    return Boolean(next && next.hasAttribute('data-pulse-file-link-action'));
  });
  /** The base name the row prints, ignoring a line suffix. */
  const baseName = value => {
    const text = String(value || '').replace(/:\d+$/, '');
    const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return cut === -1 ? text : text.slice(cut + 1);
  };
  const wrong = [];
  for (const button of decorated) {
    const action = button.nextElementSibling;
    let path = '';
    try {
      path = decodeURIComponent(new URL(action.getAttribute('href'), location.origin)
        .searchParams.get('path') || '');
    } catch (error) { path = ''; }
    if (baseName(path) !== baseName(button.textContent)) {
      wrong.push(`${button.textContent} → ${path}`);
    }
  }
  const first = decorated[0] ? decorated[0].nextElementSibling : null;
  const undecoratedText = links
    .filter(button => !(button.nextElementSibling || {}).hasAttribute
      || !button.nextElementSibling.hasAttribute('data-pulse-file-link-action'))
    .map(button => (button.textContent || '').trim().slice(0, 60));
  return {
    total: links.length,
    decorated: decorated.length,
    undecorated: links.length - decorated.length,
    undecoratedText,
    wrong,
    sampleHref: first ? first.getAttribute('href') : '',
    sampleTitle: first ? first.getAttribute('title') : '',
    // The control has to sit inside the same row as the path it belongs to.
    insideRow: Boolean(first && first.parentElement
      && first.parentElement.contains(decorated[0])),
    // Every link the injector could not resolve carries a marker, so "no control"
    // and "never looked at" stay distinguishable — here and in the self-check panel.
    unresolvedMarked: links.filter(button => button.hasAttribute('data-pulse-file-link-unresolved')).length,
    borrowedClass: Boolean(first && decorated[0].className && first.className === decorated[0].className),
    box: first ? (() => {
      const rect = first.getBoundingClientRect();
      return `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)}`;
    })() : '',
    skipped: window.__PULSE_FILE_LINKS_SKIPPED__ ?? null,
  };
});

try {
  // ---- the resolution rules, pinned down ----------------------------------
  //
  // At desktop width, because the transcript is virtualised: on a 390px phone only a
  // couple of rows are mounted at a time and a tool row with a file in it may simply
  // not be among them. That is a property of the client, not of the injector.
  const web = await prepare(WEB_UA, 1400);
  const fixture = await plant(web);
  const encoded = encodeURIComponent(SAMPLE);
  record('组件 props 里的绝对路径被取到了（并且没有被旁边的 cwd 带偏）',
    fixture.prop.includes(encodeURIComponent(SAMPLE)), `href=${fixture.prop.slice(0, 90)}`);
  record('只有 cwd 时用工作区拼出绝对路径',
    fixture.cwd.includes(encodeURIComponent('D:\\deepseek harness\\dsh-remote-pulse\\lib\\ui.js')),
    `href=${fixture.cwd.slice(0, 90)}`);
  record('行里本来就是绝对路径时直接用',
    fixture.absolute.includes(encoded.slice(0, 40)), `href=${fixture.absolute.slice(0, 90)}`);
  record('props 与行文字不是同一个文件时不用它，退回工作区而不是硬信',
    fixture.disagree.includes(encodeURIComponent('D:\\deepseek harness\\other.js')),
    `href=${fixture.disagree.slice(0, 90)}`);
  record('既没有能对上的 props 也没有工作区时拒绝注入（宁可没有，也不给错的）',
    fixture.refuse === '', `href=${fixture.refuse || '(没有控件)'}`);
  record('完全拿不到路径时也不注入', fixture.noprops === '', `href=${fixture.noprops || '(没有控件)'}`);
  record('行号后缀不影响识别', fixture.line.includes(encodeURIComponent('mobile-shell.js')),
    `href=${fixture.line.slice(0, 90)}`);
  record('控件贴在文件路径后面，样式沿用它的类', fixture.insideRow,
    `紧邻=${fixture.insideRow} 文字「${fixture.label}」`);

  if (fixture.prop) {
    const response = await fetch(new URL(fixture.prop, base).href, { headers: { cookie } });
    const disposition = response.headers.get('content-disposition') || '';
    record('那个链接真的能下载（200 且是附件）',
      response.status === 200 && disposition.startsWith('attachment'),
      `status=${response.status} disposition=${disposition.slice(0, 46)}`);
  } else {
    record('那个链接真的能下载（200 且是附件）', false, '没有 href 可测');
  }

  // ---- the live conversation ----------------------------------------------
  const openedSession = await web.evaluate(() => {
    const rows = [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const first = rows.find(node => /手机遥控|WorkBuddy|Pulse|下载/.test(node.textContent || '')) || rows[0];
    if (!first) return false;
    first.click();
    return true;
  });
  // Poll rather than sleep a fixed amount: the transcript loads, then mounts rows as
  // they scroll into view.
  let session = { total: 0 };
  for (let attempt = 0; attempt < 16 && session.total === 0; attempt += 1) {
    await new Promise(r => setTimeout(r, 750));
    session = await live(web);
  }

  if (!openedSession || session.total === 0) {
    skips.push(`真实会话这一半没跑成（${
      openedSession ? '打开的会话里没有可点开单文件的行' : '会话列表里没找到可点的会话'
    }），注入器在真实标记上的行为以夹具那一半为准`);
  } else {
    record('会话里的文件路径确实被找到了', session.total > 0,
      `文件路径 ${session.total} 处，加上控件的 ${session.decorated} 处`);
    record('加上控件的每一条都指向它自己那个文件（逐个核对文件名）',
      session.wrong.length === 0, session.wrong.length ? session.wrong.slice(0, 3).join(' / ') : '全部一致');
    record('控件和它所属的路径在同一行里，样式沿用路径的类',
      session.insideRow && session.borrowedClass, `同行=${session.insideRow} 同类=${session.borrowedClass}`);
    record('没加上控件的路径都自报在案（拿不到绝对路径的不硬猜）',
      session.undecorated === session.unresolvedMarked,
      `${session.undecorated} 处没加：${session.undecoratedText.join(' | ') || '(无)'}；`
      + `打了未解析标记的 ${session.unresolvedMarked} 处`);

    if (shot) {
      const target = resolve(here, '..', shot.replace(/\.png$/, '-web.png'));
      await web.screenshot({ path: target });
      console.log(`  电脑端截图: ${target}`);
    }
  }
  await web.close();

  // ---- the phone branch ----------------------------------------------------
  const phone = await prepare(PHONE_UA, 390);
  const phoneFixture = await plant(phone);
  record('手机端给出的是转发（分享面板才是手机该有的动作）',
    phoneFixture.prop.includes('share=1') && !phoneFixture.prop.includes('download=1')
    && phoneFixture.label === '转发',
    `文字「${phoneFixture.label}」href=${phoneFixture.prop.slice(0, 100)}`);
  if (shot) {
    const target = resolve(here, '..', shot.replace(/\.png$/, '-phone.png'));
    await phone.screenshot({ path: target });
    console.log(`  手机端截图: ${target}`);
  }
  await phone.close();
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}

console.log('');
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? `   (${result.detail})` : ''}`);
}
for (const skip of skips) console.log(`  --   ${skip}`);
console.log('');
console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
