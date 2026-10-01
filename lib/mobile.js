/**
 * The narrow-screen adaptation layer for the official harness GUI.
 *
 * ## Why this is CSS-only, and deliberately narrow in scope
 *
 * The phone runs the *official* client through the proxy. That is the whole
 * design: reimplementing the UI would fall behind the official one immediately.
 * So the phone gets a stylesheet, injected as a `{kind:'style'}` index row
 * (`webserver/index-inject`), and nothing else — no DOM rewriting, no component
 * patching, no fork of the layout.
 *
 * ## Why the rules target what they target
 *
 * The official stylesheets are CSS modules: every class is
 * `_<semantic>_<moduleHash>_<line>`, so the hash changes on every official
 * build. Targeting `.foo` would break on upgrade, so every selector here uses an
 * attribute substring match on the semantic prefix (`[class*="_paneBody_"]`),
 * which survives a rehash. `MOBILE_ANCHORS` records exactly which prefixes are
 * relied on, and `scripts/verify-mobile-layer.mjs` fails when one disappears —
 * drift becomes a reported check instead of a silent visual regression.
 *
 * The sheet is also honest about its limits: it does **not** attempt to turn the
 * desktop sidebar into a drawer. The sidebar's classes are contributed by
 * `@deepseek-ai/dsh-client-ui-sidebar` at runtime and are not present in the
 * shell's stylesheet, so a selector for them would be a guess that silently
 * rots. What is here instead is what can be *verified*: text scaling, touch
 * targets, focus-zoom suppression, and containment of wide content — the things
 * that actually make the official layout usable one-handed.
 *
 * Everything is inside a media query, so a desktop window is unaffected.
 *
 * @module dsh-remote-pulse/mobile
 */

/**
 * Class-name prefixes this sheet depends on, with what each one is for.
 *
 * Every entry was confirmed present in the stylesheet the served shell actually
 * references. A prefix that no longer matches means the official build renamed
 * or re-scoped it, and the corresponding rules have quietly stopped applying.
 *
 * @type {ReadonlyArray<{prefix: string, purpose: string}>}
 */
export const MOBILE_ANCHORS = Object.freeze([
  { prefix: '_paneBody_', purpose: 'the scrollable content pane' },
  { prefix: '_markdown_', purpose: 'rendered markdown, where wide content lives' },
  { prefix: '_iconButton_', purpose: 'icon-only toolbar buttons (28px by default)' },
  { prefix: '_addTab_', purpose: 'the add-tab button (28px by default)' },
  { prefix: '_tabClose_', purpose: 'the per-tab close button (20px by default)' },
  { prefix: '_close_', purpose: 'modal close button (28px by default)' },
  { prefix: '_modalAction_', purpose: 'modal action buttons' },
  { prefix: '_confirmAction_', purpose: 'the primary confirm button in a modal' },
  { prefix: '_tableScroll_', purpose: 'the horizontal scroller around wide tables' },
]);

/** Below this width the layout is treated as a tablet. */
export const TABLET_MAX_PX = 900;

/** Below this width the layout is treated as a phone. */
export const PHONE_MAX_PX = 560;

/**
 * Build the narrow-screen stylesheet.
 *
 * @returns {string} CSS text, safe to place inside a `<style>` element.
 */
