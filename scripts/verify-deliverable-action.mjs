#!/usr/bin/env node
/**
 * Verify the download-or-forward control the shell adds to a deliverables card.
 *
 *   node scripts/verify-deliverable-action.mjs [--url http://127.0.0.1:3199] [--shot out.png]
 *
 * ## Why a fixture rather than a live card
 *
 * The card belongs to the turn that produced the files, so in a long conversation it
 * sits far up a virtualised list — a scroll search up fourteen screens did not reach
 * it, and a text search for its heading matched the shell's own prose. So the card is
 * constructed instead, from the two things that are actually contractual:
 *
 *   * the class suffix `_menuAnchor`, which is what the injector matches on (the hash
 *     in front of it changes on every official build and is deliberately not used);
 *   * the accessible names the card really carries — `在侧边栏打开 <path>` on its open
 *     button, and the bare path on the menu anchor, both read off the live client.
 *
 * What a fixture cannot prove is that the real card renders in the real app; the
 * phone is the judge of that. What it can prove is everything the injector is
 * responsible for, including the failure that matters most: React deletes foreign
 * nodes, so the control is deleted here on purpose and must come back.
 *
 * @module dsh-remote-pulse/scripts/verify-deliverable-action
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { officialModule } from './official-client.mjs';
import { deliverableActionsScript } from '../lib/mobile-shell.js';

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
 * The sample file, derived from where this probe lives rather than from a machine.
 *
 * It used to be an APK that only existed in the author's workspace, which had two costs:
 * the "and the link really downloads" check could not pass on any other checkout, and the
 * probe silently depended on a sibling project being present. These files ship with the
 * plugin, and the shape is what the fixtures need (a subdirectory plus a file name).
 */
const REPO_ROOT = resolve(here, '..');
const SAMPLE = resolve(REPO_ROOT, 'lib', 'mobile-shell.js');
const SAMPLE_SECOND = resolve(REPO_ROOT, 'lib', 'mobile.js');
const SAMPLE_REL = 'lib/mobile-shell.js';
const SAMPLE_SECOND_REL = 'lib/mobile.js';
const SAMPLE_NAME = 'mobile-shell.js';

