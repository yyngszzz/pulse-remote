#!/usr/bin/env node
/**
 * Minimal reproduction of the "wide table swallows vertical swipes" trap.
 *
 *   node scripts/repro-scroll-trap.mjs
 *
 * ## The mechanism under test
 *
 * A box with `overflow-x: auto` and the default `overflow-y: visible` is a
 * scroll container on *both* axes: CSS computes a `visible` axis to `auto` as
 * soon as the other axis is not `visible`. That box therefore has its own
 * vertical scroll container — with nothing to scroll vertically.
 *
 * Scroll chaining is what normally saves this: the inner box cannot scroll
 * vertically, so the gesture passes up to the conversation. But
 * `overscroll-behavior: contain` on the *Y* axis suppresses exactly that
 * hand-off, and the swipe dies on the table.
 *
 * So the three cases below differ only in that one declaration:
 *
 *   A  default                       → swipe must reach the outer scroller
 *   B  overscroll-behavior: contain   → the suspected trap
 *   C  overscroll-behavior-x: contain → the official client's own choice
 *
 * Each case gets an identical synthesized *touch* scroll gesture, and the only
 * thing measured is whether the outer scroller moved. A layout that cannot be
 * scrolled by a finger is a fact, not an opinion, so the numbers decide.
 *
 * @module pulse-remote/scripts/repro-scroll-trap
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import puppeteer from 'puppeteer-core';

import { mobileStylesheet } from '../lib/mobile.js';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
].filter(Boolean);

const executablePath = process.env.PULSE_BROWSER ?? BROWSERS.find(candidate => existsSync(candidate));
if (!executablePath) {
  console.error('找不到 Chromium 系浏览器。设 PULSE_BROWSER 指向 msedge.exe / chrome.exe。');
  process.exit(2);
}

/**
 * The three declarations under test.
 *
 * `expectsToMove` is what makes this a test rather than a demo: case B is
 * *supposed* to swallow the gesture, so a run where it moves would mean the trap
 * is no longer being reproduced and the other cases prove nothing.
 *
 * @type {{name: string, expectsToMove: boolean, inner: string}[]}
 */
