#!/usr/bin/env node
/**
 * What is in the phone's composer, and what does the `+` open?
 *
 *   node scripts/audit-composer.mjs [--url http://127.0.0.1:3199] [--width 390] [--tap-plus]
 *
 * Two questions, asked of the **served** page (nothing injected — this is what the phone
 * actually runs):
 *
 * 1. Every control in the composer, with its label and size, so "the upload button is gone"
 *    can be checked against what is really there instead of against a memory of the desktop.
 * 2. What the `+` opens — the panel, its entries, and whether it can be closed — because the
 *    request is for that button to become a toggle once the panel is out.
 *
 * @module dsh-remote-pulse/scripts/audit-composer
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
const width = Number(flag('--width', '390'));

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
  body: JSON.stringify({ code: opened.code, label: 'audit-composer' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

/** Everything a control can be called, without a client-specific class name. */
const describe = `node => {
  const rect = node.getBoundingClientRect();
  return {
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute('type') || '',
    aria: (node.getAttribute('aria-label') || '').slice(0, 40),
    title: (node.getAttribute('title') || '').slice(0, 40),
    text: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
    cls: String(node.className || '').slice(0, 46),
    html: node.innerHTML.replace(/\\s+/g, ' ').trim().slice(0, 90),
    box: [Math.round(rect.width), Math.round(rect.height), Math.round(rect.left), Math.round(rect.top)],
    visible: rect.width > 0 && rect.height > 0,
  };
}`;

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
  await new Promise(r => setTimeout(r, 4000));

  // `--inject` puts the build on disk into the page, which is the only way to test a change to
  // the shell before it has been served by a restarted harness. Without it, this measures the
  // phone's own copy — which is what the other report is for.
  if (args.includes('--inject')) {
    await page.addStyleTag({ content: mobileStylesheet() });
    await page.addStyleTag({ content: mobileShellStyles() });
    await page.evaluate(source => { window.__PULSE_SHELL__ = false; window.eval(source); }, mobileShellScript());
    await new Promise(r => setTimeout(r, 1500));
  }

  const composer = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button,[role="button"],input[type="file"],a[href="#"]')];
    const inComposer = nodes.filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.bottom > window.innerHeight * 0.6;
    });
    return {
      fileInputs: [...document.querySelectorAll('input[type="file"]')].map(node => ({
        accept: node.getAttribute('accept') || '',
        hidden: node.offsetParent === null,
        cls: String(node.className || '').slice(0, 40),
      })),
      controls: inComposer.map(node => {
        const rect = node.getBoundingClientRect();
        return {
          aria: (node.getAttribute('aria-label') || '').slice(0, 40),
          title: (node.getAttribute('title') || '').slice(0, 40),
          text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
          cls: String(node.className || '').slice(0, 46),
          box: [Math.round(rect.width), Math.round(rect.height), Math.round(rect.left), Math.round(rect.top)],
        };
      }),
    };
  });
  console.log(`底部区域的文件输入框（App 的文件选择器就是它们触发的）：`);
  for (const input of composer.fileInputs) console.log(`  accept="${input.accept}" 隐藏=${input.hidden} class=${input.cls}`);
  console.log(`\n底部区域的控件（${composer.controls.length} 个）：`);
  for (const control of composer.controls) {
    console.log(`  ${control.box[0]}x${control.box[1]}@${control.box[2]},${control.box[3]}`
      + ` aria="${control.aria}" title="${control.title}" text="${control.text}" class=${control.cls}`);
  }

  // The `+` is the official composer's attach control: its accessible name is
  // "添加文件或调用指令" on this build, and the shell already tags it `pulse-attach-target`.
  const plus = await page.evaluate(describe => {
    const read = eval(describe);
    const nodes = [...document.querySelectorAll('button,[role="button"]')]
      .filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.bottom > window.innerHeight * 0.6;
      });
    const named = nodes.find(node => /添加文件|上传文件|选择文件|调用指令|attach/i.test(
      (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '')));
    return { named: named ? read(named) : null, tagged: document.querySelectorAll('.pulse-attach-target').length };
  }, describe);
  console.log(`\n加号（添加文件/调用指令）：${JSON.stringify(plus.named)}，外壳标记数=${plus.tagged}`);

  if (args.includes('--tap-plus')) {
    // The preview-version notice is a modal and swallows clicks behind it.
    await page.evaluate(() => {
      const go = [...document.querySelectorAll('button')].find(node => (node.textContent || '').trim() === '继续');
      if (go) go.click();
    });
    await new Promise(r => setTimeout(r, 700));

    /** The real control, its centre, and what the client says about its own state. */
    const attachState = () => page.evaluate(() => {
      const node = [...document.querySelectorAll('button,[role="button"]')]
        .find(candidate => /添加文件|上传文件|选择文件|调用指令|attach/i.test(
          (candidate.getAttribute('aria-label') || '') + ' ' + (candidate.getAttribute('title') || '')));
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const popovers = [...document.querySelectorAll('[role="listbox"],[role="menu"],[class*="_popover"],[class*="_popup"],[class*="_menu_"]')]
        .filter(candidate => candidate.getBoundingClientRect().width > 0)
        .map(candidate => ({
          role: candidate.getAttribute('role') || '',
          cls: String(candidate.className || '').slice(0, 44),
          text: (candidate.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          entries: [...candidate.querySelectorAll('button,[role="option"],[role="menuitem"],li')].slice(0, 10)
            .map(entry => ((entry.textContent || '').replace(/\s+/g, ' ').trim()
              || entry.getAttribute('aria-label') || '').slice(0, 28)),
        }));
      return {
        ariaExpanded: node.getAttribute('aria-expanded'),
        haspopup: node.getAttribute('aria-haspopup') || '',
        centre: [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)],
        popovers,
      };
    });

    // A trusted click, not element.click(): the client may listen for a pointer event, and an
    // untrusted click would make "it does not open" and "it does not close" look the same.
    const tapOnce = async () => {
      const before = await attachState();
      if (!before) return null;
      await page.mouse.click(before.centre[0], before.centre[1]);
      await new Promise(r => setTimeout(r, 1100));
      return attachState();
    };

    const first = await tapOnce();
    console.log(`\n第一次点：aria-expanded ${JSON.stringify(first?.ariaExpanded)}`
      + `（点击前是按 aria-haspopup="${first?.haspopup}" 找的）`);
    for (const popover of first?.popovers ?? []) {
      console.log(`  弹层 role=${popover.role} class=${popover.cls}`);
      console.log(`    文字：${popover.text}`);
      console.log(`    条目：${popover.entries.join(' | ')}`);
    }
    if (!(first?.popovers ?? []).length) console.log('  没看到弹层（aria-expanded 才是准的）');

    // ---- the four things the phone report is about -----------------------------
    const anatomy = await page.evaluate(() => {
      const active = document.activeElement;
      const composer = document.querySelector('textarea')
        ?? document.querySelector('[contenteditable="true"]');
      const attach = [...document.querySelectorAll('button,[role="button"]')]
        .find(node => /添加文件|上传文件|选择文件|调用指令/i.test(node.getAttribute('aria-label') || ''));
      const panel = [...document.querySelectorAll('[role="listbox"]')]
        .find(node => node.getBoundingClientRect().width > 0);
      const box = panel ? panel.getBoundingClientRect() : null;
      const attachBox = attach ? attach.getBoundingClientRect() : null;
      const rows = panel ? [...panel.querySelectorAll('button,[role="option"],[role="menuitem"],li')] : [];
      return {
        // Does the tap pull focus into the composer (which is what opens the keyboard)?
        activeTag: active ? active.tagName.toLowerCase() : '',
        activeIsComposer: Boolean(composer && active === composer),
        composerFocused: Boolean(composer && document.activeElement === composer),
        // Does the panel reach down over the composer and the attach button?
        panelBox: box ? [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] : null,
        composerTop: composer ? Math.round(composer.getBoundingClientRect().top) : null,
        attachBox: attachBox ? [Math.round(attachBox.left), Math.round(attachBox.top)] : null,
        coversComposer: Boolean(box && composer && box.bottom > composer.getBoundingClientRect().top),
        coversAttach: Boolean(box && attachBox && box.bottom > attachBox.top && box.left <= attachBox.left),
        entries: rows.length,
        // Everything the panel holds versus what it has painted: the phone showed only the
        // first section until it was scrolled.
        sectionTitles: panel ? [...panel.querySelectorAll('[class*="sectionTitle"]')]
          .map(node => (node.textContent || '').trim()) : [],
        scrollHeight: panel ? panel.scrollHeight : null,
        clientHeight: panel ? panel.clientHeight : null,
        innerScrollHeight: panel && panel.firstElementChild ? panel.firstElementChild.scrollHeight : null,
      };
    });
    console.log(`\n焦点：点在 ${anatomy.activeTag}，输入框拿到焦点=${anatomy.activeIsComposer}`);
    console.log(`面板：${JSON.stringify(anatomy.panelBox)}，输入框顶 ${anatomy.composerTop}，`
      + `压住输入框=${anatomy.coversComposer}，盖住加号=${anatomy.coversAttach}`);
    console.log(`面板内容：条目 ${anatomy.entries} 个，段落 ${JSON.stringify(anatomy.sectionTitles)}，`
      + `可滚高度 ${anatomy.scrollHeight}/${anatomy.clientHeight}（内层 ${anatomy.innerScrollHeight}）`);

    // How does it close today? The escape hatch matters: a toggle needs a way to put it away.
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 800));
    const afterEscape = await page.evaluate(() => document.querySelectorAll('[role="listbox"]').length);
    console.log(`按 Esc 之后还有 ${afterEscape} 个 listbox${afterEscape === 0 ? '（Esc 能关）' : '（Esc 关不掉）'}`);

    if (afterEscape > 0) {
      await page.mouse.click(200, Math.round(width / 2));
      await new Promise(r => setTimeout(r, 800));
      const afterOutside = await page.evaluate(() => document.querySelectorAll('[role="listbox"]').length);
      console.log(`点面板外面之后还有 ${afterOutside} 个 listbox${afterOutside === 0 ? '（点外面能关）' : '（点外面也关不掉）'}`);
    }

    // Does the "文件" entry actually reach a file input? That is the upload path the phone
    // says is missing; the App's own chooser is wired to `input[type=file]`.
    if (!args.includes('--inject')) {
      await page.evaluate(() => {
      window.__pulseFileClicks = 0;
      const count = () => { window.__pulseFileClicks += 1; };
      for (const input of document.querySelectorAll('input[type="file"]')) input.addEventListener('click', count);
      new MutationObserver(() => {
        for (const input of document.querySelectorAll('input[type="file"]')) {
          if (input.__pulseCounted) continue;
          input.__pulseCounted = true;
          input.addEventListener('click', count);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const reopened = await tapOnce();
    if ((reopened?.popovers ?? []).length > 0) {
      const tapped = await page.evaluate(() => {
        const panel = [...document.querySelectorAll('[role="listbox"]')]
          .find(node => node.getBoundingClientRect().width > 0);
        if (!panel) return '(no panel)';
        const entry = [...panel.querySelectorAll('button,[role="option"],[role="menuitem"],li')]
          .find(node => /文件|file/i.test(node.textContent || ''));
        if (!entry) return '(no file entry)';
        entry.click();
        return (entry.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      });
      await new Promise(r => setTimeout(r, 900));
      const clicks = await page.evaluate(() => window.__pulseFileClicks);
      console.log(`\n点「${tapped}」之后，文件输入框被点了 ${clicks} 次`
        + `${clicks > 0 ? '（上传这条路是通的）' : '（没触发文件选择器 —— 手机上说"上传按钮没了"可能就是这个）'}`);
    }
    }

    // With the build on disk injected, the three fixes can be checked end to end: the tap must
    // not leave the composer focused (keyboard), the button must be marked so the stylesheet can
    // draw a close mark instead of a +, and the second tap must put the panel away.
    if (args.includes('--inject')) {
      const shell = () => page.evaluate(() => {
        const debug = window.__PULSE_SHELL_DEBUG__;
        const control = debug.attachControl();
        const panel = debug.attachPanel();
        const composer = document.querySelector('textarea, [contenteditable="true"]');
        const root = document.documentElement;
        return {
          open: Boolean(panel),
          state: debug.state.attachOpen,
          rootClass: root.classList.contains('pulse-attach-open'),
          buttonClass: Boolean(control && control.classList.contains('pulse-attach-open-button')),
          ariaExpanded: control ? control.getAttribute('aria-expanded') : null,
          composerFocused: Boolean(composer && document.activeElement === composer),
          room: root.style.getPropertyValue('--pulse-attach-room'),
          panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
          buttonTop: control ? Math.round(control.getBoundingClientRect().top) : 0,
          upload: Boolean(document.querySelector('[data-pulse-upload]')),
          uploadNext: (() => {
            const up = document.querySelector('[data-pulse-upload]');
            return Boolean(up && control && up.previousElementSibling === control);
          })(),
        };
      });

      const attachBox = await page.evaluate(() => {
        const debug = window.__PULSE_SHELL_DEBUG__;
        const control = debug.attachControl();
        debug.syncAttach();
        const box = control.getBoundingClientRect();
        return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
      });
      await page.mouse.click(attachBox[0], attachBox[1]);
      await new Promise(r => setTimeout(r, 1200));
      const opened = await shell();
      console.log(`\n[磁盘版] 点开之后：${JSON.stringify(opened, null, 0)}`);
      const capped = opened.panelHeight === 0 || opened.panelHeight <= opened.buttonTop;
      console.log(`  面板高度 ${opened.panelHeight} 是否不压住按钮（按钮顶 ${opened.buttonTop}）: ${capped}`);
      console.log(`  键盘会不会弹（输入框是否仍持有焦点，必须是 false）: ${opened.composerFocused}`);
      console.log(`  加号是不是画成 ×: ${opened.buttonClass && opened.rootClass}`);
      console.log(`  上传按钮在加号旁边: ${opened.upload && opened.uploadNext}`);

      await page.mouse.click(attachBox[0], attachBox[1]);
      await new Promise(r => setTimeout(r, 1200));
      const closed = await shell();
      console.log(`\n[磁盘版] 再点一次之后：展开=${closed.open}，根标记=${closed.rootClass}`
        + ` ${closed.open ? '（没收起来 ✗）' : '（收起来了 ✓）'}`);

      // The keyboard question again, asked at the moment it matters: during the press, before any
      // panel has rendered. If the composer is holding the focus 60ms into a press, the keyboard
      // has already been summoned — which is what "召唤键盘又取消" looked like on the phone.
      const press = async (label, pick, keepFocus = false) => {
        // The keyboard's state is set deliberately before each press: carrying a focused composer
        // in from the previous step would test the "open stays open" rule while claiming to test
        // the other one - which is exactly what the first version of this did, reporting
        // "refused 0 times" for a case that never reached the refusal.
        await page.evaluate(keep => {
          const composer = document.querySelector('textarea, [contenteditable="true"]');
          if (!composer) return;
          if (keep) composer.focus(); else composer.blur();
        }, keepFocus);
        await new Promise(r => setTimeout(r, 250));
        const box = await page.evaluate(which => {
          const node = which === 'add'
            ? document.querySelector('[aria-label*="添加文件"]')
            : which === 'model'
              ? document.querySelector('[aria-label*="选择模型"]')
              : document.querySelector('textarea, [contenteditable="true"]');
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)];
        }, pick);
        if (!box) {
          console.log(`  ${label}: 找不到这个按钮`);
          return;
        }
        await page.mouse.move(box[0], box[1]);
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 60));
        const during = await page.evaluate(() => {
          const composer = document.querySelector('textarea, [contenteditable="true"]');
          const debug = window.__PULSE_SHELL_DEBUG__;
          return {
            focused: Boolean(composer && document.activeElement === composer),
            refused: debug.state.keyboardRefused,
            armed: debug.state.rowPointerAt > 0,
            panelOpen: Boolean(debug.state.attachOpen),
            wasFocused: debug.state.composerWasFocused,
          };
        });
        await page.mouse.up();
        await new Promise(r => setTimeout(r, 600));
        console.log(`  ${label}: 按下 60ms 后输入框持有焦点=${during.focused}（必须 false），`
          + `已拦下 ${during.refused} 次，面板开着=${during.panelOpen}，按下前的键盘状态=${during.wasFocused}`);
        // Close whatever the press opened. A *trusted* click on a neutral spot, because a synthetic
        // one is not acted on: the client's outside-click handling ignored it, so the panel stayed
        // open into the next measurement and the input press was refused by the shell's
        // panel-is-open rule — which is correct behaviour measured in the wrong situation.
        await page.mouse.click(200, 300);
        await new Promise(r => setTimeout(r, 500));
      };
      console.log('\n[磁盘版] 按下时键盘有没有机会出现：');
      await press('加号', 'add');
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 400));
      await press('模型 chip', 'model');
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 400));
      await press('输入框本身（这里应该弹键盘）', 'composer');

      // The other direction, and the layout case that started all of this: with the keyboard open
      // the room above the row is small, so the panel has to become a scroll window of its own
      // rather than reaching down over the input. A short viewport is what a keyboard looks like
      // to the page, so the viewport is shortened for this measurement.
      await page.setViewport({ width, height: 430, deviceScaleFactor: 2 });
      await new Promise(r => setTimeout(r, 600));
      // The panel is put away first: leaving it open would make the click below a toggle-close,
      // which is a different question from the one being asked here.
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 500));
      await page.evaluate(() => {
        const composer = document.querySelector('textarea, [contenteditable="true"]');
        if (composer) composer.focus();
      });
      const box = await page.evaluate(() => {
        const control = window.__PULSE_SHELL_DEBUG__.attachControl();
        if (!control) return null;
        const rect = control.getBoundingClientRect();
        return [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)];
      });
      // Focus the composer, then press the button under it: that is the phone's situation with the
      // keyboard up. A press at (0,0) used to sit here from an earlier version and quietly stole
      // the focus before the press, which made this measure the wrong thing.
      await page.evaluate(() => {
        const composer = document.querySelector('textarea, [contenteditable="true"]');
        if (composer) composer.focus();
      });
      const focusedBefore = await page.evaluate(() => {
        const composer = document.querySelector('textarea, [contenteditable="true"]');
        return Boolean(composer && document.activeElement === composer);
      });
      await page.mouse.click(box[0], box[1]);
      await new Promise(r => setTimeout(r, 1200));
      const withKeyboard = await page.evaluate(() => {
        const debug = window.__PULSE_SHELL_DEBUG__;
        const composer = document.querySelector('textarea, [contenteditable="true"]');
        const panel = debug.attachPanel();
        const control = debug.attachControl();
        const panelBox = panel ? panel.getBoundingClientRect() : null;
        return {
          composerStillFocused: Boolean(composer && document.activeElement === composer),
          wasFocused: debug.state.composerWasFocused,
          refused: debug.state.keyboardRefused,
          tightened: debug.state.attachTightened,
          panel: panelBox ? [Math.round(panelBox.top), Math.round(panelBox.bottom)] : null,
          rowTop: control ? Math.round(control.getBoundingClientRect().top) : 0,
          scrollable: panel ? panel.scrollHeight > panel.clientHeight : false,
          room: document.documentElement.style.getPropertyValue('--pulse-attach-room'),
          scrolled: debug.state.transcriptScrolled,
        };
      });
      console.log(`\n[磁盘版] 键盘开着（视口压到 430px 模拟）时点加号：`);
      console.log(`  按下前键盘是开的=${focusedBefore}，点完输入框仍持有焦点=`
        + `${withKeyboard.composerStillFocused}（加号会主动收起键盘，所以这里必须是 false）`);
      console.log(`  面板 ${JSON.stringify(withKeyboard.panel)} vs 输入框顶 ${withKeyboard.rowTop}`
        + ` → 停在对话框之上=${Boolean(withKeyboard.panel && withKeyboard.panel[1] <= withKeyboard.rowTop)}`
        + `，面板内部可滚动=${withKeyboard.scrollable}，上限=${withKeyboard.room}`
        + `，已跳到对话底部 ${withKeyboard.scrolled} 次`);

      // The decisive question for "the panel buried the +", asked of the page itself: what is under
      // that point right now? A geometric comparison can be satisfied by a panel that is merely
      // close to the row; this is the one that says the button can actually be pressed to close it.
      const reachable = await page.evaluate(() => {
        const debug = window.__PULSE_SHELL_DEBUG__;
        const control = debug.attachControl();
        if (!control) return { hitIsButton: false, hitTag: '(no attach control)', hitClass: '' };
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          hitIsButton: Boolean(hit && (hit === control || control.contains(hit))),
          hitTag: hit ? hit.tagName.toLowerCase() : '(none)',
          hitClass: hit ? String(hit.className || '').slice(0, 28) : '',
          panelOpen: debug.state.attachOpen,
        };
      });
      console.log(`  加号那一点现在是 ${reachable.hitTag}.${reachable.hitClass}`
        + ` → 点得到加号=${reachable.hitIsButton}（必须 true，否则收不起来）`);
      await page.setViewport({ width, height: 844, deviceScaleFactor: 2 });

      // The shell's own text, read off the page: a mangled byte order or a lost byte shows up
      // here as mojibake, and nowhere else would notice.
      const diag = await page.evaluate(() => {
        const toggle = document.querySelector('[aria-label="移动外壳自检"], [aria-label="关闭自检"]');
        if (!toggle) return '(no diag toggle)';
        toggle.click();
        const panel = document.querySelector('.pulse-diag');
        const text = panel ? (panel.textContent || '').replace(/\s+/g, ' ').trim() : '(no panel)';
        return text.slice(0, 260);
      });
      const mojibake = /[\u9225\u95b3\u6d52\u6de1\u6d63\u6d17]/.test(diag);
      console.log(`\n[磁盘版] 自检面板文字（前 260 字）：${diag}`);
      console.log(`  含乱码字符: ${mojibake}（必须 false）`);
    }
  }
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