const results = [];
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
  body: JSON.stringify({ code: opened.code, label: 'deliverable-action' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

/**
 * Load a page with the source on disk installed, then plant card fixtures.
 *
 * The markup is copied from @deepseek-ai/dsh-client-ui-deliverables rather than
 * invented: `div._file[data-presented-file]` holding a `button._cardPreview` (whose
 * `title` is the resolved absolute path) and a `div._split` pill containing
 * `button._open` and the `_menuAnchor` menu. The first fixture here was a guess —
 * `_menuAnchorRow` wrapping a `_split` — and it passed while the real card, whose
 * path is *relative*, got nothing at all.
 *
 * @param {string} userAgent - the user agent to present.
 * @returns {Promise<import('puppeteer-core').Page>} the tab.
 */
async function prepare(userAgent) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent(userAgent);
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.evaluateOnNewDocument(() => { window.__PULSE_DELIVERABLES__ = true; });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => { window.__PULSE_DELIVERABLES__ = false; });
  await page.evaluate(source => { window.eval(source); }, deliverableActionsScript());
  await new Promise(r => setTimeout(r, 400));

  await page.evaluate(paths => {
    const fixture = document.createElement('div');
    fixture.id = 'pulse-card-fixture';
    fixture.setAttribute('style', 'position:fixed;left:8px;top:60px;width:340px;z-index:9999;padding:6px;'
      + 'border-radius:14px;background:var(--dsw-alias-bg-layer-2,#fff)');

    /** One card row shaped exactly like PresentedFileCard's output. */
    const card = (id, spec) => {
      const label = `在侧边栏打开 ${spec.stored}`;
      return '<div class="Zz9_file" data-presented-file data-case="' + id + '">'
        + '<button type="button" class="Zz9_cardPreview"'
        + (spec.resolved ? ` title="${spec.resolved}"` : '')
        + ` aria-label="在侧边栏预览 ${spec.stored}"></button>`
        + '<span class="Zz9_fileIcon"></span>'
        + '<div class="Zz9_fileBody"><div class="Zz9_details">'
        + `<span class="Zz9_fileName">${spec.name}</span>`
        + '<span class="Zz9_description"><span class="Zz9_previewHint">在侧边栏预览</span></span>'
        + '</div><div class="Zz9_split">'
        + `<button type="button" class="Zz9_open" aria-label="${label}">打开</button>`
        + '<div class="Zz9_menuAnchor"><button type="button" class="Zz9_chevron" '
        + 'aria-label="更多操作"></button></div>'
        + '</div></div></div>';
    };

    fixture.innerHTML = [
      // The case the user hit: presented with a relative path, so the accessible name
      // carries a relative one. Only the resolved tooltip is absolute.
      card('relative', {
        stored: paths.rel,
        resolved: paths.sample,
        name: paths.name,
      }),
      // Relative, and no tooltip (the host path was unavailable): the workspace has
      // to come from the component's own cwd prop.
      card('cwd', {
        stored: paths.rel,
        resolved: '',
        name: paths.name,
      }),
      // Nothing absolute and no workspace: refuse rather than guess.
      card('nowhere', {
        stored: paths.rel,
        resolved: '',
        name: paths.name,
      }),
      // A card whose printed name is a different file than the path it carries.
      card('mismatch', {
        stored: 'lib/ui.js',
        resolved: paths.sample,
        name: 'ui.js',
      }),
    ].join('');
    document.body.appendChild(fixture);

    // cwd arrives as a React prop on the component, exactly as in the real card.
    fixture.children[1]['__reactFiber$fixture'] = {
      memoizedProps: { file: { path: paths.rel }, cwd: paths.root },
      return: null,
    };

    // ---- the collapsed `present` tool row ----------------------------------
    //
    // Copied from PresentRow in @deepseek-ai/dsh-client-ui-deliverables: a
    // `div[data-disclosure-row][class*="_row"]` holding `span._title`, then
    // `span._summary` with the state label and `span._paths` carrying
    // `args.files.map(file => file.path).join(", ")`. Read off the live client at
    // 1400px: `<div class="_row_luwio_16" data-disclosure-row="true" …>` with
    // `<span class="_93YTAG_summary"><span>已交付</span><span class="_93YTAG_paths">…`.
    const rows = document.createElement('div');
    rows.id = 'pulse-present-fixture';
    rows.setAttribute('style', 'position:fixed;left:8px;top:360px;width:340px;z-index:9999;padding:6px;'
      + 'border-radius:14px;background:var(--dsw-alias-bg-layer-2,#fff)');

    /** One collapsed tool row; the workspace prop is attached afterwards, per case. */
    const row = (id, printed) => '<div class="_row_luwio_16" data-disclosure-row="true" '
      + 'data-expandable="true" role="button" tabindex="0" aria-expanded="false" data-case="' + id + '">'
      + '<span class="_leading_luwio_29"><span class="_dot_1tljr_3" data-state="done"></span></span>'
      + '<span class="_title_luwio_79">交付文件</span>'
      + '<span class="_93YTAG_summary"><span>已交付</span>'
      + `<span class="_93YTAG_paths">${printed}</span></span>`
      + '</div>';

    rows.innerHTML = [
      // The case the user hit: one delivered file, workspace-relative.
      row('one', paths.rel),
      // A present call with several files: the official join is exactly ", ".
      row('many', `${paths.rel}, ${paths.relSecond}`),
      // Absolute already: nothing has to be reconstructed, so cwd is not needed.
      row('absolute', paths.sample),
      // Relative and no workspace anywhere: refuse rather than guess.
      row('nocwd', paths.rel),
      // A name that is not a path at all: nothing to hang a control on.
      row('bare', paths.name),
    ].join('');
    document.body.appendChild(rows);

    for (const child of rows.children) {
      if (child.getAttribute('data-case') === 'nocwd') continue;
      child['__reactFiber$fixture'] = { memoizedProps: { cwd: paths.root }, return: null };
      // Counts real clicks that reach the row, so the control's own click can be shown
      // to have stopped before it: a disclosure row expands on any click inside it.
      child.addEventListener('click', () => {
        window.__PULSE_ROW_CLICKS__ = (window.__PULSE_ROW_CLICKS__ || 0) + 1;
      });
    }
    window.__PULSE_ROW_CLICKS__ = 0;
    // Dispatch-generated clicks follow a link in Chrome, and following it would take
    // the tab off the app; the activation only has to be cancelled, the event itself
    // still has to reach the control for the propagation check to mean anything.
    document.addEventListener('click', event => {
      if (event.target.closest && event.target.closest('[data-pulse-deliverable]')) event.preventDefault();
    }, true);
  }, {
    sample: SAMPLE, rel: SAMPLE_REL, relSecond: SAMPLE_SECOND_REL, name: SAMPLE_NAME, root: REPO_ROOT,
  });
  await new Promise(r => setTimeout(r, 700));
  return page;
}

