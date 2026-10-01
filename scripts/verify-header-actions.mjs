#!/usr/bin/env node
/**
 * Verify that the session header's action chips are placed on the tab strip.
 *
 *   node scripts/verify-header-actions.mjs [--url http://127.0.0.1:3199] [--shot out.png]
 *
 * ## What this is about
 *
 * At 390px the official session header carries four things in its 342px title row — the
 * session title, the subagent ("4 个子代理") chip, the mode chip and, while anything is
 * running, the background-jobs chip — plus 88px of utilities and a 28px corner. Measured
 * before the change: the title's own container was **0px wide**, so the phone showed
 * "我的…" and the chips drew over each other. The tab strip in the row below used 88px of
 * the same 342px.
 *
 * So the shell moves the official action container down onto that strip. It is a
 * *placement*, not a DOM move: the container stays in the tree and only its box changes,
 * which is why a React re-render has nothing to fight.
 *
 * ## Why every check here is an A/B on one page
 *
 * "The chips are on the strip" is trivially true of any page. The check that means
 * something is that taking the placement away puts the title back to zero and makes the
 * rows overlap again — measured in the same page, in both directions, so it can fail.
 *
 * @module dsh-remote-pulse/scripts/verify-header-actions
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { localHeaders } from './local-operator.mjs';
import { officialModule } from './official-client.mjs';
import { mobileStylesheet } from '../lib/mobile.js';
import {
  HEADER_ACTIONS_ATTRIBUTE,
  mobileShellScript,
  mobileShellStyles,
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
/**
 * Which conversation to open.
 *
 * It matters here more than in most probes: the chips only move when they fit beside the
 * tabs, the background-jobs chip is as wide as its label, and the subagent count only exists
 * on a conversation that has subagents. `pulse` is the ordinary case; `warden` is the one
 * with four subagents, which is where the third chip can be measured at all.
 */
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

const PHONE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13';

const results = [];
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
  body: JSON.stringify({ code: opened.code, label: 'header-actions' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

/**
 * Load the phone view of the app with the layer from disk installed.
 *
 * `isMobile` is deliberately left false: changing it makes Puppeteer reload the page, and
 * this probe resizes the same tab to check that the placement is taken away again. The
 * narrow width is what the shell goes by, and the app's own breakpoints go by width too.
 *
 * @returns {Promise<import('puppeteer-core').Page>} the tab.
 */
async function prepare() {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.setUserAgent(PHONE_USER_AGENT);
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2500));
  // The served copy of this shell is already on the page, and a restart is what makes it
  // current — so while the working tree is ahead of the running process, both stylesheets
  // apply and the older rule wins by order. The JS rows are switched off by flag below;
  // the stylesheets have to be switched off explicitly, or this probe measures the build
  // that is running instead of the one on disk.
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
  if (process.env.PULSE_PRINT) console.log(`  关掉了 ${served} 份进程里下发的样式表`);
  await page.addStyleTag({ content: mobileStylesheet() });
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript());
  // At phone width the session list is behind the hamburger, so it has to be opened
  // before there is a conversation to look at.
  await page.evaluate(session => {
    window.__PULSE_WANTED__ = session;
  }, wanted);
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
  await new Promise(r => setTimeout(r, 8000));
  // Close the drawer again: it is as wide as the phone and would cover the strip.
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll('button,[role="button"]')]
      .find(node => /收起侧边栏|关闭侧边栏|Close sidebar/i.test(node.getAttribute('aria-label') || ''));
    if (toggle) toggle.click();
  });
  await new Promise(r => setTimeout(r, 900));
  return page;
}

/**
 * Measure the header: the two rows, the chips, and where the title ends up.
 *
 * @param {import('puppeteer-core').Page} page - the tab.
 * @returns {Promise<object>} the measurement.
 */
