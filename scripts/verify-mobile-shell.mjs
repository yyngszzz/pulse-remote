#!/usr/bin/env node
/**
 * Verify the mobile shell against the real client in a real browser engine.
 *
 *   node scripts/verify-mobile-shell.mjs [--url http://127.0.0.1:3199] [--shot out.png] [--keep-open]
 *
 * ## Why this exists
 *
 * Everything upstream of this file reasons *about* the official client: the class
 * names are CSS modules injected at runtime, so they cannot be read out of a
 * bundle, and jsdom cannot help because the client boots from a `<script
 * type="module">` that jsdom does not execute. That left the shell's selectors
 * unverified — inferred from the one artifact that *is* static (the layout
 * plugin's class names in the shell stylesheet) plus the client's accessible
 * names.
 *
 * This closes that gap: it drives a real Chromium (the Edge or Chrome already
 * installed on the machine — nothing is downloaded), renders the official client
 * at a phone viewport, and then injects the shell into that live page. The result
 * is the same check a phone would perform, runnable on demand.
 *
 * ## What it reports
 *
 *   * whether the sidebar/main-column anchors the drawer depends on actually exist;
 *   * which control the attach button resolves to, and whether it is clickable;
 *   * whether the shell's chrome appears outside the React root;
 *   * that pressing the hamburger really expands the official sidebar *and* that
 *     the main column keeps full width — the overlay requirement, measured;
 *   * a screenshot, because a layout regression is a visual fact.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { officialModule } from './official-client.mjs';
import { mobileStylesheet } from '../lib/mobile.js';
import { ATTACH_LABELS, SHELL_ANCHORS, mobileShellScript, mobileShellStyles } from '../lib/mobile-shell.js';

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
const keepOpen = args.includes('--keep-open');

/** Chromium-based browsers already on the machine, newest first. */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const executablePath = process.env.PULSE_BROWSER ?? BROWSERS.find(candidate => existsSync(candidate));
if (!executablePath) {
  console.error('找不到 Chromium 系浏览器。设 PULSE_BROWSER 指向 msedge.exe / chrome.exe。');
  process.exit(2);
}

/**
 * Neutralise the shell rows the *running* plugin injects, leaving the pristine
 * official client.
 *
 * This is not optional politeness. The webserver inject payload is captured when
 * the plugin loads, so a long-running DSH keeps serving whatever the shell looked
 * like at process start. That stale copy is real code with a real
 * `__PULSE_SHELL__` guard and its own MutationObserver, so injecting the current
 * source into the same page is a silent no-op — and any verdict drawn from that
 * page describes the old shell, not the one on disk.
 *
 * The guard is also the cleanest way to stop it: setting the flag before any page
 * script runs makes the stale build return immediately, so it installs neither
 * its chrome nor its observer. Its stylesheet is dropped separately once parsed.
 * Serving the document ourselves would work too, but it costs the page its local
 * origin and Chromium then refuses the client's own WebSocket — which would make
 * this impossible to point at a real conversation.
 *
 * @param {import('puppeteer-core').Page} page - the page to arm.
 * @returns {Promise<void>} once the hook is registered.
 */
async function blockInjectedShell(page) {
  await page.evaluateOnNewDocument(() => {
    window.__PULSE_SHELL__ = true;
  });
}

/**
 * Build the page's shell from the source on disk.
 *
 * @param {import('puppeteer-core').Page} page - the page to build into.
 * @returns {Promise<void>} once the shell is installed.
 */
async function installCurrentShell(page) {
  const leftovers = await page.evaluate(() => {
    let dropped = 0;
    for (const sheet of document.querySelectorAll('style')) {
      if (/pulse-burger|pulse-fab|pulse-drawer-open/.test(sheet.textContent || '')) {
        sheet.remove();
        dropped += 1;
      }
    }
    // The flag we set to disarm the stale build must come down for our own copy.
    window.__PULSE_SHELL__ = false;
    return dropped;
  });
  // Both of this plugin's stylesheets come from disk, not from the running process:
  // the process captured its injection rows when the plugin loaded, so a rule edited
  // since then would otherwise be tested in its old form — which is precisely how the
  // tab × was measured as still crooked the first time this check was written.
  await page.addStyleTag({ content: mobileStylesheet() });
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => {
    // eslint-disable-next-line no-eval
    window.eval(source);
  }, mobileShellScript());
  return leftovers;
}

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

// ---- a paired session --------------------------------------------------------

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const pairResponse = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'shell-verify' }),
});
const paired = await pairResponse.json();
const setCookie = (pairResponse.headers.getSetCookie?.() ?? [])[0] ?? '';
const cookiePair = setCookie.split(';')[0];
const cookieValue = cookiePair.slice(cookiePair.indexOf('=') + 1);

console.log(`移动外壳真浏览器验证  base=${base}`);
console.log(`  浏览器: ${executablePath}`);

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

