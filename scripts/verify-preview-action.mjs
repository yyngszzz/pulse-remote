#!/usr/bin/env node
/**
 * Verify the download-or-forward button the shell adds to an opened file's header.
 *
 *   node scripts/verify-preview-action.mjs [--url http://127.0.0.1:3199] [--shot out.png]
 *
 * ## Why this drives the real pane
 *
 * The button belongs to a surface that only exists once a file is open, and the way to
 * open one is a click — so the probe clicks. A path in the transcript opens the preview
 * in the right rail, which means the real header, the real `data-textpreview-path`
 * marker and the real viewer tools are all under test rather than a fixture built from
 * what the markup is assumed to be. The probe opens both kinds of viewer, because the
 * header is shared between them and that is worth knowing rather than assuming.
 *
 * The one thing a click cannot promise is that the session contains a file link at all
 * — the transcript is virtualised, so on a narrow or freshly-loaded page there may be
 * none. That case is reported as `--` with the reason, never as a pass.
 *
 * @module dsh-remote-pulse/scripts/verify-preview-action
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { officialModule } from './official-client.mjs';
import {
  PREVIEW_ACTION_ATTRIBUTE,
  PREVIEW_PATH_ATTRIBUTE,
  PREVIEW_SOURCE_ATTRIBUTE,
  mobileShellStyles,
  previewActionsScript,
} from '../lib/mobile-shell.js';

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
  body: JSON.stringify({ code: opened.code, label: 'preview-action' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

/**
 * Load the client with this shell's script installed, then open a session.
 *
 * @param {string} userAgent - the user agent to present.
 * @param {number} width - viewport width.
 * @returns {Promise<import('puppeteer-core').Page>} the tab, with a session open.
 */
async function prepare(userAgent, width) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2, isMobile: width <= 900, hasTouch: true });
  await page.setUserAgent(userAgent);
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.evaluateOnNewDocument(() => { window.__PULSE_PREVIEW__ = true; });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => { window.__PULSE_PREVIEW__ = false; });
  // The stylesheet from disk: a long-running process serves the copy it captured when
  // the plugin loaded, so a rule edited since then would be tested in its old form.
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => {
    // Kept for the negative case further down, which has to re-run the injector after
    // its guard flag has already been set.
    window.__PULSE_PREVIEW_SOURCE__ = source;
    window.eval(source);
  }, previewActionsScript());
  await new Promise(r => setTimeout(r, 400));

  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[class*="_sessionRow"], [class*="_listArea"] [role="button"]')];
    const first = rows.find(node => /手机遥控|WorkBuddy|Pulse|下载/.test(node.textContent || '')) || rows[0];
    if (first) first.click();
  });
  await new Promise(r => setTimeout(r, 6000));
  return page;
}

/**
 * Click a file path in the transcript, which opens that file in the side pane.
 *
 * Links are tried in order until the pane's own header reports an absolute path: a
 * transcript keeps referring to files that no longer exist, and the header falls back
 * to the relative path it was handed for those, which is a different case (and one the
 * injector is asserted to refuse further down).
 *
 * @param {import('puppeteer-core').Page} page - the tab.
 * @param {'image' | 'text'} kind - which kind of viewer to open.
 * @returns {Promise<{label: string, path: string}>} what was opened.
 */