/**
 * Read the injected controls out of the card fixture.
 *
 * Scoped to the fixture on purpose: the tab has a real conversation loaded, and a
 * page-wide count would make every number here depend on what that session happens to
 * contain — which is how a "no control for this row" assertion quietly stops meaning
 * anything.
 *
 * @param {import('puppeteer-core').Page} page - the tab.
 * @returns {Promise<object>} what was found.
 */
const read = page => page.evaluate(() => {
  const root = document.querySelector('#pulse-card-fixture');
  const nodes = [...(root ? root.querySelectorAll('[data-pulse-deliverable]') : [])];
  const first = nodes[0];
  const row = first ? first.closest('[data-presented-file]') : null;
  const split = first ? first.parentElement : null;
  const open = split ? split.querySelector('[class*="_open"]') : null;
  return {
    actions: nodes.length,
    pageWide: document.querySelectorAll('[data-pulse-deliverable]').length,
    href: first ? first.getAttribute('href') : '',
    label: first ? (first.textContent || '').trim() : '',
    hasDownloadAttribute: first ? first.hasAttribute('download') : false,
    insideRow: Boolean(first && row),
    insideSplit: Boolean(first && split && /_split/.test(String(split.className))),
    beforeAnchor: Boolean(first && first.nextElementSibling
      && String(first.nextElementSibling.className).includes('_menuAnchor')),
    // The control borrows the 打开 button's class so it sits inside the same pill.
    sameLookAsOpen: Boolean(first && open && first.className === open.className),
    hrefs: nodes.map(node => ({
      testcase: node.closest('[data-presented-file]').getAttribute('data-case'),
      href: node.getAttribute('href'),
    })),
    box: first ? (() => {
      const rect = first.getBoundingClientRect();
      return Math.round(rect.width) + 'x' + Math.round(rect.height);
    })() : '',
  };
});

/**
 * Read the injected controls out of the collapsed `present` row fixture.
 *
 * @param {import('puppeteer-core').Page} page - the tab.
 * @returns {Promise<object>} what was found, per case.
 */
