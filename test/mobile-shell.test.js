/**
 * The mobile shell, exercised against a DOM shaped like the real client's.
 *
 * The structure below is not invented: it is what the official client rendered in
 * a real browser at a phone viewport, reduced to the parts the shell addresses —
 * a `_frame` holding a `_sidebarCol` (marked `_collapsed` while it is a rail) and
 * a `_centerCol`, an official toggle labelled "打开侧边栏", and a composer whose "+"
 * carries the accessible name "上传文件".
 *
 * The fake toggle flips the collapsed marker the way the real one does, so these
 * tests assert the behaviour that matters: the shell presses the *official*
 * control and only mirrors the resulting state, rather than reimplementing any of
 * it. `scripts/verify-mobile-shell.mjs` runs the same checks against the real
 * client in a real browser.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import vm from 'node:vm';

import { JSDOM } from 'jsdom';

import {
  DELIVERABLE_PATH_ATTRIBUTE,
  DRAWER_ATTRIBUTE,
  RIGHTBAR_EMPTY_ATTRIBUTE,
  SIDEBAR_TOGGLE_LABELS,
  deliverableActionsScript,
  fileLinkActionsScript,
  isEmbeddableScript,
  mobileShellScript,
  mobileShellStyles,
  previewActionsScript,
} from '../lib/mobile-shell.js';
import { mobileStylesheet } from '../lib/mobile.js';

/**
 * Every page built by these tests.
 *
 * A jsdom window with `pretendToBeVisual` runs a requestAnimationFrame loop, and
 * the shell's MutationObserver keeps a reference to it, so an unclosed window
 * keeps the whole process alive after the last assertion — which looks exactly
 * like a hung test run and hides the failures that already happened.
 * @type {Set<object>}
 */
const openPages = new Set();

/**
 * Copy a plain object out of the jsdom realm.
 *
 * A value handed back across that boundary keeps the other realm's prototype, and
 * `deepStrictEqual` compares prototypes — so an otherwise identical `{x, y}` fails with
 * "actual: [Object]". Spreading it into this realm is the whole fix.
 *
 * @param {object} value - an object returned by a page.
 * @returns {object} the same fields, in this realm.
 */
const plain = value => ({ ...value });

after(() => {
  for (const dom of openPages) {
    try {
      dom.window.close();
    } catch {
      /* already gone */
    }
  }
  openPages.clear();
});

/**
 * Build a page with the real client's structure.
 *
 * @param {object} [options] - tuning.
 * @param {boolean} [options.sidebar] - include the sidebar column.
 * @param {boolean} [options.toggle] - include the official toggle button.
 * @param {boolean} [options.attach] - include the labelled attach control.
 * @param {boolean|string} [options.rightbar] - `'empty'`, `'content'` or `false`.
 * @param {boolean} [options.lateFrame] - mount the frame and conversation column
 *   only after the shell has booted, which is what the real client does.
 * @param {boolean} [options.tabs] - include the header's tab strip (对话 / 轨迹).
 * @param {boolean} [options.lineage] - include the subagent count chip's slot in the crumbs.
 * @param {string} [options.userAgent] - the UA to present, for the app-version line.
 * @param {number} [options.width] - viewport width.
 * @param {boolean} [options.force] - append the `?pulse=mobile` escape hatch.
 * @returns {Promise<object>} the page handle.
 */