const openFile = async (page, kind, extension = '') => {
  const count = await page.evaluate(({ wanted, ext }) => [...document.querySelectorAll('button[class*="_fileLink"]')]
    .filter(node => {
      const text = (node.textContent || '').trim();
      const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(text);
      if (ext) return text.toLowerCase().endsWith('.' + ext);
      return wanted === 'image' ? isImage : !isImage;
    }).length, { wanted: kind, ext: extension });

  for (let attempt = 0; attempt < Math.min(count, 10); attempt += 1) {
    const label = await page.evaluate(({ wanted, ext, index }) => {
      const links = [...document.querySelectorAll('button[class*="_fileLink"]')].filter(node => {
        const text = (node.textContent || '').trim();
        const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(text);
        if (ext) return text.toLowerCase().endsWith('.' + ext);
        return wanted === 'image' ? isImage : !isImage;
      });
      const target = links[index];
      if (!target) return '';
      const text = (target.textContent || '').trim();
      target.click();
      return text;
    }, { wanted: kind, ext: extension, index: attempt });
    if (!label) break;
    await new Promise(r => setTimeout(r, 2500));
    // The active pane, not the first one in the document: every click opens another tab
    // in the rail, and the first header in the DOM belongs to whichever tab was opened
    // first — which is how this read a stale file's relative path and concluded there
    // was nothing to decorate.
    const path = await page.evaluate(marker => {
      const pane = document.querySelector('[data-dockkit-pane-active="true"]') || document;
      const node = pane.querySelector('[' + marker + ']');
      return node ? String(node.getAttribute('title') || '') : '';
    }, PREVIEW_PATH_ATTRIBUTE);
    if (/^([A-Za-z]:[\\/]|\/)/.test(path)) return { label, path };
  }
  return { label: '', path: '' };
};

/**
 * Read the injected button out of the preview header.
 *
 * @param {import('puppeteer-core').Page} page - the tab.
 * @returns {Promise<object>} what was found.
 */
const read = page => page.evaluate(pathMarker => {
  // Scoped to the pane the user is looking at: the rail keeps every opened file as a
  // tab, so an unscoped query would describe whichever was opened first. If nothing is
  // found there the whole document is searched, and which scope answered is reported —
  // on a phone the rail can be laid out outside the pane the desktop uses.
  const active = document.querySelector('[data-dockkit-pane-active="true"]');
  let scope = 'pane';
  let pathNode = active ? active.querySelector('[' + pathMarker + ']') : null;
  let pane = document.querySelector('[class*="_paneBody_"]');
  if (!pathNode) {
    // Newest, not first: every opened file adds a tab, so the first match in the
    // document belongs to the oldest pane — which is how this once read a stale file.
    scope = 'document';
    pathNode = [...document.querySelectorAll('[' + pathMarker + ']')].pop() || null;
    pane = document.body;
  }
  const header = pathNode ? pathNode.parentElement : null;
  const action = header ? header.querySelector('[data-pulse-preview-action]') : null;
  const style = action ? getComputedStyle(action) : null;
  const box = action ? action.getBoundingClientRect() : null;
  const tools = header ? [...header.querySelectorAll('[class*="_tool"]')] : [];
  return {
    scope,
    hasPath: Boolean(pathNode),
    // What the viewer calls itself (代码 / 纯文本 / Markdown / 图片), so a failing kind can
    // be named rather than counted.
    viewer: (() => {
      const menu = header ? header.querySelector('[data-document-viewer-menu]') : null;
      return menu ? (menu.textContent || '').trim() : '';
    })(),
    path: pathNode ? String(pathNode.getAttribute('title') || '') : '',
    hasAction: Boolean(action),
    label: action ? (action.textContent || '').trim() : '',
    aria: action ? (action.getAttribute('aria-label') || '') : '',
    href: action ? action.getAttribute('href') : '',
    hasDownloadAttribute: action ? action.hasAttribute('download') : false,
    // Inside the header row, and after every one of the viewer's own tools: the corner
    // where a pane keeps its actions.
    insideHeader: Boolean(action && header && header.contains(action)),
    lastChild: Boolean(action && header && header.lastElementChild === action),
    afterTools: Boolean(action && tools.length > 0 && tools.every(tool => {
      const position = tool.compareDocumentPosition(action);
      return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    })),
    toolCount: tools.length,
    box: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '',
    width: box ? Math.round(box.width) : 0,
    boxRight: box ? Math.round(box.right) : null,
    viewport: window.innerWidth,
    // A header that cannot shrink its path pushes the pill out of the pane entirely.
    headerOverflow: header ? Math.round(header.scrollWidth - header.clientWidth) : 0,
    background: style ? style.backgroundColor : '',
    color: style ? style.color : '',
    glyph: action ? Boolean(action.querySelector('svg')) : false,
    // How far the button's centre sits from the right edge of the pane it heads.
    rightGap: box && pane ? Math.round(pane.getBoundingClientRect().right - box.right) : null,
  };
}, PREVIEW_PATH_ATTRIBUTE);