const readRows = page => page.evaluate(() => {
  const root = document.querySelector('#pulse-present-fixture');
  const cases = {};
  for (const row of [...(root ? root.children : [])]) {
    const controls = [...row.querySelectorAll('[data-pulse-deliverable]')];
    const summary = row.querySelector('[class*="_paths"]');
    cases[row.getAttribute('data-case')] = {
      controls: controls.length,
      label: controls[0] ? (controls[0].textContent || '').trim() : '',
      sources: controls.map(node => node.getAttribute('data-pulse-deliverable-path')),
      hrefs: controls.map(node => node.getAttribute('href')),
      // Appended to the row itself, not into the summary span, and after it: the
      // summary is the flex item that owns the ellipsis.
      inRow: controls.length > 0 && controls.every(node => node.parentElement === row),
      afterSummary: controls.length > 0
        && controls.every(node => summary && summary.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
      rowWasMarked: row.hasAttribute('data-presented-file'),
    };
  }
  return { cases, rowClicks: window.__PULSE_ROW_CLICKS__ || 0 };
});

try {
  // ---- the web branch ------------------------------------------------------
  const web = await prepare('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  const webState = await read(web);
  const byCase = Object.fromEntries(webState.hrefs.map(entry => [entry.testcase, entry.href]));
  const sample = SAMPLE;

  record('卡片那一行上出现了我们的控件', webState.actions > 0,
    `数量 ${webState.actions}，尺寸 ${webState.box}，文字「${webState.label}」`);
  // The bug the user reported: `present` records a relative path, and the first
  // version only accepted an absolute one, so this card got nothing at all.
  record('相对路径的卡片也挂上了（就是漏掉的那一种）',
    Boolean(byCase.relative) && byCase.relative.includes(encodeURIComponent(sample)),
    `href=${(byCase.relative || '(没有控件)').slice(0, 100)}`);
  record('没有绝对 tooltip 时用组件自己的 cwd 拼出来',
    Boolean(byCase.cwd) && byCase.cwd.includes(encodeURIComponent(sample)),
    `href=${(byCase.cwd || '(没有控件)').slice(0, 100)}`);
  record('既没有绝对路径也没有 cwd 时拒绝注入（宁可没有，也不给错的）',
    !byCase.nowhere, `href=${byCase.nowhere || '(没有控件)'}`);
  record('卡片印的文件名和路径不是同一个文件时拒绝注入',
    !byCase.mismatch, `href=${byCase.mismatch || '(没有控件)'}`);
  record('控件就挂在卡片那一行里（不是飘在别处）', webState.insideRow, `insideRow=${webState.insideRow}`);
  record('控件插在那颗药丸里、▾ 之前（和「打开」并排）',
    webState.insideSplit && webState.beforeAnchor,
    `pill=${webState.insideSplit} beforeAnchor=${webState.beforeAnchor}`);
  record('控件沿用「打开」的样式（不是另贴一个按钮）', webState.sameLookAsOpen,
    `className 与「打开」一致=${webState.sameLookAsOpen}`);
  record('电脑端给出的是下载（带 download 属性）',
    webState.href.includes('download=1') && webState.href.includes(encodeURIComponent(SAMPLE_NAME))
    && webState.hasDownloadAttribute,
    `href=${webState.href.slice(0, 110)}`);

  const probeUrl = webState.href ? new URL(webState.href, base).href : '';
  if (probeUrl) {
    const response = await fetch(probeUrl, { headers: { cookie } });
    const disposition = response.headers.get('content-disposition') || '';
    record('那个链接真的能下载（200 且是附件）',
      response.status === 200 && disposition.startsWith('attachment'),
      `status=${response.status} disposition=${disposition.slice(0, 50)}`);
  } else {
    record('那个链接真的能下载（200 且是附件）', false, '没有 href 可测');
  }

  // ---- the collapsed present row -------------------------------------------
  //
  // The row the user was actually looking at. 交付文件 · 已交付 <path> is the collapsed
  // PresentRow, and the card this script's other half decorates only exists once that
  // row is expanded — so before this the delivered file had no control at all until the
  // row happened to be tapped.
  const rowState = await readRows(web);
  const rows = rowState.cases;
  const one = rows.one || {};
  record('折叠的交付行上直接就有控件（不用先展开）',
    one.controls === 1 && one.inRow && one.afterSummary,
    `数量 ${one.controls}，在行里 ${one.inRow}，在路径后面 ${one.afterSummary}`);
  record('行里印的是相对路径，拼成了绝对路径',
    (one.sources || []).includes(sample),
    `source=${(one.sources || []).join(' , ') || '(没有控件)'}`);
  record('折叠行上的控件电脑端也是下载',
    (one.hrefs || [])[0] === undefined ? false
      : one.hrefs[0].includes('download=1') && one.hrefs[0].includes(encodeURIComponent(sample)),
    `href=${((one.hrefs || [])[0] || '(没有控件)').slice(0, 110)}`);
  // The official renderer joins several files with ", ", so one row can print several —
  // and the per-row marker the card uses would have hidden every one after the first.
  record('一次交付多个文件时每个都有自己的控件',
    (rows.many || {}).controls === 2
    && (rows.many.sources || [])[1] === SAMPLE_SECOND,
    `数量 ${(rows.many || {}).controls}，${(rows.many.sources || []).map(name => name.split('\\').pop()).join(' + ')}`);
  record('行里已经是绝对路径时不需要 cwd 也能挂上',
    (rows.absolute || {}).controls === 1 && (rows.absolute.sources || [])[0] === sample,
    `数量 ${(rows.absolute || {}).controls}，source=${((rows.absolute || {}).sources || [])[0] || '(没有控件)'}`);
  record('相对路径但拿不到 cwd 时拒绝注入（宁可没有，也不给错的）',
    (rows.nocwd || {}).controls === 0, `数量 ${(rows.nocwd || {}).controls}`);
  record('印出来的不是路径（没有分隔符）时拒绝注入',
    (rows.bare || {}).controls === 0, `数量 ${(rows.bare || {}).controls}`);

  // The row is a disclosure button that expands the call on a click anywhere inside it,
  // so the control has to stop the click or a download would also expand the call — and
  // the counter is proven able to move, or "it did not fire" would mean nothing.
  const clicks = await web.evaluate(() => {
    const root = document.querySelector('#pulse-present-fixture');
    const target = root.querySelector('[data-case="one"]');
    const before = window.__PULSE_ROW_CLICKS__ || 0;
    target.querySelector('[data-pulse-deliverable]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const afterControl = window.__PULSE_ROW_CLICKS__ || 0;
    target.querySelector('[class*="_title"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { before, afterControl, afterRow: window.__PULSE_ROW_CLICKS__ || 0 };
  });
  record('点下载不会顺手把这一行展开', clicks.afterControl === clicks.before,
    `控件点击后行被点了 ${clicks.afterControl} 次`);
  record('（自检）点这一行的别处确实会展开 → 上面那个计数器是活的',
    clicks.afterRow === clicks.before + 1,
    `点标题后行被点了 ${clicks.afterRow} 次`);

  // ---- React deletes foreign nodes: prove it comes back --------------------
  const wiped = await web.evaluate(marker => {
    const nodes = [...document.querySelectorAll('[' + marker + ']')];
    nodes.forEach(node => node.remove());
    return nodes.length;
  }, 'data-pulse-deliverable');
  await new Promise(r => setTimeout(r, 900));
  const restored = await read(web);
  const restoredRows = await readRows(web);
  record('控件被抹掉之后会自己回来（React 重渲染就是这个行为）',
    wiped > 0 && restored.actions > 0 && restored.insideRow,
    `抹掉 ${wiped} 个，回来 ${restored.actions} 个`);
  record('折叠行上的控件被抹掉之后也会自己回来（一个不留就补一个）',
    (restoredRows.cases.one || {}).controls === 1
    && (restoredRows.cases.many || {}).controls === 2
    && (restoredRows.cases.nocwd || {}).controls === 0,
    `one=${(restoredRows.cases.one || {}).controls} many=${(restoredRows.cases.many || {}).controls} nocwd=${(restoredRows.cases.nocwd || {}).controls}`);

  if (shot) {
    const target = resolve(here, '..', shot.replace(/\.png$/, '-web.png'));
    await web.screenshot({ path: target });
    console.log(`  电脑端截图: ${target}`);
  }
  await web.close();

  // ---- the phone branch ----------------------------------------------------
  const phone = await prepare('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.9');
  const phoneState = await read(phone);
  record('手机端给出的是转发（分享面板才是手机该有的动作）',
    phoneState.href.includes('share=1') && !phoneState.href.includes('download=1')
    && phoneState.label === '转发',
    `文字「${phoneState.label}」 href=${phoneState.href.slice(0, 110)}`);
  record('手机端同样挂在卡片里（相对路径那张也一样）',
    phoneState.insideRow && phoneState.insideSplit && phoneState.actions === 2,
    `数量 ${phoneState.actions}，位置 ${phoneState.box}`);

  const phoneRows = (await readRows(phone)).cases;
  const phoneOne = phoneRows.one || {};
  record('手机端折叠的交付行上也直接有控件，而且是转发',
    phoneOne.controls === 1 && phoneOne.label === '转发'
    && (phoneOne.hrefs || [])[0].includes('share=1') && !(phoneOne.hrefs || [])[0].includes('download=1'),
    `数量 ${phoneOne.controls}，文字「${phoneOne.label}」 href=${((phoneOne.hrefs || [])[0] || '').slice(0, 100)}`);
  record('手机端拒绝注入的两种情况一致（cwd 缺失、不是路径）',
    (phoneRows.nocwd || {}).controls === 0 && (phoneRows.bare || {}).controls === 0,
    `nocwd=${(phoneRows.nocwd || {}).controls} bare=${(phoneRows.bare || {}).controls}`);
  if (shot) {
    const target = resolve(here, '..', shot.replace(/\.png$/, '-phone.png'));
    await phone.screenshot({ path: target });
    console.log(`  手机端截图: ${target}`);
  }
  await phone.close();

  // ---- the contract the fixture is copied from ------------------------------
  //
  // The fixture above proves the injector, not that the official card still looks the
  // way it was copied. That is the silent failure mode: a DSH upgrade renames the
  // attributes or the label template, the fixture keeps passing, and the real card
  // quietly gets no control — which is exactly what happened once already, with a
  // guessed fixture and a relative path.
  const card = await officialModule(base, cookie, '@deepseek-ai/dsh-client-ui-deliverables');
  record('官方交付卡片那一块能取到', card.section.length > 1000, `${card.section.length} 字节`);
  record('官方仍然用 data-presented-file 标注那一行', card.section.includes('"data-presented-file"'),
    `data-presented-file ${card.section.includes('"data-presented-file"') ? '在' : '不在'}`);
  record('官方仍然有 _cardPreview（它的 title 是解析好的绝对路径）',
    card.section.includes('cardPreview') && card.section.includes('resolveWorkspacePath'),
    `cardPreview ${card.section.includes('cardPreview')}, resolveWorkspacePath ${card.section.includes('resolveWorkspacePath')}`);
  record('官方仍然有 _open / _split / _menuAnchor 这套结构',
    ['_open{', '_split{', '_menuAnchor{'].every(name => card.section.includes(name)),
    ['_open{', '_split{', '_menuAnchor{'].map(name => `${name} ${card.section.includes(name)}`).join('，'));
  record('「在侧边栏打开 {name}」这个模板还在（相对路径就是从这里读出来的）',
    card.section.includes('presented.previewButton') && card.section.includes('在侧边栏打开'),
    `previewButton ${card.section.includes('presented.previewButton')}`);
  // The prop the fallback route depends on: without `cwd` on the component, a card
  // whose tooltip is missing cannot be resolved at all.
  record('官方组件仍然收到 cwd 这个 prop（兜底那条路要靠它）',
    /\bcwd\b/.test(card.section), 'cwd 出现在组件源码里');

  // ---- the contract the collapsed row was copied from -----------------------
  //
  // The PresentRow half of the same module: if a DSH upgrade renames `_paths` or drops
  // the ", " join, the row fixture keeps passing while the real row gets nothing.
  record('官方折叠行仍然把路径印在 _paths 这个类名下',
    card.section.includes('"paths"') && card.section.includes('_paths{'),
    `paths ${card.section.includes('"paths"')}，_paths{ ${card.section.includes('_paths{')}`);
  record('官方仍然把多个路径用「, 」拼在一起（一个控件对一个文件就是这么来的）',
    card.section.includes('.join(", ")') && /\bargs\.files\b/.test(card.section),
    card.section.includes('.join(", ")') ? 'join(", ") 在' : 'join(", ") 不在了');
  record('官方折叠行仍然是 DisclosureRow（点整行会展开，所以控件必须拦掉冒泡）',
    card.section.includes('DisclosureRow') && card.section.includes('expandOnRowClick'),
    `DisclosureRow ${card.section.includes('DisclosureRow')}，expandOnRowClick ${card.section.includes('expandOnRowClick')}`);
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
console.log('');
console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
