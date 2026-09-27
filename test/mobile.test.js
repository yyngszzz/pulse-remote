/**
 * The narrow-screen layer's contract.
 *
 * These pin the properties that make it safe to push into the official client's
 * document: it cannot break the parse, it cannot touch a desktop window, and it
 * records which official class prefixes it depends on so drift is detectable.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MOBILE_ANCHORS, PHONE_MAX_PX, TABLET_MAX_PX, isEmbeddable, mobileStylesheet } from '../lib/mobile.js';

test('the stylesheet is safe to embed in a style element', () => {
  const css = mobileStylesheet();
  assert.ok(css.length > 0);
  // The injection contract is explicit: a `</style` closes the element early and
  // turns the remainder of the sheet into markup.
  assert.ok(!/<\/style/i.test(css));
  assert.equal(isEmbeddable(css), true);
  assert.equal(isEmbeddable('a { } </style><script>alert(1)</script>'), false);
  assert.equal(isEmbeddable('a { } </STYLE >'), false);
  assert.equal(isEmbeddable(null), false);
});

test('every rule is scoped so a desktop window is unaffected', () => {
  const css = mobileStylesheet();
  // Two universal declarations are allowed outside a media query because they
  // are no-ops away from a touch browser; everything else must be scoped.
  const stripped = css
    .replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = stripped.match(/[a-z-]+\s*:/gi) ?? [];
  for (const declaration of declarations) {
    assert.ok(
      /^(-webkit-text-size-adjust|text-size-adjust):/.test(declaration.trim()),
      `unscoped declaration found: ${declaration.trim()}`,
    );
  }
});

test('the sheet declares both breakpoints', () => {
  const css = mobileStylesheet();
  assert.ok(css.includes(`@media (max-width: ${TABLET_MAX_PX}px)`));
  assert.ok(css.includes(`@media (max-width: ${PHONE_MAX_PX}px)`));
  // Touch targets and focus-zoom are properties of the input device, not the
  // viewport, so they must key on the pointer.
  assert.ok(css.includes('@media (pointer: coarse)'));
});

test('touch-target rules raise the official sizes above the guideline floor', () => {
  // Comments are stripped first: the rule below documents the official geometry inside
  // its own comment ("top:4px; right:4px"), and a regex looking for numbers finds that
  // first and reports the very values the rule exists to replace.
  const css = mobileStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
  // The official sizes are 28px (icon button), 28px (add tab), 20px (tab close).
  for (const prefix of ['_iconButton_', '_addTab_', '_tabClose_', '_close_']) {
    assert.ok(css.includes(`[class*="${prefix}"]`), `no rule for ${prefix}`);
  }
  assert.ok(/min-width:\s*40px/.test(css), 'icon buttons should reach 40px');

  // The tab's × is the one target that cannot simply be enlarged: it is absolutely
  // positioned inside a 28px tab, so a bigger box grows downward and off the tab's
  // centreline — which is exactly the crooked × that shipped. The box is therefore
  // symmetric in the tab (2 + 24 + 2) and the extra reach comes from a pseudo-element,
  // so this checks the reach rather than the box: 24px of box plus 4px of inset on each
  // side is a 32px target, and the whole thing still fits the tab's height.
  const close = /\[class\*="_tab_"\]\s*\[class\*="_tabClose_"\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(close, 'the tab close rule must be scoped to its tab, or it loses to the official rule');
  const box = Number(/width:\s*(\d+)px/.exec(close[1])?.[1] ?? 0);
  const top = Number(/top:\s*(\d+)px/.exec(close[1])?.[1] ?? 0);
  const inset = Number(/inset:\s*-(\d+)px/.exec(css.slice(css.indexOf(close[0])))?.[1] ?? 0);
  assert.equal(box + inset * 2 >= 32, true, `tab close should reach at least 32px, got ${box + inset * 2}`);
  assert.equal(top * 2 + box <= 28, true, `and stay inside the 28px tab, got ${top * 2 + box}`);
});

test('focus-zoom suppression targets every focusable text control', () => {
  const css = mobileStylesheet();
  // iOS zooms when a control under 16px takes focus and never zooms back.
  assert.ok(/font-size:\s*max\(16px,\s*1em\)/.test(css));
  for (const selector of ['input', 'textarea', 'select', '[contenteditable="true"]']) {
    assert.ok(css.includes(selector), `focus zoom not suppressed for ${selector}`);
  }
});

test('wide content inside a pane is contained', () => {
  const css = mobileStylesheet();
  // The realistic ways a phone gets a sideways-scrolling page.
  assert.ok(/\[class\*="_paneBody_"\] pre/.test(css));
  assert.ok(/\[class\*="_paneBody_"\] img/.test(css));
  assert.ok(/\[class\*="_paneBody_"\] table/.test(css));
  assert.ok(/min-width:\s*0/.test(css), 'flex children need min-width:0 to shrink');
});

test('a horizontal scroller never contains the vertical axis', () => {
  const css = mobileStylesheet();
  // This shipped once and made the phone unusable in the worst way: a finger
  // resting on a wide table stopped the conversation from scrolling at all.
  // An overflow-x:auto box computes overflow-y to auto, so the shorthand turns
  // it into a vertical scroll container that swallows the gesture instead of
  // handing it up. scripts/repro-scroll-trap.mjs measures 0px vs 30px.
  const blocks = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map(match => ({ selector: match[1].trim(), body: match[2] }));

  for (const block of blocks) {
    const horizontal = /\[class\*="_tableScroll_"\]|\[class\*="_stripTabs_"\]/.test(block.selector);
    if (!horizontal) continue;
    assert.ok(
      !/(^|[^-])overscroll-behavior\s*:/.test(block.body),
      `${block.selector} must not use the overscroll-behavior shorthand`,
    );
  }

  const tableRule = blocks.find(block => /\[class\*="_tableScroll_"\]/.test(block.selector));
  assert.ok(tableRule, 'the table scroller should be styled');
  assert.match(tableRule.body, /overscroll-behavior-x:\s*contain/, 'X containment is what the official sheet uses');
});

test('selectors match on the semantic prefix, never on a module hash', () => {
  const css = mobileStylesheet();
  // A CSS-module class is _<semantic>_<hash>_<line>; the hash changes on every
  // official build, so any selector containing one would rot silently.
  const classSelectors = [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]);
  for (const name of classSelectors) {
    assert.ok(
      !/_[0-9a-f]{4,}_\d+$/.test(name),
      `selector .${name} is pinned to a module hash and will break on upgrade`,
    );
  }
  assert.ok(css.includes('[class*="_'), 'expected attribute substring selectors');
});

test('every declared anchor is used by the sheet', () => {
  const css = mobileStylesheet();
  assert.ok(MOBILE_ANCHORS.length > 0);
  for (const anchor of MOBILE_ANCHORS) {
    assert.ok(
      css.includes(`[class*="${anchor.prefix}"]`),
      `anchor ${anchor.prefix} is declared but unused, so the drift check would be vacuous`,
    );
    assert.ok(anchor.purpose.length > 0, `anchor ${anchor.prefix} needs a purpose`);
  }
});

test('the generated sheet is deterministic', () => {
  // A non-deterministic sheet would make the injection untestable and would
  // defeat any future content hash.
  assert.equal(mobileStylesheet(), mobileStylesheet());
});