async function mountShell(options = {}) {
  const {
    sidebar = true, toggle = true, attach = true, rightbar = 'empty',
    lateFrame = false, tabs = true, lineage = false, userAgent = '', width = 390, force = true,
  } = options;
  const url = force ? 'https://example.test/?pulse=mobile' : 'https://example.test/';

  const rightbarMarkup = rightbar === false
    ? ''
    : '<div class="pI_x6G_rightbarCol">'
      + (rightbar === 'content' ? '<button aria-label="预览文件">preview</button>' : '<div></div>')
      + '</div>';

  // The session header, with the two rows that matter here: the title row holding the
  // action chips (the mode chip, and the background-jobs chip while anything runs) and
  // the tab strip under it. Both classes are the real suffixes; the hashes in front of
  // them change every build, which is why nothing here matches on a whole class name.
  const headerMarkup = '<header class="wSkVaW_header">'
    + '<div class="wSkVaW_titleRow">'
    + '<div class="wSkVaW_titleCluster">'
    + '<div class="wSkVaW_crumbs">'
    + '<div class="wSkVaW_crumbSeg"><button type="button" class="wSkVaW_crumb">我的世界大逃亡游戏制作</button>'
    // The subagent count chip: a slot wrapper that generates no box of its own
    // (display:contents) around the plugin's own root. Copied from the real page, including
    // the separator that is part of the chip's box.
    + (lineage
      ? '<div data-slot="conversation.session.header.lineage" style="display: contents;">'
        + '<div class="ZKlsPq_root "><span class="ZKlsPq_separator">/</span>'
        + '<button type="button" class="ZKlsPq_trigger" aria-label="4 个子代理">4 个子代理</button>'
        + '</div></div>'
      : '')
    + '</div></div>'
    + '<div class="wSkVaW_headerActions">'
    + '<button type="button" class="SVAs4q_seat" aria-haspopup="menu">标准模式</button>'
    + '</div></div>'
    + '<div class="wSkVaW_headerUtilities"><button type="button">⋯</button></div>'
    + '<div class="wSkVaW_headerCorner"></div>'
    + '</div>'
    + (tabs
      ? '<div class="wSkVaW_tabs" role="tablist">'
        + '<button type="button" role="tab" aria-selected="true">对话</button>'
        + '<button type="button" role="tab" aria-selected="false">轨迹</button>'
        + '</div>'
      : '')
    + '</header>';

  const centerMarkup = lateFrame
    ? ''
    : '<div class="pI_x6G_centerCol">' + headerMarkup + '<div class="wSkVaW_root">'
      + (attach ? '<button aria-label="上传文件" id="official-attach">+</button>' : '')
      + '<textarea></textarea></div></div>';

  // The frame is a grid with an inline template, because that inline template is
  // the whole reason the shell has to rewrite it: a grid item that leaves the
  // flow takes its track's width with it and every remaining column shifts left.
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root"><div class="${lateFrame ? 'pI_x6G_notYet' : 'pI_x6G_frame'}" style="grid-template-columns: 56px minmax(0px, 1fr) 0px;">${
      sidebar
        ? '<div class="pI_x6G_sidebarCol"><div class="hHd-Xa_root hHd-Xa_collapsed" id="rail">' +
          (toggle ? `<button aria-label="${SIDEBAR_TOGGLE_LABELS.open}" id="official-toggle">rail</button>` : '') +
          '<div class="bhn1Oq_listArea">会话列表</div></div></div>'
        : ''
    }${centerMarkup}${rightbarMarkup}</div></div></body></html>`,
    { url, runScripts: 'outside-only', pretendToBeVisual: true },
  );

  const { window } = dom;
  openPages.add(dom);
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  if (userAgent) {
    // jsdom's own `userAgent` option is ignored in 30.x — it was passed and the
    // window still reported the jsdom default — so the property is replaced
    // directly, the same way the viewport width is.
    Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  }

  // Emulate the official toggle: it flips the collapsed marker and swaps its own
  // accessible name, exactly as the real client does.
  let toggleClicks = 0;
  const officialToggle = window.document.getElementById('official-toggle');
  if (officialToggle) {
    officialToggle.addEventListener('click', () => {
      toggleClicks += 1;
      const rail = window.document.getElementById('rail');
      const collapsed = rail.classList.toggle('hHd-Xa_collapsed');
      officialToggle.setAttribute('aria-label',
        collapsed ? SIDEBAR_TOGGLE_LABELS.open : SIDEBAR_TOGGLE_LABELS.close);
    });
  }

  window.eval(mobileShellScript());
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  }
  await new Promise(resolve => setTimeout(resolve, 60));

  return {
    window,
    document: window.document,
    html: window.document.documentElement,
    toggleClicks: () => toggleClicks,
    click: selector => {
      const node = window.document.querySelector(selector);
      if (node) node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return Boolean(node);
    },
  };
}

test('the generated shell script compiles', () => {
  const source = mobileShellScript();
  assert.ok(typeof source === 'string', `must return a string, got ${typeof source}`);
  assert.ok(source.length > 1000, `suspiciously short: ${source.length}`);
  assert.equal(new vm.Script(source, { filename: 'shell.js' }) instanceof vm.Script, true);
  assert.equal(isEmbeddableScript(source), true);
  assert.equal(isEmbeddableScript('a = 1; </script><img>'), false);
  assert.equal(isEmbeddableScript(''), false);

  // A backtick inside one of these generated strings ends its template literal early,
  // and the failure is a module-level parse error — it has cost a debugging round trip
  // several times, always from a comment. The module cannot even load in that case, so
  // what is checked here is the other route to the same breakage: a backtick reaching
  // the *output* through a nested constant or label, where the page would silently drop
  // the rule or throw inside the injected script.
  for (const [name, generated] of Object.entries({
    'shell stylesheet': mobileShellStyles(),
    'narrow-screen stylesheet': mobileStylesheet(),
    'mobile shell script': mobileShellScript(),
    'preview action': previewActionsScript(),
    'file link action': fileLinkActionsScript(),
    'deliverable action': deliverableActionsScript(),
  })) {
    assert.equal(generated.includes('`'), false, `${name} must not ship a backtick`);
  }

  // An injected script is compiled here because a template literal eats escapes: a
  // regex written with a single backslash ships as a syntax error in the served page
  // and nothing else would notice. The preview header's action is the one that has to
  // work on the desktop as well as the phone, so it is the one checked.
  const entry = previewActionsScript();
  assert.ok(entry.length > 500, `suspiciously short: ${entry.length}`);
  assert.equal(new vm.Script(entry, { filename: 'preview-actions.js' }) instanceof vm.Script, true);
  assert.equal(isEmbeddableScript(entry), true);
  assert.match(entry, /PulseApp\\\//, 'the app marker regex must survive the template literal');
  assert.equal(/\binnerWidth\s*<=/.test(entry), false, 'it must not be width-gated');
});

test('the stylesheet is scoped and floats the sidebar', () => {
  const css = mobileShellStyles();
  assert.ok(css.includes('@media (max-width:'));
  assert.ok(css.includes('pulse-burger'));
  assert.ok(css.includes(DRAWER_ATTRIBUTE));
  // The one official thing it styles is addressed by the attribute this module
  // sets, never by a generated class name.
  assert.equal(/\.pI_|\.hHd|\.bhn1Oq/.test(css), false, 'must not name a generated class');
  assert.equal(css.includes('</style'), false);
});

test('a photograph wider than the phone is capped at the screen width', () => {
  const css = mobileShellStyles();
  // The official viewer shows an image at its natural size, so a screenshot
  // arrived as a wall of pixels; the app also had pinch-zoom switched off, which is
  // fixed on the App side. Only a ceiling is imposed here — a max-width cannot make
  // an image bigger, so this cannot fight a view that sizes one deliberately.
  assert.match(css, /(^|\s)img\s*\{[^}]*max-width:\s*100%\s*!important/, 'images must fit the phone width');
});