try {
  // ---- the desktop branch, both viewers ------------------------------------
  const web = await prepare('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 1400);

  const imageOpened = await openFile(web, 'image');
  const imageState = await read(web);
  const imageLinks = await web.evaluate(() => [...document.querySelectorAll('button[class*="_fileLink"]')]
    .filter(node => /\.(png|jpg|jpeg|gif|webp)$/i.test((node.textContent || '').trim())).length);
  if (!imageOpened.label) {
    skips.push(`会话里没有能解析出绝对路径的图片（这一屏的图片路径共 ${imageLinks} 处，`
      + '转写是虚拟滚动的），图片查看器那一半没跑');
  } else {
    record('打开图片后，头部出现下载按钮', imageState.hasAction,
      `点了 ${imageOpened.label} → ${imageOpened.path}`);
  }

  const textOpened = await openFile(web, 'text');
  const textState = await read(web);
  if (!textOpened.label) {
    skips.push('会话里没有能解析出绝对路径的文本，文本查看器那一半没跑');
  }

  const state = textOpened.label ? textState : imageState;
  if (!state.hasAction) {
    record('按钮挂在头部那一行里、排在查看器自己的工具之后',
      false, '头部里没有按钮');
  } else {
    record('按钮挂在头部那一行里、排在查看器自己的工具之后',
      state.insideHeader && state.lastChild && state.afterTools,
      `同行=${state.insideHeader} 最后一个=${state.lastChild} 工具之后=${state.afterTools}（查看器有 ${state.toolCount} 个工具）`);
    record('按钮指向的文件就是头部显示的那个（绝对路径逐字相同）',
      state.href.includes(encodeURIComponent(state.path)) && state.path.length > 3,
      `${state.path} → ${state.href.slice(0, 100)}`);
    record('文字查看器里也有（两个查看器共用同一个头部）',
      Boolean(textOpened.label) && textState.hasAction, textOpened.label || '(没有文本路径)');
    record('电脑端给出的是下载（带 download 属性）',
      state.href.includes('download=1') && state.hasDownloadAttribute,
      `文字「${state.label}」href=${state.href.slice(0, 110)}`);
    // "Bright place" is the request, so "bright" is measured: a saturated blue, not a
    // near-black chip. The client's brand token resolves to rgb(15,17,21), and a pill in
    // that colour is one more dark control in a row of dark controls.
    const channels = /rgb\((\d+), (\d+), (\d+)\)/.exec(state.background);
    const vivid = channels ? Number(channels[3]) - Number(channels[1]) >= 40 && Number(channels[3]) >= 120 : false;
    record('按钮是「鲜艳」的：饱和蓝底 + 白字 + 图标',
      state.glyph && vivid && /rgb\(255, 255, 255\)/.test(state.color),
      `背景 ${state.background}，字色 ${state.color}，尺寸 ${state.box}`);
    record('它落在面板右侧的操作角（距右边缘在 40px 内）',
      state.rightGap !== null && state.rightGap >= 0 && state.rightGap < 40,
      `距右边缘 ${state.rightGap}px`);

    const response = await fetch(new URL(state.href, base).href, { headers: { cookie } });
    const disposition = response.headers.get('content-disposition') || '';
    record('那个链接真的能下载（200 且是附件）',
      response.status === 200 && disposition.startsWith('attachment'),
      `status=${response.status} disposition=${disposition.slice(0, 46)}`);

    // React removes foreign nodes; the observer has to put it back.
    const wiped = await web.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-pulse-preview-action]')];
      nodes.forEach(node => node.remove());
      return nodes.length;
    });
    await new Promise(r => setTimeout(r, 900));
    const restored = await read(web);
    record('按钮被抹掉之后会自己回来（React 重渲染就是这个行为）',
      wiped > 0 && restored.hasAction && restored.insideHeader,
      `抹掉 ${wiped} 个，回来 ${restored.hasAction ? 1 : 0} 个`);
  }

  // ---- a header the host could not resolve gets no button ------------------
  //
  // A transcript keeps referring to files that no longer exist, and for those the
  // header carries the workspace-relative path it was handed. The host's file route
  // answers 400 for a relative path, so a button there would be one that always fails;
  // it must be refused and marked instead of silently doing nothing.
  //
  // The same fixture then proves the fix for the reported bug: the header mounts with
  // the relative path and is later given the absolute one **as an attribute write on an
  // element that already exists**. Watching children alone never saw that, so the file
  // sat there with no button until something else re-rendered the pane — "有的文件点进去
  // 之后要再点上面一个别的按钮才能出现分享按钮". Nothing is added or removed here, so a
  // pass means the title itself is being watched.
  const relative = await web.evaluate(({ marker, button, unresolved, sourceMark }) => {
    const host = document.createElement('div');
    host.id = 'pulse-preview-relative';
    host.innerHTML = '<div class="Zz_header"><div ' + marker + '="true" '
      + 'title="dsh-remote-pulse/scripts/gone.mjs"></div></div>';
    document.body.appendChild(host);
    window.__PULSE_PREVIEW__ = false;
    // eslint-disable-next-line no-eval
    window.eval(window.__PULSE_PREVIEW_SOURCE__);
    window.__PULSE_PREVIEW__ = true;

    const pathNode = host.querySelector('[' + marker + ']');
    const result = {
      button: Boolean(host.querySelector('[' + button + ']')),
      marked: pathNode.hasAttribute(unresolved),
      afterTitleUpdate: null,
      stillMarked: null,
      href: '',
      retargetedHref: '',
      retargetedSource: '',
      sameNode: null,
    };
    const settle = () => new Promise(resolve => window.requestAnimationFrame(
      () => window.requestAnimationFrame(resolve)));

    pathNode.setAttribute('title', 'D:\\deepseek harness\\dsh-remote-pulse\\scripts\\gone.mjs');
    return settle().then(() => {
      const injected = host.querySelector('[' + button + ']');
      result.afterTitleUpdate = Boolean(injected);
      result.stillMarked = pathNode.hasAttribute(unresolved);
      result.href = injected ? String(injected.getAttribute('href')) : '';
      // The header rewrites its own title after mounting — the measured case was the
      // same file spelled with forward slashes on one side and backslashes on the
      // other, which left the button opening the spelling the header no longer showed.
      // A node that already exists must follow the title, not be skipped.
      pathNode.setAttribute('title', 'D:/deepseek harness/dsh-remote-pulse/scripts/gone.mjs');
      return settle().then(() => {
        const again = host.querySelector('[' + button + ']');
        result.sameNode = again === injected;
        result.retargetedHref = again ? String(again.getAttribute('href')) : '';
        result.retargetedSource = again ? String(again.getAttribute(sourceMark) || '') : '';
        result.nodeCount = host.querySelectorAll('[' + button + ']').length;
        host.remove();
        return result;
      });
    });
  }, {
    marker: PREVIEW_PATH_ATTRIBUTE,
    button: PREVIEW_ACTION_ATTRIBUTE,
    unresolved: 'data-pulse-preview-unresolved',
    sourceMark: PREVIEW_SOURCE_ATTRIBUTE,
  }).catch(error => ({ error: String(error && error.message ? error.message : error) }));
  if (relative && relative.error) {
    skips.push(`相对路径那一项夹具自己出错了：${relative.error}`);
  } else if (relative) {
    record('路径解析不出来时不给按钮，但会打上标记（不是静默什么都不做）',
      !relative.button && relative.marked,
      `按钮=${relative.button} 未解析标记=${relative.marked}`);
    record('标题从相对改成绝对（只改属性、不动任何节点）之后按钮自己出现',
      relative.afterTitleUpdate === true && relative.stillMarked === false
      && relative.href.includes(encodeURIComponent('gone.mjs')),
      `按钮=${relative.afterTitleUpdate} 标记已清=${relative.stillMarked === false}`
      + ` href=${String(relative.href).slice(0, 60)}`);
    // The failure this fixture found in the live page: a button that already existed kept
    // the path it was created with, so it opened a spelling the header no longer showed.
    record('标题又改了之后（同一份文件换了个写法）按钮跟着改，而且是同一个节点',
      relative.sameNode === true && relative.nodeCount === 1
      && relative.retargetedSource === 'D:/deepseek harness/dsh-remote-pulse/scripts/gone.mjs'
      && relative.retargetedHref.includes(encodeURIComponent('D:/deepseek harness/dsh-remote-pulse/scripts/gone.mjs')),
      `同一个节点=${relative.sameNode} 数量=${relative.nodeCount}`
      + ` source=${relative.retargetedSource} href=${String(relative.retargetedHref).slice(0, 60)}`);
    record('标题改回解析不出来的时候，按钮被撤掉（不能留个打不开的按钮）',
      await web.evaluate(({ marker, button, unresolved }) => {
        const host = document.createElement('div');
        host.innerHTML = '<div class="Zz_header"><div ' + marker + '="true" '
          + 'title="D:\\deepseek harness\\dsh-remote-pulse\\scripts\\gone.mjs"></div></div>';
        document.body.appendChild(host);
        return new Promise(resolve => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            const pathNode = host.querySelector('[' + marker + ']');
            const had = Boolean(host.querySelector('[' + button + ']'));
            pathNode.setAttribute('title', 'dsh-remote-pulse/scripts/gone.mjs');
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
              const gone = !host.querySelector('[' + button + ']');
              const marked = pathNode.hasAttribute(unresolved);
              host.remove();
              resolve({ had, gone, marked });
            }));
          }));
        });
      }, {
        marker: PREVIEW_PATH_ATTRIBUTE,
        button: PREVIEW_ACTION_ATTRIBUTE,
        unresolved: 'data-pulse-preview-unresolved',
      }).then(state => state.gone && state.marked,
        () => false),
      '标题变回相对路径之后按钮不该还在');
  } else {
    skips.push('相对路径那一项夹具没跑成（evaluate 返回了空）');
  }

  // ---- every viewer kind gets it without a second click ---------------------
  //
  // The viewers differ in when they resolve the path, which is what made the bug look
  // like "some files". Each kind this transcript offers is opened on its own, with no
  // extra clicks anywhere, and polled rather than sampled once.
  const openedKinds = [];
  for (const wanted of ['md', 'ps1', 'png', 'js', 'json']) {
    const opened = await openFile(web, wanted === 'png' ? 'image' : 'text', wanted);
    if (!opened.label) continue;
    let kindState = await read(web);
    for (let attempt = 0; attempt < 12 && !kindState.hasAction; attempt += 1) {
      await new Promise(r => setTimeout(r, 400));
      kindState = await read(web);
    }
    openedKinds.push({ kind: wanted, viewer: kindState.viewer, hasButton: kindState.hasAction });
  }
  record('代码 / 纯文本 / Markdown / 图片 各点开一次，都是一打开就有按钮',
    openedKinds.length > 0 && openedKinds.every(entry => entry.hasButton),
    openedKinds.map(entry => `${entry.kind}(${entry.viewer})=${entry.hasButton ? '有' : '没有'}`).join(' ')
      || '(这一屏没有可点的文件)');

  // ---- the phone branch's difference: the label and the URL -----------------
  //
  // Both are driven by the user agent, and a phone-width page cannot open a file at all
  // (no paths are mounted), so the UA is overridden on the page that can and the
  // injector is re-run. The real header, the real path, the real placement.
  const phoneBranch = await web.evaluate(({ source, marker }) => {
    const before = document.querySelector('[data-pulse-preview-action]');
    if (!before) return { why: '没有可复用的按钮' };
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.11',
    });
    document.querySelectorAll('[' + marker + ']').forEach(node => node.remove());
    window.__PULSE_PREVIEW__ = false;
    // eslint-disable-next-line no-eval
    window.eval(source);
    window.__PULSE_PREVIEW__ = true;
    const after = document.querySelector('[data-pulse-preview-action]');
    const result = after ? {
      label: (after.textContent || '').trim(),
      href: after.getAttribute('href'),
      download: after.hasAttribute('download'),
    } : { why: '重新注入后没有按钮' };
    if (descriptor) Object.defineProperty(Navigator.prototype, 'userAgent', descriptor);
    return result;
  }, { source: previewActionsScript(), marker: PREVIEW_ACTION_ATTRIBUTE });

  if (phoneBranch.why) {
    skips.push(`手机端那一半没跑成：${phoneBranch.why}`);
  } else {
    record('手机端给出的是转发（分享面板才是手机该有的动作）',
      phoneBranch.href.includes('share=1') && !phoneBranch.href.includes('download=1')
      && phoneBranch.download === false && phoneBranch.label === '转发',
      `文字「${phoneBranch.label}」 href=${phoneBranch.href.slice(0, 100)}`);
  }

  if (shot) {
    const target = resolve(here, '..', shot.replace(/\.png$/, '-web.png'));
    await web.screenshot({ path: target });
    console.log(`  电脑端截图: ${target}`);
  }
  await web.close();

  // ---- the phone branch ----------------------------------------------------
  const phone = await prepare('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.11', 390);
  const phoneOpened = await openFile(phone, 'text');
  // Polled: opening a pane, mounting the header and letting the injector's observer run
  // are three asynchronous steps, and sampling once turned that race into a check that
  // failed on some runs and passed on others — which is worse than no check at all.
  let phoneState = await read(phone);
  for (let attempt = 0; attempt < 16 && !phoneState.hasAction; attempt += 1) {
    await new Promise(r => setTimeout(r, 500));
    phoneState = await read(phone);
  }
  if (!phoneOpened.label) {
    // Reported, not passed over: a 390px transcript mounts no file paths at all (the
    // list is virtualised and a phone screen holds far fewer rows), so this branch
    // cannot be driven the way the desktop one is. The phone *behaviour* is checked
    // above, by user agent, on the page that can open a file.
    skips.push('手机宽度下这一屏没有任何文件路径可点，手机那一半的界面没跑（行为由 UA 那一项覆盖）');
  } else {
    record('390px 的真实页面上，打开的文件头部里也是转发',
      phoneState.href.includes('share=1') && !phoneState.href.includes('download=1')
      && !phoneState.hasDownloadAttribute && phoneState.label === '转发',
      `文字「${phoneState.label}」 href=${phoneState.href.slice(0, 100)}`);
    // Existing in the DOM is not the same as being on the screen. On a 390px header the
    // path is long, and without a shrinking path the pill is pushed past the right edge:
    // the DOM said "there", the screenshot said "not visible".
    record('390px 下按钮没有被挤出屏幕（路径会让位）',
      phoneState.boxRight !== null && phoneState.boxRight <= phoneState.viewport - 1
      && phoneState.width > 0 && phoneState.headerOverflow <= 1,
      `按钮右边缘 ${phoneState.boxRight} / 视口 ${phoneState.viewport}，头部溢出 ${phoneState.headerOverflow}px`);
    record('手机端同样挂在打开后的头部里', phoneState.insideHeader && phoneState.hasAction,
      `同行=${phoneState.insideHeader} 尺寸 ${phoneState.box}`);
  }
  if (shot) {
    const target = resolve(here, '..', shot.replace(/\.png$/, '-phone.png'));
    await phone.screenshot({ path: target });
    console.log(`  手机端截图: ${target}`);
  }
  await phone.close();

  // ---- the contract the injector depends on --------------------------------
  const preview = await officialModule(base, cookie, '@deepseek-ai/dsh-client-ui-sidebar-documentpreview');
  record('官方预览那一块能取到', preview.section.length > 1000, `${preview.section.length} 字节`);
  record('官方仍然用 data-textpreview-path 标注头部里的路径（绝对路径就在它的 title 上）',
    preview.section.includes('data-textpreview-path') || preview.section.includes('textpreview-path'),
    `data-textpreview-path ${preview.section.includes('textpreview-path') ? '在' : '不在'}`);
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