const measure = page => page.evaluate(mark => {
  const box = node => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left), right: Math.round(rect.right),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  };
  // The same pairing the shell uses, rather than "the first element whose class matches":
  // at desktop width the first `_headerActions` in the document belongs to another
  // module, and measuring that one would make every check below vacuously true.
  const debug = window.__PULSE_SHELL_DEBUG__;
  const row = debug && debug.headerRow ? debug.headerRow() : null;
  const container = (row && row.actions)
    || document.querySelector('[' + mark + ']')
    || document.querySelector('[class*="_headerActions"]');
  // The box the shell puts into the strip to hold everything it moved there. It is the
  // measurement that matters for "do the chips fit": one container, one width.
  const group = debug.headerGroup ? debug.headerGroup() : null;
  const items = debug.headerItems ? debug.headerItems() : [];
  /** Whether a node is one of the chips the shell moved, or lives inside one. */
  const movedNode = node => items.some(item => item.node === node || item.node.contains(node));
  const header = row ? row.header : (container ? container.closest('header') : null);
  const tabs = row ? row.tabs : (header ? header.querySelector('[class*="_tabs"]') : null);
  const crumbs = header ? header.querySelector('[class*="_crumbs"]') : null;
  // Our own chips live in the strip too, so "the last tab" has to be the last *tab*:
  // taking the last button in the strip made the jobs chip's own button the reference and
  // turned an assertion about the tabs into a tautology (it read our own right edge).
  const tabButtons = tabs
    ? [...tabs.querySelectorAll('button,[role="tab"]')].filter(node => !movedNode(node))
    : [];
  const lastTab = tabButtons.length ? tabButtons[tabButtons.length - 1] : null;
  const chipBox = box(container);
  const tabsBox = box(tabs);
  const lastTabBox = box(lastTab);
  const marked = Boolean(container && container.hasAttribute(mark));
  // Hit-tested rather than read out of the layout: a control can be in the right place
  // and still be covered by something of ours.
  const point = chipBox ? [Math.round((chipBox.left + chipBox.right) / 2), Math.round((chipBox.top + chipBox.bottom) / 2)] : null;
  const topmost = point ? document.elementFromPoint(point[0], point[1]) : null;
  return {
    picked: window.__PULSE_PICKED__,
    header: box(header),
    tabs: box(tabs),
    crumbs: box(crumbs),
    chip: chipBox,
    lastTab: lastTabBox,
    marked,
    inlineTop: container ? container.style.top : '',
    inlineRight: container ? container.style.right : '',
    inlineMaxWidth: container ? container.style.maxWidth : '',
    position: container ? getComputedStyle(container).position : '',
    point,
    topmost: topmost ? `${topmost.tagName}.${String(topmost.className || '').slice(0, 34)}` : '',
    hitsChip: Boolean(topmost && container && (topmost === container || container.contains(topmost))),
    insideStrip: Boolean(chipBox && tabsBox
      && chipBox.top >= tabsBox.top - 8 && chipBox.bottom <= tabsBox.bottom + 14
      && chipBox.right <= tabsBox.right + 2),
    // The structural half of the claim: not "its pixels land on the strip" but "it is a
    // child of the strip" — that is what makes it vanish and get covered with the header.
    // Every wrapper, because the slot host renders one per contribution, and the group
    // because that is the node the strip actually holds.
    inStrip: (() => {
      if (!group) return false;
      return Boolean(container && container.parentElement === group
        && group.parentElement === (row ? row.tabs : null));
    })(),
    // The group and what is in it, in order: "next to the mode chip" is a claim about the
    // sequence, so the sequence is what gets printed.
    group: group ? box(group) : null,
    groupChildren: group ? [...group.children].map(node => {
      const kind = node.hasAttribute('data-pulse-header-lineage') ? '子代理'
        : node.hasAttribute('data-pulse-header-actions') ? '模式/任务' : '别的';
      return `${kind}:${String(node.className || node.tagName).slice(0, 20)}`;
    }) : [],
    // The subagent count chip, which arrives in the title's crumb segment rather than in a
    // `_headerActions` wrapper — so "is it in the strip" is a separate question with its own
    // answer. The box is read off the plugin's root inside the slot wrapper, because that
    // wrapper is display:contents and has no box of its own anywhere.
    lineage: (() => {
      const slot = row ? row.lineage : null;
      if (!slot) return { present: false, visible: false };
      const content = slot.firstElementChild;
      const contentBox = content ? content.getBoundingClientRect() : null;
      return {
        present: true,
        // The slot wrapper exists whenever the header does, but the plugin renders nothing
        // inside it on a conversation with no subagents — so "there is a chip here" is a
        // question about the box, not about the slot. Without this the checks below would
        // assert things about an empty wrapper and call it a pass.
        visible: Boolean(contentBox && contentBox.width > 0),
        marked: slot.getAttribute('data-pulse-header-lineage') || '',
        parent: slot.parentElement
          ? String(slot.parentElement.className || slot.parentElement.tagName).slice(0, 24)
          : '(没有)',
        inGroup: Boolean(group && slot.parentElement === group),
        index: group ? [...group.children].indexOf(slot) : -1,
        box: contentBox
          ? `${Math.round(contentBox.width)}x${Math.round(contentBox.height)}`
            + `@${Math.round(contentBox.left)},${Math.round(contentBox.top)}`
          : '(没有)',
        // The "/" that separates the count from the session title in the crumb row. It is
        // part of the chip's own box and means nothing in the strip, so the shell hides it
        // while the chip is moved — asserted because "the chip is in the strip" is not the
        // whole claim; "/ 4 个子代理" next to 创造模式 is not what was asked for.
        separator: content ? getComputedStyle(content.querySelector('[class*="_separator"]') || content).display : '',
        text: content ? (content.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20) : '',
      };
    })(),
    // How many containers the page has, and where each one is — a React re-render can
    // create a second one, and a second chip in the strip is both visible and confusing.
    containers: (() => {
      return [...document.querySelectorAll('[class*="_headerActions"]')].map(node => {
        const parent = node.parentElement;
        return `${String(parent && parent.className || '').slice(0, 22)}`
          + (node.hasAttribute(mark) ? ' [标记]' : '');
      });
    })(),
    // Every chip the shell would move, with the box it measures — the diagnostic that says
    // whether "it declined" means "there is not enough room" or "the shell never saw it".
    items: items.map(item => ({
      kind: item.node.hasAttribute('data-pulse-header-lineage') ? '子代理' : '模式/任务',
      label: (item.node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      inGroup: Boolean(group && item.node.parentElement === group),
      box: (() => {
        const nodeBox = item.measure.getBoundingClientRect();
        return `${Math.round(nodeBox.width)}x${Math.round(nodeBox.height)}`
          + `@${Math.round(nodeBox.left)},${Math.round(nodeBox.top)}`;
      })(),
    })),
    // The same arithmetic the shell does, for the failure detail: "it declined" and "it was
    // never asked again" look identical from the outside otherwise.
    fitsInputs: (() => {
      if (!tabsBox) return null;
      const style = getComputedStyle(tabs);
      const gap = parseFloat(style.columnGap || style.gap) || 0;
      let limitLeft = 0;
      for (const node of tabs.querySelectorAll('button,[role="tab"]')) {
        if (movedNode(node)) continue;
        const nodeBox = node.getBoundingClientRect();
        if (nodeBox.width > 0 && nodeBox.right > limitLeft) limitLeft = nodeBox.right;
      }
      // Summed over the chips, not read off one container: the group does not exist until
      // the chips have been moved, and reading one wrapper reports whichever contribution
      // happens to come first in the document.
      let chipWidth = 0;
      let counted = 0;
      for (const item of items) {
        const nodeBox = item.measure.getBoundingClientRect();
        if (nodeBox.width <= 0) continue;
        counted += 1;
        chipWidth += nodeBox.width;
      }
      if (counted > 1) chipWidth += 6 * (counted - 1);
      const room = Math.round(tabsBox.right - (limitLeft || tabsBox.left) - gap - 8);
      return { gap, limitLeft, chipWidth: Math.round(chipWidth), tabsRight: tabsBox.right, room, fits: chipWidth <= room };
    })(),
    // Where the shell remembers React put it, and where it currently is.
    home: (() => {
      const debug = window.__PULSE_SHELL_DEBUG__;
      const remembered = debug.state.headerActionsHome;
      return {
        remembered: remembered && remembered.parent
          ? String(remembered.parent.className || remembered.parent.tagName).slice(0, 24)
          : '(没记)',
        rememberedConnected: Boolean(remembered && remembered.parent && remembered.parent.isConnected),
        nowParent: container && container.parentElement
          ? String(container.parentElement.className || container.parentElement.tagName).slice(0, 24)
          : '(没有)',
        movesIn: debug.state.movesIn,
        movesBack: debug.state.movesBack,
        refreshes: debug.state.refreshes,
        syncs: debug.state.syncs,
      };
    })(),
    // Diagnostics for the "another pane covers the strip" guard: what the guard looks at,
    // and what state it decided.
    guard: (() => {
      const debug = window.__PULSE_SHELL_DEBUG__;
      if (!tabsBox) return { state: debug.headerActions() };
      const at = document.elementsFromPoint(
        Math.round(tabsBox.left + tabsBox.width / 2),
        Math.round(tabsBox.top + tabsBox.height / 2),
      ) || [];
      return {
        state: debug.headerActions(),
        stripCentre: at.slice(0, 4).map(node => `${node.tagName}.${String(node.className || '').slice(0, 24)}`),
        drawer: Boolean(document.querySelector('[data-pulse-drawer]')),
        drawerOpen: document.documentElement.classList.contains('pulse-drawer-open'),
      };
    })(),
    // The other box comparison that matters: the chips must not sit on the tabs.
    clearsLastTab: Boolean(chipBox && lastTabBox && chipBox.left > lastTabBox.right),
    // The chips drawing over each other is what the move is meant to end: the title's own
    // container collapsing to zero width is how it showed on the phone.
    chipCountLabel: (() => {
      const node = container ? container.querySelector('[class*="_count"]') : null;
      return node ? (node.textContent || '').trim().slice(0, 24) : '';
    })(),
    buttons: container ? [...container.querySelectorAll('button')].map(node => ({
      label: (node.textContent || '').trim().slice(0, 20),
      expanded: node.getAttribute('aria-expanded'),
      haspopup: node.getAttribute('aria-haspopup'),
    })) : [],
  };
}, HEADER_ACTIONS_ATTRIBUTE);