test('the stylesheet rewrites the frame grid instead of only floating the sidebar', () => {
  const css = mobileShellStyles();
  // Floating the sidebar alone is a trap that was measured in a real browser: a
  // grid item with position: fixed stops occupying its track, so the
  // conversation shifted into the 56px sidebar track and the empty right rail
  // inherited the 1fr — 56px of conversation beside a 334px void.
  assert.match(css, /\[class\*="_frame"\]\s*\{[^}]*grid-template-columns: minmax\(0px, 1fr\) auto 0px\s*!important/,
    'the conversation must be the flexible track after the sidebar leaves the flow');
  assert.ok(css.includes(RIGHTBAR_EMPTY_ATTRIBUTE), 'an empty right rail must be told to take no width');
});

test('the sidebar column is tagged and the drawer starts closed', async () => {
  const page = await mountShell();
  assert.equal(page.html.classList.contains('pulse-has-sidebar'), true);
  assert.equal(page.document.querySelector(`[${DRAWER_ATTRIBUTE}]`) !== null, true);
  assert.equal(page.html.classList.contains('pulse-drawer-open'), false, 'a collapsed rail is not an open drawer');
});

test('an empty right rail is marked so it stops reserving width', async () => {
  const page = await mountShell({ rightbar: 'empty' });
  const rail = page.document.querySelector('.pI_x6G_rightbarCol');
  assert.equal(rail.hasAttribute(RIGHTBAR_EMPTY_ATTRIBUTE), true);
});

test('a right rail with content in it is left alone', async () => {
  const page = await mountShell({ rightbar: 'content' });
  const rail = page.document.querySelector('.pI_x6G_rightbarCol');
  assert.equal(rail.hasAttribute(RIGHTBAR_EMPTY_ATTRIBUTE), false,
    'hiding a rail that holds a preview would hide the user\'s own content');
});

test('the right rail is re-judged when its content appears', async () => {
  const page = await mountShell({ rightbar: 'empty' });
  const rail = page.document.querySelector('.pI_x6G_rightbarCol');
  assert.equal(rail.hasAttribute(RIGHTBAR_EMPTY_ATTRIBUTE), true);

  const button = page.document.createElement('button');
  button.setAttribute('aria-label', '预览文件');
  rail.appendChild(button);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(rail.hasAttribute(RIGHTBAR_EMPTY_ATTRIBUTE), false,
    'a re-render that fills the rail must un-hide it');

  button.remove();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(rail.hasAttribute(RIGHTBAR_EMPTY_ATTRIBUTE), true, 'and it must be re-marked when emptied again');
});

test('the hamburger presses the official toggle rather than moving anything itself', async () => {
  const page = await mountShell();
  assert.equal(page.click('.pulse-burger'), true);
  await new Promise(resolve => setTimeout(resolve, 60));
  // Pressing the official control is the whole point: the client expands its own
  // sidebar, with its own session list inside.
  assert.equal(page.toggleClicks(), 1);
  assert.equal(page.html.classList.contains('pulse-drawer-open'), true, 'the mirrored state follows the official one');
});

test('a second press closes the drawer again', async () => {
  const page = await mountShell();
  page.click('.pulse-burger');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(page.html.classList.contains('pulse-drawer-open'), true);
  page.click('.pulse-burger');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(page.html.classList.contains('pulse-drawer-open'), false);
  assert.equal(page.toggleClicks(), 2);
});

test('the scrim closes an open drawer and does nothing when closed', async () => {
  const page = await mountShell();
  page.click('.pulse-scrim');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(page.toggleClicks(), 0, 'a closed drawer must not be toggled open by the scrim');

  page.click('.pulse-burger');
  await new Promise(resolve => setTimeout(resolve, 60));
  page.click('.pulse-scrim');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(page.toggleClicks(), 2);
  assert.equal(page.html.classList.contains('pulse-drawer-open'), false);
});

test('the shell keeps its own nodes out of the client root, except the hamburger', async () => {
  const page = await mountShell();
  const root = page.document.getElementById('root');
  for (const selector of ['.pulse-chrome', '.pulse-scrim', '.pulse-diag', '.pulse-diag-toggle']) {
    const node = page.document.querySelector(selector);
    assert.ok(node, `${selector} must exist`);
    assert.equal(root.contains(node), false, `${selector} must not be inside #root`);
  }
  // The hamburger is the deliberate exception: on mobile it is an item inside the client's
  // header row, which is what makes it stop being a floating box that has to be hidden by
  // hand whenever the client puts a control in that corner.
  const burger = page.document.querySelector('.pulse-burger');
  assert.ok(burger, 'the hamburger exists');
  assert.equal(burger.getAttribute('data-pulse'), 'burger',
    'and it says it is ours, because "inside the chrome container" no longer describes it');
  assert.equal(burger.parentElement.className.includes('wSkVaW_titleRow'), true,
    'it sits in the header title row');
  assert.equal(burger.hasAttribute('data-pulse-placed'), true, 'and is marked as placed');
});

test('the official attach control is found by accessible name and enlarged', async () => {
  const page = await mountShell();
  const attach = page.document.getElementById('official-attach');
  assert.equal(attach.classList.contains('pulse-attach-target'), true, 'its hit area is enlarged on a phone');
});

