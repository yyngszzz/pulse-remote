#!/usr/bin/env node
/**
 * Audit the phone's conversation header: what is the tab strip, what is the mode chip,
 * and what is the list that overlaps them?
 *
 *   node scripts/audit-phone-header.mjs [--url http://127.0.0.1:3199] [--width 390] [--shot out.png]
 *
 * The report is structural on purpose: geometry, the ancestor chain, and the class names
 * of everything that sits in the first 160px of the page, because the layout question is
 * "which official row could host what" — and that is answered by reading the real rows
 * rather than by guessing at them.
 *
 * @module pulse-remote/scripts/audit-phone-header
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
/** Which conversation to open. The one with subagents in it is where the header is full. */
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
  body: JSON.stringify({ code: opened.code, label: 'audit-header' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, deviceScaleFactor: 2, isMobile: width <= 900, hasTouch: width <= 900 });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13');
  await page.setCookie({
    name: 'pulse_session', value: cookie.slice(cookie.indexOf('=') + 1),
    domain: new URL(base).hostname, path: '/',
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.addStyleTag({ content: mobileStylesheet() });
  await page.addStyleTag({ content: mobileShellStyles() });
  await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript());
  await page.evaluate(wanted => { window.__PULSE_WANTED__ = wanted; }, wanted);
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
  console.log('会话:', await page.evaluate(() => window.__PULSE_PICKED__));

  // Anything that would be reported: the tabs, the mode chip, and the overlap.
  const report = await page.evaluate(() => {
    const box = node => {
      const rect = node.getBoundingClientRect();
      return `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`;
    };
    const chain = node => {
      const out = [];
      let at = node;
      for (let depth = 0; at && depth < 5; depth += 1) {
        out.push(`${at.tagName}.${String(at.className || '').slice(0, 48)}[${box(at)}]`);
        at = at.parentElement;
      }
      return out;
    };
    const describe = node => ({
      tag: node.tagName,
      className: String(node.className || '').slice(0, 80),
      text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      box: box(node),
      display: getComputedStyle(node).display,
      position: getComputedStyle(node).position,
      overflow: getComputedStyle(node).overflow,
      maxHeight: getComputedStyle(node).maxHeight,
      chain: chain(node),
      attrs: [...node.attributes].map(attr => `${attr.name}=${attr.value.slice(0, 40)}`).slice(0, 12),
    });

    /** A leaf (or near-leaf) whose text is exactly one of these. */
    const named = label => [...document.querySelectorAll('*')]
      .filter(node => node.children.length <= 1 && (node.textContent || '').trim() === label)
      .slice(0, 4)
      .map(describe);

    // Everything sitting in the top strip of the page, so the rows that could host a
    // control are visible even when their text is not distinctive.
    const top = [...document.querySelectorAll('#root *')]
      .filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.height > 0 && rect.height < 60 && rect.top >= 0 && rect.top < 160
          && rect.width > 40 && !node.querySelector('*');
      })
      .slice(0, 40)
      .map(node => `${String(node.className || node.tagName).slice(0, 40)} "${(node.textContent || '').trim().slice(0, 24)}" ${box(node)}`);

    // The subagent list: identified by its own text, not by a class.
    const plans = [...document.querySelectorAll('*')]
      .filter(node => /Write Plan [A-Z]/.test(node.textContent || '') && node.children.length >= 4);
    const listRoot = plans.length > 0 ? plans[plans.length - 1] : null;
    const plansRoot = listRoot ? (() => {
      let at = listRoot;
      for (let depth = 0; at && depth < 8; depth += 1) {
        const style = getComputedStyle(at);
        if (/auto|scroll/.test(style.overflowY) || at.getAttribute('role') === 'dialog'
          || at.getAttribute('role') === 'menu' || style.position === 'fixed' || style.position === 'absolute') {
          return at;
        }
        at = at.parentElement;
      }
      return listRoot;
    })() : null;

    return {
      tabs: {
        conversation: named('对话'),
        trajectory: named('轨迹'),
        standard: named('标准模式'),
        creative: named('创造模式'),
      },
      top,
      list: plansRoot ? {
        ...describe(plansRoot),
        rows: [...plansRoot.children].map(describe).slice(0, 8),
        html: plansRoot.outerHTML.slice(0, 1500),
      } : null,
      listRoots: plans.map(describe).slice(-3),
      headerBottom: (() => {
        const nodes = [...document.querySelectorAll('#root *')].filter(node => {
          const rect = node.getBoundingClientRect();
          return rect.top <= 2 && rect.height > 20 && rect.width > 200;
        });
        return nodes.map(node => `${String(node.className || node.tagName).slice(0, 40)} ${box(node)}`).slice(0, 6);
      })(),
    };
  });

  console.log('\n=== 顶部那一条（前 160px 里的叶子节点）');
  for (const line of report.top) console.log('  ' + line);

  console.log('\n=== 贴顶的容器');
  for (const line of report.headerBottom) console.log('  ' + line);

  for (const [name, nodes] of Object.entries(report.tabs)) {
    if (nodes.length === 0) continue;
    console.log(`\n=== 「${name}」`);
    for (const node of nodes) {
      console.log('  ' + node.tag + '.' + node.className + '  ' + node.box
        + ` display=${node.display} pos=${node.position}`);
      console.log('    text: ' + node.text);
      console.log('    attrs: ' + node.attrs.join(' | '));
      for (const step of node.chain) console.log('      ^ ' + step);
    }
  }

  if (report.list) {
    console.log('\n=== 那个列表（子代理）');
    console.log('  ' + report.list.tag + '.' + report.list.className + '  ' + report.list.box
      + ` pos=${report.list.position} overflow=${report.list.overflow} max-h=${report.list.maxHeight}`);
    console.log('  attrs: ' + report.list.attrs.join(' | '));
    for (const step of report.list.chain) console.log('    ^ ' + step);
    for (const row of report.list.rows) {
      console.log('    - ' + row.tag + '.' + row.className + '  ' + row.box + ' :: ' + row.text);
    }
    console.log('  html: ' + report.list.html);
  } else {
    console.log('\n=== 那个列表：这一屏没有（子代理列表可能是收起的）');
  }
  if (report.listRoots.length > 1) {
    console.log('\n=== 提到 Write Plan 的容器');
    for (const node of report.listRoots) {
      console.log('  ' + node.tag + '.' + node.className + ' ' + node.box + ' :: ' + node.text.slice(0, 60));
    }
  }

  // ---- our own chrome, measured against the header -------------------------
  //
  // The hamburger is an overlay of ours, drawn outside the client's root, so whether it is
  // "in the header" is a question about the box it lands in — not something to assume.
  const chrome = await page.evaluate(() => {
    const box = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        left: Math.round(rect.left), right: Math.round(rect.right),
        top: Math.round(rect.top), bottom: Math.round(rect.bottom),
        width: Math.round(rect.width), height: Math.round(rect.height),
      };
    };
    const burger = document.querySelector('.pulse-burger');
    const header = document.querySelector('header[class*="_header"]');
    const titleRow = header ? header.querySelector('[class*="_titleRow"]') : null;
    const cluster = header ? header.querySelector('[class*="_titleCluster"]') : null;
    const style = burger ? getComputedStyle(burger) : null;
    const burgerBox = box(burger);
    const headerBox = box(header);
    return {
      burger: burgerBox,
      burgerCss: style
        ? `position=${style.position} z=${style.zIndex} display=${style.display} top=${style.top} left=${style.left}`
        : '(没有汉堡)',
      header: headerBox,
      titleRow: titleRow ? { ...box(titleRow), paddingLeft: getComputedStyle(titleRow).paddingLeft } : null,
      cluster: box(cluster),
      insideHeaderBox: Boolean(burgerBox && headerBox
        && burgerBox.top >= headerBox.top && burgerBox.bottom <= headerBox.bottom
        && burgerBox.left >= headerBox.left && burgerBox.right <= headerBox.right),
      visible: Boolean(burgerBox && burgerBox.width > 0 && burgerBox.height > 0),
      cornerTaken: document.documentElement.classList.contains('pulse-corner-taken'),
      firstTitleRowChildren: titleRow
        ? [...titleRow.children].map(node => `${node.tagName}.${String(node.className || '').slice(0, 26)} ${JSON.stringify(box(node))}`)
        : [],
    };
  });
  console.log('\n=== 我们的汉堡 vs 页头');
  console.log('  汉堡: ' + JSON.stringify(chrome.burger) + '  ' + chrome.burgerCss);
  console.log('  页头: ' + JSON.stringify(chrome.header));
  console.log('  标题行: ' + JSON.stringify(chrome.titleRow));
  console.log('  标题簇: ' + JSON.stringify(chrome.cluster));
  console.log('  汉堡整个落在页头盒子里吗: ' + chrome.insideHeaderBox + '，可见: ' + chrome.visible
    + '，角落被占标记: ' + chrome.cornerTaken);
  for (const line of chrome.firstTitleRowChildren) console.log('    ' + line);

  if (shot) {
    const target = resolve(here, '..', shot);
    await page.screenshot({ path: target });
    console.log(`\n截图: ${target}`);
  }

  // ---- the subagent list, opened the way the user opens it ------------------
  //
  // It is the official lineage chip (`conversation.session.header.lineage`), which only
  // exists on a conversation that has subagents. Clicking it is the only way to see the
  // panel, and the panel's geometry is the whole question: the screenshot shows its first
  // row cut off, and "cut off" can come from our clamp, from the panel's own max-height,
  // or from the header drawing over it.
  // A real tap, not `element.click()`: this is a React control and the popover trigger
  // may listen for `pointerdown` (Radix-style) rather than `click`. `page.click` was
  // tried first and landed on whatever our own chrome covers that point, which is why the
  // sequence is dispatched at the element itself.
  const lineageSelector = '[data-slot*="lineage"] button';
  await page.waitForSelector(lineageSelector, { timeout: 5000 }).catch(() => {});

  const lineage = await page.evaluate(async () => {
    const slot = document.querySelector('[data-slot*="header.lineage"], [data-slot*="lineage"]');
    // The slot's own trigger, not the first button in the header: that one is the title.
    const button = slot ? slot.querySelector('button') : null;
    const box = node => {
      if (!node) return '';
      const rect = node.getBoundingClientRect();
      return `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`;
    };
    const before = {
      slotFound: Boolean(slot),
      slotHtml: slot ? slot.outerHTML.slice(0, 400) : '',
      holderClass: slot ? String((slot.parentElement || {}).className || '') : '',
      holderBox: box(slot ? slot.parentElement : null),
      buttonText: button ? (button.textContent || '').trim().slice(0, 40) : '',
      buttonBox: box(button),
    };
    // The row the chips live in, child by child: this is where the crowding is.
    const titleRow = document.querySelector('[class*="titleRow"]');
    const titleCluster = document.querySelector('[class*="titleCluster"]');
    const rowChildren = titleRow ? [...titleRow.children].map(node =>
      `${node.tagName}.${String(node.className || '').slice(0, 40)} ${box(node)} :: `
      + `[${[...node.children].map(child => String(child.className || child.tagName).slice(0, 26) + ' ' + box(child)).join(' | ')}]`) : [];

    // The full pointer sequence a finger produces, then a click, then whichever of them
    // the control was waiting for has happened.
    const fire = type => button.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true,
      pointerType: 'touch', button: 0, buttons: type === 'pointerdown' ? 1 : 0,
    }));
    const stages = [];
    if (button) {
      fire('pointerdown');
      await new Promise(r => setTimeout(r, 120));
      stages.push('pointerdown→' + button.getAttribute('aria-expanded'));
      fire('pointerup');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      await new Promise(r => setTimeout(r, 1200));
      stages.push('click→' + button.getAttribute('aria-expanded'));
    }
    await new Promise(r => setTimeout(r, 600));

    // The lineage menu has **no click handler on the header variant** — its `onClick` is
    // only wired when a switcher title exists — and opens 150 ms after a hover. On a phone
    // the tap's synthetic mouseover is what opens it, so that is what is dispatched here.
    const root = button ? button.closest('div') : null;
    if (root) {
      root.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, cancelable: true, relatedTarget: document.body,
      }));
    }
    await new Promise(r => setTimeout(r, 500));

    const menu = document.querySelector('[role="tree"]') || document.querySelector('[class*="_menu"]');
    const menuInfo = menu ? (() => {
      const rect = menu.getBoundingClientRect();
      const style = getComputedStyle(menu);
      // Which element actually paints at a point inside the menu's top strip: the menu,
      // or the opaque app header that sits over it.
      const probeY = Math.round(rect.top + 12);
      const stack = document.elementsFromPoint(Math.round(rect.left + rect.width / 2), probeY)
        .slice(0, 5).map(node => `${node.tagName}.${String(node.className || '').slice(0, 34)}`);
      const header = document.querySelector('[class*="_header"]');
      const headerStyle = header ? getComputedStyle(header) : null;
      return {
        inlineTop: menu.style.top,
        inlineLeft: menu.style.left,
        box: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        position: style.position,
        zIndex: style.zIndex,
        maxHeight: style.maxHeight,
        overflow: style.overflowY,
        parent: menu.parentElement ? menu.parentElement.tagName : '',
        probeY,
        stack,
        topmostIsMenu: stack.length > 0 && /ZKlsPq_menu|_menu/.test(stack[0]),
        header: headerStyle
          ? `pos=${headerStyle.position} z=${headerStyle.zIndex} bg=${headerStyle.backgroundColor}`
          : '',
        rows: [...menu.querySelectorAll('*')]
          .filter(node => node.children.length === 0 && (node.textContent || '').trim())
          .slice(0, 12)
          .map(node => {
            const rowRect = node.getBoundingClientRect();
            return `${String(node.className || node.tagName).slice(0, 34)}`
              + ` ${Math.round(rowRect.width)}x${Math.round(rowRect.height)}@${Math.round(rowRect.left)},${Math.round(rowRect.top)}`
              + ` :: ${(node.textContent || '').trim().slice(0, 34)}`;
          }),
      };
    })() : null;

    const describe = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        className: String(node.className || node.tagName).slice(0, 60),
        box: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        position: style.position,
        overflow: style.overflowY,
        maxHeight: style.maxHeight,
        zIndex: style.zIndex,
        paddingTop: style.paddingTop,
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      };
    };

    // Whichever panel appeared. Not narrowed to fixed/absolute this time: a `role="tree"`
    // or an open-state marker is the contract, and a position test is what missed it.
    const panels = [...document.querySelectorAll('body *')].filter(node => {
      if (node.closest('[class*="_column"],[class*="_markdown"]')) return false;
      const style = getComputedStyle(node);
      const role = node.getAttribute('role') || '';
      const open = node.getAttribute('data-state') === 'open';
      const tall = node.getBoundingClientRect().height > 60;
      return tall && (/tree|menu|dialog|listbox/.test(role) || open)
        && /个子代理|tok|可继续/.test(node.textContent || '');
    });
    const panel = panels[panels.length - 1] || null;
    const header = document.querySelector('[class*="header"]');
    // What is inside the actions container, child by child: whether the mode chip can be
    // moved on its own or only with the status chip that shares the container decides
    // whether this is a CSS move or a DOM move.
    const actionsNode = document.querySelector('[class*="headerActions"]');
    const actionsChildren = actionsNode ? [...actionsNode.querySelectorAll('*')]
      .filter(node => node.children.length === 0 && (node.textContent || '').trim())
      .map(node => `${node.tagName}.${String(node.className || '').slice(0, 30)} ${box(node)}`
        + ` :: ${(node.textContent || '').trim().slice(0, 30)}`) : [];

    /** Who paints at a point, topmost first, with the reason each one can win. */
    const stackAt = (x, y) => document.elementsFromPoint(Math.round(x), Math.round(y))
      .slice(0, 6)
      .map(node => {
        const style = getComputedStyle(node);
        return `${node.tagName}.${String(node.className || '').slice(0, 32)}`
          + ` pos=${style.position} z=${style.zIndex} bg=${style.backgroundColor}`;
      });
    // The first row of the panel and the header band overlap. This says which of them is
    // actually painted on top — the difference between "the client placed it wrong" and
    // "something of ours covers it".
    const panelStack = panel ? (() => {
      const rect = panel.getBoundingClientRect();
      const leaves = [...panel.querySelectorAll('*')]
        .filter(node => node.children.length === 0 && (node.textContent || '').trim());
      const first = leaves[0];
      const firstRect = first ? first.getBoundingClientRect() : rect;
      return {
        panelTop: Math.round(rect.top),
        firstRowTop: Math.round(firstRect.top),
        firstRowText: first ? (first.textContent || '').trim().slice(0, 30) : '',
        overlapsHeaderBand: Math.round(firstRect.top) < 87,
        atHeaderBand: stackAt(window.innerWidth / 2, 40),
        atFirstRow: stackAt(window.innerWidth / 2, firstRect.top + 6),
      };
    })() : null;

    return {
      before,
      stages,
      rowChildren,
      clusterBox: box(titleCluster),
      actionsBox: box(actionsNode),
      actionsChildren,
      menu: menuInfo,
      panelStack,
      headerBox: header ? describe(header) : null,
      panel: panel ? { ...describe(panel), rows: [...panel.querySelectorAll('*')]
        .filter(node => node.children.length === 0 && (node.textContent || '').trim())
        .slice(0, 14).map(describe) } : null,
      panelCount: panels.length,
      expanded: button ? button.getAttribute('aria-expanded') : null,
      scrollParent: panel ? (() => {
        let at = panel;
        for (let depth = 0; at && depth < 6; depth += 1) {
          if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return describe(at);
          at = at.parentElement;
        }
        return null;
      })() : null,
      // The strip the tabs live in, and how much of it is actually used: that is the
      // budget for moving a chip down there.
      tabs: (() => {
        const node = document.querySelector('[class*="_tabs"]');
        if (!node) return null;
        const style = getComputedStyle(node);
        return {
          box: box(node),
          display: style.display,
          justifyContent: style.justifyContent,
          gap: style.gap,
          children: [...node.children].map(child => `${child.tagName}.${String(child.className || '').slice(0, 30)} ${box(child)}`),
        };
      })(),
    };
  }).catch(error => ({ error: String(error && error.message ? error.message : error) }));

  console.log('\n=== 子代理那一块（lineage）');
  if (lineage.error) {
    console.log('  夹具出错: ' + lineage.error);
  } else {
    console.log('  slot: ' + (lineage.before.slotFound ? lineage.before.slotHtml : '(这一屏没有 lineage 槽)'));
    console.log('  holder: ' + lineage.before.holderClass + ' ' + lineage.before.holderBox);
    console.log('  触发按钮: 「' + lineage.before.buttonText + '」 ' + lineage.before.buttonBox
      + ' expanded=' + lineage.expanded);
    if (lineage.stages) console.log('  事件阶段: ' + lineage.stages.join('  '));
    console.log('  titleCluster: ' + lineage.clusterBox);
    console.log('  headerActions: ' + lineage.actionsBox);
    if (lineage.menu) {
      const menu = lineage.menu;
      console.log('  菜单: ' + menu.box + ` inline top=${menu.inlineTop} left=${menu.inlineLeft}`
        + ` pos=${menu.position} z=${menu.zIndex} max-h=${menu.maxHeight} overflow=${menu.overflow}`);
      console.log('  父节点: ' + menu.parent);
      console.log('  header: ' + menu.header);
      console.log('  在菜单顶部往下 12px 处（y=' + menu.probeY + '）从上到下:');
      for (const line of menu.stack) console.log('    > ' + line);
      console.log('  最上面那个是菜单自己吗: ' + menu.topmostIsMenu);
      for (const row of menu.rows) console.log('    - ' + row);
    } else {
      console.log('  菜单: 悬停也没打开（这一屏可能没有子代理目录）');
    }
    console.log('  titleRow 的孩子:');
    for (const line of lineage.rowChildren) console.log('    ' + line);
    if (lineage.tabs) {
      console.log('  tabs: ' + lineage.tabs.box + ` display=${lineage.tabs.display}`
        + ` justify=${lineage.tabs.justifyContent} gap=${lineage.tabs.gap}`);
      for (const child of lineage.tabs.children) console.log('    ' + child);
    }
    if (lineage.panelStack) {
      const stack = lineage.panelStack;
      console.log('  面板: top=' + stack.panelTop + '  第一行 top=' + stack.firstRowTop
        + '  文字「' + stack.firstRowText + '」  压进头部区域=' + stack.overlapsHeaderBand);
      console.log('  在头部那一条（y=40）从上到下:');
      for (const line of stack.atHeaderBand) console.log('    > ' + line);
      console.log('  在第一行上（y=' + (stack.firstRowTop + 6) + '）从上到下:');
      for (const line of stack.atFirstRow) console.log('    > ' + line);
    }
    if (lineage.headerBox) console.log('  header: ' + lineage.headerBox.box);
    if (lineage.panel) {
      console.log('  面板: ' + lineage.panel.className + ' ' + lineage.panel.box
        + ` pos=${lineage.panel.position} overflow=${lineage.panel.overflow}`
        + ` max-h=${lineage.panel.maxHeight} z=${lineage.panel.zIndex} pad-top=${lineage.panel.paddingTop}`);
      if (lineage.scrollParent) {
        console.log('  可滚动祖先: ' + lineage.scrollParent.className + ' ' + lineage.scrollParent.box);
      }
      for (const row of lineage.panel.rows) {
        console.log('    - ' + row.className + ' ' + row.box + ` top=${row.top}` + ' :: ' + row.text);
      }
    } else {
      console.log('  面板: 没找到（点了按钮也没有出现带 tok 的浮层）');
    }
  }
  if (shot) {
    const target = resolve(here, '..', shot.replace(/\.png$/, '-lineage.png'));
    await page.screenshot({ path: target });
    console.log(`\n截图: ${target}`);
  }
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