const CASES = [
  { name: 'A 默认', expectsToMove: true, inner: '' },
  { name: 'B overscroll-behavior: contain（原来的写法）', expectsToMove: false, inner: 'overscroll-behavior: contain;' },
  { name: 'C overscroll-behavior-x: contain（官方写法，现在的写法）', expectsToMove: true, inner: 'overscroll-behavior-x: contain;' },
];

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let failures = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // The viewport meta is load-bearing: with `isMobile: true` and no meta,
  // Chromium lays the page out at 980px, so every `max-width: 900px` rule in the
  // layer silently fails to match and the whole test measures the wrong layout.
  await page.setContent(
    '<!doctype html><html><head>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '</head><body style="margin:0"></body></html>',
  );
  const cdp = await page.target().createCDPSession();

  console.log(`滚动陷阱最小复现  浏览器=${executablePath}`);
  console.log('');

  for (const testCase of CASES) {
    const geometry = await page.evaluate(inner => {
      document.body.innerHTML = `
        <div id="outer" style="width:390px;height:400px;overflow-y:auto;background:#eee">
          <div style="height:400px">上面</div>
          <div id="inner" style="overflow-x:auto;${inner}background:#cde">
            <table style="width:1200px"><tr><td>很宽的一行内容</td></tr></table>
          </div>
          <div style="height:400px">下面</div>
        </div>`;
      const outer = document.getElementById('outer');
      // Scroll first, then measure: the gesture has to land on a point that is
      // inside the scroller's visible box *after* the pre-scroll, or it misses
      // the scroller entirely and the case proves nothing.
      outer.scrollTop = 400;
      const innerBox = document.getElementById('inner');
      const style = getComputedStyle(innerBox);
      const rect = innerBox.getBoundingClientRect();
      const outerRect = outer.getBoundingClientRect();
      const x = Math.round(outerRect.left + outerRect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      return {
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        touchAction: style.touchAction,
        overscrollX: style.overscrollBehaviorX,
        overscrollY: style.overscrollBehaviorY,
        x,
        y,
        onTarget: y >= outerRect.top && y <= outerRect.bottom,
        innerTop: Math.round(rect.top),
        innerHeight: Math.round(rect.height),
        outerTop: Math.round(outerRect.top),
        outerBottom: Math.round(outerRect.bottom),
      };
    }, testCase.inner);

    const before = await page.evaluate(() => document.getElementById('outer').scrollTop);

    // Control first: if the box cannot be scrolled even by script, then no
    // gesture result means anything and the harness is what is broken.
    const control = await page.evaluate(() => {
      const outer = document.getElementById('outer');
      outer.scrollTop = 400;
      outer.scrollTop = 500;
      const reached = outer.scrollTop;
      outer.scrollTop = 400;
      return reached;
    });

    const results = {};
    for (const gestureSourceType of ['touch', 'mouse']) {
      await page.evaluate(() => { document.getElementById('outer').scrollTop = 400; });
      // A finger flick upwards, which must scroll the conversation downwards.
      await cdp.send('Input.synthesizeScrollGesture', {
        x: geometry.x,
        y: geometry.y,
        xDistance: 0,
        yDistance: -240,
        gestureSourceType,
        speed: 800,
        preventFling: true,
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      results[gestureSourceType] = await page.evaluate(() => document.getElementById('outer').scrollTop) - 400;
    }

    const moved = Math.max(results.touch, results.mouse);
    const ok = geometry.onTarget && (moved > 0) === testCase.expectsToMove;
    if (!ok) failures += 1;

    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${testCase.name}`
      + `（预期：${testCase.expectsToMove ? '能滑' : '被吃掉'}）`);
    console.log(`       内层计算样式 overflow=${geometry.overflowX}/${geometry.overflowY} `
      + `touch-action=${geometry.touchAction} overscroll=${geometry.overscrollX}/${geometry.overscrollY}`);
    console.log(`       脚本可滚到 ${control}（对照）；手势位移 touch=${results.touch}px mouse=${results.mouse}px`);
    console.log(`       手势起点 (${geometry.x},${geometry.y}) 落在内层上=${geometry.onTarget}`);
    console.log('');
  }

  console.log(failures === 0
    ? '机制复现符合预期：简写会卡住，X 长写不会。'
    : `有 ${failures} 项与预期不符。`);

  // ---- phase 2: our own stylesheet, not a hand-written stand-in -------------
  //
  // The cases above prove the mechanism. This one asks whether the stylesheet we
  // actually ship still contains it, using the selector form the layer uses
  // (semantic suffix substring) and the official declaration
  // (`overflow-x: auto` from `_tableScroll_`).

  console.log('');
  console.log('我们的样式表（lib/mobile.js 的真实输出）：');
  await page.evaluate(() => {
    document.body.innerHTML = `
      <div id="pane" class="_paneBody_test_1" style="width:390px;height:400px;overflow-y:auto;background:#eee">
        <div style="height:400px">上面</div>
        <div class="_tableScroll_test_1" style="max-width:100%;overflow-x:auto;background:#cde">
          <table style="width:1200px"><tr><td>很宽的表格</td></tr></table>
        </div>
        <div style="height:400px">下面</div>
      </div>`;
  });
  await page.addStyleTag({ content: mobileStylesheet() });

  const shipped = await page.evaluate(() => {
    const pane = document.getElementById('pane');
    pane.scrollTop = 400;
    const table = document.querySelector('._tableScroll_test_1');
    const style = getComputedStyle(table);
    const rect = table.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    return {
      overscroll: `${style.overscrollBehaviorX}/${style.overscrollBehaviorY}`,
      overflow: `${style.overflowX}/${style.overflowY}`,
      x: Math.round(paneRect.left + paneRect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      paneScroller: getComputedStyle(pane).overscrollBehaviorY,
      // Evidence that the stylesheet is actually in play: a green result from a
      // rule that never matched is worse than a red one.
      mediaMatches: matchMedia('(max-width: 900px)').matches,
      coarse: matchMedia('(pointer: coarse)').matches,
      styleTags: document.querySelectorAll('style').length,
      sheetRules: [...document.styleSheets].reduce((total, sheet) => {
        try {
          return total + sheet.cssRules.length;
        } catch {
          return total;
        }
      }, 0),
      tableRuleFound: [...document.styleSheets].some(sheet => {
        try {
          return [...sheet.cssRules].some(rule => String(rule.cssText).includes('_tableScroll_'));
        } catch {
          return false;
        }
      }),
      htmlAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust
        || getComputedStyle(document.documentElement).textSizeAdjust,
    };
  });

  console.log('  （诊断：' + JSON.stringify({
    mediaMatches: shipped.mediaMatches,
    coarse: shipped.coarse,
    styleTags: shipped.styleTags,
    sheetRules: shipped.sheetRules,
    tableRuleFound: shipped.tableRuleFound,
    htmlAdjust: shipped.htmlAdjust,
  }) + '）');

  await page.evaluate(() => { document.getElementById('pane').scrollTop = 400; });
  await cdp.send('Input.synthesizeScrollGesture', {
    x: shipped.x,
    y: shipped.y,
    xDistance: 0,
    yDistance: -240,
    gestureSourceType: 'mouse',
    speed: 800,
    preventFling: true,
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  const shippedMoved = await page.evaluate(() => document.getElementById('pane').scrollTop - 400);

  const shippedOk = shippedMoved > 0;
  if (!shippedOk) failures += 1;
  console.log(`  ${shippedOk ? 'ok  ' : 'FAIL'} 手指落在宽表格上时，对话仍然能上下滚`);
  console.log(`       表格计算样式 overflow=${shipped.overflow} overscroll=${shipped.overscroll}；`
    + `对话列 overscroll-y=${shipped.paneScroller}`);
  console.log(`       滑动位移 ${shippedMoved}px（${shippedOk ? '通' : '被表格吃掉'}）`);
  console.log('');
  console.log('  说明：headless Chromium 在这个环境里不投递合成 touch 手势（三种用例都是 0px），');
  console.log('        所以上面用滚轮走同一条 scroll chaining 路径。overscroll-behavior 与输入设备无关。');
} finally {
  await browser.close().catch(() => {});
}

process.exitCode = failures === 0 ? 0 : 1;