try {
  const page = await prepare();
  const placed = await measure(page);
  console.log(`会话: ${placed.picked}`);

  // The shell re-derives on every mutation it observes. If that watcher is dead, every
  // other check here can pass on a stale state and the phone is left with whatever the
  // last successful pass produced — so the watcher itself is checked, by making a mutation
  // and watching the shell's own counter move.
  const watcher = await page.evaluate(async () => {
    const debug = window.__PULSE_SHELL_DEBUG__;
    const before = debug.state.syncs;
    const probe = document.createElement('div');
    probe.id = 'pulse-watcher-probe';
    document.body.appendChild(probe);
    await new Promise(r => window.setTimeout(r, 400));
    const after = debug.state.syncs;
    probe.remove();
    await new Promise(r => window.setTimeout(r, 200));
    return { before, after, active: debug.state.active, refreshes: debug.state.refreshes };
  });
  record('外壳的观察者还活着（改一下 DOM，它就会重算一遍）',
    watcher.after > watcher.before,
    `同步次数 ${watcher.before} → ${watcher.after}（active=${watcher.active}，refresh 次数=${watcher.refreshes}）`);

  if (process.env.PULSE_PRINT) console.log(JSON.stringify(placed, null, 2));

  record('页头找到了（标题行 + 页签行 + chip 都在）',
    Boolean(placed.tabs && placed.crumbs && placed.chip),
    `tabs=${placed.tabs ? placed.tabs.width + 'px' : '没有'} crumbs=${placed.crumbs ? placed.crumbs.width + 'px' : '没有'}`
    + ` chip=${placed.chip ? placed.chip.width + 'px' : '没有'} 标记=${placed.marked}`
    + ` ｜状态=${placed.guard.state} 页签行中心=${placed.guard.stripCentre ? placed.guard.stripCentre.join(' > ') : '?'}`
    + ` 抽屉=${placed.guard.drawer}/${placed.guard.drawerOpen}`
    + ` ｜要搬的 chip：${placed.items.map(item => `${item.kind}「${item.label}」${item.box}`).join(' + ') || '(没有)'}`);

  // Whether the chips *can* be moved on this page is a property of the page, not of the
  // shell: the background-jobs chip is as wide as its own label ("1 个后台任务运行中" is
  // 226px by itself, measured), and the strip only has what is left after 对话/轨迹. When
  // the arithmetic says they do not fit, declining is the designed outcome — the official
  // layout is left alone — and asserting the moved shape here would be asserting something
  // the page cannot show. So that case is reported as a skip, with the numbers, and the
  // shape that *is* required for it (no chip on top of the tabs) is asserted instead.
  const room = placed.fitsInputs;
  const cannotFit = placed.guard.state === 'narrow' && Boolean(room) && room.fits === false;
  if (cannotFit) {
    skips.push(`这一屏的 chip 真的放不下（${room.chipWidth}px > 轨迹右边的 ${room.room}px），`
      + '外壳按设计留在官方位置：搬进页签行的那几条这一轮测不了');
  }
  record('外壳没有在不该搬的时候硬搬（放得下才搬）',
    !cannotFit || (placed.marked === false && placed.inStrip === false && placed.group === null),
    `状态=${placed.guard.state} 合起来 ${room ? room.chipWidth : '?'}px，空档 ${room ? room.room : '?'}px，`
    + `标记=${placed.marked}，组=${placed.group ? '在' : '没有'}`);

  record('chip 没有压在页签上（搬进页签行就落在「轨迹」右边，没搬就留在上面的标题行）',
    cannotFit
      ? Boolean(placed.chip && placed.tabs && placed.chip.bottom <= placed.tabs.top + 2)
      : placed.clearsLastTab,
    cannotFit
      ? `留在标题行：chip ${placed.chip ? `${placed.chip.left},${placed.chip.top} → ${placed.chip.right},${placed.chip.bottom}` : '(没有)'}`
        + ` 在页签行 ${placed.tabs ? `${placed.tabs.left},${placed.tabs.top} → ${placed.tabs.right},${placed.tabs.bottom}` : '(没有)'} 上面`
      : `chip 左边 ${placed.chip ? placed.chip.left : '?'} > 最后一个页签右边 ${placed.lastTab ? placed.lastTab.right : '?'}`);

  if (!cannotFit) {
    record('chip 真的被搬进了页签行（DOM 上就在里面，不只是像素落在那）',
      placed.inStrip && placed.insideStrip,
      `在组里=${placed.inStrip}；chip ${placed.chip ? `${placed.chip.left},${placed.chip.top} → ${placed.chip.right},${placed.chip.bottom}` : '(没有)'}`
      + ` vs 页签行 ${placed.tabs ? `${placed.tabs.left},${placed.tabs.top} → ${placed.tabs.right},${placed.tabs.bottom}` : '(没有)'}`
      + ` 组=${placed.group ? `${placed.group.width}x${placed.group.height}@${placed.group.left},${placed.group.top}` : '(没有)'}`);
  }

  // ---- the subagent count chip, which arrives somewhere else entirely -------
  //
  // It is not in a `_headerActions` wrapper: the client renders the lineage slot inside the
  // title's crumb segment, which is why it stayed at the top of the header while the other
  // chips moved down.
  //
  // A conversation with subagents is environment state rather than a contract — after a DSH
  // restart the live chip is gone, measured, and every check here would quietly turn into a
  // skip. So when there is no live chip the slot is **planted** in the real header with the
  // client's own markup (a display:contents wrapper, the ZKlsPq root, the separator and the
  // trigger) and the same assertions run against that. It is our node, so it is taken back
  // out again before the checks that follow.
  //
  // The count arrives with the session's subagent data, *after* the conversation does, so it
  // is given time to appear before a stand-in is planted. Planting too early puts a second
  // slot in the header, and every measurement after that is about two chips: measured, the
  // fixture and the real count together came to 284px of chips against 202px of room, and the
  // shell correctly declined to move anything — a probe artefact that reads exactly like a
  // product failure.
  let lineageView = placed;
  let planted = null;
  if (!placed.lineage.visible) {
    // Long enough for the count to arrive with the session's subagent data, which is slower
    // than the conversation itself: measured, it appeared well after the first measurement
    // and a shorter wait had already put a stand-in in the header.
    const appeared = await page.evaluate(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const slot = document.querySelector('[data-slot*="header.lineage"]');
        const content = slot && slot.firstElementChild;
        if (content && content.getBoundingClientRect().width > 0) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    });
    if (appeared) {
      // It was only late, not absent: the real chip is the subject.
      await new Promise(r => setTimeout(r, 400));
      lineageView = await measure(page);
    } else if (!args.includes('--plant-lineage')) {
      // Planting is opt-in, and that is a correction rather than a preference: the slot goes
      // into the first crumb segment, which can sit *before* the real one in the document, and
      // the shell takes the first match it finds — so a stand-in planted on a page that also
      // has a real count makes the shell move the stand-in and ignore the real chip. Measured:
      // exactly that, with the checks then failing against a header no client renders.
      skips.push('这一屏没有真的子代理 chip（会话里没有子代理），子代理那几条没跑；'
        + '要拿替身测请加 --plant-lineage（替身只测搬运本身，不代表页面上真有子代理）');
    } else {
    const plant = await page.evaluate(() => {
      const header = document.querySelector('header[class*="_header"]');
      const home = header ? header.querySelector('[class*="_crumbSeg"]') : null;
      if (!home) return { missing: true };
      const slot = document.createElement('div');
      slot.setAttribute('data-slot', 'conversation.session.header.lineage');
      slot.setAttribute('style', 'display: contents');
      slot.innerHTML = '<div class="ZKlsPq_root"><span class="ZKlsPq_separator">/</span>'
        + '<button type="button" aria-haspopup="tree" aria-label="4 个子代理"><span>4 个子代理</span></button>'
        + '</div>';
      home.appendChild(slot);
      window.__PULSE_PLANTED_LINEAGE__ = slot;
      window.__PULSE_SHELL_DEBUG__.syncHeaderActions();
      return { missing: false, home: String(home.className || '').slice(0, 24) };
    }).catch(error => ({ error: String(error && error.message ? error.message : error) }));
    if (plant.missing || plant.error) {
      skips.push(`这一屏没有真的子代理 chip，放一份替身也失败了（${plant.error || '找不到 crumbSeg'}），那几条没跑`);
    } else {
      planted = plant;
      await new Promise(r => setTimeout(r, 200));
      lineageView = await measure(page);
      skips.push(`这一屏没有真的子代理 chip（DSH 重启后列表就空了），改用放进 ${plant.home} 的替身`
        + `（官方标记一模一样：data-slot + ZKlsPq 结构）`);
    }
    }
  }

  if (!lineageView.lineage.visible) {
    skips.push('子代理 chip 既没有真的、也没放成，那几条没跑');
  } else if (cannotFit) {
    skips.push('这一屏的 chip 放不下，子代理 chip 也没得搬，那几条没跑');
  } else if (lineageView.guard.state === 'partial') {
    // Three chips (mode + jobs + subagent count) need about 283px of a 202px strip, measured,
    // and no amount of truncation closes that. So the shell picks by priority: the action
    // wrapper takes the strip, the count keeps the crumb row the client gave it. What matters
    // here is that the *title* stays readable — declining everything (what this did before)
    // put all three back in the title row and squeezed the session title to a measured 0px,
    // which is exactly what the phone showed as "the top is a mess".
    record('三个 chip 放不下时：模式/任务 chip 进页签行，子代理数留在标题行旁边（标题还有宽度）',
      !lineageView.lineage.inGroup
      && lineageView.lineage.parent.includes('crumb')
      && lineageView.lineage.separator !== 'none'
      && lineageView.items.some(item => item.kind === '模式/任务' && item.inGroup)
      && Boolean(lineageView.crumbs && lineageView.crumbs.width > 60),
      `状态=${lineageView.guard.state} 子代理在组里=${lineageView.lineage.inGroup}`
      + `（在 ${lineageView.lineage.parent}）模式 chip 在组里=`
      + `${lineageView.items.some(item => item.kind === '模式/任务' && item.inGroup)}`
      + ` 标题容器=${lineageView.crumbs ? lineageView.crumbs.width : '?'}px`
      + ` 组里依次是 ${lineageView.groupChildren.join(' , ')}`);
    skips.push('这一屏是"三个 chip 放不下"的那种（模式 + 后台任务 + 子代理数），'
      + '所以「子代理也在页签行里」那几条按设计不适用');
  } else {
    record('子代理 chip 也被搬进了页签行，就在模式 chip 前面',
      lineageView.lineage.inGroup && lineageView.lineage.index === 0,
      `父母=${lineageView.lineage.parent} 在组里=${lineageView.lineage.inGroup} 序号=${lineageView.lineage.index}`
      + ` 标记=「${lineageView.lineage.marked}」尺寸=${lineageView.lineage.box} 文字=「${lineageView.lineage.text}」`
      + ` 组里依次是 ${lineageView.groupChildren.join(' , ')}${planted ? '（替身）' : ''}`);

    record('chip 前面那个「/」在页签行里不显示（否则读作「/ 4 个子代理 创造模式」）',
      lineageView.lineage.separator === 'none',
      `分隔符 display=${lineageView.lineage.separator || '(没有这个元素)'}`);

    // The pre-paint hold, checked in the shape that actually matters: the client puts the
    // chip back, and the *next animation frame* must not see it there. Without the microtask
    // correction the chip is drawn 33px higher for one frame, and a tap that begins in that
    // frame delivers no click at all — measured with a forced move every 60ms: four taps in
    // five failed before this, and twelve in twelve opened after it (forced every 16ms).
    const hold = await page.evaluate(() => {
      const debug = window.__PULSE_SHELL_DEBUG__;
      const row = debug.headerRow();
      const group = debug.headerGroup();
      if (!row || !row.lineage || !group) return { missing: true };
      return new Promise(resolve => {
        requestAnimationFrame(() => {
          resolve({
            missing: false,
            seenWrong: row.lineage.parentElement !== group,
            settled: row.lineage.parentElement === group,
            home: String((row.lineageHome || {}).className || '').slice(0, 24),
            index: [...group.children].indexOf(row.lineage),
          });
        });
        // Exactly what the client does on its own re-render.
        row.lineageHome.appendChild(row.lineage);
      });
    }).catch(error => ({ error: String(error && error.message ? error.message : error) }));
    if (hold.error) {
      skips.push(`「放回去也不闪」那条夹具出错：${hold.error}`);
    } else if (!hold.missing) {
      record('（自校验）客户端把子代理 chip 放回去之后，下一帧它已经在页签行里（不是晚一帧）',
        hold.seenWrong === false && hold.settled === true && hold.index === 0,
        `下一帧看到的父节点是错的=${hold.seenWrong}，最终在组里=${hold.settled}`
        + `（放进的是 ${hold.home}，在组里的序号 ${hold.index}）`);
    }

    // The A/B, on the same page: hand everything back, read the chip, move it again, read it
    // again. "It is in the group" is otherwise true of any page the shell has already fixed,
    // and the failure that matters — the count staying at the top of the header while the
    // other chips move down — would look exactly like a pass.
    const lineageAb = await page.evaluate(() => {
      const debug = window.__PULSE_SHELL_DEBUG__;
      const read = () => {
        const row = debug.headerRow();
        const slot = row && row.lineage;
        if (!slot) return null;
        const content = slot.firstElementChild;
        const chip = content ? content.getBoundingClientRect() : null;
        const strip = row.tabs.getBoundingClientRect();
        const separator = content ? content.querySelector('[class*="_separator"]') : null;
        return {
          inGroup: slot.parentElement === debug.headerGroup(),
          home: String((slot.parentElement || {}).className || '').slice(0, 24),
          top: chip ? Math.round(chip.top) : null,
          separator: separator ? getComputedStyle(separator).display : '(没有)',
          // Above the strip is where the crumb row is: that is the reported symptom.
          aboveStrip: Boolean(chip && chip.bottom <= strip.top + 2),
        };
      };
      // Read synchronously: the observer that would re-place everything is a microtask, so
      // nothing can have run between the call and the read.
      debug.clearHeaderActions();
      const handedBack = read();
      debug.syncHeaderActions();
      const moved = read();
      return { handedBack, moved };
    }).catch(error => ({ error: String(error && error.message ? error.message : error) }));
    if (lineageAb.error) {
      skips.push(`子代理 chip 来回搬的夹具出错：${lineageAb.error}`);
    } else {
      record('（自校验）把它放回去，它就回到页签行上面的标题行 → 上面那条不是白过的',
        lineageAb.handedBack.inGroup === false && lineageAb.handedBack.aboveStrip === true
        && lineageAb.handedBack.separator !== 'none'
        && lineageAb.moved.inGroup === true && lineageAb.moved.aboveStrip === false
        && lineageAb.moved.separator === 'none',
        `放回后 在组里=${lineageAb.handedBack.inGroup}（${lineageAb.handedBack.home}）`
        + ` top=${lineageAb.handedBack.top} 在页签行上面=${lineageAb.handedBack.aboveStrip}`
        + ` 斜杠=${lineageAb.handedBack.separator}；`
        + `再搬后 在组里=${lineageAb.moved.inGroup} top=${lineageAb.moved.top}`
        + ` 在页签行上面=${lineageAb.moved.aboveStrip} 斜杠=${lineageAb.moved.separator}`);
    }
  }

  // The planted stand-in goes back out here, before anything else is measured: it is our
  // node, and a second lineage slot in the header makes the checks that follow measure a
  // header no client renders (desktop hand-back, rotation, tab switch all read the group).
  if (planted) {
    const removed = await page.evaluate(() => {
      const slot = window.__PULSE_PLANTED_LINEAGE__;
      if (!slot) return { removed: false, slots: 0 };
      if (slot.parentElement) slot.parentElement.removeChild(slot);
      window.__PULSE_SHELL_DEBUG__.syncHeaderActions();
      return {
        removed: true,
        slots: document.querySelectorAll('header [data-slot*="header.lineage"]').length,
      };
    }).catch(() => ({ removed: false, slots: -1 }));
    await new Promise(r => setTimeout(r, 200));
    record('（清理）放进去的替身 chip 已经拿掉，页头回到客户端自己的样子',
      removed.removed && removed.slots <= 1,
      `拿掉=${removed.removed}，页头里还剩 ${removed.slots} 个 lineage 槽`);
  }

  record('chip 在屏幕上是可点的（那一点最上面的就是它）',
    placed.hitsChip,
    `命中 ${placed.topmost}`);

  // The measurement the whole change is for: the title's own box. On a page whose chips
  // cannot fit, this is 0px *by definition* — the official header is what squeezes it, and
  // the shell deliberately does not touch that layout — so it is asserted as such instead
  // of being reported as a failure of the move.
  record('会话标题拿回了宽度（这就是手机上看不见标题的原因）',
    cannotFit ? Boolean(placed.crumbs && placed.crumbs.width <= 60) : Boolean(placed.crumbs && placed.crumbs.width > 60),
    cannotFit
      ? `这一屏 chip 放不下，标题就还是被官方布局挤到 ${placed.crumbs ? placed.crumbs.width : 0}px`
      : `标题容器 ${placed.crumbs ? placed.crumbs.width : 0}px（改动前实测 0px）`);

  // ---- the hamburger, inside the header rather than floating over it --------
  //
  // Asked for directly: put the three bars into the top bar too, phone only. A floating
  // button is positioned against the viewport, so it had to be hidden by hand whenever the
  // client put a control in that corner; as an item in the title row it is covered with the
  // header and the row itself makes space for it.
  const burger = await page.evaluate(() => {
    const node = document.querySelector('.pulse-burger');
    const header = document.querySelector('header[class*="_header"]');
    if (!node || !header) return { missing: true };
    const box = node.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const style = getComputedStyle(node);
    const titleRow = header.querySelector('[class*="_titleRow"]');
    return {
      placed: node.getAttribute('data-pulse-placed') || '',
      inTitleRow: Boolean(titleRow && node.parentElement === titleRow),
      isFirst: Boolean(titleRow && titleRow.firstElementChild === node),
      visible: box.width > 0 && box.height > 0,
      insideHeader: box.top >= headerBox.top - 1 && box.bottom <= headerBox.bottom + 1
        && box.left >= headerBox.left - 1 && box.right <= headerBox.right + 1,
      position: style.position,
      box: `${Math.round(box.width)}x${Math.round(box.height)}@${Math.round(box.left)},${Math.round(box.top)}`,
      headerBox: `${Math.round(headerBox.width)}x${Math.round(headerBox.height)}@${Math.round(headerBox.left)},${Math.round(headerBox.top)}`,
    };
  }).catch(error => ({ error: String(error && error.message ? error.message : error) }));

  if (burger.missing) {
    skips.push('这一屏没有页头，汉堡那一条没跑');
  } else if (burger.error) {
    skips.push(`汉堡夹具出错：${burger.error}`);
  } else {
    record('汉堡就在页头标题行的最左边（DOM 上，不是浮在上面）',
      burger.placed === 'header' && burger.inTitleRow && burger.isFirst && burger.position === 'static',
      `标记=${burger.placed} 父节点是标题行=${burger.inTitleRow} 第一个=${burger.isFirst} position=${burger.position}`);
    record('而且它整个落在页头盒子里、是可见的（能被手指点到）',
      burger.visible && burger.insideHeader,
      `汉堡 ${burger.box}，页头 ${burger.headerBox}`);
  }

  // ---- and it has to be reversible, or the desktop layout inherits it --------
  //
  // The A/B is on the chip's own box, not on the title's width: how much the title gains
  // depends on what else this session's header carries (the background-jobs chip only
  // exists while a job runs), while "which row are the chips in" is the same question on
  // every page — and it is exactly what has to flip when the viewport grows.
  //
  // Done by resizing the real tab, which is the code path a rotation takes: `refresh()`
  // runs, sees a viewport over the threshold, and calls `clearHeaderActions()`. Poking
  // the attribute by hand would be undone by the observer within a frame.
  //
  // The user agent has to change too, and that is not a detail: inside the app the shell
  // stays active at **any** width on purpose, so `shouldActivate()` only returns false
  // once the width is over the threshold *and* the page is an ordinary browser — which is
  // exactly the PC, where the chips belong in the title row.
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 1800));
  const desktop = await measure(page);
  record('（自校验）放大到桌面宽度后 chip 回到标题行 → 上面那条「在页签行里」不是白过的',
    desktop.marked === false && desktop.inStrip === false && desktop.chip && placed.chip
    && desktop.chip.left !== placed.chip.left,
    `桌面宽度下 标记=${desktop.marked} 父节点是页签行=${desktop.inStrip}`
    + ` chip=${desktop.chip ? `${desktop.chip.left},${desktop.chip.top}` : '(没有)'}`
    + ` home=${JSON.stringify(desktop.home)}`);
  record('放大之后我们写的坐标也清掉了（不留给桌面布局）',
    desktop.inlineTop === '' && desktop.inlineRight === '' && desktop.inlineMaxWidth === ''
    && desktop.position !== 'fixed',
    `top=「${desktop.inlineTop}」 right=「${desktop.inlineRight}」`
    + ` max-width=「${desktop.inlineMaxWidth}」 position=${desktop.position}`);

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 1500));
  const back = await measure(page);
  record('缩回手机宽度又会自己搬回去（旋转屏幕走的是同一条路）',
    cannotFit ? back.marked === false : (back.marked === true && back.insideStrip === true),
    `chip=${back.chip ? `${back.chip.left},${back.chip.top}` : '(没有)'} 标记=${back.marked}`
    + ` 外壳状态=${back.guard.state}`
    + ` 容器们=${JSON.stringify(back.containers)}`
    + ` fits=${back.fitsInputs ? JSON.stringify(back.fitsInputs) : '?'}`);

  // ---- a phone narrow enough that both chips cannot fit ---------------------
  //
  // 226px of chips (both of them, while a job runs) plus the tab strip needs more than a
  // 320px screen has. Two outcomes are acceptable and each has its own shape: moved, in
  // which case it must clear the tabs; or deliberately declined, in which case it is
  // exactly where the official client put it. What is never acceptable is a chip sitting
  // on top of 轨迹, which is the crowding this placement exists to end.
  await page.setViewport({ width: 320, height: 720, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 1500));
  const narrow = await measure(page);
  const narrowState = await page.evaluate(() => window.__PULSE_SHELL_DEBUG__.headerActions());
  const narrowOk = narrowState === 'tabs'
    ? narrow.marked === true && narrow.clearsLastTab && narrow.insideStrip
    : narrowState === 'narrow' && narrow.marked === false;
  record('320px 的窄屏上 chip 绝不压住页签（放得下就搬，放不下就留在官方位置）',
    narrowOk,
    `外壳状态=${narrowState} 标记=${narrow.marked}`
    + ` chip ${narrow.chip ? `${narrow.chip.left},${narrow.chip.top} → ${narrow.chip.right},${narrow.chip.bottom}` : '(没有)'}`
    + `，页签行 ${narrow.tabs ? `${narrow.tabs.left},${narrow.tabs.top} → ${narrow.tabs.right},${narrow.tabs.bottom}` : '(没有)'}`
    + `，最后一个页签右边 ${narrow.lastTab ? narrow.lastTab.right : '?'}`);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 1200));

  // Put it back for the remaining checks by letting the shell re-place it.
  await page.evaluate(() => { window.__PULSE_SHELL_DEBUG__.syncHeaderActions(); });
  await new Promise(r => setTimeout(r, 300));

  // ---- the mode chip is still its own control ------------------------------
  const beforeTap = await measure(page);
  const interactive = beforeTap.buttons.some(button => button.haspopup);
  if (!interactive) {
    skips.push('这一屏的页头 chip 没有可展开的按钮（这个构建里它是只读状态），点开那一项没跑');
  } else {
    const target = await page.evaluate(() => {
      const node = document.querySelector('[class*="_headerActions"] button[aria-haspopup]');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
        expanded: node.getAttribute('aria-expanded') };
    });
    if (target) {
      await page.mouse.click(target.x, target.y);
      await new Promise(r => setTimeout(r, 700));
      const opened = await page.evaluate(() => document.querySelectorAll('[role="menu"],[class*="_menu"]').length);
      const after = await measure(page);
      record('搬过去之后 chip 还是它自己的控件（真的按下去，面板照样弹出来）',
        opened > 0 || after.buttons.some(button => button.expanded === 'true'),
        `点 (${target.x},${target.y}) 之后页面上有 ${opened} 个 menu 元素，`
        + `aria-expanded=${after.buttons.map(button => button.expanded).join(',') || '没有'}`);
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 400);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // ---- a React re-render must not undo it ----------------------------------
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('button[class*="_tab"]')].pop();
    if (tab) tab.click();
  });
  await new Promise(r => setTimeout(r, 1200));
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('button[class*="_tab"]')][0];
    if (tab) tab.click();
  });
  await new Promise(r => setTimeout(r, 1200));
  const afterRender = await measure(page);
  record('切换页签（React 重新渲染）之后 chip 的处理没有变',
    cannotFit ? afterRender.marked === false : (afterRender.marked && afterRender.insideStrip),
    `标记=${afterRender.marked} 状态=${afterRender.guard.state}`
    + ` chip=${afterRender.chip ? `${afterRender.chip.left},${afterRender.chip.top}` : '(没有)'}`);

  // ---- the real subagent panel no longer opens over the header ------------
  //
  // The panel is placed at trigger.bottom + 5 — inside the header — so before the clamp
  // its first two rows were drawn over 对话/轨迹. Opening it needs a hover: this build
  // wires no click handler on the header variant.
  const clamped = await page.evaluate(async () => {
    const trigger = document.querySelector('[data-slot*="lineage"] button');
    if (!trigger) return { missing: true };
    const root = trigger.closest('div');
    root.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget: document.body }));
    await new Promise(r => setTimeout(r, 600));
    const menu = document.querySelector('[role="tree"][class*="_menu"]') || document.querySelector('[class*="_menu"][aria-label]');
    const header = document.querySelector('header[class*="_header"]');
    if (!menu || !header) return { missing: false, menu: false };
    const box = menu.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    return {
      missing: false,
      menu: true,
      top: Math.round(box.top),
      headerBottom: Math.round(headerBox.bottom),
      firstRowTop: (() => {
        const leaf = [...menu.querySelectorAll('*')]
          .find(node => node.children.length === 0 && (node.textContent || '').trim());
        return leaf ? Math.round(leaf.getBoundingClientRect().top) : null;
      })(),
      transform: menu.style.transform,
    };
  }).catch(() => ({ missing: true }));
  if (clamped.missing === true) {
    skips.push('这个会话没有子代理，那个"4 个子代理"面板没得开，压不压页头那一项没跑');
  } else if (clamped.menu === false) {
    skips.push('悬停没能打开子代理面板（这个构建的触发方式变了），那一项没跑');
  } else {
    record('子代理面板打开时落在页头下面，不再压住「对话/轨迹」',
      clamped.top >= clamped.headerBottom,
      `面板 top=${clamped.top}，页头底部=${clamped.headerBottom}`
      + `，第一行 top=${clamped.firstRowTop}，我们写上的 transform=${clamped.transform || '(没有)'}`);
  }

  if (shot) {
    const target = resolve(here, '..', shot);
    await page.screenshot({ path: target });
    console.log(`  截图: ${target}`);
  }

  // ---- the clamp's wiring, with the panel's own measured geometry -----------
  //
  // The real panel needs a conversation that has subagents, which is environment state
  // rather than a contract — so the same boxes are planted here, in the real class and
  // the real position, and the shell's own pass is asked to deal with them. The second
  // one is the self-check: a menu that is already below the header must not be touched,
  // or "it moved" would only mean the clamp fires on everything.
  const clampFixture = await page.evaluate(() => {
    const plant = (id, top) => {
      const node = document.createElement('div');
      node.className = 'ZKlsPq_menu';
      node.setAttribute('role', 'tree');
      node.id = id;
      node.setAttribute('style', `position:fixed;left:20px;top:${top}px;width:336px;height:208px;`
        + 'z-index:100;background:rgb(53,54,56)');
      document.body.appendChild(node);
      return node;
    };
    const over = plant('pulse-clamp-over', 52);
    const below = plant('pulse-clamp-below', 200);
    const debug = window.__PULSE_SHELL_DEBUG__;
    debug.clampPopovers();
    const read = node => ({
      transform: node.style.transform,
      top: Math.round(node.getBoundingClientRect().top),
    });
    const result = {
      headerBottom: debug.headerBottom(),
      over: read(over),
      below: read(below),
      clampedCount: debug.clamped(),
    };
    over.remove();
    below.remove();
    return result;
  });
  // Asserted on the box, not on the string: the CSSOM serialises what we wrote
  // (`translate(0px,43px)`) back with a space in it, and a string comparison would be
  // testing the browser's formatting rather than where the panel ended up. The distance is
  // computed from the header's own bottom rather than written out: the header's height is
  // allowed to change (that is what the hamburger's negative margins are about), and a
  // frozen 43px turned a layout change into a false alarm here.
  const expectedShift = clampFixture.headerBottom + 8 - 52;
  record('挂在页头里的面板会被推到页头下面（那一格原来压在「对话/轨迹」上）',
    clampFixture.over.top === clampFixture.headerBottom + 8
    && new RegExp(`translate\\(\\s*0px\\s*,\\s*${expectedShift}px\\s*\\)`).test(clampFixture.over.transform),
    `页头底=${clampFixture.headerBottom}，面板原本 top=52 → 现在 top=${clampFixture.over.top}`
    + `（位移 ${expectedShift}px，transform=${clampFixture.over.transform || '(没有)'}）`);
  record('（自校验）本来就在页头下面的面板一动不动',
    clampFixture.below.transform === '' && clampFixture.below.top === 200,
    `transform=「${clampFixture.below.transform}」 top=${clampFixture.below.top}`);

  // ---- a popover that lives inside the moved container ---------------------
  //
  // The chips used to be placed with `position: fixed`, and a fixed element **creates a
  // stacking context**: the background-jobs menu asks for `z-index: 100`, but inside
  // that context it was capped at whatever the container's own z-index was. Measured on
  // the phone: with the container at 5 the transcript painted *over* the open job list.
  // The group is a flow child with no z-index, so the menu keeps its own — asserted here,
  // and the assertion is proven able to fail by planting a rival at z-index 101.
  //
  // The subagent panel is closed first. It is a fixed portal carrying the same z-index as the
  // jobs menu, and an earlier check leaves it open; with both open the later one in the DOM
  // wins, measured as the subagent list covering the job rows — which reads as a stacking bug
  // in the moved chips and is in fact two official popovers overlapping. The precondition is
  // asserted rather than assumed.
  const panelClosed = await page.evaluate(async () => {
    const slot = document.querySelector('[data-slot*="header.lineage"]');
    const root = slot && slot.firstElementChild;
    if (root) {
      root.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true, cancelable: true, relatedTarget: document.body,
      }));
    }
    const still = () => [...document.querySelectorAll('[class*="ZKlsPq_menu"]')]
      .some(node => node.getBoundingClientRect().height > 40);
    for (let attempt = 0; attempt < 10 && still(); attempt += 1) {
      await new Promise(r => setTimeout(r, 150));
    }
    return !still();
  }).catch(() => false);
  record('（自校验）子代理面板先关掉，作业菜单那几条测的才是它自己',
    panelClosed, panelClosed ? '面板已关闭' : '面板还开着，下面那条会被它盖住');

  const stack = await page.evaluate(mark => {
    const debug = window.__PULSE_SHELL_DEBUG__;
    const row = debug.headerRow();
    if (!row) return { missing: true };
    // The group, because that is the flex row the menu's ancestors now include; a z-index
    // on it would cap the menu, and a z-index on the chip itself would cap it too.
    const container = debug.headerGroup() || row.actions;
    // The jobs chip is the one whose accessible name counts jobs; with nothing running
    // there is no such chip and nothing to open.
    const trigger = container.querySelector('button[aria-label*="后台任务"]');
    if (!trigger) return { noChip: true };
    trigger.click();
    return new Promise(resolve => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const panel = container.querySelector('[class*="_menu"]');
        if (!panel) {
          resolve({ noPanel: true });
          return;
        }
        const describe = node => {
          const style = getComputedStyle(node);
          return `${node.tagName}.${String(node.className || '').slice(0, 28)}`
            + `[pos=${style.position} z=${style.zIndex}]`;
        };
        const box = panel.getBoundingClientRect();
        const firstRow = panel.querySelector('li,button,[class*="_row"]') || panel;
        const rowBox = firstRow.getBoundingClientRect();
        const point = [Math.round(box.left + box.width / 2), Math.round(rowBox.top + rowBox.height / 2)];
        const topmost = () => {
          const at = document.elementsFromPoint(point[0], point[1]);
          return {
            first: at.length ? describe(at[0]) : '(没有)',
            panelWins: at.length > 0 && (at[0] === panel || panel.contains(at[0])),
            stack: at.slice(0, 4).map(describe),
          };
        };
        const real = getComputedStyle(container).zIndex;
        // Both links in the chain, because either one could be the one that caps the menu:
        // the group we added and the official chip wrapper that now sits inside it.
        const chain = [container, row.actions].map(node => {
          const style = getComputedStyle(node);
          return `${String(node.className || node.tagName).slice(0, 20)} pos=${style.position} z=${style.zIndex}`;
        });
        // Read the real page *before* planting anything: whether something on this page
        // paints over the open menu is a question about this page, and a control of my own
        // in the way would answer a different one.
        const withReal = topmost();
        const control = document.createElement('div');
        control.className = 'pulse-fake-rival';
        control.setAttribute('style', `position:absolute;left:${point[0] - 30}px;top:${point[1] - 10}px;`
          + 'width:60px;height:20px;z-index:101;background:rgb(120,40,40)');
        (row.header.parentElement || document.body).appendChild(control);
        const withControl = topmost();
        control.remove();
        resolve({
          panelBox: `${Math.round(box.width)}x${Math.round(box.height)}`
            + `@${Math.round(box.left)},${Math.round(box.top)}`,
          panelZ: getComputedStyle(panel).zIndex,
          containerZ: real,
          chain,
          headerBottom: debug.headerBottom(),
          panelTop: Math.round(box.top),
          point,
          withReal,
          withControl,
          banner: (() => {
            // Whatever is actually painted at the menu's first row, named — so a failure
            // describes the page instead of just saying "something".
            const at = document.elementsFromPoint(point[0], point[1]) || [];
            return at.slice(0, 3).map(describe).join(' > ');
          })(),
        });
      }));
    });
  }, HEADER_ACTIONS_ATTRIBUTE).catch(error => ({ error: String(error && error.message ? error.message : error) }));

  if (stack.missing) {
    skips.push('这一屏没有页签行，作业菜单那一项没跑');
  } else if (stack.noChip) {
    skips.push('这一屏没有后台任务 chip（没有作业在跑），作业菜单压不压内容那一项没跑');
  } else if (stack.noPanel) {
    skips.push('点了作业 chip 也没出现菜单，那一项没跑');
  } else if (stack.error) {
    skips.push(`作业菜单夹具出错：${stack.error}`);
  } else {
    record('作业菜单开的浮层盖在会话内容之上（不是被内容盖住）',
      stack.withReal.panelWins,
      `容器 z=${stack.containerZ}，菜单 z=${stack.panelZ}；`
      + `菜单第一行处最上面的是 ${stack.withReal.first}；那一摞是 ${stack.banner}`);
    record('（自校验）放一个 z-index 101 的对手上去，菜单就输了 → 上面那条能失败',
      stack.withControl.panelWins === false,
      `对手压上去后最上面的是 ${stack.withControl.first}`);
    record('组自己没有 z-index（不让作业菜单的 z-index:100 被限制在一个层叠上下文里）',
      stack.containerZ === 'auto' && stack.chain.every(entry => /pos=static z=auto/.test(entry)),
      `那一摞：${stack.chain.join(' > ')}`);
    record('菜单没有被推到页头上面（还是落在页头下面）',
      stack.panelTop >= stack.headerBottom,
      `菜单 top=${stack.panelTop}，页头底=${stack.headerBottom}，菜单 ${stack.panelBox}`);
  }

  // ---- the chips must not float over another pane --------------------------
  //
  // The chips used to be placed with `position: fixed`, which meant they did not care that
  // the chat header had been covered: open the file browser or a document preview on the
  // phone and the chips kept painting at their viewport coordinates, on top of that pane's
  // own header (reported with two phone screenshots). Now they are in the strip's flow, so
  // whatever covers the header covers them — a property of the tree, checked here by
  // standing a pane in front of the whole conversation.
  const paneCheck = await page.evaluate(mark => {
    const debug = window.__PULSE_SHELL_DEBUG__;
    const row = debug.headerRow();
    if (!row) return { missing: true };
    // The group, not a chip: it is the box that spans every chip the shell moved, so a
    // failure that leaves one chip sticking out is caught by measuring the whole group. A
    // page whose chips do not fit has no group, and the chip the client placed is measured
    // instead — the property under test ("the pane is painted over them") is the same one.
    const find = () => debug.headerGroup() || row.actions;
    const stripBox = row.tabs.getBoundingClientRect();
    const point = [
      Math.round((stripBox.left + stripBox.right) / 2),
      Math.round((stripBox.top + stripBox.bottom) / 2),
    ];
    const describe = node => (node ? `${node.tagName}.${String(node.className || '').slice(0, 24)}` : '(没有)');
    const read = () => ({
      stripTopmost: describe((document.elementsFromPoint(point[0], point[1]) || [])[0]),
      state: debug.headerActions(),
      marked: Boolean(debug.headerGroup()),
      // The property that replaced the whole monitor: with the chips in the header's flow,
      // anything painted in front of the header is painted in front of them.
      chipOnTop: (() => {
        const node = find();
        if (!node) return null;
        const box = node.getBoundingClientRect();
        const at = document.elementsFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height / 2),
        ) || [];
        return at.length > 0 && (at[0] === node || node.contains(at[0]));
      })(),
      chip: (() => {
        const node = find();
        if (!node) return '(没有)';
        const box = node.getBoundingClientRect();
        return `${Math.round(box.width)}x${Math.round(box.height)}@${Math.round(box.left)},${Math.round(box.top)}`;
      })(),
    });
    const before = read();
    const pane = document.createElement('div');
    pane.className = 'pulse-fake-pane';
    pane.setAttribute('style', 'position:fixed;inset:0;z-index:46;background:rgb(20,22,26)');
    document.body.appendChild(pane);
    return new Promise(resolve => {
      window.setTimeout(() => {
        const after = read();
        pane.remove();
        window.setTimeout(() => {
          resolve({ before, after, back: read() });
        }, 700);
      }, 700);
    });
  }, HEADER_ACTIONS_ATTRIBUTE).catch(error => ({ error: String(error && error.message ? error.message : error) }));

  if (paneCheck.missing) {
    skips.push('这一屏没有页签行，右侧面板那一项没跑');
  } else if (paneCheck.error) {
    skips.push(`右侧面板夹具出错：${paneCheck.error}`);
  } else {
    record('会话前面出现别的面板时，chip 也随之被盖住（不再浮在它上面）',
      paneCheck.before.chipOnTop === true && paneCheck.after.chipOnTop === false
      && paneCheck.back.chipOnTop === true,
      `面板出现前 chip 在自己那一点最上面=${paneCheck.before.chipOnTop}（chip ${paneCheck.before.chip}）；`
      + `出现后=${paneCheck.after.chipOnTop}（页签行中心最上面是 ${paneCheck.after.stripTopmost}）；`
      + `撤掉后=${paneCheck.back.chipOnTop}`);
    record('（自校验）那块面板确实盖住了页签行 → 上面那条测的是真事',
      paneCheck.before.stripTopmost !== paneCheck.after.stripTopmost
      && paneCheck.after.stripTopmost.includes('pulse-fake-pane'),
      `${paneCheck.before.stripTopmost} → ${paneCheck.after.stripTopmost}`);
    record('面板撤掉之后 chip 又回到最上面（不是一直让开）',
      paneCheck.back.chipOnTop === true,
      `状态=${paneCheck.back.state} 有组=${paneCheck.back.marked} chip=${paneCheck.back.chip}`);
  }

  // ---- the contract this placement is copied from --------------------------
  const headerModule = await officialModule(base, cookie, '@deepseek-ai/dsh-client-ui-conversation');
  record('官方会话页头仍然是 titleRow / titleCluster / headerActions / tabs 这套类名',
    ['_titleRow{', '_titleCluster{', '_headerActions{', '_tabs{']
      .every(name => headerModule.section.includes(name)),
    ['_titleRow{', '_titleCluster{', '_headerActions{', '_tabs{']
      .map(name => `${name} ${headerModule.section.includes(name)}`).join('，'));

  const jobs = await officialModule(base, cookie, '@deepseek-ai/dsh-client-ui-jobs');
  record('后台任务 chip 仍然注册进同一个槽（所以它和模式 chip 是一个容器）',
    jobs.section.includes('conversation.session.header.actions') && jobs.section.includes('job-list'),
    `槽 ${jobs.section.includes('conversation.session.header.actions')}，id ${jobs.section.includes('job-list')}`);
  // It renders nothing at all without jobs, which is why an ordinary conversation never
  // grows this chip and why "the row got an extra chip" only ever happens while one runs.
  record('没有后台任务时它什么都不渲染（那格是空的）',
    /jobs\.length === 0\) return null/.test(jobs.section),
    /jobs\.length === 0\) return null/.test(jobs.section) ? '有那条返回' : '那条返回不见了');

  const preset = await officialModule(base, cookie, '@deepseek-ai/dsh-client-ui-agent-preset');
  record('模式 chip 也注册进同一个槽（两个 chip 一起搬是有依据的）',
    preset.section.includes('conversation.session.header.actions'),
    preset.section.includes('conversation.session.header.actions') ? '在' : '不在了');

  const subagent = await officialModule(base, cookie, '@deepseek-ai/dsh-client-ui-subagent');
  record('官方子代理面板仍然是 fixed + 同样的最大高度（我们靠它自己定位，然后才谈得上纠正）',
    /_menu\{[^}]*position:fixed/.test(subagent.section) && subagent.section.includes('max-height:min(560px,100vh - 140px)'),
    `fixed ${/_menu\{[^}]*position:fixed/.test(subagent.section)}，max-height ${subagent.section.includes('max-height:min(560px,100vh - 140px)')}`);
  record('它仍然挂在触发按钮下面 5px（页头里的触发按钮 → 面板因此压住页头）',
    /top: rect\.bottom \+ 5/.test(subagent.section),
    /top: rect\.bottom \+ 5/.test(subagent.section) ? 'top = rect.bottom + 5 在' : '这条定位规则变了');
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