let failure = null;
try {
  const page = await browser.newPage();
  // A phone viewport, which is the whole point of the shell.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setCookie({ name: 'pulse_session', value: cookieValue, domain: new URL(base).hostname, path: '/' });

  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(String(error.message).slice(0, 200)));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(String(message.text()).slice(0, 200));
  });

  // Disarm the plugin's snapshot of the shell before any page script runs, so the
  // page we measure is the official client alone.
  await blockInjectedShell(page);

  const response = await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  record('/ 返回 200', response?.status() === 200, `status=${response?.status()}`);

  // The official client mounts asynchronously; wait for its tree rather than a timer.
  let rendered = true;
  try {
    await page.waitForFunction(() => {
      const root = document.getElementById('root');
      return Boolean(root && root.children.length > 0);
    }, { timeout: 60_000 });
  } catch {
    rendered = false;
  }
  record('官方客户端渲染出 DOM', rendered, rendered ? 'ok' : '#root 一直为空');

  const tree = await page.evaluate(() => {
    const root = document.getElementById('root');
    return { elements: document.querySelectorAll('*').length, rootChildren: root ? root.children.length : 0 };
  });
  record('页面元素数量合理', tree.elements > 50, `elements=${tree.elements} #root children=${tree.rootChildren}`);

  // ---- do the shell's assumptions hold? ------------------------------------

  const anchors = await page.evaluate(prefixes => {
    const found = {};
    for (const prefix of prefixes) {
      const nodes = document.querySelectorAll(`[class*="${prefix}"]`);
      found[prefix] = nodes.length;
    }
    // The drawer is only an overlay if the sidebar can be lifted out of the flex
    // flow, so what matters is the sidebar's *parent* — the box the shell will
    // position against — not a particular generated class name.
    const sidebar = document.querySelector('[class*="_sidebarCol"]');
    const center = document.querySelector('[class*="_centerCol"]');
    const frame = document.querySelector('[class*="_frame"]');
    return {
      found,
      sharesParent: Boolean(sidebar && center && sidebar.parentElement === center.parentElement),
      sidebarParentContainsFrame: Boolean(frame && sidebar && frame.contains(sidebar)),
      collapsedMarkers: document.querySelectorAll('[class*="_collapsed"]').length,
    };
  }, SHELL_ANCHORS.map(anchor => anchor.prefix));

  for (const anchor of SHELL_ANCHORS) {
    record(`锚点 ${anchor.prefix} 命中（${anchor.purpose}）`, anchors.found[anchor.prefix] > 0,
      `${anchors.found[anchor.prefix]} 个`);
  }
  record('侧栏与主列同级（抽屉可以脱离流式布局）', anchors.sharesParent,
    `sharesParent=${anchors.sharesParent}`);
  record('收起点存在（用 class 而不是宽度判断）', anchors.collapsedMarkers > 0,
    `_collapsed 命中 ${anchors.collapsedMarkers} 个`);
  // The frame's grid template is rewritten by a rule that matches by suffix, so a
  // second element with that suffix anywhere on the page would silently inherit
  // the override too.
  record('外框锚点只命中一个（改轨道的那条规则只作用于它）', anchors.found['_frame'] === 1,
    `_frame 命中 ${anchors.found['_frame']} 个`);

  // ---- the real tree, with real geometry -----------------------------------
  //
  // Printed on demand because this is how the shell's selectors get written and
  // repaired: the official class names are generated, so the only durable way to
  // identify an element is where it sits and what it contains.
  if (args.includes('--dump')) {
    const tree = await page.evaluate(() => {
      const lines = [];
      /**
       * @param {Element} element - current node.
       * @param {number} depth - current depth.
       */
      function walk(element, depth) {
        if (depth > 6) return;
        const rect = element.getBoundingClientRect();
        const classes = String(element.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
        const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
        const size = `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`;
        // A zero-size element is still walked: React commonly wraps everything in
        // a `display: contents` layer, whose own box is empty and whose children
        // are the entire page. Returning early there would print nothing.
        lines.push(`${'  '.repeat(depth)}${element.tagName.toLowerCase()} [${size}] ${classes}${label ? ` {${label}}` : ''}`);
        for (const child of element.children) walk(child, depth + 1);
      }
      const root = document.getElementById('root');
      if (root) walk(root, 0);
      return lines;
    });
    console.log('\n=== #root 结构（真实几何，宽x高@左,上） ===');
    for (const line of tree.slice(0, 140)) console.log('  ' + line);
    console.log('');

    // The sidebar and the composer are the two things the shell touches, so both
    // are printed in full: whether a drawer can be built by widening what is
    // already there depends on whether the content exists in the DOM at all.
    const detail = await page.evaluate(() => {
      /** @param {string} selector - what to print. @returns {string[]} the lines. */
      function subtree(selector) {
        const node = document.querySelector(selector);
        if (!node) return [`(没有 ${selector})`];
        const lines = [];
        /**
         * @param {Element} element - current node.
         * @param {number} depth - current depth.
         */
        function walk(element, depth) {
          if (depth > 7) return;
          const rect = element.getBoundingClientRect();
          const classes = String(element.className || '').trim().split(/\s+/).filter(Boolean).join(' ');
          const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
          const own = Array.from(element.childNodes)
            .filter(child => child.nodeType === 3)
            .map(child => child.textContent.trim())
            .filter(Boolean)
            .join(' ')
            .slice(0, 28);
          const size = `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`;
          lines.push(`${'  '.repeat(depth)}${element.tagName.toLowerCase()} [${size}] ${classes}${label ? ` {${label}}` : ''}${own ? ` "${own}"` : ''}`);
          for (const child of element.children) walk(child, depth + 1);
        }
        walk(node, 0);
        return lines;
      }
      const expandish = Array.from(document.querySelectorAll('button, [role="button"], [title], [aria-label]'))
        .map(node => `${node.getAttribute('aria-label') || node.getAttribute('title') || ''}`)
        .filter(name => /展开|收起|侧栏|菜单|expand|collapse|sidebar|menu/i.test(name));
      return {
        sidebar: subtree('[class*="_sidebarCol"]'),
        composer: subtree('textarea').length > 1 ? [] : subtree('form'),
        expandish: [...new Set(expandish)],
      };
    });

    console.log('=== 侧栏子树 ===');
    for (const line of detail.sidebar.slice(0, 70)) console.log('  ' + line);
    console.log('\n=== 与"展开/收起/侧栏/菜单"有关的可访问名 ===');
    console.log('  ' + (detail.expandish.length ? detail.expandish.join(' | ') : '(没有)'));
    console.log('');
  }

  // ---- which control does the attach button resolve to? ---------------------

  const attach = await page.evaluate(labels => {
    const matcher = new RegExp(labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], label, a, span[title]'));
    const named = candidates
      .map(node => ({
        label: node.getAttribute('aria-label') || '',
        title: node.getAttribute('title') || '',
        text: (node.textContent || '').trim().slice(0, 16),
      }))
      .filter(entry => entry.label || entry.title);
    const hit = candidates.findIndex(node => matcher.test(
      (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '') + ' ' + (node.textContent || '')
    ));
    return { named: named.slice(0, 30), hitIndex: hit, candidates: candidates.length };
  }, ATTACH_LABELS);

  record('按可访问名找到官方添加入口', attach.hitIndex >= 0,
    attach.hitIndex >= 0 ? `候选 #${attach.hitIndex}` : `未命中；候选 ${attach.candidates} 个，带名 ${attach.named.length} 个`);
  if (attach.hitIndex < 0 && attach.named.length) {
    console.log('\n  页面上的可访问名（用于修正 ATTACH_LABELS）：');
    for (const entry of attach.named) {
      console.log(`    aria-label=${JSON.stringify(entry.label)} title=${JSON.stringify(entry.title)} text=${JSON.stringify(entry.text)}`);
    }
    console.log('');
  }

  // ---- what does the official sidebar toggle actually do at phone width? ---
  //
  // This is the question the shell's whole design hangs on. If the official
  // control overlays the sidebar, the shell only needs to click it; if it pushes
  // the content instead, the shell has to make the expanded column overlay.
  if (args.includes('--probe-sidebar')) {
    const before = await page.evaluate(() => {
      const frame = document.querySelector('[class*="_frame"]');
      const sidebar = document.querySelector('[class*="_sidebarCol"]');
      const center = document.querySelector('[class*="_centerCol"]');
      const toggle = document.querySelector('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]');
      const box = node => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) };
      };
      return {
        frame: box(frame), sidebar: box(sidebar), center: box(center),
        toggleLabel: toggle ? toggle.getAttribute('aria-label') : null,
        toggleBox: box(toggle),
      };
    });
    console.log('\n=== 点击官方「打开侧边栏」之前 ===');
    console.log('  ' + JSON.stringify(before));

    if (before.toggleLabel) {
      await page.click('button[aria-label="打开侧边栏"]').catch(() => {});
      await new Promise(r => setTimeout(r, 500));

      const after = await page.evaluate(() => {
        const frame = document.querySelector('[class*="_frame"]');
        const sidebar = document.querySelector('[class*="_sidebarCol"]');
        const center = document.querySelector('[class*="_centerCol"]');
        const layer = document.querySelector('[class*="_overlayLayer"]');
        const box = node => {
          if (!node) return null;
          const r = node.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) };
        };
        const rail = document.querySelector('[class*="_collapsed"]');
        return {
          frame: box(frame), sidebar: box(sidebar), center: box(center),
          overlayLayer: box(layer),
          stillCollapsed: Boolean(rail),
          toggleLabelNow: (document.querySelector('button[aria-label="收起侧边栏"]') || {}).getAttribute
            ? document.querySelector('button[aria-label="收起侧边栏"]').getAttribute('aria-label')
            : null,
        };
      });
      console.log('\n=== 点击之后 ===');
      console.log('  ' + JSON.stringify(after));
      const sidebarWidth = after.sidebar ? after.sidebar.w : 0;
      const centerWidth = after.center ? after.center.w : 0;
      console.log('');
      console.log(`  侧栏宽度 ${before.sidebar?.w} → ${sidebarWidth}`);
      console.log(`  主区宽度 ${before.center?.w} → ${centerWidth}`);
      console.log(`  已展开（不再 collapsed）: ${!after.stillCollapsed}`);
      console.log(
        centerWidth >= 390
          ? '  → 侧栏是浮层（主区没被挤窄），外壳只需点这个按钮'
          : '  → 侧栏是推挤式（主区被挤窄），外壳需要把展开后的侧栏改成浮层',
      );
      if (shot) {
        const target = resolve(shot.replace(/\.png$/, '-sidebar-open.png'));
        await page.screenshot({ path: target });
        console.log(`  截图: ${target}`);
      }
    } else {
      console.log('  没找到「打开侧边栏」按钮');
    }
  }

  // ---- what else is taking width in the frame? ------------------------------
  //
  // The frame turned out to have three columns, not two, and the conversation
  // cannot be full width while a third one holds space. So each of them is
  // described well enough to decide whether it should also leave the flow.
  if (args.includes('--probe-cols')) {
    const columns = await page.evaluate(() => {
      const frame = document.querySelector('[class*="_frame"]');
      if (!frame) return [];
      return Array.prototype.map.call(frame.children, child => {
        const r = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return {
          cls: String(child.className || ''),
          w: Math.round(r.width),
          left: Math.round(r.left),
          pos: style.position,
          display: style.display,
          overflow: style.overflow,
          collapsed: child.querySelectorAll('[class*="_collapsed"]').length,
          buttons: child.querySelectorAll('button, [role="button"]').length,
          elementChildren: child.children.length,
          text: (child.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
          labels: Array.prototype.slice.call(child.querySelectorAll('[aria-label], [title]'), 0, 8)
            .map(node => node.getAttribute('aria-label') || node.getAttribute('title')),
          skeleton: Array.prototype.slice.call(child.querySelectorAll('*'), 0, 7).map(node => {
            const cls = String(node.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 1).join('');
            const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
            return `${node.tagName.toLowerCase()}${cls ? '.' + cls.split('_').slice(-1)[0] : ''}${label ? `{${label}}` : ''}`;
          }).join(' > '),
        };
      });
    });
    console.log('\n=== 外框里的每一栏 ===');
    for (const [index, column] of columns.entries()) {
      console.log(`  [${index}] ${String(column.w).padStart(4)}px @${String(column.left).padStart(4)}  ${column.pos.padEnd(9)} ${column.display.padEnd(8)} ${column.cls}`);
      console.log(`       _collapsed 命中=${column.collapsed} 按钮=${column.buttons} 子元素=${column.elementChildren}`);
      console.log(`       可访问名: ${column.labels.join(' | ') || '(无)'}`);
      console.log(`       骨架: ${column.skeleton || '(无)'}`);
      console.log(`       文字: ${column.text || '(空)'}`);
    }
    console.log('');
  }

  // ---- inject the shell into the live page ---------------------------------

  const leftoverSheets = await installCurrentShell(page);
  await new Promise(r => setTimeout(r, 600));
  record('运行中插件的旧外壳已被拦下（本次验证的是磁盘上的源码）', true,
    leftoverSheets > 0 ? `并丢弃了它 ${leftoverSheets} 张样式表` : '页面里没有别的外壳样式');

  const pristine = await page.evaluate(() => ({
    burger: Boolean(document.querySelector('.pulse-burger')),
    chrome: document.querySelectorAll('[data-pulse="chrome"]').length,
  }));
  record('现在页面上只有这一份外壳', pristine.burger && pristine.chrome === 1,
    `burger=${pristine.burger} chrome=${pristine.chrome}`);

  const shell = await page.evaluate(() => {
    const root = document.getElementById('root');
    const chromeHost = document.querySelector('[data-pulse="chrome"]');
    return {
      drawerTagged: document.querySelectorAll('[data-pulse-drawer]').length,
      hasSidebar: document.documentElement.classList.contains('pulse-has-sidebar'),
      drawerOpen: document.documentElement.classList.contains('pulse-drawer-open'),
      burger: Boolean(document.querySelector('.pulse-burger')),
      attachTargets: document.querySelectorAll('.pulse-attach-target').length,
      rightbarEmpty: document.querySelectorAll('[data-pulse-rightbar-empty]').length,
      rightbar: (() => {
        const rail = document.querySelector('[class*="_rightbarCol"]');
        if (!rail) return null;
        const interactive = rail.querySelectorAll(
          'button, [role="button"], a, input, textarea, select, svg, img, canvas, video');
        return {
          tagged: rail.hasAttribute('data-pulse-rightbar-empty'),
          width: Math.round(rail.getBoundingClientRect().width),
          text: (rail.textContent || '').trim().slice(0, 40),
          interactive: interactive.length,
          tags: Array.prototype.slice.call(interactive, 0, 4).map(node => node.tagName.toLowerCase()),
          htmlLength: rail.innerHTML.length,
        };
      })(),
      chromeOutsideRoot: Boolean(chromeHost) && !root.contains(chromeHost),
    };
  });

  record('外壳给侧栏打了抽屉标记', shell.drawerTagged > 0, `tagged=${shell.drawerTagged}`);
  record('外壳识别到侧栏存在', shell.hasSidebar, `pulse-has-sidebar=${shell.hasSidebar}`);
  record('汉堡按钮存在', shell.burger, '');

  // Hidden counts as missing. Every other check about the hamburger is about where
  // it sits, and a display:none button satisfies all of them trivially — the
  // overlap check reported "no overlap" for a control that was not on the screen at
  // all, which is how a regression in the hiding rule got through.
  const burgerState = await page.evaluate(() => {
    const node = document.querySelector('.pulse-burger');
    const rect = node ? node.getBoundingClientRect() : null;
    const closers = [...document.querySelectorAll('[class*="_tabClose_"]')].slice(0, 3)
      .map(item => {
        const box = item.getBoundingClientRect();
        const style = getComputedStyle(item);
        return `${Math.round(box.width)}x${Math.round(box.height)}/${style.display}`;
      });
    return {
      size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '(缺失)',
      htmlClass: document.documentElement.className,
      tabClosers: closers.join(' ') || '(无)',
    };
  });
  record('对话页上汉堡是可见的（没有被外壳自己藏起来）',
    Number.parseInt(burgerState.size, 10) > 0,
    `尺寸 ${burgerState.size}；html class=「${burgerState.htmlClass}」；_tabClose_ ${burgerState.tabClosers}`);

  // Both directions of the corner *report*, proved in a real engine because it is
  // geometric and jsdom performs no layout at all. What changed with the hamburger's move
  // into the header: the report is now information for the self-check panel, not a reason to
  // hide the button — a floating button had to step aside for the client's own tab strip,
  // an item inside the header cannot cover anything outside it.
  const cornerRule = await page.evaluate(async () => {
    const root = document.getElementById('root');
    const burger = document.querySelector('.pulse-burger');
    if (!root || !burger) return null;
    const isTaken = () => document.documentElement.classList.contains('pulse-corner-taken');

    /** Milliseconds until a predicate holds, or -1. */
    const until = async predicate => {
      const started = performance.now();
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (predicate()) return Math.round(performance.now() - started);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return -1;
    };

    const probe = document.createElement('button');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px;z-index:9;'
      + 'background:transparent;border:0';
    root.appendChild(probe);
    const takenAfter = await until(isTaken);
    const box = burger.getBoundingClientRect();
    const visibleWhenTaken = box.width > 0 && box.height > 0;
    const placedWhenTaken = burger.getAttribute('data-pulse-placed') || '';

    probe.remove();
    const restoredAfter = await until(() => !isTaken());
    const shown = burger.getBoundingClientRect().width > 0;
    return {
      taken: takenAfter >= 0, takenAfter, visibleWhenTaken, placedWhenTaken,
      restored: restoredAfter >= 0, restoredAfter, shown,
    };
  });
  record('客户端的控件占住那个角时，外壳仍然认得出来（两个方向都可观测）',
    Boolean(cornerRule) && cornerRule.taken && cornerRule.restored,
    `识别到占用=${cornerRule?.taken} 解除=${cornerRule?.restored}`);
  record('而且汉堡不再因此被藏起来 —— 它在页头里（或没有页头时浮着），两种都可见',
    Boolean(cornerRule) && cornerRule.visibleWhenTaken && cornerRule.shown,
    `占用时可见=${cornerRule?.visibleWhenTaken}（状态 ${cornerRule?.placedWhenTaken}），`
    + `解除后可见=${cornerRule?.shown}`);
  record('占用与解除都是即时的（不再等 250ms 的节流）',
    Boolean(cornerRule) && cornerRule.takenAfter >= 0 && cornerRule.takenAfter < 150
    && cornerRule.restoredAfter >= 0 && cornerRule.restoredAfter < 150,
    `识别占用用了 ${cornerRule?.takenAfter}ms，解除用了 ${cornerRule?.restoredAfter}ms`);

  // ---- the × in a tab is centred on the tab -------------------------------
  //
  // The official close button is `position:absolute; top:4px; right:4px; width:20px`
  // inside a 28px tab, which is already symmetric. An earlier rule of ours grew it to
  // 32px with min-width/min-height — which cannot move an absolute anchor, so the box
  // grew downward and the ink sat 6px below the tab's centreline. "It looks crooked" is
  // a measurement, so this measures it: the tab's centreline against the ink's.
  const shellHtml = await (await fetch(`${base}/`, { headers: { cookie: cookiePair } })).text();
  const shellCssHref = (/href="([^"]*assets\/index-[^"]+\.css)"/.exec(shellHtml) || [])[1] || '';
  const tabCss = shellCssHref
    ? await (await fetch(new URL(shellCssHref, base).href, { headers: { cookie: cookiePair } })).text()
    : '';
  const names = {
    tab: (/\.(_tab_[\w-]+)\{/.exec(tabCss) || [])[1] || '',
    active: (/\.(_tabActive_[\w-]+)[\s,{]/.exec(tabCss) || [])[1] || '',
    title: (/\.(_tabTitle_[\w-]+)\{/.exec(tabCss) || [])[1] || '',
    close: (/\.(_tabClose_[\w-]+)\{/.exec(tabCss) || [])[1] || '',
  };
  const tabRules = [...tabCss.matchAll(/\.[^{}]*_(?:tab|tabActive|tabTitle|tabClose)_[\w-]+[^{}]*\{[^}]*\}/g)]
    .map(match => match[0]).join('\n');
  if (!names.close || !names.tab) {
    record('从官方样式里取到了标签页和关闭按钮的类名', false, JSON.stringify(names));
  } else {
    const measured = await page.evaluate(({ names, tabRules }) => {
      const style = document.createElement('style');
      style.id = 'pulse-tab-probe-official';
      style.textContent = tabRules;
      document.head.appendChild(style);

      const host = document.createElement('div');
      host.id = 'pulse-tab-fixture';
      host.setAttribute('style', 'position:fixed;left:8px;top:120px;z-index:600;display:flex');
      host.innerHTML = '<div class="' + names.tab + ' ' + names.active + '">'
        + '<span class="' + names.title + '">文件</span>'
        + '<button type="button" class="' + names.close + '" aria-label="关闭">'
        + '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" '
        + 'stroke="currentColor" stroke-width="1.6" fill="none"/></svg></button></div>';
      document.body.appendChild(host);

      const tab = host.firstElementChild;
      const close = host.querySelector('.' + names.close);
      /** The ink's centre against the tab's centre, in px. */
      const offset = () => {
        const tabBox = tab.getBoundingClientRect();
        const ink = close.querySelector('svg') || close;
        const inkBox = ink.getBoundingClientRect();
        return {
          dx: Math.round(((inkBox.left + inkBox.width / 2) - (tabBox.left + tabBox.width / 2)) * 10) / 10,
          dy: Math.round(((inkBox.top + inkBox.height / 2) - (tabBox.top + tabBox.height / 2)) * 10) / 10,
          hangsOut: Math.round(close.getBoundingClientRect().bottom - tabBox.bottom),
          target: Math.round(close.getBoundingClientRect().width)
            + 'x' + Math.round(close.getBoundingClientRect().height),
          tabHeight: Math.round(tabBox.height),
        };
      };

      const shipped = offset();

      // Prove the check can fail: put the old rule back. It has to be written at the
      // same specificity as the shipped one, or it would simply lose the cascade and
      // the "regression" would measure as fixed — a self-check that cannot fail.
      const regression = document.createElement('style');
      regression.textContent = '.' + names.tab + ' .' + names.close
        + '{min-width:32px;min-height:32px;top:4px;right:4px;display:inline-flex;'
        + 'align-items:center;justify-content:center;align-self:center}';
      document.head.appendChild(regression);
      const withOldRule = offset();
      regression.remove();

      // And the touch area, which the pseudo-element is there to keep.
      const probe = document.elementFromPoint(
        close.getBoundingClientRect().left - 3,
        close.getBoundingClientRect().top + close.getBoundingClientRect().height / 2,
      );
      const targetReaches = Boolean(probe && (probe === close || close.contains(probe)));

      style.remove();
      host.remove();
      return { shipped, withOldRule, targetReaches };
    }, { names, tabRules });

    record('从官方样式里取到了标签页和关闭按钮的类名',
      Boolean(names.tab && names.close && names.title),
      `tab=${names.tab} close=${names.close}`);
    record('这个检查能发现「× 不居中」那个 bug（把旧规则放回去就会偏）',
      Math.abs(measured.withOldRule.dy) >= 3,
      `旧规则下偏 ${measured.withOldRule.dy}px、还多伸出标签 ${measured.withOldRule.hangsOut}px`);
    record('标签里的 × 在垂直方向居中（偏差 ≤ 1px）',
      Math.abs(measured.shipped.dy) <= 1,
      `偏 ${measured.shipped.dy}px（标签高 ${measured.shipped.tabHeight}px，按钮 ${measured.shipped.target}）`);
    record('× 的盒子不再伸出标签之外',
      measured.shipped.hangsOut <= 0, `底部超出 ${measured.shipped.hangsOut}px`);
    record('触摸区域仍然够大（伪元素把命中范围撑到 32px 宽）',
      measured.targetReaches,
      `按钮左边 3px 处是否仍命中按钮：${measured.targetReaches}`);
  }
  record('官方「+」被标成上传入口', shell.attachTargets > 0, `pulse-attach-target ×${shell.attachTargets}`);
  // Stated as the rule rather than a fixed expectation: a rail with nothing in it
  // must keep no width, and a rail holding a real panel must never be hidden.
  // Which of the two shows up depends on whether the client has live data — with
  // a working WebSocket the rail carries a collapsed "空面板" panel with its own
  // controls, and without one it is genuinely blank.
  const railHasContent = Boolean(shell.rightbar) && (shell.rightbar.interactive > 0 || shell.rightbar.text !== '');
  record('右侧栏按内容判定：空的让出宽度，有内容的原样保留',
    Boolean(shell.rightbar) && (railHasContent
      ? shell.rightbar.tagged === false
      : shell.rightbar.tagged === true && shell.rightbar.width === 0),
    `有内容=${railHasContent} tagged=${shell.rightbar?.tagged} width=${shell.rightbar?.width} `
    + `控件=${shell.rightbar?.interactive} 文字=${JSON.stringify(shell.rightbar?.text)}`);
  record('自有 UI 在 #root 之外', shell.chromeOutsideRoot, 'React 重渲染不会抹掉它');

  // ---- the self-check panel must have a way out of it ------------------------
  //
  // The panel covers the bottom of the screen, so the button that opened it has to
  // stay hittable. It did not: the panel sat at z-index 90 and the toggle at 50,
  // so opening it buried the only control that could close it. Hit-testing the
  // toggle's own centre point is what catches that — "there is a close button
  // somewhere in the markup" was already true and did not help.
  const diag = await page.evaluate(() => {
    const toggle = document.querySelector('.pulse-diag-toggle');
    const panel = document.querySelector('.pulse-diag');
    if (!toggle || !panel) return null;

    /** @returns {{ok: boolean, hit: string}} whether the toggle's own centre hits it. */
    const hitsToggle = () => {
      const rect = toggle.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        ok: Boolean(hit && (hit === toggle || toggle.contains(hit))),
        hit: hit ? (String(hit.className) || hit.tagName) : '(nothing)',
      };
    };

    // Prove this check can fail, by restoring the arrangement that shipped: panel
    // above the toggle. If the hit test still reported "reachable" here, then the
    // assertion below would be incapable of catching the bug it exists for.
    const probe = document.createElement('style');
    probe.textContent = '.pulse-diag{z-index:99 !important}.pulse-diag-toggle{z-index:40 !important}';
    document.head.appendChild(probe);
    toggle.click();
    const blind = hitsToggle();
    toggle.click();
    probe.remove();

    toggle.click();
    const live = hitsToggle();
    const state = {
      opened: !panel.hidden,
      reachable: live.ok,
      hit: live.hit,
      detectsTheBug: !blind.ok,
      blindHit: blind.hit,
      hasCloseButton: Boolean(panel.querySelector('.pulse-diag-close')),
      labelWhileOpen: toggle.getAttribute('aria-label'),
      explainsItself: Boolean(panel.querySelector('.pulse-diag-body')),
      text: (panel.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
    };
    toggle.click();
    state.closedAgain = panel.hidden;
    return state;
  });
  record('「关不掉」这条检查本身能发现该 bug',
    Boolean(diag) && diag.detectsTheBug,
    `把面板盖在按钮上方时，命中=${diag?.blindHit}（说明检查会失败）`);
  record('自检面板打开后，打开它的按钮仍然点得到（否则关不掉）',
    Boolean(diag) && diag.opened && diag.reachable,
    `面板打开=${diag?.opened} 该点命中=${diag?.hit} 可达=${diag?.reachable}`);
  record('自检面板里有一个明确的关闭按钮', Boolean(diag) && diag.hasCloseButton,
    `关闭按钮=${diag?.hasCloseButton} 打开时按钮叫「${diag?.labelWhileOpen}」`);
  record('自检面板能再点一次关掉', Boolean(diag) && diag.closedAgain, `closed=${diag?.closedAgain}`);
  record('自检面板说清楚它是干什么的', Boolean(diag) && diag.explainsItself,
    `开头是「${diag?.text}」`);

  // ---- popovers must not hang off the right edge ---------------------------
  //
  // The background-jobs menu is position:absolute at its trigger's left edge with a
  // fixed 336px width, and the official CSS never checks whether that fits — on a
  // desktop window it does, which is why nobody notices. On a 390px phone the trigger
  // sits around x=144 (after the mode chip) and the menu ends ~90px past the right
  // edge: the user sees a box cut in half and cannot read the right-hand column.
  //
  // The fixture uses the jobs plugin's own class names and its own stylesheet, so the
  // geometry under test is the real one. The check is self-validating in both
  // directions: it first proves the fixture really does overflow (otherwise the fix
  // could not be distinguished from a fixture that was never broken), and it plants a
  // second menu that already fits, which the clamp must leave alone.
  const official = await officialModule(base, cookiePair, '@deepseek-ai/dsh-client-ui-jobs');
  const popover = await page.evaluate(({ prefix, css }) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const host = document.createElement('div');
    host.id = 'pulse-popover-fixture';
    // 144px is where the real header puts the jobs chip: after the hamburger and the
    // mode selector.
    host.setAttribute('style', 'position:fixed;left:144px;top:70px;z-index:400');
    host.innerHTML = '<div class="' + prefix + '_root">'
      + '<button type="button" class="' + prefix + '_trigger">1 个后台任务</button>'
      + '<ul class="' + prefix + '_menu">'
      + '<li class="' + prefix + '_row"><span class="' + prefix + '_kind">pwsh</span>'
      + '<span class="' + prefix + '_label">powershell -ExecutionPolicy Bypass …</span>'
      + '<span class="' + prefix + '_status">exited</span></li></ul></div>';
    document.body.appendChild(host);

    const cramped = host.querySelector('[class*="_menu"]');
    // A second one close to the left edge, which fits and must be left alone.
    const fitsHost = document.createElement('div');
    fitsHost.setAttribute('style', 'position:fixed;left:8px;top:220px;z-index:400');
    fitsHost.innerHTML = '<div class="' + prefix + '_root">'
      + '<ul class="' + prefix + '_menu"><li class="' + prefix + '_row">短的</li></ul></div>';
    document.body.appendChild(fitsHost);
    const fits = fitsHost.querySelector('[class*="_menu"]');

    /** @param {Element} node @returns {object} its box, rounded. */
    const box = node => {
      const rect = node.getBoundingClientRect();
      return {
        left: Math.round(rect.left), right: Math.round(rect.right),
        width: Math.round(rect.width), transform: node.style.transform || '(none)',
      };
    };

    // Measured synchronously, before the observer's animation frame can run: this is
    // what the user sees today.
    const before = box(cramped);
    const fitsBefore = box(fits);
    window.__PULSE_SHELL_DEBUG__.clampPopovers();
    const after = box(cramped);
    const fitsAfter = box(fits);

    return { before, after, fitsBefore, fitsAfter, viewport: window.innerWidth, prefix, cssBytes: css.length };
  }, { prefix: official.prefix, css: official.css });

  record('后台任务那个框在手机上确实会伸出屏幕（否则这条检查不可能失败）',
    popover.before.right > popover.viewport - 8 + 20,
    `右边缘 ${popover.before.right} > 视口 ${popover.viewport}，宽 ${popover.before.width}`);
  record('夹回之后完整落在屏幕里',
    popover.after.right <= popover.viewport - 8 + 1 && popover.after.left >= 7,
    `${popover.after.left} … ${popover.after.right}（视口 ${popover.viewport}）`);
  record('只移动刚好够用的距离（右边缘贴到边距，不是乱挪）',
    popover.viewport - 8 - popover.after.right <= 1 && popover.after.left < popover.before.left,
    `移动 ${popover.after.left - popover.before.left}px，右边缘 ${popover.before.right}→${popover.after.right}`);
  record('本来就放得下的菜单一根手指都不动',
    popover.fitsBefore.transform === '(none)' && popover.fitsAfter.transform === '(none)'
    && popover.fitsBefore.left === popover.fitsAfter.left,
    `transform ${popover.fitsAfter.transform}，left ${popover.fitsBefore.left}→${popover.fitsAfter.left}`);

  // Above the threshold the shell stands down, and the shift has to be taken away
  // again — a desktop window must be left exactly as the client drew it.
  //
  // The width is faked in the page rather than changed through the driver, because
  // puppeteer reloads the page when `isMobile` changes, which would take the injected
  // shell and the fixture with it and silently turn this into a check of nothing. The
  // functions exercised are still the real `refresh()` and `shouldActivate()`.
  const wide = await page.evaluate(() => {
    const shell = window.__PULSE_SHELL_DEBUG__;
    if (!shell) return { error: '外壳调试句柄不在，说明页面被重载过' };
    const host = document.getElementById('pulse-popover-fixture');
    const menu = host ? host.querySelector('[class*="_menu"]') : null;
    if (!menu) return { error: '找不到夹具菜单' };

    const real = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 1200 });
    shell.refresh();
    const desktop = { transform: menu.style.transform || '(none)', active: shell.state.active, clamped: shell.clamped() };

    if (real) Object.defineProperty(window, 'innerWidth', real);
    shell.refresh();
    const back = { transform: menu.style.transform || '(none)', active: shell.state.active, clamped: shell.clamped() };
    return { desktop, back };
  });
  record('拉宽到桌面宽度后位移被撤销（桌面窗口一点没动）',
    !wide.error && wide.desktop.transform === '(none)' && wide.desktop.active === false && wide.desktop.clamped === 0,
    wide.error ?? `transform=${wide.desktop?.transform} 外壳激活=${wide.desktop?.active} 还夹着 ${wide.desktop?.clamped} 个`);
  record('缩回手机宽度后重新夹好（来回切不会漏）',
    !wide.error && wide.back.active === true && wide.back.clamped === 1 && wide.back.transform !== '(none)',
    wide.error ?? `transform=${wide.back?.transform} 夹住 ${wide.back?.clamped} 个`);


  // ---- does the hamburger sit on top of the official header? ---------------
  //
  // It is position:fixed at the top-left, and the conversation header also starts
  // at the top-left, so an overlap is the expected failure of this design rather
  // than a surprise. Reported as the elements it actually covers.
  // A conversation has a session header where a new session does not, and that
  // header is exactly what the fixed-position hamburger lands on. So the overlap
  // is only reproducible with a session actually open.
  if (args.includes('--open-session')) {
    /**
     * Every clickable control in the top strip, by accessible name.
     * @returns {Promise<string[]>} name@x,y wxh entries.
     */
    const topControls = () => page.evaluate(() => [...document.querySelectorAll('button, [role="button"], [aria-label]')]
      .map(node => {
        const rect = node.getBoundingClientRect();
        const name = (node.getAttribute('aria-label') || node.getAttribute('title')
          || (node.textContent || '').trim()).replace(/\s+/g, ' ').slice(0, 22);
        const mine = Boolean(node.closest('[data-pulse="chrome"]'));
        return { name, rect, mine };
      })
      .filter(entry => entry.rect.width > 0 && entry.rect.height > 0 && entry.rect.top < 70)
      .map(entry => `${entry.mine ? '[我们的]' : ''}${entry.name || '(无名)'}@${Math.round(entry.rect.left)},${Math.round(entry.rect.top)}`));

    console.log('');
    console.log(`  新会话页 顶部控件: ${(await topControls()).join(' | ') || '(无)'}`);

    const openedSession = await page.evaluate(() => {
      const burger = document.querySelector('.pulse-burger');
      if (burger) burger.click();
      return Boolean(burger);
    });
    await new Promise(r => setTimeout(r, 800));

    const tree = await page.evaluate(() => {
      const list = document.querySelector('[class*="_listArea"]');
      if (!list) return { found: false, items: [] };
      const items = [...list.querySelectorAll('[class*="_sessionRow"]')]
        .map(node => ({
          cls: String(node.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 2).join(' '),
          text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        }))
        .filter(item => item.text);
      return { found: true, items: items.slice(0, 8) };
    });
    console.log('=== 侧栏里的会话条目 ===');
    for (const item of tree.items) console.log(`  ${item.cls} "${item.text}"`);

    const clicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[class*="_sessionRow"]')]
        .filter(node => (node.textContent || '').trim().length > 1
          && !/新建会话|搜索会话|添加工作区|视图选项|设置/.test(node.textContent || ''));
      const target = rows[0];
      if (!target) return '';
      target.click();
      return (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    });
    await new Promise(r => setTimeout(r, 2500));

    // Collapse again through the official control, so the question being answered
    // is whether the client offers a reachable toggle once the drawer is shut —
    // if it does, this shell's own hamburger is a duplicate that can be removed.
    const collapsedByOfficial = await page.evaluate(() => {
      const toggle = [...document.querySelectorAll('button, [role="button"]')]
        .find(node => node.getAttribute('aria-label') === '收起侧边栏'
          && !node.closest('[data-pulse="chrome"]'));
      if (!toggle) return false;
      toggle.click();
      return true;
    });
    await new Promise(r => setTimeout(r, 900));
    const tabs = await page.evaluate(() => [...document.querySelectorAll('button, [role="tab"]')]
      .map(node => (node.textContent || '').trim())
      .filter(name => /对话|轨迹/.test(name)).slice(0, 3));
    console.log(`  点了：${clicked || '(没有可点的会话条目)'}；对话/轨迹：${tabs.join(' | ') || '(没出现)'}`);
    console.log(`  汉堡展开=${openedSession}；用官方控件收起=${collapsedByOfficial}`);
    console.log(`  会话页抽屉收起后 顶部控件: ${(await topControls()).join(' | ') || '(无)'}`);

    // The ancestor chain of the title, because the fix is to give the top-left
    // corner back to the shell: whichever box actually starts at x=0 here is the
    // one that needs the left padding.
    const crumbChain = await page.evaluate(() => {
      const crumb = document.querySelector('[class*="_crumb"]');
      const chain = [];
      let node = crumb;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        const rect = node.getBoundingClientRect();
        chain.push(`${node.tagName.toLowerCase()}.`
          + `${String(node.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 2).join(' ')}`
          + ` [${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}]`);
        node = node.parentElement;
      }
      return chain;
    });
    console.log('  标题的祖先链:');
    for (const link of crumbChain) console.log(`    ${link}`);

    // The reading surface, measured rather than eyeballed: "cramped at the top"
    // and "too much room on the right" are both numbers before they are opinions.
    const reading = await page.evaluate(() => {
      const center = document.querySelector('[class*="_centerCol"]');
      if (!center) return null;
      const viewport = center.getBoundingClientRect().width;
      /**
       * @param {string} selector - what to measure, inside the conversation column.
       * @returns {object|null} its box and typography.
       */
      const measure = selector => {
        const node = center.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          at: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
          pad: style.padding,
          margin: style.margin,
          font: `${style.fontSize}/${style.lineHeight}`,
          left: Math.round(rect.left),
          right: Math.round(center.getBoundingClientRect().right - rect.right),
        };
      };
      // Where the reading inset actually comes from: the padding is on some
      // container between the scroller and the text, not on either of them.
      const chain = [];
      let node = center.querySelector('[class*="_markdown_"]');
      for (let depth = 0; depth < 14 && node && node !== document.body; depth += 1) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const padding = `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
        chain.push(`${node.tagName.toLowerCase()}.`
          + `${String(node.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 2).join('.')}`
          + `[${Math.round(rect.width)}@${Math.round(rect.left)}] pad=${padding}`
          + `${style.maxWidth !== 'none' ? ` max=${style.maxWidth}` : ''}`
          + `${/auto|scroll/.test(style.overflowY) ? ' [scroller]' : ''}`);
        node = node.parentElement;
      }
      // The tab strip is not the class the official stylesheet suggests, so the
      // header's own subtree is printed: the row that has to shrink is whichever
      // one actually holds 对话/轨迹.
      const headerNode = center.querySelector('header');
      const headerTree = [];
      if (headerNode) {
        /**
         * @param {Element} element - current node.
         * @param {number} depth - current depth.
         */
        const walkHeader = (element, depth) => {
          if (depth > 3) return;
          const rect = element.getBoundingClientRect();
          const own = Array.from(element.childNodes)
            .filter(node => node.nodeType === 3).map(node => node.textContent.trim()).filter(Boolean).join(' ').slice(0, 14);
          headerTree.push(`${'  '.repeat(depth)}${element.tagName.toLowerCase()}.`
            + `${String(element.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 2).join('.')}`
            + ` [${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}]`
            + `${own ? ` "${own}"` : ''} pad=${getComputedStyle(element).padding}`);
          for (const child of element.children) walkHeader(child, depth + 1);
        };
        walkHeader(headerNode, 0);
      }
      return {
        viewport: Math.round(viewport),
        header: measure('header'),
        titleRow: measure('[class*="_titleRow"]'),
        titleCluster: measure('[class*="_titleCluster"]'),
        paneBody: measure('[class*="_paneBody_"]'),
        markdown: measure('[class*="_markdown_"]'),
        burger: (() => {
          const node = document.querySelector('.pulse-burger');
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          const icon = node.querySelector('svg');
          const iconRect = icon ? icon.getBoundingClientRect() : null;
          return {
            at: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
            icon: iconRect ? `${Math.round(iconRect.width)}x${Math.round(iconRect.height)}` : '(文字字形)',
            font: getComputedStyle(node).fontSize,
          };
        })(),
        chain,
        headerTree,
      };
    });
    if (!reading) {
      console.log('  （没找到会话列，排版未测量）');
    } else {
      console.log(`  阅读区排版（会话列 ${reading.viewport}px）:`);
      for (const [name, value] of Object.entries(reading)) {
        if (name === 'viewport' || name === 'chain' || name === 'headerTree' || !value) continue;
        if (name === 'burger') {
          console.log(`    ${name.padEnd(10)} ${value.at} 图标=${value.icon} 字号=${value.font}`);
          continue;
        }
        console.log(`    ${name.padEnd(10)} ${value.at} 左=${value.left} 右=${value.right} `
          + `pad=${value.pad} margin=${value.margin} font=${value.font}`);
      }
      console.log('    页头子树:');
      for (const line of reading.headerTree) console.log(`      ${line}`);
      console.log('    内缩来源（由内往外）:');
      for (const link of reading.chain) console.log(`      ${link}`);
    }

    // Captured here, with the drawer shut, because this is the state the header
    // overlap was reported in.
    if (shot) {
      const target = resolve(shot.replace(/\.png$/, '-conversation.png'));
      await page.screenshot({ path: target });
      console.log(`  会话截图: ${target}`);
    }

    // The conversation's own file card is where a phone user looks for a file, so
    // its menu decides whether saving is reachable from where they already are —
    // or whether the only way out is Pulse's own file list.
    const fileCard = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('div, section')]
        .filter(node => /文件改动|新增：|个文件/.test(node.textContent || '') && node.children.length <= 8);
      const card = candidates[candidates.length - 1];
      if (!card) return { found: false, controls: [] };
      const controls = [...card.querySelectorAll('button, a, [role="button"]')].map(node => ({
        tag: node.tagName.toLowerCase(),
        label: (node.getAttribute('aria-label') || node.getAttribute('title')
          || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18),
      }));
      const trigger = [...card.querySelectorAll('button')].pop();
      if (trigger) trigger.click();
      return { found: true, controls };
    });
    await new Promise(r => setTimeout(r, 700));
    const menu = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], [role="menu"] *, [class*="_popup"] *, [class*="_menu"] [class*="_item"]')]
      .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22))
      .filter(Boolean)
      .slice(0, 10));
    console.log(`  文件卡片控件: ${fileCard.controls.map(entry => `${entry.tag}:${entry.label}`).join(' | ') || '(没找到文件卡片)'}`);
    console.log(`  ▾ 展开后: ${menu.join(' | ') || '(没有菜单)'}`);
    console.log('');
  }

  const overlaps = await page.evaluate(() => {
    const burger = document.querySelector('.pulse-burger');
    const root = document.getElementById('root');
    if (!burger || !root) return [];
    const box = burger.getBoundingClientRect();
    const hits = [];
    for (const element of root.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Only the page's own header counts. Conversation content scrolling under a
      // floating control is what a floating control does, and flagging it would
      // bury the real complaint, which was the logo and the session title.
      if (!element.closest('header')) continue;
      const intersects = !(rect.right <= box.left || rect.left >= box.right
        || rect.bottom <= box.top || rect.top >= box.bottom);
      if (!intersects) continue;
      const text = Array.from(element.childNodes)
        .filter(node => node.nodeType === 3).map(node => node.textContent.trim()).filter(Boolean).join(' ');
      const graphical = ['svg', 'img', 'canvas'].includes(element.tagName.toLowerCase());
      if (!text && !graphical) continue;
      hits.push({
        cls: String(element.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 2).join(' '),
        tag: element.tagName.toLowerCase(),
        text: text.slice(0, 24),
        rect: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
        // Where it lives, because "an svg is covered" is not actionable until you
        // know which part of the page it belongs to.
        ancestors: (() => {
          const chain = [];
          let node = element.parentElement;
          for (let depth = 0; depth < 3 && node; depth += 1) {
            const name = String(node.className || '').split(/\s+/).filter(part => /_/.test(part)).slice(0, 1).join('')
              || node.tagName.toLowerCase();
            chain.push(name);
            node = node.parentElement;
          }
          return chain.join(' < ');
        })(),
      });
    }
    return { burger: `${Math.round(box.width)}x${Math.round(box.height)}@${Math.round(box.left)},${Math.round(box.top)}`, hits: hits.slice(0, 8) };
  });
  record('汉堡按钮没有压住官方页头（logo / 标题 / 会话名）', overlaps.hits.length === 0,
    overlaps.hits.length === 0
      ? `汉堡在 ${overlaps.burger}`
      : `汉堡在 ${overlaps.burger}，压住了：${overlaps.hits.map(hit => `${hit.tag}.${hit.cls}${hit.text ? `"${hit.text}"` : ''}@${hit.rect} [${hit.ancestors}]`).join(' | ')}`);

  // Printed only when something is wrong: this is the shell's own view of the
  // same page, which distinguishes "the selector missed" from "the shell never
  // ran" — the two causes that otherwise look identical from the outside.
  if (!shell.drawerTagged || !shell.hasSidebar || !shell.attachTargets) {
    const debug = await page.evaluate(() => {
      const hooks = window.__PULSE_SHELL_DEBUG__;
      if (!hooks) return { hook: false };
      const column = hooks.sidebarColumn();
      return {
        hook: true,
        innerWidth: window.innerWidth,
        shouldActivate: hooks.shouldActivate(),
        active: hooks.state.active,
        stateSidebar: hooks.state.sidebar,
        stateAttach: hooks.state.attach,
        stateCenter: hooks.state.center,
        stateFrame: hooks.state.frame,
        stateExpanded: hooks.state.expanded,
        notes: hooks.state.notes.slice(),
        htmlClass: document.documentElement.className,
        columnFound: Boolean(column),
        columnClass: column ? String(column.className).slice(0, 80) : '',
        expandedNow: hooks.sidebarExpanded(),
        attachFound: Boolean(hooks.attachControl()),
        toggleFound: Boolean(hooks.toggleButton()),
        centerFound: Boolean(document.querySelector('[class*="_centerCol"]')),
      };
    });
    console.log('\n  外壳自检（为什么没生效）:');
    console.log('  ' + JSON.stringify(debug, null, 2).split('\n').join('\n  '));
    console.log('');
  }

  // ---- the decisive outcome: does the drawer overlay instead of squeezing? ---
  //
  // This is the defect the shell exists to fix. The official layout is a push
  // split: at 390px the expanded 280px sidebar leaves the conversation 110px.
  // The documented fix is that the sidebar becomes `position: fixed` while
  // `pulse-drawer-open` is set, so the main column must stay ~full width.

  const measure = () => page.evaluate(() => {
    const center = document.querySelector('[class*="_centerCol"]');
    const sidebar = document.querySelector('[data-pulse-drawer]');
    const box = node => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { w: Math.round(r.width), left: Math.round(r.left) };
    };
    // Every child of the frame, because "the main column is not full width" has
    // several possible causes and the sibling list tells them apart in one shot.
    const frame = document.querySelector('[class*="_frame"]');
    const kids = frame
      ? Array.prototype.map.call(frame.children, child => {
          const r = child.getBoundingClientRect();
          const style = getComputedStyle(child);
          return {
            cls: String(child.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 2).join(' '),
            w: Math.round(r.width),
            pos: style.position,
            flex: style.flex,
            inline: child.getAttribute('style') || '',
          };
        })
      : [];
    const frameStyle = frame ? getComputedStyle(frame) : null;
    const frameBox = frame
      ? {
          w: Math.round(frame.getBoundingClientRect().width),
          display: frameStyle.display,
          direction: frameStyle.flexDirection,
          inline: frame.getAttribute('style') || '',
        }
      : null;
    return {
      center: box(center),
      sidebar: box(sidebar),
      collapsed: Boolean(document.querySelector('[class*="_collapsed"]')),
      drawerOpen: document.documentElement.classList.contains('pulse-drawer-open'),
      kids,
      frameBox,
    };
  });

  // Normalise: `--probe-sidebar` may have left the sidebar open, and the drawer
  // assertion only means anything starting from the collapsed state.
  const first = await measure();
  if (!first.collapsed) {
    await page.evaluate(() => {
      const burger = document.querySelector('.pulse-burger');
      if (burger) burger.click();
    });
    await new Promise(r => setTimeout(r, 600));
  }
  const closed = await measure();
  record('点汉堡可以收起官方侧栏', closed.collapsed && !closed.drawerOpen,
    `collapsed=${closed.collapsed} drawerOpen=${closed.drawerOpen}`);
  // The closed state is the one the user actually reads the conversation in,
  // because the open drawer is an overlay that covers the conversation anyway.
  record('收起时对话区占满宽度（这是用户真正在读的宽度）', (closed.center?.w ?? 0) >= 380,
    `center=${closed.center?.w}px / 视口 390px，外壳生效前这里只有 56px`);
  if (shot && !args.includes('--probe-sidebar')) {
    const target = resolve(shot.replace(/\.png$/, '-closed.png'));
    await page.screenshot({ path: target });
    console.log(`  收起态截图: ${target}`);
  }

  const openedByBurger = await page.evaluate(() => {
    const burger = document.querySelector('.pulse-burger');
    if (!burger) return false;
    burger.click();
    return true;
  });
  await new Promise(r => setTimeout(r, 600));
  const opened = await measure();

  console.log('');
  console.log(`  主列宽度 收起=${closed.center?.w} 展开=${opened.center?.w}   侧栏 ${opened.sidebar?.w}px @${opened.sidebar?.left}`);
  // Both states, because the drawer is an overlay: the width the user actually
  // reads the conversation at is the *closed* one. The open state only has to
  // prove the drawer is not stealing layout while it floats.
  for (const [name, snapshot] of [['收起', closed], ['展开', opened]]) {
    console.log(`  外框子节点（${name}）: 主列=${snapshot.center?.w}px  外框=${JSON.stringify(snapshot.frameBox)}`);
    for (const kid of snapshot.kids) {
      console.log(`    ${String(kid.w).padStart(4)}px  ${kid.pos.padEnd(9)} flex=${kid.flex.padEnd(11)} ${kid.cls}${kid.inline ? `   inline="${kid.inline}"` : ''}`);
    }
  }
  record('点汉堡后官方侧栏真的展开了', openedByBurger && opened.collapsed === false,
    `collapsed=${opened.collapsed}`);
  record('抽屉状态已镜像到页面（CSS 用得上）', opened.drawerOpen, `pulse-drawer-open=${opened.drawerOpen}`);
  record('主列比官方的推挤式宽得多（官方只剩 110px）', (opened.center?.w ?? 0) > 110,
    `center=${opened.center?.w}px，官方推挤式是 110px`);
  record('抽屉不占布局：展开后主列不比收起时窄', (opened.center?.w ?? 0) >= (closed.center?.w ?? 0),
    `收起=${closed.center?.w}px 展开=${opened.center?.w}px`);
  record('浮层从最左边开始（覆盖侧栏原来的位置）', (opened.sidebar?.left ?? -1) === 0,
    `left=${opened.sidebar?.left}`);

  if (shot) {
    const target = resolve(shot);
    await page.screenshot({ path: target });
    console.log(`  截图: ${target}`);
  }
  // ---- the settings dialog at phone width -----------------------------------
  //
  // Run last, and only after the shell's stylesheet is installed: the whole point
  // is to see what the current source does to the official sheet, and running it
  // earlier measured the un-styled client and reported "no change".
  if (args.includes('--probe-settings')) {
    const openedDialog = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('button, [role="button"]')];
      const settings = candidates.find(node => (node.getAttribute('aria-label') || '') === '设置'
        || (node.textContent || '').trim() === '设置');
      if (!settings) return false;
      settings.click();
      return true;
    });
    await new Promise(r => setTimeout(r, 1200));

    // The symptom is not "narrow", it is "a short label broken over several
    // lines", so that is what gets measured. A fixed pixel threshold cannot tell
    // a squeezed label from a legitimately short one, and reported both the icons
    // and the word 模型 as faults.
    await page.evaluate(() => {
      window.__pulseSqueezed = element => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0) return false;
        const text = (element.textContent || '').trim();
        // Long text is allowed to be tall: a paragraph is not a squeezed label.
        if (text.length < 4 || text.length > 40) return false;
        const style = getComputedStyle(element);
        const fontSize = parseFloat(style.fontSize) || 14;
        const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.4;
        const lines = Math.round(rect.height / lineHeight);
        return lines >= 3 && rect.width < 200;
      };
    });

    // Test the detector before trusting it. A detector that never fires would
    // report a clean settings page and mean nothing.
    const detectorSelfTest = await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0';
      // Attached before measuring: a detached node has no layout, so every box
      // would report 0x0 and the detector would look like it never fires.
      document.body.appendChild(host);
      const cases = [
        { width: 60, text: '选择新会话的默认权限模式', expect: true },
        { width: 390, text: '选择新会话的默认权限模式', expect: false },
        { width: 390, text: '模型', expect: false },
      ];
      const results = cases.map(item => {
        const box = document.createElement('div');
        box.style.cssText = `width:${item.width}px;font-size:14px;line-height:20px`;
        box.textContent = item.text;
        host.appendChild(box);
        const rect = box.getBoundingClientRect();
        const style = getComputedStyle(box);
        const flagged = window.__pulseSqueezed(box);
        return {
          ...item,
          flagged,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          textLength: (box.textContent || '').trim().length,
        };
      });
      host.remove();
      return results;
    });
    record('「挤扁」探针本身能区分窄栏与短标签',
      detectorSelfTest.every(item => item.flagged === item.expect),
      detectorSelfTest.map(item => `${item.w}x${item.h}/lh${item.lineHeight}/${item.textLength}字→${item.flagged}`).join(' '));

    const dialog = await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]');
      if (!root) return null;
      const lines = [];
      /**
       * @param {Element} element - current node.
       * @param {number} depth - current depth.
       */
      function walk(element, depth) {
        if (depth > 7) return;
        const rect = element.getBoundingClientRect();
        const classes = String(element.className || '').split(/\s+/).filter(name => /_/.test(name)).slice(0, 3).join(' ');
        const label = element.getAttribute('aria-label') || '';
        const own = Array.from(element.childNodes)
          .filter(node => node.nodeType === 3)
          .map(node => node.textContent.trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 20);
        lines.push({
          depth,
          tag: element.tagName.toLowerCase(),
          classes,
          label,
          text: own,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          x: Math.round(rect.left),
          // Typography, because "make it match WorkBuddy" is only actionable as
          // numbers: these are the values being compared against a reference.
          fontSize: getComputedStyle(element).fontSize,
          lineHeight: getComputedStyle(element).lineHeight,
          padding: getComputedStyle(element).padding,
          // The reported symptom, as a measurement: a short label broken over
          // several lines because its box is too narrow.
          squeezed: window.__pulseSqueezed(element),
        });
        for (const child of element.children) walk(child, depth + 1);
      }
      walk(root, 0);
      return {
        role: root.getAttribute('role') || '',
        w: Math.round(root.getBoundingClientRect().width),
        h: Math.round(root.getBoundingClientRect().height),
        x: Math.round(root.getBoundingClientRect().left),
        lines,
      };
    });

    console.log('');
    if (!openedDialog || !dialog) {
      record('设置弹窗能被打开', false, openedDialog ? '找不到 dialog 容器' : '找不到「设置」按钮');
    } else {
      const squeezed = dialog.lines.filter(line => line.squeezed);
      console.log(`=== 设置弹窗结构（容器 ${dialog.role}，${dialog.w}x${dialog.h}@${dialog.x}） ===`);
      for (const line of dialog.lines.slice(0, 60)) {
        console.log(`  ${'  '.repeat(line.depth)}${line.tag}.${line.classes} [${line.w}x${line.h}@${line.x}]`
          + ` ${line.fontSize}/${line.lineHeight} pad=${line.padding}`
          + `${line.label ? ` {${line.label}}` : ''}${line.text ? ` "${line.text}"` : ''}`
          + `${line.squeezed ? '   <== 被挤扁' : ''}`);
      }
      console.log('');
      record('设置弹窗占满手机屏（不再是一个 342px 的桌面弹层）', dialog.w >= 380 && dialog.h >= 780,
        `${dialog.w}x${dialog.h}@${dialog.x}，视口 390x844`);
      record('设置里没有被挤扁的盒子（不再一字一行）', squeezed.length === 0,
        squeezed.length === 0 ? 'ok' : `${squeezed.length} 个：${squeezed.map(l => `${l.classes}[${l.w}px]`).join(', ')}`);
      if (shot) {
        const target = resolve(shot.replace(/\.png$/, '-settings.png'));
        await page.screenshot({ path: target });
        console.log(`  设置截图: ${target}`);
      }
      console.log('');
    }
  }

  // ---- what does the official attach button actually open? ------------------
  //
  // The phone cannot upload, and the shell never touches this path: the official
  // control does whatever it does, and the Activity only supplies a file chooser
  // if the page asks the browser for one. So the question is which API it asks
  // for, and whether that API exists in an Android WebView at all.
  if (args.includes('--probe-attach')) {
    const trace = await page.evaluate(async () => {
      const calls = [];
      const originalPicker = window.showOpenFilePicker;
      if (originalPicker) {
        window.showOpenFilePicker = function (...arguments_) {
          calls.push('showOpenFilePicker()');
          return originalPicker.apply(this, arguments_);
        };
      }
      const originalCreate = document.createElement.bind(document);
      document.createElement = function (tag, ...rest) {
        const element = originalCreate(tag, ...rest);
        if (String(tag).toLowerCase() === 'input') calls.push(`createElement(input type=${element.type || '?'})`);
        return element;
      };
      const originalClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (String(this.type).toLowerCase() === 'file') {
          calls.push(`input[type=file].click() accept=${this.getAttribute('accept') || '-'} multiple=${this.multiple}`);
        }
        return originalClick.apply(this, arguments);
      };

      const control = [...document.querySelectorAll('button, [role="button"], label, a')]
        .find(node => /上传文件|添加文件|选择文件|添加附件|附件/.test(
          (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '') + ' ' + (node.textContent || '')));
      if (!control) return { found: false, calls };

      control.click();
      await new Promise(resolve => setTimeout(resolve, 700));
      const inputs = [...document.querySelectorAll('input[type=file]')].map(node => ({
        accept: node.getAttribute('accept') || '',
        multiple: node.multiple,
        inDom: document.body.contains(node),
        hidden: node.hidden || getComputedStyle(node).display === 'none',
      }));
      return {
        found: true,
        apiPresent: typeof originalPicker === 'function',
        calls,
        inputs,
        control: (control.getAttribute('aria-label') || control.textContent || '').trim().slice(0, 24),
      };
    });

    console.log('');
    console.log('=== 官方「添加附件」到底怎么弹选择器 ===');
    console.log('  ' + JSON.stringify(trace, null, 2).split('\n').join('\n  '));
    console.log('');
    record('官方添加入口能触发某种文件选择路径',
      trace.found && (trace.calls.length > 0 || trace.inputs.length > 0),
      trace.found ? `调用：${trace.calls.join(' / ') || '什么都没调用'}` : '找不到添加入口');
  }

  // ---- the phone page cannot be zoomed ---------------------------------------
  //
  // Asked for directly. There are two halves — the viewport meta and touch-action — and only
  // the second is enforced by Chromium at gesture time, so this drives a real pinch through CDP
  // and reads the visual viewport's scale instead of trusting the declaration. The control is
  // the same gesture with our half removed: without it, "scale stayed 1" would prove nothing.
  const zoomCdp = await page.createCDPSession();
  const pinchScale = async () => {
    await zoomCdp.send('Input.synthesizePinchGesture', {
      x: 195, y: 520, scaleFactor: 3, relativeSpeed: 800,
    }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 700));
    return page.evaluate(() => (window.visualViewport ? Number(window.visualViewport.scale.toFixed(2)) : -1));
  };
  const zoomMeta = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    return {
      content: meta ? meta.getAttribute('content') : '(没有)',
      touch: getComputedStyle(document.documentElement).touchAction,
      locked: document.documentElement.classList.contains('pulse-no-zoom'),
    };
  });
  record('手机页面声明了不可缩放，并用 touch-action 真正拦住捏合',
    zoomMeta.locked && /user-scalable=no/.test(zoomMeta.content) && /pan-x pan-y/.test(zoomMeta.touch),
    `class=${zoomMeta.locked} content=「${zoomMeta.content}」 touch-action=${zoomMeta.touch}`);

  const lockedScale = await pinchScale();
  record('双指捏合之后页面没有放大（真的做了一次手势）',
    lockedScale === 1, `visualViewport.scale=${lockedScale}`);

  await page.evaluate(() => {
    window.__PULSE_SHELL_DEBUG__.unlockViewportScale();
    document.documentElement.style.touchAction = 'auto';
    if (document.body) document.body.style.touchAction = 'auto';
  });
  const freeScale = await pinchScale();
  record('（自校验）把我们那一半撤掉，同一个手势就能放大 → 上一条不是白过的',
    freeScale > 1, `撤掉后 visualViewport.scale=${freeScale}`);

  // ---- a page that outlived the process it came from -------------------------
  //
  // The shell is snapshotted into the page when the plugin loads, and a phone keeps its page
  // for days: after a harness restart that page talks to a process that no longer exists, and
  // everything delivered as *state* rather than as a stream — a pending question, a
  // re-rendered transcript — never arrives. The user reads that as "it didn't render" or "it
  // won't refresh" while the same conversation is fine in a freshly loaded tab, which is
  // exactly what happened twice before this existed.
  //
  // Two halves are checked here: the endpoint that makes the difference measurable, and the
  // reload itself, driven by pretending the backend was replaced (a real restart would end
  // this probe's own session).
  const bootA = await fetch(`${base}/pulse-boot`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const bootB = await fetch(`${base}/pulse-boot`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  record('后端会报自己的进程标识（页面靠它判断自己是不是过期了）',
    Boolean(bootA && bootA.id) && bootA.id === bootB.id,
    bootA ? `第一次 ${bootA.id}，第二次 ${bootB && bootB.id}（同一个进程必须一样）` : '拿不到 /pulse-boot');

  const bootSeen = await page.evaluate(() => window.__PULSE_SHELL_DEBUG__.boot());
  record('外壳自己在轮询这个标识（不是只在启动时读一次）',
    bootSeen.checks > 0 && bootSeen.id === (bootA && bootA.id),
    `检查了 ${bootSeen.checks} 次，记下的 id=${bootSeen.id || '(空)'}`);

  let navigated = false;
  page.once('framenavigated', () => { navigated = true; });
  await page.evaluate(() => {
    // Pretend the answer changed: the shell has to reload, and only because of that.
    const real = window.fetch;
    window.fetch = (url, init) => (String(url).includes('pulse-boot')
      ? Promise.resolve(new Response(JSON.stringify({ id: 'pretend-restart' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      : real.call(window, url, init));
    window.__PULSE_SHELL_DEBUG__.pollBoot();
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  record('（自校验）后端换了 → 页面自己重载（不用用户去按刷新）',
    navigated, navigated ? '页面已经重新加载' : '页面没有重载');

  // Serving the document ourselves costs it Chromium's "local network" blessing,
  // so the page's own WebSocket to 127.0.0.1 is refused. That is an artifact of
  // this harness rather than of the shell, so it is filtered by exact name and
  // the count is reported instead of being quietly dropped.
  const relevant = consoleErrors.filter(message => !/ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS/.test(message));
  record('没有页面级 JS 错误', relevant.length === 0, relevant.slice(0, 2).join(' | ') || 'none');
  if (relevant.length !== consoleErrors.length) {
    console.log(`  （已滤除 ${consoleErrors.length - relevant.length} 条拦截产物：文档由本脚本代答，WebSocket 被本地网络访问检查拦下）`);
  }

  if (keepOpen) {
    console.log('\n  --keep-open：浏览器保持运行，按 Ctrl+C 结束');
    await new Promise(() => {});
  }
} catch (error) {
  failure = error;
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${paired.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}

// ---- report ------------------------------------------------------------------

console.log('');
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? `   (${result.detail})` : ''}`);
}
if (failure) {
  console.log('');
  console.log(`  运行失败: ${failure.message}`);
}
console.log('');
console.log(failed === 0 && !failure ? '全部通过' : `${failed} 项失败`);
process.exitCode = failed === 0 && !failure ? 0 : 1;