export function mobileStylesheet() {
  return `/* Pulse mobile layer — narrow screens only. Generated; see lib/mobile.js. */
html {
  /* Without this, iOS inflates body text in landscape and the layout jumps. */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

@media (max-width: ${TABLET_MAX_PX}px) {
  /* The conversation pane: a phone has no scroll wheel, so momentum scrolling
     plus containing the overscroll keeps a flick inside the pane instead of
     dragging the whole page along once the pane hits its end. This box really is
     a vertical scroller, so containing it is correct. */
  [class*="_paneBody_"] {
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  /* A horizontal scroller gets the X axis contained, and that axis only.
     Never write the overscroll-behavior shorthand here: an element with
     overflow-x:auto and the default overflow-y:visible computes overflow-y to
     auto, so it *is* a vertical scroll container — with nothing to scroll
     vertically. Containing its Y axis then stops the swipe from chaining up to
     the conversation, and a finger resting on a wide table or diagram can no
     longer move the page at all. Measured in a real browser: 0px of scroll with
     the shorthand, 30px with the X longhand, which is also what the official
     sheet chose. Reproduce with scripts/repro-scroll-trap.mjs. */
  [class*="_tableScroll_"] {
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
  }

  /* Nothing in a conversation should be able to scroll the whole page sideways.
     The official sheet already wraps tables in a scroller, but code blocks,
     images and embedded media are not always inside one. */
  [class*="_paneBody_"] pre,
  [class*="_markdown_"] pre {
    max-width: 100%;
    overflow-x: auto;
  }
  [class*="_paneBody_"] img,
  [class*="_paneBody_"] video,
  [class*="_markdown_"] img {
    max-width: 100%;
    height: auto;
  }
  [class*="_paneBody_"] table {
    max-width: 100%;
  }

  /* Reading rhythm rather than reading size. The conversation font size is the
     official 字号大小 setting, so overriding it here would silently fight a
     choice the user made in Settings; line height and paragraph gaps are not
     exposed there, and the desktop values are tight for a phone column. */
  [class*="_markdown_"] {
    line-height: 1.75;
  }
  [class*="_markdown_"] p {
    margin-block: 0.85em;
  }
  [class*="_markdown_"] li {
    margin-block: 0.35em;
  }

  /* A flex child defaults to min-width:auto, so one wide descendant can push the
     whole row past the viewport. This is the standard fix and it is inert
     wherever nothing overflows. */
  [class*="_pane_"],
  [class*="_paneBody_"] {
    min-width: 0;
  }
}

/* A finger is not a mouse pointer. Keying on the pointer rather than the screen
   keeps these rules from firing on a narrow desktop window, where 28px icon
   buttons are perfectly fine. */
@media (pointer: coarse) {
  /* iOS Safari zooms the whole page when a control smaller than 16px receives
     focus, and never zooms back out. max() raises only the fields that would
     trigger it, leaving larger text alone. */
  input,
  textarea,
  select,
  [contenteditable="true"] {
    font-size: max(16px, 1em);
  }

  /* Minimum 40px touch targets. The official sizes are 28px (icon buttons),
     28px (add tab), 20px (tab close) — all below the 44px guideline and all
     genuinely hard to hit one-handed. Only the box grows; the icon inside keeps
     its own size, so nothing looks inflated. */
  [class*="_iconButton_"],
  [class*="_addTab_"],
  [class*="_close_"] {
    min-width: 40px;
    min-height: 40px;
  }
  /* The close button is addressed through its tab so this rule outranks the official
     one on specificity (0,2,0 against 0,1,0) rather than on document order. Two equal
     selectors would leave the result depending on whether our stylesheet happens to be
     injected after the app's, and the failure mode is silent: the box lands 2px low and
     the × looks crooked again. The probe injects the official rules *after* ours on
     purpose, so that ordering cannot make it pass. */
  [class*="_tab_"] [class*="_tabClose_"] {
    /* The official × is position:absolute; top:4px; right:4px; 20x20 inside a 28px tab
       — already symmetric, 4px of chip above it and 4px below. An earlier rule here
       grew it with min-width/min-height, which cannot move an absolute anchor: the box
       grew downward and rightward only, so the ink ended up 6px below the tab's
       centreline and the hit area hung out of the chip. That is the crooked × in the
       tab strip, and it was ours, not the client's.

       Now the box is symmetric by construction (2 + 24 + 2 = 28) and the extra touch
       area comes from a pseudo-element: it changes what a finger can hit without
       changing what the eye sees. The minimums are restated because a minimum beats a
       width — leaving them at the 32px an earlier version set would keep the box 32px
       whatever the width says. */
    top: 2px;
    right: 2px;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
  }
  [class*="_tab_"] [class*="_tabClose_"]::after {
    content: '';
    position: absolute;
    /* 32x32 effective target, centred on the same ink. */
    inset: -4px;
    border-radius: inherit;
  }
}

@media (max-width: ${PHONE_MAX_PX}px) {
  /* Two side-by-side modal buttons with fixed min-widths (72px / 136px) plus a
     gap stop fitting once the dialog is phone-width. Letting them share the row
     keeps both reachable with a thumb instead of one overflowing off-screen. */
  [class*="_modalAction_"],
  [class*="_confirmAction_"] {
    flex: 1 1 auto;
    min-width: 0;
  }
}
`;
}

/**
 * Whether a stylesheet is safe to embed in a `<style>` element.
 *
 * The injection contract states the text must not contain `</style`, which would
 * close the element early and turn the rest of the sheet into markup.
 *
 * @param {string} css - the stylesheet text.
 * @returns {boolean} true when it can be embedded verbatim.
 */
export function isEmbeddable(css) {
  return typeof css === 'string' && !/<\/style/i.test(css);
}