test('a title works as well as an aria-label for the attach control', async () => {
  const page = await mountShell();
  const attach = page.document.getElementById('official-attach');
  attach.removeAttribute('aria-label');
  attach.setAttribute('title', '添加文件');
  // Force a re-sync the way a re-render would.
  page.document.body.appendChild(page.document.createElement('div'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(attach.classList.contains('pulse-attach-target'), true);
});

test('a missing sidebar disables the drawer but keeps the diagnostics reachable', async () => {
  const page = await mountShell({ sidebar: false });
  assert.equal(page.html.classList.contains('pulse-has-sidebar'), false);
  assert.equal(page.document.querySelector('.pulse-diag-toggle') !== null, true);
  assert.ok(page.document.querySelector('.pulse-burger'), 'the burger still exists; CSS decides whether it shows');
});

test('a missing official toggle is reported instead of failing silently', async () => {
  const page = await mountShell({ toggle: false });
  page.click('.pulse-burger');
  await new Promise(resolve => setTimeout(resolve, 60));
  const panel = page.document.querySelector('.pulse-diag');
  assert.equal(panel.hidden, false, 'the diagnostics panel must open');
  assert.match(panel.textContent, /找不到/, 'and it must say what was not found');
  assert.equal(page.html.classList.contains('pulse-drawer-open'), false);
});

test('the diagnostics panel has a way out of it', async () => {
  const page = await mountShell();
  const panel = page.document.querySelector('.pulse-diag');
  const toggle = page.document.querySelector('.pulse-diag-toggle');
  assert.equal(panel.hidden, true, 'it starts closed');

  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(panel.hidden, false, 'the toggle opens it');
  assert.equal(toggle.getAttribute('aria-label'), '关闭自检', 'and the same control now says that it closes it');

  // The panel covers the bottom of the screen, so the toggle has to stay above it.
  // That is a z-index relationship, which jsdom cannot test at all — the browser
  // check in scripts/verify-mobile-shell.mjs hit-tests the toggle with the panel
  // open. What is testable here is that an explicit close button exists and works.
  const close = panel.querySelector('.pulse-diag-close');
  assert.ok(close, 'a labelled close button must exist inside the panel');
  close.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(panel.hidden, true, 'the close button closes it');

  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(panel.hidden, false);
  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(panel.hidden, true, 'and the toggle closes it again');

  // Closing through the close button has to put the toggle back to a question
  // mark. It did not: that button cleared the hidden flag on its own, so the
  // toggle kept the × it was given when the panel opened and never changed again.
  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(toggle.textContent, '×', 'open: the toggle offers to close');
  close.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(panel.hidden, true);
  assert.equal(toggle.textContent, '?', 'closed through the close button: the toggle goes back to ?');
  assert.equal(toggle.getAttribute('aria-label'), '移动外壳自检', 'and its label goes back with it');
});

test('the panel says which build of the app is running', async () => {
  // The phone cannot otherwise answer "have I installed the build with the fix?".
  // The app names itself in the user agent for exactly this, and the panel reads
  // it back.
  const fromApp = await mountShell({ userAgent: 'Mozilla/5.0 (Linux; Android 14) PulseApp/1.2' });
  fromApp.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(fromApp.document.querySelector('.pulse-diag').textContent, /App 版本 1\.2/);

  const fromBrowser = await mountShell({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
  fromBrowser.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(fromBrowser.document.querySelector('.pulse-diag').textContent, /旧 APK|浏览器/,
    'a build with no marker has to be called out, not silently reported as fine');
});

test('the panel reports what it sees now, not what it saw at boot', async () => {
  // The real client mounts asynchronously, so the frame and the conversation
  // column can appear well after the shell booted. On a phone the panel reported
  // both as 未找到 for exactly that reason: they were only ever measured in
  // refresh(), which runs at boot and on resize.
  const page = await mountShell({ lateFrame: true });
  const root = page.document.querySelector('#root > div');
  root.className = 'pI_x6G_frame';
  const center = page.document.createElement('div');
  center.className = 'pI_x6G_centerCol';
  root.appendChild(center);
  await new Promise(resolve => setTimeout(resolve, 80));

  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  const text = page.document.querySelector('.pulse-diag').textContent;
  assert.match(text, /应用外框: 已找到/, 'the frame is on the page now, so the panel must say so');
  assert.match(text, /主列: 已找到/, 'and the same for the conversation column');

  // The proof that these came from a fresh probe rather than the cache: the
  // cached boot-time value is *still* false, so a panel reading it could not
  // possibly have printed 已找到. Without this, the two assertions above would
  // also pass on an implementation that happened to cache a true value.
  const cached = page.window.__PULSE_SHELL_DEBUG__.state.frame;
  assert.equal(cached, false, 'the cached value is still the stale one');
});

test('the diagnostics panel says what it is for', async () => {
  const page = await mountShell();
  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  const panel = page.document.querySelector('.pulse-diag');
  // It is not a feature button and it has no counterpart on the desktop, which is
  // exactly what made it confusing: so it has to explain itself.
  assert.match(panel.textContent, /自检/);
  assert.match(panel.textContent, /不是功能按钮/);
  // Re-rendering the text must not take the close button with it.
  assert.ok(panel.querySelector('.pulse-diag-close'), 'the close button survives a re-render');
});

test('the shell stays out of the way on a desktop-width viewport', async () => {
  const page = await mountShell({ width: 1400, force: false });
  assert.equal(page.html.classList.contains('pulse-has-sidebar'), false);
  assert.equal(page.document.querySelector('.pulse-chrome').style.display, 'none');
});

test('a narrow viewport activates the shell without any escape hatch', async () => {
  const page = await mountShell({ width: 390, force: false });
  assert.equal(page.html.classList.contains('pulse-has-sidebar'), true);
  assert.notEqual(page.document.querySelector('.pulse-chrome').style.display, 'none');
});

test('running twice does not build two shells', async () => {
  const page = await mountShell();
  page.window.eval(mobileShellScript());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(page.document.querySelectorAll('.pulse-burger').length, 1);
  assert.equal(page.document.querySelectorAll('.pulse-scrim').length, 1);
});

/**
 * Mount the collapsed `present` tool row and run the deliverables injector on it.
 *
 * The markup is the real thing, read off the live client: `PresentRow` renders a
 * `DisclosureRow` whose collapsed content is
 * `<span class="<hash>_summary"><span>已交付</span><span class="<hash>_paths">…</span></span>`,
 * where the paths are `args.files.map(file => file.path).join(", ")` — workspace
 * relative, with no absolute path anywhere in the DOM.
 *
 * jsdom has no React, so `cwd` arrives the only way it can: as the same
 * `__reactFiber$` property the real renderer leaves on the node, which is what
 * {@link propsAlong} reads.
 *
 * @param {Array<{id: string, printed: string, cwd?: string}>} cases - rows to plant.
 * @param {object} [options] - tuning.
 * @param {string} [options.userAgent] - the UA to present.
 * @returns {Promise<object>} the page handle.
 */
async function mountPresentRows(cases, options = {}) {
  const rows = cases.map(spec => '<div class="luwio_row" data-disclosure-row="true" role="button" '
    + `data-case="${spec.id}"><span class="luwio_leading"></span>`
    + '<span class="luwio_title">交付文件</span>'
    + '<span class="hash_summary"><span>已交付</span>'
    + `<span class="hash_paths">${spec.printed}</span></span></div>`).join('');

  const dom = new JSDOM(`<!doctype html><html><body><div id="flow">${rows}</div></body></html>`,
    { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  openPages.add(dom);
  if (options.userAgent) {
    Object.defineProperty(window.navigator, 'userAgent', { value: options.userAgent, configurable: true });
  }
  for (const spec of cases) {
    const node = window.document.querySelector(`[data-case="${spec.id}"]`);
    node['__reactFiber$test'] = { memoizedProps: spec.cwd ? { cwd: spec.cwd } : {}, return: null };
  }

  // jsdom cannot navigate, and a dispatched click on an `<a href>` would otherwise
  // report "Not implemented: navigation to another Document" into stderr on every
  // run. The activation is cancelled; the event still travels, which is what the
  // propagation assertions need.
  window.document.addEventListener('click', event => {
    if (event.target.closest?.('[data-pulse-deliverable]')) event.preventDefault();
  }, true);

  window.eval(deliverableActionsScript());
  await new Promise(resolve => setTimeout(resolve, 60));

  return {
    window,
    document: window.document,
    /** Every injected control inside one case, with what it says it stands for. */
    controls: id => [...window.document.querySelectorAll(`[data-case="${id}"] [data-pulse-deliverable]`)]
      .map(node => ({
        label: node.textContent,
        href: node.getAttribute('href'),
        source: node.getAttribute(DELIVERABLE_PATH_ATTRIBUTE),
        inRow: node.parentElement === window.document.querySelector(`[data-case="${id}"]`),
      })),
  };
}

test('the collapsed present row carries the control, at every width', async () => {
  const root = 'D:\\code';
  const delivered = 'pulse-android/dist/pulse-remote.apk';
  // The expected URL is built from the path rather than written out: the encoded form
  // (`D%3A%5Cdeepseek%20harness`) is what a copy-pasted literal gets wrong, and a frozen
  // one made this test pass only on the author's checkout.
  const sample = `${root}\\${delivered.replace(/\//g, '\\')}`;
  const page = await mountPresentRows([
    { id: 'one', printed: delivered, cwd: root },
    { id: 'many', printed: `${delivered}, pulse-android/dist/other.zip`, cwd: root },
    { id: 'absolute', printed: sample },
    { id: 'nocwd', printed: delivered },
    { id: 'bare', printed: 'pulse-remote.apk', cwd: root },
  ]);

  const one = page.controls('one');
  assert.equal(one.length, 1, 'the row the user was looking at had no control at all before this');
  assert.equal(one[0].inRow, true, 'it belongs to the row, not to the summary span that owns the ellipsis');
  assert.equal(one[0].source, sample);
  assert.equal(one[0].href, `/api/file?path=${encodeURIComponent(sample)}&download=1`);
  assert.equal(one[0].label, '下载', 'a browser without the app marker downloads');

  // The official join is ", ", so a per-row guard would have hidden every file after
  // the first: the marker has to name the file it belongs to.
  const many = page.controls('many');
  assert.equal(many.length, 2, 'one control per delivered file');
  assert.deepEqual(many.map(control => control.source.split('\\').pop()),
    ['pulse-remote.apk', 'other.zip'], 'in printed order');

  assert.equal(page.controls('absolute').length, 1, 'an absolute path needs no workspace');
  // The two refusals: a relative path with nothing to resolve it against, and a
  // string that is not a path at all. A wrong download link is worse than none.
  assert.equal(page.controls('nocwd').length, 0, 'no cwd means no control');
  assert.equal(page.controls('bare').length, 0, 'a bare file name is not a path');
});

test('the row control does not expand the row it sits in', async () => {
  const page = await mountPresentRows([{ id: 'one', printed: 'a/b.apk', cwd: 'D:\\work' }]);
  const row = page.document.querySelector('[data-case="one"]');
  let expansions = 0;
  // The real row is a DisclosureRow with expandOnRowClick, so anything inside it that
  // lets a click through expands the call under the user's finger.
  row.addEventListener('click', () => { expansions += 1; });
  const control = page.document.querySelector('[data-case="one"] [data-pulse-deliverable]');

  control.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(expansions, 0, 'the control stops its own click');

  // ... and the counter has to be able to move, or the assertion above proves nothing.
  row.querySelector('.luwio_title').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  assert.equal(expansions, 1, 'a click anywhere else still expands the row');
});

/**
 * Give the header's two rows and the chip container the geometry a real browser reports.
 *
 * jsdom has no layout, so every rect there is zero — and the shell reads those rects both
 * to decide where the chips go and to decide whether they fit beside the tabs at all.
 * Left alone, the decision is made from "a 0px strip whose right edge is at x=0", which is
 * not a state a browser can be in, and the shell correctly declines to move anything.
 *
 * The numbers are the real ones, measured on the phone at 390px: the strip is 342px wide
 * at x=20 and 20px tall at y=56, the two tabs are 26px wide and 62px apart, and the chip
 * container is 28px tall.
 *
 * @param {object} page - the page handle from mountShell.
 * @param {object} [options] - tuning.
 * @param {number} [options.width] - the viewport width to report.
 * @param {number} [options.chipWidth] - how wide the chip container is.
 * @param {number} [options.lineageWidth] - how wide the subagent count chip is, when the
 *   fixture has one. Zero by default, which is what jsdom reports for everything.
 * @returns {{actions: Element, tabs: Element, lineage: ?Element}} the stubbed elements.
 */
function stubHeaderGeometry(page, options = {}) {
  const { width = 390, chipWidth = 68, lineageWidth = 0 } = options;
  const actions = page.document.querySelector('.wSkVaW_headerActions');
  const tabs = page.document.querySelector('.wSkVaW_tabs');
  const lineage = page.document.querySelector('[data-slot*="header.lineage"]');
  const rect = (boxWidth, height, left, top) => ({
    width: boxWidth, height, left, top, x: left, y: top,
    right: left + boxWidth, bottom: top + height,
    toJSON() { return this; },
  });
  tabs.getBoundingClientRect = () => rect(width - 48, 20, 20, 56);
  [...tabs.querySelectorAll('button')].forEach((button, index) => {
    button.getBoundingClientRect = () => rect(26, 20, 28 + index * 62, 56);
  });
  actions.getBoundingClientRect = () => rect(chipWidth, 28, width - 48 - 20 - chipWidth, 52);
  if (lineage && lineage.firstElementChild) {
    // The wrapper is display:contents and has no box anywhere, jsdom or browser; the chip's
    // width is on the element inside it, which is what the shell measures.
    lineage.firstElementChild.getBoundingClientRect = () => rect(lineageWidth, 28, 0, 19);
  }
  Object.defineProperty(page.window, 'innerWidth', { value: width, configurable: true, writable: true });
  return { actions, tabs, lineage };
}

test('the present row control follows the app, not the width', async () => {
  const page = await mountPresentRows([{ id: 'one', printed: 'a/b.apk', cwd: 'D:\\work' }], {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/120.0.0.0 Mobile Safari/537.36 PulseApp/1.13',
  });
  const control = page.controls('one')[0];
  assert.equal(control.label, '转发', 'a phone shares instead of downloading');
  assert.match(control.href, /&share=1$/);
  assert.equal(control.href.includes('download=1'), false);
});

test('the header chips are placed on the tab strip, not over the title', async () => {
  // The numbers are the ones measured on the real page at 390px: the tab strip is 342px
  // wide at x=20 (so its right edge is 362), its gap is 36px, and the chips are 28px tall.
  // jsdom has no layout, so the arithmetic is exercised with the real numbers passed in,
  // and the DOM wiring is covered by the tests below it.
  const page = await mountShell();
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  const strip = { left: 20, right: 362, top: 56, height: 20 };
  const chips = width => ({ width, height: 28 });
  assert.equal(debug.headerPlacement(strip, chips(68), 36, 116), true, 'the mode chip fits');
  // With the background-jobs chip present the chips are ~177px together, still inside the
  // 202px of room beside 轨迹 (362 - 116 - 36 - 8).
  assert.equal(debug.headerPlacement(strip, chips(177), 36, 116), true, 'both chips fit at 390px');
  // 320px: the strip ends at 292 and 轨迹 at 90, so there are 158px of room. A flex line
  // that runs out of space overflows rather than reporting anything, so the chips are
  // declined instead of spilling past the strip's edge (measured: 11px past it when this
  // arithmetic still measured against the viewport instead of the strip).
  assert.equal(
    debug.headerPlacement({ left: 20, right: 292, top: 56, height: 20 }, chips(177), 36, 90),
    false, 'declined at 320px');
  assert.equal(
    debug.headerPlacement({ left: 20, right: 292, top: 56, height: 20 }, chips(68), 36, 90),
    true, 'the mode chip alone still fits at 320px');
});

test('a phone too narrow for the chips declines instead of overflowing', async () => {
  // 320px of screen, 226px of chips (both of them, while a background job runs): there is
  // no line for that beside the tabs, and capping the container was tried and made it
  // wrap into a 43px column that poked out under the header. Declining is the honest
  // failure — the official layout is what the client chose for that width.
  const page = await mountShell();
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  const { actions } = stubHeaderGeometry(page, { width: 320, chipWidth: 226 });
  debug.syncHeaderActions();
  assert.equal(debug.headerActions(), 'narrow', 'declined rather than moved');
  assert.equal(actions.hasAttribute('data-pulse-header-actions'), false);
  assert.equal(actions.style.top, '', 'and left exactly where the client put it');
  // ... and the panel explains it, because on a phone there is no console.
  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(page.document.querySelector('.pulse-diag').textContent, /这一屏太窄/);

  // One chip instead of two fits even at 320px, and the very next pass moves it — in the
  // DOM, which is the property jsdom *can* check.
  stubHeaderGeometry(page, { width: 320, chipWidth: 68 });
  debug.syncHeaderActions();
  assert.equal(debug.headerActions(), 'tabs');
  assert.equal(actions.getAttribute('data-pulse-header-actions'), 'tabs');
  assert.equal(actions.parentElement, debug.headerGroup(),
    'and it is inside our group in the strip, not merely drawn over it');
  assert.equal(debug.headerGroup().parentElement, page.document.querySelector('.wSkVaW_tabs'),
    'the group is the strip\u2019s child, which is what makes the chips leave with the header');
});

test('the shell finds the header action container and its tab strip together', async () => {
  const page = await mountShell();
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  const row = debug.headerRow();
  assert.ok(row, 'the fixture has both halves in one header');
  assert.equal(row.actions.className.includes('wSkVaW_headerActions'), true);
  assert.equal(row.tabs.className.includes('wSkVaW_tabs'), true);

  stubHeaderGeometry(page);
  debug.syncHeaderActions();
  assert.equal(debug.headerActions(), 'tabs', 'the chips are placed on the strip');
  assert.equal(row.actions.getAttribute('data-pulse-header-actions'), 'tabs');
  // The move is structural, so the assertion is about the tree. That is the whole reason
  // this is a DOM move: it is the part a browser-free test can hold on to.
  assert.equal(row.actions.parentElement, debug.headerGroup(), 'it is inside the group');
  assert.equal(debug.headerGroup().parentElement, row.tabs, 'and the group is a child of the strip');
  const css = mobileShellStyles();
  assert.match(css, /\[data-pulse-header-group\]\s*\{[^}]*margin:\s*0 0 0 auto/,
    'the group carries the auto margin that keeps the chips at the strip\u2019s end');
  assert.match(css, /\[data-pulse-header-actions\],\s*\[data-pulse-header-lineage\]\s*\{[^}]*margin:\s*0 !important/,
    'the chips themselves do not, or two auto margins would spread the group');
  assert.doesNotMatch(css, /\[data-pulse-header-(actions|group)\]\s*\{[^}]*position:\s*fixed/,
    'a fixed box would keep painting over whatever covers the header');
  assert.equal(debug.headerRows().length, 1, 'the fixture has one wrapper; the client may render more');
});

test('the subagent count chip is moved next to the mode chip, in front of it', async () => {
  // The third contribution does not arrive in a `_headerActions` wrapper at all: the client
  // renders the lineage slot inside the title's crumb segment, which is why it stayed at the
  // top of the header when the other chips moved down to the strip.
  const page = await mountShell({ lineage: true });
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  const { actions, tabs, lineage } = stubHeaderGeometry(page, { chipWidth: 68, lineageWidth: 80 });
  assert.ok(lineage, 'the fixture has the slot');
  assert.equal(lineage.parentElement.className.includes('wSkVaW_crumbSeg'), true,
    'before the move it lives in the crumb segment, next to the session title');

  debug.syncHeaderActions();
  assert.equal(debug.headerActions(), 'tabs');
  assert.equal(lineage.getAttribute('data-pulse-header-lineage'), 'tabs');
  const group = debug.headerGroup();
  assert.equal(lineage.parentElement, group, 'the chip itself moves, not a copy of it');
  assert.equal(actions.parentElement, group);
  // Order is the point of the request ("改到标准模式的旁边"): the count first, then 标准模式.
  assert.equal(group.children.length, 2, 'the group holds exactly the two chips');
  assert.equal(group.children[0].getAttribute('data-pulse-header-lineage'), 'tabs',
    'the subagent count comes first, so it reads next to the mode chip');
  assert.equal(group.children[1].getAttribute('data-pulse-header-actions'), 'tabs');
  assert.equal(group.parentElement, tabs);
});

test('the subagent count chip counts toward whether the row still fits', async () => {
  // The arithmetic that decides the move has to include it. Without that, an 80px chip
  // arrives in a row that was measured without it and the group runs past the strip's edge
  // — the exact failure this measurement exists to prevent.
  const page = await mountShell({ lineage: true });
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  const strip = { left: 20, right: 362, top: 56, height: 20 };
  // 362 - 116 (轨迹's right edge) - 36 (the strip's gap) - 8 = 202px of room.
  assert.equal(debug.headerPlacement(strip, { width: 68 + 80 + 6, height: 28 }, 36, 116), true,
    'the mode chip, the subagent count and the group\u2019s gap still fit at 390px');
  assert.equal(debug.headerPlacement(strip, { width: 160 + 80 + 6, height: 28 }, 36, 116), false,
    'and the same chips are declined once they do not');

  // The DOM half goes through the shell's own reading of the stylesheet, and jsdom applies
  // no client CSS at all — so the strip's gap reads as 0 there and the room is 238px rather
  // than the real 202px. The width below overflows both, which keeps the check about the
  // subagent count being counted rather than about which gap the test environment reported.
  const { actions, lineage } = stubHeaderGeometry(page, { chipWidth: 160, lineageWidth: 80 });
  debug.syncHeaderActions();
  assert.equal(debug.headerActions(), 'narrow', 'so the row is left as the client laid it out');
  assert.equal(lineage.parentElement.className.includes('wSkVaW_crumbSeg'), true,
    'and the subagent count is handed back with the others, not left behind in the strip');
  assert.equal(actions.parentElement.className.includes('wSkVaW_titleCluster'), true);
});

test('a client re-insert of the chip is undone without waiting for a frame', async () => {
  // The subagent count is React's node, and the client puts it back into the crumb row on
  // its own re-renders. Correcting that from the animation frame below is a frame too late:
  // the chip is painted 33px higher for that frame, and a tap that begins in it delivers no
  // click at all (measured on a real page: four taps in five, with a forced move every 60ms).
  // The observer calls this synchronously, so the wrong position is never drawn.
  const page = await mountShell({ lineage: true });
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  const { tabs, lineage } = stubHeaderGeometry(page, { chipWidth: 68, lineageWidth: 80 });
  debug.syncHeaderActions();
  const group = debug.headerGroup();
  assert.equal(lineage.parentElement, group);

  const home = debug.headerRow().lineageHome;
  home.appendChild(lineage);
  assert.equal(lineage.parentElement, home, 'the fixture stands in for the client');
  debug.holdHeaderPlacement();
  assert.equal(lineage.parentElement, group, 'and one synchronous call is enough to undo it');
  assert.equal(lineage, group.children[0],
    'the subagent count goes back in front of the mode chip, not behind it');
  assert.equal(group.children[1], page.document.querySelector('.wSkVaW_headerActions'));
  assert.equal(group.parentElement, tabs);

  // Nothing to hold once the shell is not placing the chips: the official layout is the
  // client's, and a helper that kept pulling the chip into a group that was handed back
  // would fight the client at the desktop width this shell deliberately leaves alone.
  debug.clearHeaderActions();
  home.appendChild(lineage);
  debug.holdHeaderPlacement();
  assert.equal(lineage.parentElement, home, 'a handed-back chip is left where the client put it');
});

test('a header with no tab strip is left alone rather than moved somewhere else', async () => {
  const page = await mountShell({ tabs: false });
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  assert.equal(debug.headerRow(), null, 'the pairing is required, not assumed');
  assert.equal(debug.headerActions(), 'missing');
  const actions = page.document.querySelector('.wSkVaW_headerActions');
  assert.equal(actions.hasAttribute('data-pulse-header-actions'), false);
  assert.equal(actions.style.top, '', 'nothing was written to a header we cannot place');
  // ... and the panel says so, because on a phone there is no console to check it in.
  page.click('.pulse-diag-toggle');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(page.document.querySelector('.pulse-diag').textContent, /没找到页签行/);
});

test('a desktop-width viewport gets the chips back in the title row', async () => {
  // The placement is ours, so it has to be taken away again: a desktop header has room
  // for the chips and the title row is where they belong. `force: false` because the
  // `?pulse=mobile` hatch would keep the shell active at any width.
  const page = await mountShell({ force: false, lineage: true });
  const debug = page.window.__PULSE_SHELL_DEBUG__;
  const { actions, lineage } = stubHeaderGeometry(page, { lineageWidth: 80 });
  debug.syncHeaderActions();
  assert.equal(debug.headerActions(), 'tabs');
  assert.equal(lineage.parentElement, debug.headerGroup(), 'the count moves with the chips');

  Object.defineProperty(page.window, 'innerWidth', { value: 1400, configurable: true, writable: true });
  debug.refresh();
  assert.equal(debug.headerActions(), 'row');
  assert.equal(actions.hasAttribute('data-pulse-header-actions'), false);
  assert.equal(actions.parentElement.className.includes('wSkVaW_titleCluster'), true,
    'and the DOM is handed back to the row the client put it in');
  assert.equal(lineage.hasAttribute('data-pulse-header-lineage'), false);
  assert.equal(lineage.parentElement.className.includes('wSkVaW_crumbSeg'), true,
    'the subagent count goes back to the crumb segment it came from');
  assert.equal(debug.headerGroup(), null, 'and our group is taken out of the strip');
});

test('the popover clamp keeps a menu inside the viewport and below the header', async () => {
  // The real subagent panel, measured on the page: 336x208 at top 52 while the header
  // ends at 87. Its first rows were drawn over 对话/轨迹.
  const page = await mountShell();
  const shift = page.window.__PULSE_SHELL_DEBUG__.popoverShift;
  assert.deepEqual(plain(shift({ top: 52, bottom: 260, left: 39, right: 375, height: 208 }, 390, 844, 87)),
    { x: 0, y: 43 }, 'pushed down to 8px below a header that ends at 87');

  // A menu already below the header must not be moved: a clamp that always fires would
  // slide every popover on the page.
  assert.deepEqual(plain(shift({ top: 120, bottom: 328, left: 39, right: 375, height: 208 }, 390, 844, 87)),
    { x: 0, y: 0 });

  // The half that already existed: a 336px menu hanging off a trigger at x=136.
  assert.deepEqual(plain(shift({ top: 200, bottom: 408, left: 136, right: 472, height: 208 }, 390, 844, 87)),
    { x: -90, y: 0 }, 'slid left to the 8px margin');

  // A panel taller than the space below the header cannot be helped by moving it, and
  // pushing it down would hide its last rows instead of its first.
  assert.deepEqual(plain(shift({ top: 52, bottom: 852, left: 20, right: 370, height: 800 }, 390, 844, 87)),
    { x: 0, y: 0 });

  // A menu overflowing the bottom slides up, but the header still wins.
  assert.deepEqual(plain(shift({ top: 700, bottom: 900, left: 20, right: 370, height: 200 }, 390, 844, 87)),
    { x: 0, y: -64 });
});
