/**
 * The mobile shell: the phone's own chrome, laid over the official client.
 *
 * ## What this is, and what it deliberately is not
 *
 * The phone still runs the official client. This adds what a desktop layout cannot
 * give a phone — a sidebar that overlays instead of shrinking the conversation —
 * and the few entry points the official interface has no equivalent for. Everything
 * else, including features added after this was written, stays the official one.
 *
 * ## Why the chrome lives outside the client's root
 *
 * The official client is React. Anything inserted into its tree is removed on the
 * next render, so the shell's own elements are appended to the body and positioned
 * fixed. Snapshot class names are generated per build and are therefore matched by
 * their stable semantic suffix, never by the full name.
 *
 * ## Failing quietly is not allowed
 *
 * A selector that stops matching is the likeliest failure and the hardest to
 * notice, so every probe records what it found and a small panel can be opened from
 * any screen. A broken shell announces itself.
 *
 * @module pulse-remote/mobile-shell
 */

import { TABLET_MAX_PX } from './mobile.js';

/** Semantic class-name suffixes this shell anchors on, named rather than indexed. */
const SIDEBAR_COLUMN_SUFFIX = '_sidebarCol';
const COLLAPSED_MARKER_SUFFIX = '_collapsed';
const CENTER_COLUMN_SUFFIX = '_centerCol';
const RIGHTBAR_COLUMN_SUFFIX = '_rightbarCol';
const FRAME_SUFFIX = '_frame';
const FOOT_SUFFIX = '_footArea';

/**
 * The official deliverables card's dropdown anchor.
 *
 * Matched without a trailing underscore on purpose: this build names that module's
 * classes hash_menuAnchor, where others use name_hash_line. Requiring the trailing
 * underscore found nothing at all.
 */
const MENU_ANCHOR_SUFFIX = '_menuAnchor';

/**
 * The session header's action container — the mode chip, and the background-jobs chip
 * while anything is running.
 *
 * Both register into the same official slot, `conversation.session.header.actions`
 * (`dsh-client-ui-agent-preset` and `dsh-client-ui-jobs`), so they arrive as one
 * container and move together or not at all.
 */
const HEADER_ACTIONS_SUFFIX = '_headerActions';

/** The session header's tab strip — 对话 / 轨迹 — which sits under the title row. */
const HEADER_TABS_SUFFIX = '_tabs';

/** The row the chips belong to when the shell is not placing them. */
const HEADER_CLUSTER_SUFFIX = '_titleCluster';

/** The header row the hamburger goes into, at its left end. */
const HEADER_TITLE_ROW_SUFFIX = '_titleRow';

/** The title's crumb segment: where the subagent count chip is rendered. */
const HEADER_CRUMB_SEG_SUFFIX = '_crumbSeg';

/**
 * The subagent count chip's slot marker.
 *
 * It is not in an `_headerActions` wrapper — the client renders the lineage slot inside the
 * title's crumb segment — so it needs its own hook, and a `data-slot` name is a better one
 * than any generated class: it is the contract the plugin system itself routes on.
 */
const HEADER_LINEAGE_SLOT = 'header.lineage';

/**
 * Set on that chip while the shell has moved it into the tab strip.
 *
 * The path is the same as for the action wrappers (see HEADER_ACTIONS_ATTRIBUTE); the
 * value names the row it was moved into.
 */
export const HEADER_LINEAGE_ATTRIBUTE = 'data-pulse-header-lineage';

/**
 * The box this shell puts into the strip to hold everything it moved there.
 *
 * One element rather than several siblings, and that is the whole reason it exists: the
 * official strip spaces its flex children 36px apart, which is right for two tabs and
 * wrong for three chips — measured on the real page, the mode chip, the subagent count and
 * the jobs chip would have needed 292px of a 254px budget and simply declined to move at
 * all. Inside a container of our own the spacing is ours (6px), the strip sees a single
 * child, and the width to fit is one measurement instead of a sum that has to guess at
 * gaps.
 */
export const HEADER_GROUP_ATTRIBUTE = 'data-pulse-header-group';

/**
 * The spacing between the chips in that group, in pixels.
 *
 * The official strip gaps its children by 36px, which is right for two tabs and far too
 * much for three chips. The same number is used by the stylesheet and by the arithmetic
 * that decides whether the group fits, so it is defined once here and interpolated into
 * both — a fit test that disagrees with the layout is a fit test that lies.
 */
const HEADER_GROUP_GAP_PX = 6;

/**
 * Set on that container while the shell has moved it down into the tab strip.
 *
 * The tab strip is three quarters empty (342px with 88px used) while the title row was
 * carrying 226px of chips, 88px of utilities and a 28px corner — enough to squeeze the
 * session title to a measured **0px**, so the phone showed "我的…" and the chips sat on
 * top of each other. The value names the row it was moved into, so triage can tell
 * "moved" from "the strip was not found"; removing the attribute is how the move is
 * undone when the viewport grows back.
 */
export const HEADER_ACTIONS_ATTRIBUTE = 'data-pulse-header-actions';

/**
 * The class suffix the present tool prints its delivered paths under.
 *
 * `span.<hash>_paths` inside the tool row's collapsed summary, e.g.
 * `<span class="_93YTAG_summary"><span>已交付</span><span class="_93YTAG_paths">dist/app.apk</span></span>`.
 * Matched by suffix like every other official hook here.
 */
const SUMMARY_PATH_SUFFIX = '_paths';

export const SHELL_ANCHORS = Object.freeze([
  { prefix: SIDEBAR_COLUMN_SUFFIX, purpose: '侧栏列（收起时 56px 图标栏，展开时 280px 会话列表）' },
  { prefix: COLLAPSED_MARKER_SUFFIX, purpose: '侧栏处于收起态时，它内部会出现这个名字' },
  { prefix: CENTER_COLUMN_SUFFIX, purpose: '对话主列——抽屉浮起后它会占满宽度' },
  { prefix: RIGHTBAR_COLUMN_SUFFIX, purpose: '右侧栏（空着的时候会白白占掉对话的宽度）' },
  { prefix: FRAME_SUFFIX, purpose: '应用外框' },
]);

export const SIDEBAR_TOGGLE_LABELS = Object.freeze({
  open: '打开侧边栏',
  close: '收起侧边栏',
});

export const ATTACH_LABELS = Object.freeze(['上传文件', '添加文件', '选择文件', '附件', 'attach', 'upload']);

export const DRAWER_ATTRIBUTE = 'data-pulse-drawer';

export const RIGHTBAR_EMPTY_ATTRIBUTE = 'data-pulse-rightbar-empty';

/** Marker attribute for the control this shell adds to a deliverables card. */
export const DELIVERABLE_ACTION_ATTRIBUTE = 'data-pulse-deliverable';

/**
 * Which file one injected deliverable control stood for, on the control itself.
 *
 * `data-pulse-deliverable` answers "did the injector run here"; this answers "for which
 * file", which is what a row printing several paths needs: the guard cannot be a single
 * marker on the row, or the second file of a `present` call would never get a control
 * because the first one already marked it.
 */
export const DELIVERABLE_PATH_ATTRIBUTE = 'data-pulse-deliverable-path';

/** Marker attribute for the control this shell adds to an opened file's header. */
export const PREVIEW_ACTION_ATTRIBUTE = 'data-pulse-preview-action';

/**
 * The preview header's own marker, and where the absolute path is written.
 *
 * `div[data-textpreview-path="true"][title="<absolute path>"]` in
 * @deepseek-ai/dsh-client-ui-sidebar-documentpreview, for the text viewer and the
 * image viewer alike. Structure rather than presentation, so nothing has to be
 * recovered from an accessible name — and the probe asserts it is still there in the
 * bundle the client receives, because losing it would fail silently.
 */
export const PREVIEW_PATH_ATTRIBUTE = 'data-textpreview-path';

/**
 * Set on a preview header whose path the host could not resolve to an absolute one.
 *
 * The header falls back to the relative path it was handed, and the host's file route
 * answers 400 for those — so no button is added. The mark is what keeps that from
 * looking identical to "the injector never ran", on the page and in the self-check
 * panel.
 */
export const PREVIEW_UNRESOLVED_ATTRIBUTE = 'data-pulse-preview-unresolved';

/**
 * Which path one injected preview control currently opens.
 *
 * The header rewrites its own `title` after mounting — the same file arrives once with
 * forward slashes and once with backslashes, and a transcript link's path can be
 * replaced outright. Without this, "is there already a button here" was the only
 * question asked and the button kept opening the value it was born with: measured, a
 * header reading `C:\Users\…\client.js` beside a button opening `C:/Users/…`.
 */
export const PREVIEW_SOURCE_ATTRIBUTE = 'data-pulse-preview-source';

/** Marker attribute for the control this shell adds to a file link in a tool row. */
export const FILE_LINK_ACTION_ATTRIBUTE = 'data-pulse-file-link-action';

/**
 * Set on a file link whose absolute path could not be recovered.
 *
 * A link with no control and no marker would be indistinguishable from a link the
 * injector never looked at, which is the difference between "this build's React props
 * moved" and "this build has no file links". It is also what the self-check panel
 * counts, so a phone can answer the question without a console.
 */
export const FILE_LINK_UNRESOLVED_ATTRIBUTE = 'data-pulse-file-link-unresolved';

/**
 * The class suffix the conversation's tool rows put on an underlined file path.
 *
 * `button.<hash>_fileLink`, inside the read / write / edit rows. Matched by suffix
 * because the hash in front of it changes on every official build.
 */
export const FILE_LINK_SUFFIX = '_fileLink';

export const FILE_PATH_ATTRIBUTE = 'data-files-path';

/**
 * Where a file's bytes are served from.
 *
 * The **host's own** file route, not this plugin's artifact route. That route is an
 * allowlist of paths the agent wrote, which sounds safer and is simply wrong here: a
 * deliverables card can list a file a script produced — an APK, for instance — and
 * the allowlist answered 403 for it while the client could open it perfectly well.
 * Going through the host's route means anything the client can open can also be
 * saved, under exactly the host's own permissions.
 */
export const HOST_FILE_PATH = '/api/file';

/**
 * The mobile shell's own stylesheet.
 *
 * Targets only the shell's own elements and the attributes this module sets, plus
 * the sidebar by semantic suffix. Every rule sits inside a media query, so a desktop
 * window is unaffected.
 *
 * @returns {string} CSS text.
 */
export function mobileShellStyles() {
  return `
/* ---- Pulse mobile shell ---- */
.pulse-chrome { display: none; }

@media (max-width: ${TABLET_MAX_PX}px) {
  .pulse-chrome { display: block; }

  /* The sidebar leaves the layout flow entirely. Out of flow, the conversation
     column grows back to the full viewport width — that is the whole fix, since
     the official rail otherwise keeps 56px and the expanded panel crushes the
     conversation to 110px. */
  [data-pulse-drawer] {
    position: fixed !important;
    top: 0; bottom: 0; left: 0;
    z-index: 60;
    box-shadow: 0 0 48px rgba(0, 0, 0, .5);
    transition: transform .22s cubic-bezier(.32, .72, 0, 1);
  }
  /* Off-screen until the official toggle has actually expanded it, so the
     collapsed rail never flashes across the screen. */
  html:not(.pulse-drawer-open) [data-pulse-drawer] {
    transform: translateX(-104%);
    box-shadow: none;
  }

  /* The frame is not a flex row — it is a CSS grid whose tracks are written
     inline by the client, e.g. "56px minmax(0px, 1fr) 0px" for
     sidebar / conversation / right rail.
     
     That single fact is what makes floating the sidebar tricky: a grid item with
     position: fixed stops occupying its track, so the conversation slides one
     track to the left and lands in the 56px sidebar track while the empty right
     rail inherits the 1fr. Measured exactly that: 56px of conversation beside a
     334px void.
     
     So the template is rewritten to match the new in-flow order — conversation
     first and flexible, right rail second and sized to whatever width the client
     gave it (zero when it is empty and therefore hidden, see below). An explicit
     percentage here would be wrong: a non-fr track takes its maximum even with
     nothing in it, which is how the first attempt still lost 175px to a blank
     column. */
  [class*="_frame"] {
    grid-template-columns: minmax(0px, 1fr) auto 0px !important;
  }
  /* An empty right rail reserves width for nothing, so it keeps none. Without
     this the conversation would still be sharing the row with a blank column. */
  [data-pulse-rightbar-empty] { display: none !important; }

  /* Kept as well because it is what the layout needs if the frame is ever a flex
     row again; the flex property is simply ignored on a grid item. */
  [class*="_centerCol"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }

  .pulse-scrim {
    position: fixed; inset: 0; z-index: 55;
    background: rgba(0, 0, 0, .45);
    opacity: 0; pointer-events: none;
    transition: opacity .22s ease-out;
  }
  html.pulse-drawer-open .pulse-scrim { opacity: 1; pointer-events: auto; }

  /* Our hamburger replaces the affordance the hidden rail used to carry.
     No box behind it. It had one for a while to keep it off the client's own
     folder icon in the file browser's tab strip — but that corner is now left to
     the client entirely and the hamburger is hidden there, so the box has nothing
     left to solve and the mark can be what it should be: three heavy bars, level
     with the title and a little larger than it. */
  /* The hamburger is an item **inside** the session header's title row, not a floating
     button: the shell moves the node in there (see syncBurger). Same lesson as the chips —
     a fixed box is positioned against the viewport, so it stayed on screen when the header
     did not, and it had to be hidden by hand whenever the client put a control in that
     corner. In the title row it is covered with the header, needs no corner rule, and the
     row's own layout makes space for it.
     
     It is hidden until it has actually been placed, because before the first pass it still
     lives in the chrome container outside the client's root, where an in-flow box would
     render at the end of the document. */
  .pulse-burger {
    width: 40px; height: 40px;
    flex: none;
    /* A 40px tap target inside a 46px row would make that row 10px taller, and the header
       with it (measured: 87px → 97px). The negative block margins take that height back
       out of the layout while leaving the finger target at 40px — the row still decides
       its own height, which is what the header's two rows were balanced around. */
    margin: -6px 2px -6px 0;
    display: none; align-items: center; justify-content: center;
    border: 0; padding: 0;
    background: transparent;
    color: var(--dsw-alias-label-primary, #1a1a1a);
    font-size: 0; line-height: 0;
  }
  html.pulse-has-sidebar .pulse-burger[data-pulse-placed="header"] { display: flex; }
  /* Fallback for a screen with no session header to live in — the first launch, where the
     hamburger is exactly how the user reaches the session list. There it floats as it used
     to; with no conversation open there is no pane for it to cover either. */
  html.pulse-has-sidebar .pulse-burger[data-pulse-placed="float"] {
    display: flex;
    position: fixed; z-index: 50;
    top: calc(env(safe-area-inset-top) + 13px); left: 6px;
    margin: 0;
  }
  .pulse-burger:active { opacity: .6; }

  /* The header text sits at 17px against the 18px hamburger icon, so the two read
     as one row rather than as a big button beside small text. */
  [class*="_centerCol"] header [class*="_titleCluster"] {
    font-size: 17px;
  }

  /* The two header rows, rebalanced. Measured before this: the title row was 30px
     while the 对话/轨迹 row took 35px (25px of buttons plus a 10px gap), so the
     small tab labels carried more air than the row holding every control. The tab
     row is tightened and the room goes to the title row, which is also what the
     floating hamburger sits in. */
  [class*="_centerCol"] header [class*="_tabs"] {
    height: 20px !important;
    margin-top: 0 !important;
  }
  [class*="_centerCol"] header button[class*="_tab"] {
    height: 20px !important;
    padding-bottom: 4px !important;
  }
  /* Whatever the tab row gave up goes to the title row, which is what holds the
     controls and the hamburger. */
  [class*="_centerCol"] header [class*="_titleRow"] {
    padding-block: 8px !important;
  }

  /* The header's action chips — the mode chip, and the background-jobs chip while
     anything is running — are **moved into the tab strip**, in the DOM, not merely onto
     its pixels.
     
     Measured on the real page at 390px before this, on the session whose header was
     full: the title row was 342px carrying 226px of chips, 88px of utilities and a 28px
     corner, which squeezed the session title to **0px** — the phone showed "我的…"
     while the chips drew over each other — and the tab strip in the row below used
     88px of the same 342px. Both chips register into one official slot
     (conversation.session.header.actions), so they arrive as a single container.
     
     Why a DOM move and not position:fixed on the same node (which was tried first, and
     shipped for an hour): a fixed box is positioned against the viewport, so it does not
     follow the header out of sight. Opening the file browser or a preview on the phone
     left the chips painted over that pane's own header — and every fix for it was a
     *monitor* (hit-test the strip, retry while covered, listen for transitionend) with a
     window in which the state was wrong. In the flow of the strip, the chips are painted
     exactly where the header is painted: whatever covers the header covers them, and when
     the header is not on screen they are not either. That is a property of the tree
     instead of a watch on it.
     
     It also fixes the stacking: as a flow child with no z-index, the background-jobs menu
     inside it keeps its own z-index:100 in the page's context, so it still paints above
     the conversation's sticky banners. As a position:fixed container it became a stacking
     context and capped that menu at the container's own z-index — measured: the banner
     wrapper at z-index 6 painted over the open job list. */
  [data-pulse-header-actions],
  [data-pulse-header-lineage] {
    margin: 0 !important;
    flex: 0 0 auto;
    align-self: center;
  }
  /* The box the moved chips live in. The auto margin is what keeps them at the strip's
     right end, where they were before they moved; it goes on the container rather than on
     each chip, because two auto margins would split the free space and spread the group. */
  [data-pulse-header-group] {
    display: flex;
    align-items: center;
    gap: ${HEADER_GROUP_GAP_PX}px;
    flex: 0 0 auto;
    align-self: center;
    margin: 0 0 0 auto !important;
  }
  /* In the crumb row the chip is preceded by a "/" that separates it from the session
     title. That separator means nothing in the strip — it would read as "/ 4 个子代理"
     next to 标准模式 — and it is part of the chip's own box, so it is hidden while the chip
     is moved. Matched by class suffix, like everything else here, rather than by any
     module hash. */
  [data-pulse-header-lineage] [class*="_separator"] {
    display: none !important;
  }
  /* The chip itself must not be crushed by the row it comes from. Measured at 320px while
     the crumb row was squeezed: the 80px chip laid out **2px** wide in the title row and
     80px in the strip, so "does it fit" depended on which row it was in — it fitted above,
     moved down, no longer fitted, was handed back, and the two states alternated about once
     a second with the move counter climbing on every frame. Refusing to shrink gives one
     width in both places and therefore one answer.
     
     Scoped by the slot name and not by the marker: the marker is removed when the chip is
     handed back, which is exactly the state whose width has to be measured, and a rule that
     only holds while moved would keep the two widths different. The session title is the
     thing that gives way instead, and it already ellipsises. */
  [data-slot*="${HEADER_LINEAGE_SLOT}"] > * {
    flex: 0 0 auto !important;
  }
  /* The strip is 20px tall (tightened above) and the chips are 28px, so they must not be
     clipped by it: a clipped chip is also not tappable outside the clip rect. */
  [class*="_centerCol"] header [class*="_tabs"] {
    overflow: visible !important;
  }

  /* An image wider than the phone is shown at its natural size by the official
     viewer, which on a 394px screen is a wall of pixels — and the app used to have
     pinch-zoom switched off as well, so there was no way to see any of it. A
     ceiling cannot make an image bigger, so applying it broadly at phone width is
     safe; the height is left alone so nothing that sizes an image deliberately is
     fought over. */
  img {
    max-width: 100% !important;
  }

  /* The official attach control IS the upload entry; on a phone its hit area is
     worth enlarging rather than duplicating. */
  .pulse-attach-target { min-width: 44px !important; min-height: 44px !important; }

  /* ---- 阅读区的呼吸感 -----------------------------------------------------

     Three measurements, three complaints:

     1. the message flow is inset 32px on each side by the official sheet, leaving
        316px of text on a 390px phone; the reading interfaces this was compared
        against (WeChat Reading, WorkBuddy) sit nearer 20px;
     2. that inset lives on a wrapper whose direct child is the text column, so it
        is targeted structurally with :has() rather than by a module hash;
     3. the top felt cramped because the header (title row plus the 对话/轨迹 strip)
        ends flush against the first line of the conversation. The extra room goes
        on the header, not inside the scroller, because space inside a scroller
        scrolls away with the content and space on the header does not. */
  [class*="_centerCol"] header {
    padding-bottom: 10px !important;
  }
  [class*="_centerCol"] *:has(> [class*="_column"]) {
    padding: 16px 20px !important;
  }
  /* A reserved scrollbar gutter shows up on one side only, which is exactly what
     an uneven right margin looks like. On a touch screen it carries no
     information anyway. */
  [class*="_centerCol"] [class*="_scrollBody"] {
    scrollbar-width: none;
  }
  [class*="_centerCol"] [class*="_scrollBody"]::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  /* ---- 设置：从桌面式双栏弹层变成整页 ------------------------------------

     Measured at 390px before this existed: the panel was 342px wide, split into a
     188px section nav and a 154px content pane, leaving 106px for rows whose
     labels then wrapped to one character per line. No amount of padding fixes a
     pane that narrow — on a phone the sheet has to become the page.

     Anchored on role="dialog" instead of a module class because that is the part
     that survives an official rebuild, and :has() keeps the treatment from
     reaching any other dialog the client may open. */
  [role="dialog"]:has([class*="_navList"]) {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    max-width: none !important;
    height: 100% !important;
    max-height: none !important;
    border-radius: 0 !important;
    flex-direction: column !important;
    /* The labels and controls inside inherit, so one value here moves the whole
       sheet to the reference's scale instead of leaving it at the desktop 14px. */
    font-size: 16px;
    padding: calc(env(safe-area-inset-top) + 10px) 0 calc(env(safe-area-inset-bottom) + 10px) !important;
  }
  /* Structural, not name-based: the section nav is the panel's first child and
     the content pane its last, so this survives any renaming. */
  [role="dialog"]:has([class*="_navList"]) > * {
    width: auto !important;
    min-width: 0 !important;
  }
  [role="dialog"]:has([class*="_navList"]) > *:first-child {
    flex: none !important;
  }
  [role="dialog"]:has([class*="_navList"]) > *:last-child {
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }
  /* The section list becomes a strip above the content, which is what a phone has
     room for. The padding is tightened until the four sections fit the width at
     this font size rather than relying on the strip scrolling: measured, the
     official cell padding totalled 431px of cells in a 366px strip, which cut the
     last label off mid-word. */
  [role="dialog"] [class*="_navList"] {
    flex-direction: row !important;
    width: 100% !important;
    box-sizing: border-box;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    gap: 4px;
    padding: 0 10px 8px !important;
  }
  [role="dialog"] [class*="_navList"]::-webkit-scrollbar { display: none; }
  [role="dialog"] [class*="_navCell"] {
    flex: 0 0 auto !important;
    width: auto !important;
    white-space: nowrap;
    padding: 0 8px !important;
  }
  [role="dialog"] [class*="_navLabel"] {
    font-size: 15px;
    word-break: normal;
    overflow-wrap: break-word;
  }
  /* Row labels inherit the sheet's size, but their line box was left at normal,
     which reads cramped at 16px. */
  [role="dialog"] [class*="_rowText"] {
    line-height: 1.5;
  }
  /* The close button belongs on the title row, level with 设置. It ships inside
     the content pane's header — which on a full page is a row of its own below
     the section strip, so it floated unattached in the middle of the screen.
     Lifting it to the panel's top-right corner pairs it with the title. */
  [role="dialog"]:has([class*="_navList"]) [class*="_close"] {
    position: absolute !important;
    /* Centred on the title: the panel pads 10px and the section nav another 22px,
       so the title's line box starts at 32px and the 28px button needs 30px to
       share its centre line. */
    top: calc(env(safe-area-inset-top) + 30px) !important;
    right: 12px !important;
  }
}

/* ---- the opened file's header: one bright button ----
   The files tree used to carry a control on every row; that is twenty repeated marks
   down the sidebar, so it moved here, to the header of the file the user actually
   opened. Filled and coloured on purpose: in a row of grey 28px viewer icons this has
   to be the one thing the eye lands on.

   The colour is the theme's *link* token rather than its brand token, which sounds
   backwards and is not: in this client the brand token resolves to near-black
   (rgb(15,17,21)), so a brand-coloured pill reads as one more dark chip.
   The link token is the vivid blue, and it is a token rather than a literal, so a
   different theme still gets its own colour. */
[data-pulse-preview-action] {
  display: inline-flex; align-items: center; gap: 5px;
  flex: none; margin-left: 8px;
  height: 28px; padding: 0 12px; border-radius: 999px;
  font-size: 13px; line-height: 1; text-decoration: none; white-space: nowrap;
  background: var(--dsw-alias-link, #4176e6);
  color: #fff;
}
[data-pulse-preview-action]:hover {
  filter: brightness(1.08);
  color: #fff;
}
[data-pulse-preview-action] .pulse-preview-icon { display: inline-flex; }
[data-pulse-preview-action] svg { display: block; width: 15px; height: 15px; }

/* ---- the conversation's underlined file paths ----
   The control borrows the path's own class so it reads as part of the same
   underline rather than as a chip bolted next to it; only the spacing is ours. */
[data-pulse-file-link-action] { flex: none; margin-left: 10px; }

/* Diagnostics stay available on any width, because the failure they describe is
   invisible by nature — but they only matter where the shell is active. */
.pulse-diag-toggle { display: none; }
.pulse-diag {
  position: fixed; z-index: 90; inset: auto 0 0 0;
  max-height: 60vh; overflow: auto;
  /* The bottom padding clears the toggle, which deliberately sits above this
     panel: the first version had the panel at z-index 90 and the toggle at 50,
     so opening the panel covered the only control that could close it. */
  padding: 14px 16px calc(env(safe-area-inset-bottom) + 48px);
  background: var(--dsw-alias-bg-layer-2, #f5f6f8);
  border-radius: 18px 18px 0 0;
  box-shadow: 0 -12px 40px rgba(0, 0, 0, .35);
  font-size: 12px; line-height: 1.7;
  color: var(--dsw-alias-label-secondary, #4a5160);
}
.pulse-diag[hidden] { display: none; }
.pulse-diag b { color: var(--dsw-alias-label-primary, #14161c); }
.pulse-diag-body { white-space: pre-wrap; word-break: break-word; }
.pulse-diag-close {
  position: absolute; top: 10px; right: 12px;
  padding: 5px 12px;
  border: 0; border-radius: 999px;
  background: rgba(127, 127, 127, .2);
  color: var(--dsw-alias-label-primary, #14161c);
  font-size: 12px; line-height: 1.4;
}

@media (max-width: ${TABLET_MAX_PX}px) {
  .pulse-diag-toggle {
    /* Above the panel it opens, so it stays tappable and doubles as the close
       control once the panel is up. */
    position: fixed; z-index: 95;
    right: calc(env(safe-area-inset-right) + 6px);
    bottom: calc(env(safe-area-inset-bottom) + 6px);
    width: 28px; height: 28px; padding: 0;
    border: 1px solid rgba(127, 127, 127, .3); border-radius: 50%;
    background: rgba(127, 127, 127, .16); color: rgba(127, 127, 127, .85);
    font-size: 13px; line-height: 1;
  }
  html.pulse-has-sidebar .pulse-diag-toggle { display: block; }
}
`;
}

/**
 * Whether a script is safe to embed in a script element.
 *
 * @param {string} source - the script text.
 * @returns {boolean} true when it can be embedded verbatim.
 */
export function isEmbeddableScript(source) {
  return typeof source === 'string' && source.length > 0 && !/<\/script/i.test(source);
}

/**
 * A download-or-forward control on every underlined file path in the conversation.
 *
 * This is the path the user actually reads while the agent works: the `read` /
 * `write` / `edit` rows in the transcript state the file they touched, underlined
 * and dotted, and clicking one opens a preview. What it cannot do is hand the file
 * to the phone, which is the thing the user asks for the moment they see a name they
 * recognise.
 *
 * ## Where the absolute path comes from
 *
 * The DOM carries only the *display* path — `pulse-remote\lib\ui.js`, relative to
 * the workspace — because that is what the row prints. The absolute path the app
 * would open is a React prop on the component, and React keeps a component's props on
 * the DOM node under a generated key, so it is reachable by reading fiber props and
 * walking up a few levels. There is no click-free alternative: the path is not in any
 * attribute, and asking the user to click first would defeat the point.
 *
 * Reading another library's internals is a real cost, so it is fenced in three ways:
 *
 *   * **every resolved path is checked against the row's own text** — the base name
 *     must match, or nothing is injected. A wrong resolution degrades to "no control",
 *     never to a link that quietly downloads a different file;
 *   * the walk is bounded, and if the props are not there the control is simply not
 *     added (the self-check panel reports the count that were skipped);
 *   * the marker attribute is on our own element, so a re-render is detected the same
 *     way as everywhere else in this file.
 *
 * @returns {string} JavaScript source.
 */
export function fileLinkActionsScript() {
  const marker = JSON.stringify(FILE_LINK_ACTION_ATTRIBUTE);
  const unresolved = JSON.stringify(FILE_LINK_UNRESOLVED_ATTRIBUTE);
  const suffix = JSON.stringify(FILE_LINK_SUFFIX);
  const contentPath = JSON.stringify(HOST_FILE_PATH);
  const saveLabel = JSON.stringify('下载');
  const shareLabel = JSON.stringify('转发');
  return `(function () {
  'use strict';
  if (window.__PULSE_FILE_LINKS__) return;
  window.__PULSE_FILE_LINKS__ = true;

  var MARK = ${marker};
  var UNRESOLVED = ${unresolved};
  var SUFFIX = ${suffix};
  var CONTENT = ${contentPath};
  var skipped = 0;

  function inApp() {
    return /PulseApp\\//.test(navigator.userAgent || '');
  }

  function basename(value) {
    // A row may address a line ("file.js:42"); the file is what matters.
    var text = String(value == null ? '' : value).replace(/:[0-9]+$/, '');
    var cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\\\'));
    return cut === -1 ? text : text.slice(cut + 1);
  }

  function isAbsolute(value) {
    return /^([A-Za-z]:[\\\\/]|\\/)/.test(String(value || ''));
  }

  function join(root, relative) {
    var head = String(root).replace(/[\\\\/]+$/, '');
    var tail = String(relative).replace(/:[0-9]+$/, '').replace(/^[\\\\/]+/, '');
    var separator = head.indexOf('\\\\') === -1 ? '/' : '\\\\';
    return head + separator + tail.split(/[\\\\/]/).join(separator);
  }

  /**
   * Read named string props off the React component behind a DOM node, nearest
   * ancestor first. Returns only the names it was asked for.
   */
  function propsAlong(node, wanted) {
    var keys = Object.keys(node);
    var fiber = null;
    for (var index = 0; index < keys.length; index += 1) {
      if (keys[index].indexOf('__reactFiber$') === 0) { fiber = node[keys[index]]; break; }
    }
    var found = {};
    if (!fiber) return found;
    var remaining = wanted.slice();
    for (var depth = 0; fiber && depth < 24 && remaining.length > 0; depth += 1) {
      var props = fiber.memoizedProps;
      if (props) {
        for (var at = 0; at < remaining.length; at += 1) {
          var name = remaining[at];
          if (typeof props[name] === 'string' && props[name]) {
            found[name] = props[name];
            remaining.splice(at, 1);
            at -= 1;
          }
        }
      }
      fiber = fiber.return;
    }
    return found;
  }

  /**
   * The absolute path behind one file link, or an empty string.
   */
  function absolutePath(button) {
    var shown = (button.textContent || '').trim();
    if (!shown || shown.length > 400) return '';
    var wanted = basename(shown);
    if (!wanted) return '';

    var props = propsAlong(button, ['filePath', 'cwd']);
    // The component's own prop, when it names the same file this row prints. This
    // comparison is the operative guard: a prop that disagrees is a prop belonging to
    // some other element further up the tree, and using it would download a file the
    // row never mentioned.
    var candidate = basename(props.filePath) === wanted ? props.filePath : '';
    // Otherwise the row printed a workspace-relative path, and the component two
    // levels up knows the workspace it is relative to.
    if (!candidate && props.cwd && !isAbsolute(shown)) candidate = join(props.cwd, shown);
    // A row may print an absolute path in the first place.
    if (!candidate && isAbsolute(shown)) candidate = shown.replace(/:[0-9]+$/, '');

    // The guard that makes the guess safe: the last segment has to be the file the
    // row names, whatever route produced it.
    return basename(candidate) === wanted ? candidate : '';
  }

  function decorate() {
    var links;
    try {
      links = document.querySelectorAll('button[class*="' + SUFFIX + '"]');
    } catch (error) {
      return;
    }
    skipped = 0;
    for (var index = 0; index < links.length; index += 1) {
      var button = links[index];
      if (button.hasAttribute(MARK)) continue;
      var next = button.nextElementSibling;
      if (next && next.hasAttribute(MARK)) continue;

      // Cleared first: a link that resolves on this pass must not keep a mark from a
      // pass where its props were not mounted yet.
      button.removeAttribute(UNRESOLVED);
      var source = absolutePath(button);
      if (!source) {
        skipped += 1;
        button.setAttribute(UNRESOLVED, '');
        continue;
      }

      var action = document.createElement('a');
      action.setAttribute(MARK, '');
      action.textContent = inApp() ? ${shareLabel} : ${saveLabel};
      action.href = CONTENT + '?path=' + encodeURIComponent(source)
        + (inApp() ? '&share=1' : '&download=1');
      if (!inApp()) action.setAttribute('download', '');
      action.title = source;
      // Borrow the path's own class: same font, same colour, same dotted underline,
      // so it reads as part of the file name rather than as a second control.
      action.className = button.className;
      if (button.parentNode) button.parentNode.insertBefore(action, button.nextSibling);
    }
    window.__PULSE_FILE_LINKS_SKIPPED__ = skipped;
  }
  function boot() {
    decorate();
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () { pending = false; decorate(); });
    }).observe(document.body, {
      childList: true, subtree: true,
      // The header mounts carrying the path it was handed and only afterwards gets the
      // resolved, absolute one — and that arrives as an attribute write on an element
      // that already exists, so watching children alone never saw it. The file then sat
      // with no button until something else re-rendered the pane, which is exactly the
      // "I have to click another header button first" that was reported.
      attributes: true, attributeFilter: ['title'],
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
}

/**
 * The two glyphs the preview button uses, drawn rather than typed.
 *
 * Strokes on a 16-unit grid and `currentColor`, so they take the button's own colour
 * and stay readable at 15px beside a 13px label. A word sits next to each one: the
 * point of this control is to be unmistakable, and an unlabelled glyph in a row of
 * other glyphs is not that.
 */
const SHARE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M8 10.4V1.9"/><path d="M4.7 5.2 8 1.9l3.3 3.3"/>'
  + '<path d="M2.7 9.6v3.1a1.4 1.4 0 0 0 1.4 1.4h7.8a1.4 1.4 0 0 0 1.4-1.4V9.6"/></g></svg>';

const SAVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M8 1.9v8.5"/><path d="M4.7 7.1 8 10.4l3.3-3.3"/><path d="M2.7 12.9h10.6"/></g></svg>';

/**
 * A download-or-forward button in the header of a file the user has opened.
 *
 * ## Why it is here and not on every row
 *
 * The first version put a control on every row of the files tree, so twenty rows
 * carried twenty glyphs down the right edge. Even as icons that is a column of
 * repeated marks competing with the file names, and the user asked for it to move:
 * not on the rows, but in a bright place once a file is actually open. It is also the
 * better moment — by then the file has been chosen, so one unmistakable button beats
 * twenty ambiguous ones.
 *
 * ## Where the path comes from
 *
 * The preview header states it outright: the path element is marked
 * `data-textpreview-path` and its `title` is the absolute path, for the text viewer
 * and the image viewer alike. No name-scraping and no React internals — the same kind
 * of structural hook as the files tree's `data-files-path`, and the probe asserts it
 * is still there in the bundle the client receives.
 *
 * The button goes at the end of that header, after the viewer's own tools: that corner
 * is where a pane keeps its actions, and a filled brand-coloured pill with a word on it
 * cannot be missed in a row of grey 28px icons.
 *
 * @returns {string} JavaScript source.
 */
export function previewActionsScript() {
  const marker = JSON.stringify(PREVIEW_ACTION_ATTRIBUTE);
  const unresolved = JSON.stringify(PREVIEW_UNRESOLVED_ATTRIBUTE);
  const pathAttribute = JSON.stringify(PREVIEW_PATH_ATTRIBUTE);
  const sourceAttribute = JSON.stringify(PREVIEW_SOURCE_ATTRIBUTE);
  const contentPath = JSON.stringify(HOST_FILE_PATH);
  const saveLabel = JSON.stringify('下载');
  const shareLabel = JSON.stringify('转发');
  const shareIcon = JSON.stringify(SHARE_ICON);
  const saveIcon = JSON.stringify(SAVE_ICON);
  return `(function () {
  'use strict';
  if (window.__PULSE_PREVIEW__) return;
  window.__PULSE_PREVIEW__ = true;

  var MARK = ${marker};
  var UNRESOLVED_MARK = ${unresolved};
  var PATH_MARK = ${pathAttribute};
  var SOURCE_MARK = ${sourceAttribute};
  var CONTENT = ${contentPath};
  var SHARE_ICON = ${shareIcon};
  var SAVE_ICON = ${saveIcon};

  function inApp() {
    // The app names itself in the user agent; a browser has no share sheet.
    return /PulseApp\\//.test(navigator.userAgent || '');
  }

  /** Whether the header resolved this path to a real absolute one. */
  function isAbsolute(value) {
    return /^([A-Za-z]:[\\\\/]|\\/)/.test(String(value || ''));
  }

  /**
   * Point an existing control at a path the header now shows.
   *
   * The node is kept rather than replaced: it is already in the right place in the
   * row, and replacing it would make the button flicker on every re-render.
   *
   * @param {Element} action - the control this shell injected.
   * @param {string} source - the header's current absolute path.
   * @returns {void}
   */
  function retarget(action, source) {
    var app = inApp();
    action.setAttribute(SOURCE_MARK, source);
    action.setAttribute('aria-label', (app ? ${shareLabel} : ${saveLabel}) + ' ' + source);
    action.title = action.getAttribute('aria-label');
    action.href = CONTENT + '?path=' + encodeURIComponent(source)
      + (app ? '&share=1' : '&download=1');
    if (app) action.removeAttribute('download');
    else action.setAttribute('download', '');
  }

  function decorate() {
    var paths;
    try {
      paths = document.querySelectorAll('[' + PATH_MARK + ']');
    } catch (error) {
      return;
    }
    for (var index = 0; index < paths.length; index += 1) {
      var pathNode = paths[index];
      var source = String(pathNode.getAttribute('title') || '').trim();
      // The header is the row that holds the path and the viewer's own tools; the
      // button belongs in that row, not inside the path element.
      var header = pathNode.parentElement;
      if (!header) continue;
      var existing = header.querySelector('[' + MARK + ']');
      // The header falls back to whatever the opener handed it — a workspace-relative
      // path — when the host cannot resolve the file. There is nothing to forward in
      // that case: the host's own file route answers 400 for a relative path, so a
      // button here would be a control that always fails. Marked rather than ignored,
      // so "no button" and "never looked" stay distinguishable.
      pathNode.removeAttribute(UNRESOLVED_MARK);
      if (!source || !isAbsolute(source)) {
        if (source) pathNode.setAttribute(UNRESOLVED_MARK, '');
        // A header that used to resolve and now does not must not keep offering the
        // path it resolved to before.
        if (existing) existing.remove();
        continue;
      }
      if (existing) {
        // The host canonicalises the path after mounting — the same file arrives once
        // with forward slashes and once with backslashes, and a transcript link's path
        // can be replaced outright. Skipping whenever a button exists is how one kept
        // pointing at the *previous* value: the probe caught exactly that, a header
        // reading one spelling beside a button opening the other.
        if (existing.getAttribute(SOURCE_MARK) !== source) retarget(existing, source);
        continue;
      }

      var action = document.createElement('a');
      action.setAttribute(MARK, '');
      action.setAttribute(SOURCE_MARK, source);
      action.setAttribute('aria-label', (inApp() ? ${shareLabel} : ${saveLabel}) + ' ' + source);
      action.title = action.getAttribute('aria-label');
      action.href = CONTENT + '?path=' + encodeURIComponent(source)
        + (inApp() ? '&share=1' : '&download=1');
      if (!inApp()) action.setAttribute('download', '');
      action.innerHTML = '<span class="pulse-preview-icon">' + (inApp() ? SHARE_ICON : SAVE_ICON) + '</span>'
        + '<span>' + (inApp() ? ${shareLabel} : ${saveLabel}) + '</span>';
      header.appendChild(action);
    }
  }

  function boot() {
    decorate();
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () { pending = false; decorate(); });
    }).observe(document.body, {
      childList: true, subtree: true,
      // The header mounts carrying the path it was handed and only afterwards gets the
      // resolved, absolute one — and that arrives as an attribute write on an element
      // that already exists, so watching children alone never saw it. The file then sat
      // with no button until something else re-rendered the pane, which is exactly the
      // "I have to click another header button first" that was reported.
      attributes: true, attributeFilter: ['title'],
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
}


/**
 * A download-or-forward control beside each file on an official deliverables card.
 *
 * The card's own dropdown is not extensible — its items are built inside
 * @deepseek-ai/dsh-client-ui-deliverables, with their labels in that plugin's own
 * dictionary — so this is DOM inserted into a React subtree. React removes foreign
 * nodes, so the observer puts it back, and the verification script checks that it
 * survives a re-render rather than assuming it does.
 *
 * ## The path is stored in two forms, and only one was handled at first
 *
 * `PresentedFileCard` renders `aria-label="在侧边栏打开 {file.path}"`, and `file.path`
 * is whatever the tool recorded: a `write` with an absolute path leaves an absolute
 * one, while `present` of `pulse-android/dist/app.apk` leaves a *relative* one. The
 * first version of this only accepted a path that looked like `C:\…` or `/…`, so
 * every relative card silently got no control at all — the worst kind of failure,
 * because the card looked normal and the button simply was not there. The user hit
 * exactly that, on the card for the APK, which had been presented with a relative
 * path.
 *
 * So the resolution now tries, in order: the card's own tooltip (which the component
 * fills with `resolveWorkspacePath(cwd, file.path)`, i.e. already absolute), any
 * absolute path in an accessible name, and finally the relative path joined to the
 * workspace the component carries as a `cwd` prop. Whatever the route, the result has
 * to name the same file the card prints (`_fileName`), or nothing is injected.
 *
 * @returns {string} JavaScript source.
 */
export function deliverableActionsScript() {
  const anchorSuffix = JSON.stringify(MENU_ANCHOR_SUFFIX);
  const pathsSuffix = JSON.stringify(SUMMARY_PATH_SUFFIX);
  const marker = JSON.stringify(DELIVERABLE_ACTION_ATTRIBUTE);
  const source = JSON.stringify(DELIVERABLE_PATH_ATTRIBUTE);
  const rowAttribute = JSON.stringify('data-presented-file');
  const contentPath = JSON.stringify(HOST_FILE_PATH);
  const saveLabel = JSON.stringify('下载');
  const shareLabel = JSON.stringify('转发');
  /**
   * How many summary controls one row may carry.
   *
   * The official row prints every path of the call, joined with `", "`, in a single
   * `_paths` span styled to ellipsis — so an unbounded set of controls would push the
   * filenames out of sight. Four covers every delivery that has actually been made
   * here; past that the row keeps the first four and the rest stay reachable from the
   * opened file's own header.
   */
  const summaryLimit = 4;
  return `(function () {
  'use strict';
  if (window.__PULSE_DELIVERABLES__) return;
  window.__PULSE_DELIVERABLES__ = true;

  var ANCHOR = ${anchorSuffix};
  var PATHS = ${pathsSuffix};
  var MARK = ${marker};
  var SOURCE = ${source};
  var ROW = ${rowAttribute};
  var CONTENT = ${contentPath};
  var LIMIT = ${summaryLimit};

  function inApp() {
    // The app names itself in the user agent; a browser has no share sheet.
    return /PulseApp\\//.test(navigator.userAgent || '');
  }

  function basename(value) {
    var text = String(value == null ? '' : value).replace(/:[0-9]+$/, '').trim();
    var cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\\\'));
    return cut === -1 ? text : text.slice(cut + 1);
  }

  function isAbsolute(value) {
    return /^([A-Za-z]:[\\\\/]|\\/)/.test(String(value || '').trim());
  }

  function join(root, relative) {
    var head = String(root).replace(/[\\\\/]+$/, '');
    var tail = String(relative).replace(/^[\\\\/]+/, '');
    var separator = head.indexOf('\\\\') === -1 ? '/' : '\\\\';
    return head + separator + tail.split(/[\\\\/]/).join(separator);
  }

  /**
   * Pull an absolute path out of an accessible name.
   *
   * The label may be the path alone or a sentence around it, and a Windows path
   * contains spaces, so the path is everything from where it starts.
   *
   * @param {string} text - the accessible name.
   * @returns {string} the path, or an empty string.
   */
  function pathIn(text) {
    if (!text) return '';
    var drive = /[A-Za-z]:[\\\\/]/.exec(text);
    if (drive) return text.slice(drive.index).trim();
    var rooted = /(?:^|\\s)(\\/[^\\s].*)$/.exec(text);
    return rooted ? rooted[1].trim() : '';
  }

  /**
   * The path-shaped tail of a sentence like 在侧边栏打开 pulse-android/dist/app.apk.
   *
   * Only the last word is considered, and it has to contain a separator; that is
   * enough to pick the path out of a localized sentence without depending on the
   * wording, which is the plugin's to change.
   *
   * @param {string} text - the accessible name.
   * @returns {string} the relative path, or an empty string.
   */
  function relativeIn(text) {
    if (!text) return '';
    var token = String(text).trim().split(/\\s+/).pop() || '';
    if (isAbsolute(token)) return '';
    if (token.indexOf('/') === -1 && token.indexOf('\\\\') === -1) return '';
    return token;
  }

  /** Read named string props off the React component behind a DOM node. */
  function propsAlong(node, wanted) {
    var keys = Object.keys(node);
    var fiber = null;
    for (var index = 0; index < keys.length; index += 1) {
      if (keys[index].indexOf('__reactFiber$') === 0) { fiber = node[keys[index]]; break; }
    }
    var found = {};
    if (!fiber) return found;
    var remaining = wanted.slice();
    for (var depth = 0; fiber && depth < 24 && remaining.length > 0; depth += 1) {
      var props = fiber.memoizedProps;
      if (props) {
        for (var at = 0; at < remaining.length; at += 1) {
          var name = remaining[at];
          if (typeof props[name] === 'string' && props[name]) {
            found[name] = props[name];
            remaining.splice(at, 1);
            at -= 1;
          }
        }
      }
      fiber = fiber.return;
    }
    return found;
  }

  /**
   * The absolute path for one card row, or an empty string.
   *
   * @param {Element} row - the [data-presented-file] element.
   * @param {Element} split - the button pill inside it.
   * @returns {string} the path, or an empty string.
   */
  function absolutePath(row, split) {
    var nameNode = row.querySelector('[class*="_fileName"]');
    var wanted = nameNode ? basename(nameNode.textContent || '') : '';

    /** Only the file the row prints, or nothing. */
    var accept = function (candidate) {
      if (!candidate) return '';
      return !wanted || basename(candidate) === wanted ? candidate : '';
    };

    // 1. The card resolved it for its own tooltip; nothing to reconstruct.
    var preview = row.querySelector('[class*="_cardPreview"]');
    var title = preview ? String(preview.getAttribute('title') || '').trim() : '';
    if (isAbsolute(title)) return accept(title);

    // 2. An accessible name that already carries an absolute path.
    var labelled = row.querySelectorAll('[aria-label],[title]');
    for (var index = 0; index < labelled.length; index += 1) {
      var node = labelled[index];
      var found = pathIn(node.getAttribute('aria-label') || '')
        || pathIn(node.getAttribute('title') || '');
      if (found) return accept(found);
    }

    // 3. A relative path, joined to the workspace the component knows.
    var open = split.querySelector('[class*="_open"]') || preview;
    var relative = relativeIn(open ? open.getAttribute('aria-label') : '')
      || relativeIn(row.getAttribute('aria-label') || '')
      || relativeIn(title);
    if (relative) {
      var props = propsAlong(row, ['cwd']);
      if (props.cwd) return accept(join(props.cwd, relative));
    }
    return '';
  }

  /**
   * The paths a present call printed in its collapsed summary.
   *
   * The tool row reads 交付文件 · 已交付 pulse-android/dist/pulse-remote.apk. It is a
   * different half of the same module from the turn-tail card: the card is registered in
   * the conversation.chat.turnTail slot, while this row is the present tool view, and it
   * prints the delivered paths whether or not the card is anywhere on screen. So
   * decorating the card alone left a delivered file with no control on any client that
   * was looking at this row — which is what the phone was doing. Measured on the live
   * session at both widths.
   *
   * The printed paths are workspace-relative, so they are joined to the cwd the
   * tool-call host carries.
   *
   * The official renderer is args.files.map(file => file.path).join(", "), read off
   * @deepseek-ai/dsh-client-ui-deliverables, so the separator is a literal comma-space —
   * but it is split loosely, because a filename may itself contain a comma and a miss
   * here only costs one control.
   *
   * @param {Element} span - a _paths element from the present tool's summary.
   * @returns {string[]} absolute paths, in printed order, without duplicates.
   */
  function pathsFromSummary(span) {
    var shown = (span.textContent || '').trim();
    if (!shown || shown.length > 600) return [];
    var tokens = shown.split(/\\s*,\\s*/);
    var props = propsAlong(span.closest('[class*="_row"]') || span, ['cwd']);
    var out = [];
    for (var index = 0; index < tokens.length && out.length < LIMIT; index += 1) {
      var token = tokens[index].trim();
      if (!token || token.length > 300) continue;
      var candidate = '';
      if (isAbsolute(token)) {
        candidate = token;
      } else {
        var relative = relativeIn(token) || token;
        if (relative.indexOf('/') === -1 && relative.indexOf('\\\\') === -1) continue;
        // No workspace to resolve against means no control: a wrong link is worse than
        // a missing one, which is the rule everywhere else in this file too.
        if (!props.cwd) continue;
        candidate = join(props.cwd, relative);
      }
      // Same guard as the card route: the last segment has to be the file that was
      // printed, or nothing is offered.
      if (basename(candidate) !== basename(token)) continue;
      if (out.indexOf(candidate) === -1) out.push(candidate);
    }
    return out;
  }

  function decorate() {
    var anchors;
    try { anchors = document.querySelectorAll('[class*="' + ANCHOR + '"]'); } catch (error) { return; }
    for (var index = 0; index < anchors.length; index += 1) {
      var anchor = anchors[index];
      // Only the innermost match. The suffix test also catches a wrapper whose name
      // merely starts the same way, and one control per wrapper plus one per anchor
      // is how a single card ended up with two of them side by side.
      if (anchor.querySelector('[class*="' + ANCHOR + '"]')) continue;
      var split = anchor.parentElement;
      if (!split || split.querySelector('[' + MARK + ']')) continue;
      var row = anchor.closest('[' + ROW + ']') || split.parentElement || split;

      var source = absolutePath(row, split);
      if (!source) continue;

      var action = document.createElement('a');
      action.setAttribute(MARK, '');
      action.textContent = inApp() ? ${shareLabel} : ${saveLabel};
      action.href = CONTENT + '?path=' + encodeURIComponent(source)
        + (inApp() ? '&share=1' : '&download=1');
      if (!inApp()) action.setAttribute('download', '');
      action.title = source;
      // Borrow the neighbouring control's own class rather than inventing a look:
      // the pill's styles are generated per build, so copying the class is both the
      // way to sit inside it and the only way to stay in step with them. Only
      // spacing is ours.
      var openButton = split.querySelector('[class*="_open"]');
      if (openButton) action.className = openButton.className;
      action.style.marginRight = '8px';
      split.insertBefore(action, anchor);
    }

    // ... and the same control on the *collapsed* row that announced the delivery, so
    // the file can be downloaded without first expanding a tool call to find its card.
    var summaries;
    try { summaries = document.querySelectorAll('[class*="' + PATHS + '"]'); } catch (error) { return; }
    for (var scan = 0; scan < summaries.length; scan += 1) {
      var span = summaries[scan];
      var line = span.closest('[class*="_row"]') || span.parentElement;
      if (!line) continue;
      var printed = pathsFromSummary(span);
      if (printed.length === 0) continue;

      // One control per printed path, so the guard has to be per path rather than per
      // row — the first control already marks the row.
      var taken = {};
      var mine = line.querySelectorAll('[' + SOURCE + ']');
      for (var seen = 0; seen < mine.length; seen += 1) {
        taken[mine[seen].getAttribute(SOURCE)] = true;
      }

      for (var at = 0; at < printed.length; at += 1) {
        if (taken[printed[at]]) continue;
        var button = document.createElement('a');
        button.setAttribute(MARK, '');
        button.setAttribute(SOURCE, printed[at]);
        button.textContent = inApp() ? ${shareLabel} : ${saveLabel};
        button.href = CONTENT + '?path=' + encodeURIComponent(printed[at])
          + (inApp() ? '&share=1' : '&download=1');
        if (!inApp()) button.setAttribute('download', '');
        button.title = printed[at];
        // The row is a disclosure button that expands the call on any click inside it,
        // so taking the tap stops the row from toggling underneath the download.
        button.addEventListener('click', function (event) { event.stopPropagation(); });
        // Styled off the official _inspect control's own tokens rather than invented:
        // an unstyled anchor would arrive blue and underlined next to the row's type.
        button.style.marginLeft = '8px';
        button.style.flex = '0 0 auto';
        button.style.color = 'var(--dsw-alias-link, #4176e6)';
        button.style.font = 'inherit';
        button.style.fontSize = '12px';
        button.style.textDecoration = 'none';
        button.style.whiteSpace = 'nowrap';
        // When the call is expanded the official 查看 button is right there, and its
        // class is the better answer than any styling of mine.
        var inspectButton = line.querySelector('[class*="_inspect"]');
        if (inspectButton && typeof inspectButton.className === 'string' && inspectButton.className) {
          button.className = inspectButton.className;
        }
        line.appendChild(button);
      }
    }
  }

  function boot() {
    decorate();
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () { pending = false; decorate(); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
}

/**
 * The mobile shell script, injected into the page as a body row.
 *
 * @returns {string} JavaScript source.
 */
export function mobileShellScript() {
  const sidebarSuffix = JSON.stringify(SIDEBAR_COLUMN_SUFFIX);
  const collapsedSuffix = JSON.stringify(COLLAPSED_MARKER_SUFFIX);
  const centerSuffix = JSON.stringify(CENTER_COLUMN_SUFFIX);
  const rightbarSuffix = JSON.stringify(RIGHTBAR_COLUMN_SUFFIX);
  const frameSuffix = JSON.stringify(FRAME_SUFFIX);
  const footSuffix = JSON.stringify(FOOT_SUFFIX);
  const toggleOpen = JSON.stringify(SIDEBAR_TOGGLE_LABELS.open);
  const toggleClose = JSON.stringify(SIDEBAR_TOGGLE_LABELS.close);
  const attachLabels = JSON.stringify(ATTACH_LABELS);
  const drawerAttribute = JSON.stringify(DRAWER_ATTRIBUTE);
  const rightbarEmptyAttribute = JSON.stringify(RIGHTBAR_EMPTY_ATTRIBUTE);
  const fileLinkMark = JSON.stringify(FILE_LINK_ACTION_ATTRIBUTE);
  const fileLinkUnresolved = JSON.stringify(FILE_LINK_UNRESOLVED_ATTRIBUTE);
  const headerActionsSuffix = JSON.stringify(HEADER_ACTIONS_SUFFIX);
  const headerTabsSuffix = JSON.stringify(HEADER_TABS_SUFFIX);
  const headerClusterSuffix = JSON.stringify(HEADER_CLUSTER_SUFFIX);
  const headerTitleRowSuffix = JSON.stringify(HEADER_TITLE_ROW_SUFFIX);
  const headerCrumbSegSuffix = JSON.stringify(HEADER_CRUMB_SEG_SUFFIX);
  const headerLineageSlot = JSON.stringify(HEADER_LINEAGE_SLOT);
  const headerLineageAttribute = JSON.stringify(HEADER_LINEAGE_ATTRIBUTE);
  const headerGroupAttribute = JSON.stringify(HEADER_GROUP_ATTRIBUTE);
  const headerGroupGap = HEADER_GROUP_GAP_PX;
  const headerActionsAttribute = JSON.stringify(HEADER_ACTIONS_ATTRIBUTE);
  const tabletMax = TABLET_MAX_PX;
  const anchorsForReport = JSON.stringify(SHELL_ANCHORS.map(anchor => anchor.prefix).join('  '));
  return `(function () {
  'use strict';
  if (window.__PULSE_SHELL__) return;
  window.__PULSE_SHELL__ = true;

  var SIDEBAR_SUFFIX = ${sidebarSuffix};
  var COLLAPSED_SUFFIX = ${collapsedSuffix};
  var CENTER_SUFFIX = ${centerSuffix};
  var RIGHTBAR_SUFFIX = ${rightbarSuffix};
  var FRAME_SUFFIX = ${frameSuffix};
  var TOGGLE_OPEN = ${toggleOpen};
  var TOGGLE_CLOSE = ${toggleClose};
  var ATTACH_LABELS = ${attachLabels};
  var DRAWER_ATTR = ${drawerAttribute};
  var RIGHTBAR_EMPTY_ATTR = ${rightbarEmptyAttribute};
  var FILE_LINK_MARK = ${fileLinkMark};
  var FILE_LINK_UNRESOLVED = ${fileLinkUnresolved};
  var HEADER_ACTIONS_SUFFIX = ${headerActionsSuffix};
  var HEADER_TABS_SUFFIX = ${headerTabsSuffix};
  var HEADER_CLUSTER_SUFFIX = ${headerClusterSuffix};
  var HEADER_TITLE_ROW_SUFFIX = ${headerTitleRowSuffix};
  var HEADER_CRUMB_SEG_SUFFIX = ${headerCrumbSegSuffix};
  var HEADER_LINEAGE_SLOT = ${headerLineageSlot};
  var HEADER_LINEAGE_MARK = ${headerLineageAttribute};
  var HEADER_GROUP_MARK = ${headerGroupAttribute};
  var HEADER_GROUP_GAP = ${headerGroupGap};
  var BURGER_PLACED = 'data-pulse-placed';
  var HEADER_ACTIONS_MARK = ${headerActionsAttribute};
  var MOVED_TO_TABS = 'tabs';
  var TABLET_MAX = 900;

  var state = {
    active: false, width: 0, sidebar: false, expanded: false,
    attach: false, attachLabel: '', frame: false, center: false, corner: false,
    rightbar: false, rightbarEmpty: false, headerActions: 'row', headerActionsHome: null,
    burger: 'chrome',
    movesIn: 0, movesBack: 0, refreshes: 0, syncs: 0, notes: []
  };

  function note(message) {
    state.notes.push(message);
    if (state.notes.length > 8) state.notes.shift();
  }
  function one(selector) {
    try { return document.querySelector(selector); } catch (error) { return null; }
  }
  function all(selector) {
    try { return Array.prototype.slice.call(document.querySelectorAll(selector)); } catch (error) { return []; }
  }
  function withSuffix(suffix) { return all('[class*="' + suffix + '"]'); }

  /** The sidebar column, found by the stable half of its generated class name. */
  function sidebarColumn() { return one('[class*="' + SIDEBAR_SUFFIX + '"]'); }

  /**
   * Whether a node is one of ours.
   *
   * Two homes, not one: the chrome container outside the client's root, and the hamburger,
   * which is moved **into** the client's header on mobile. Missing the second one is not
   * cosmetic — the hamburger carries the same accessible name as the official sidebar
   * toggle, so a search for that control finds ours, presses it, and recurses.
   *
   * @param {Element} node - the candidate.
   * @returns {boolean} true when the node belongs to this shell.
   */
  function isMine(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest('[data-pulse="chrome"]') || node.closest('[data-pulse="burger"]'));
  }

  /**
   * Whether a node belongs to this shell rather than to the official client.
   *
   * Load-bearing: our own hamburger carries the same accessible name as the
   * official control, so a plain query for that name finds the hamburger as soon
   * as the client relabels its own button — and pressing it would press itself.
   * @param {Element} node - the candidate.
   * @returns {boolean} true when the node is not ours.
   */
  function isOfficial(node) {
    return !isMine(node);
  }

  /** The official toggle, in whichever direction it currently offers. */
  function toggleButton() {
    var candidates = all('button[aria-label="' + TOGGLE_OPEN + '"], button[aria-label="' + TOGGLE_CLOSE + '"]');
    for (var index = 0; index < candidates.length; index += 1) {
      if (isOfficial(candidates[index])) return candidates[index];
    }
    return null;
  }

  /**
   * Whether the sidebar is currently expanded.
   * The client marks the collapsed rail with a class, so the absence of that
   * marker inside the column means the real session list is showing.
   */
  function sidebarExpanded() {
    var column = sidebarColumn();
    if (!column) return false;
    return !column.querySelector('[class*="' + COLLAPSED_SUFFIX + '"]');
  }

  /** The official attach control, by accessible name rather than by class. */
  function attachControl() {
    // Each label is escaped on its own, then joined with a pipe. Escaping the
    // joined string instead would escape the alternation itself — the standard
    // regex escape set includes the pipe — leaving one literal that matches
    // nothing, which is exactly as silent as it sounds.
    var matcher = new RegExp(ATTACH_LABELS.map(function (label) {
      return label.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    }).join('|'), 'i');
    var candidates = all('button, [role="button"], label, a, span[title]');
    for (var index = 0; index < candidates.length; index += 1) {
      var node = candidates[index];
      var name = ((node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '')).trim();
      if (name.length > 1 && name.length < 60 && matcher.test(name)) {
        state.attachLabel = name.slice(0, 24);
        return node;
      }
    }
    return null;
  }

  function shouldActivate() {
    if (/[?&]pulse=mobile\\b/.test(location.search)) return true;
    if (/PulseApp/.test(navigator.userAgent)) return true;
    return window.innerWidth <= TABLET_MAX;
  }

  // ---- our own chrome, outside the client's React root ----------------------

  var chrome = null;
  var burger = null;
  var scrim = null;
  var diagToggle = null;
  var diagPanel = null;
  var diagBody = null;
  var diagClose = null;

  /**
   * Drive the official toggle, and say so when it cannot be found.
   * Everything about the sidebar's contents stays the official implementation;
   * this only presses the button the client already ships.
   */
  function clickToggle() {
    var button = toggleButton();
    if (!button) {
      note('找不到官方的「打开侧边栏」按钮');
      showDiag();
      return;
    }
    button.click();
  }

  function build() {
    if (chrome) return;

    chrome = document.createElement('div');
    chrome.className = 'pulse-chrome';
    chrome.setAttribute('data-pulse', 'chrome');

    scrim = document.createElement('div');
    scrim.className = 'pulse-scrim';
    scrim.addEventListener('click', function () { if (sidebarExpanded()) clickToggle(); });

    burger = document.createElement('button');
    burger.type = 'button';
    burger.className = 'pulse-burger';
    // Marked as ours in its own right: on mobile this node is moved into the client's
    // header, where "inside the chrome container" no longer describes it.
    burger.setAttribute('data-pulse', 'burger');
    burger.setAttribute('aria-label', TOGGLE_OPEN);
    // Drawn rather than the U+2630 glyph: the glyph's ink size is a property of
    // the font, so it could not be sized deliberately against the title beside it.
    // 20px against the header's 17px text — a little larger, as asked — with heavy
    // strokes so it reads as three solid bars rather than a faint glyph.
    burger.innerHTML = '<svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">'
      + '<path d="M3 6h16M3 11h16M3 16h16" fill="none" stroke="currentColor"'
      + ' stroke-width="2.9" stroke-linecap="round"/></svg>';
    burger.addEventListener('click', clickToggle);

    diagToggle = document.createElement('button');
    diagToggle.type = 'button';
    diagToggle.className = 'pulse-diag-toggle';
    diagToggle.setAttribute('aria-label', '移动外壳自检');
    diagToggle.textContent = '?';
    diagToggle.addEventListener('click', function () { setDiagOpen(Boolean(diagPanel && diagPanel.hidden)); });

    diagPanel = document.createElement('div');
    diagPanel.className = 'pulse-diag';
    diagPanel.hidden = true;

    // The text goes in its own element so that re-rendering it cannot delete the
    // close button sitting beside it.
    diagBody = document.createElement('div');
    diagBody.className = 'pulse-diag-body';

    diagClose = document.createElement('button');
    diagClose.type = 'button';
    diagClose.className = 'pulse-diag-close';
    diagClose.textContent = '关闭';
    diagClose.addEventListener('click', function () { setDiagOpen(false); });

    diagPanel.appendChild(diagBody);
    diagPanel.appendChild(diagClose);

    chrome.appendChild(scrim);
    chrome.appendChild(burger);
    chrome.appendChild(diagToggle);
    chrome.appendChild(diagPanel);
    document.body.appendChild(chrome);
  }

  // ---- state mirroring ------------------------------------------------------

  /** Tag the sidebar column and mirror the official expanded state onto html. */
  function syncSidebar() {
    var column = sidebarColumn();
    state.sidebar = Boolean(column);
    if (!column) {
      document.documentElement.classList.remove('pulse-has-sidebar', 'pulse-drawer-open');
      return;
    }
    if (!column.hasAttribute(DRAWER_ATTR)) column.setAttribute(DRAWER_ATTR, '');
    document.documentElement.classList.add('pulse-has-sidebar');
    state.expanded = sidebarExpanded();
    document.documentElement.classList.toggle('pulse-drawer-open', state.expanded);
  }


  /**
   * Mark a right rail that holds nothing, so it stops reserving width.
   *
   * "Empty" is judged by content, not by width or a class name: a rail that
   * happens to be 0px wide right now is still worth tagging, and one holding a
   * preview must never be hidden. The tag is removed as soon as anything
   * interactive, textual or graphical appears.
   */
  function syncRightbar() {
    var rail = one('[class*="' + RIGHTBAR_SUFFIX + '"]');
    state.rightbar = Boolean(rail);
    if (!rail) { state.rightbarEmpty = false; return; }
    var content = rail.querySelectorAll('button, [role="button"], a, input, textarea, select, svg, img, canvas, video');
    var empty = content.length === 0 && (rail.textContent || '').trim().length === 0;
    state.rightbarEmpty = empty;
    if (empty) rail.setAttribute(RIGHTBAR_EMPTY_ATTR, '');
    else rail.removeAttribute(RIGHTBAR_EMPTY_ATTR);
  }

  /** Enlarge the official attach control's hit area, once it appears. */
  function syncAttach() {
    var control = attachControl();
    state.attach = Boolean(control);
    if (control) control.classList.add('pulse-attach-target');
  }

  /**
   * Whether the client already owns the corner the hamburger sits in.
   *
   * Asked geometrically, not by looking for a particular class. The first attempt
   * looked for the client's tab-close button, which was too broad in one direction
   * and too narrow in the other: that button appears in the conversation too, once
   * a session is open, so the hamburger would have hidden itself on the main
   * screen; and any other client control landing there would have been missed.
   *
   * What actually matters is whether a tap in that corner would reach the client
   * instead of us, so that is what is measured. The point is fixed rather than
   * taken from the button's own box: once the button is hidden its box is empty,
   * and measuring a moving target would make the rule oscillate. The numbers match
   * the stylesheet (left 6 + half of 40, top 13 + half of 40).
   *
   * @returns {boolean} true when something the client owns is in the way.
   */
  function cornerTaken() {
    if (!burger) return false;
    // jsdom does not implement hit testing, and this rule is pure geometry: with no
    // way to hit-test, the honest answer is "cannot tell" rather than an exception
    // that takes the whole shell down. scripts/verify-mobile-shell.mjs proves both
    // directions of it in a real engine.
    var root = document.getElementById('root');
    if (!root) return false;
    var x = 26;
    var y = 33;
    var stack = [];
    if (typeof document.elementsFromPoint === 'function') stack = document.elementsFromPoint(x, y);
    else if (typeof document.elementFromPoint === 'function') stack = [document.elementFromPoint(x, y)];
    for (var index = 0; index < stack.length; index += 1) {
      var node = stack[index];
      if (!node || !node.closest) continue;
      // Our own chrome is skipped rather than hidden. elementsFromPoint returns the
      // whole stack at that point, topmost first, so what sits *under* the hamburger is
      // already known — no visibility flip, no forced style recalculation, and
      // therefore no reason to throttle the answer. The hamburger itself counts as ours
      // here too: it lives in the header now, and reporting "something official is in the
      // corner" because of our own button would be a lie the panel repeats.
      if (isMine(node)) continue;
      if (!root.contains(node)) continue;
      // The first thing of the client's that a tap would reach decides it. Anything
      // interactive there means the client owns the corner and we get out of its way.
      return Boolean(node.closest('button, a, [role="button"], [role="tab"], [class*="_tab_"]'));
    }
    return false;
  }

  /**
   * Show the hamburger only where the client is not already using that corner.
   *
   * Re-derived on every mutation, so leaving the client's tab view brings it back.
   *
   * This used to be throttled to one probe per 250ms with a trailing call, because the
   * probe hid the button and re-showed it — which invalidates style and forces layout,
   * so running it on every frame of a streaming reply was genuinely expensive. It was
   * also visibly slow: tapping into the right panel left the hamburger on screen for a
   * quarter of a second before it disappeared, and the same again on the way back.
   * Reading the hit stack instead removes the reason for the throttle rather than
   * trading one problem for the other.
   */
  function syncCorner() {
    var taken = cornerTaken();
    if (taken === state.corner
      && document.documentElement.classList.contains('pulse-corner-taken') === taken) return;
    state.corner = taken;
    document.documentElement.classList.toggle('pulse-corner-taken', taken);
  }

  // ---- the header's action chips -------------------------------------------
  //
  // Measured on the real page at 390px, on the conversation whose header was full:
  //
  //   titleRow 342 ── titleCluster 182 [ crumbs(title) 0px | headerActions 226 ]
  //                ── headerUtilities 88
  //                ── headerCorner 28
  //   tabs     342 ── 对话 26 + gap 36 + 轨迹 26 = 88, so 254px unused
  //
  // The title was squeezed to zero width and the chips drew over each other. The strip
  // below is the same width and almost empty, so the chips move down there and the
  // title gets its row back.

  /**
   * Every action wrapper that belongs to the session header, with its strip.
   *
   * **There is more than one wrapper, and that is the point.** The slot host renders one
   * headerActions per contribution: with a background job running, the mode chip and the
   * jobs chip arrive as two siblings of the same class — measured as two entries, both
   * sitting in wSkVaW_titleCluster — so placing "the container" moved one of them and left
   * the other behind. Everything here therefore works on the list.
   *
   * The subagent count chip is a third contribution, and it does not live in a
   * _headerActions wrapper at all: the client renders the lineage slot inside the title's
   * crumb segment, which is why it stayed behind when the others moved. It is picked up by
   * its own data-slot marker — a name the plugin system itself relies on, so it is a
   * better contract than any generated class.
   *
   * The pairing is required rather than assumed: a wrapper is only accepted when the
   * element holding it also holds a tab strip. Another module's header actions would
   * otherwise be dropped into a strip that has nothing to do with it, and querySelector
   * match order is not a contract.
   *
   * @returns {Array<{actions: Element, tabs: Element, header: Element, cluster: Element,
   *   lineage: ?Element, lineageHome: ?Element}>} the wrappers.
   */
  function headerRows() {
    var out = [];
    var candidates = withSuffix(HEADER_ACTIONS_SUFFIX);
    for (var index = 0; index < candidates.length; index += 1) {
      var actions = candidates[index];
      var header = actions.closest('header');
      if (!header) continue;
      var tabs = header.querySelector('[class*="' + HEADER_TABS_SUFFIX + '"]');
      if (!tabs) continue;
      // Where a wrapper belongs when this shell is not placing it. Derived from the header
      // every time rather than remembered: the client rebuilds this header for a different
      // width, and a remembered parent is then a detached node that can neither receive the
      // wrapper back nor be recognised as gone.
      var cluster = header.querySelector('[class*="' + HEADER_CLUSTER_SUFFIX + '"]') || tabs;
      // The subagent count chip: the slot's own marker, and the crumb segment it belongs to
      // (derived by class, for the same reason the cluster is — a remembered parent goes
      // stale when the client rebuilds the header).
      var lineage = header.querySelector('[data-slot*="' + HEADER_LINEAGE_SLOT + '"]');
      var lineageHome = header.querySelector('[class*="' + HEADER_CRUMB_SEG_SUFFIX + '"]') || tabs;
      out.push({
        actions: actions, tabs: tabs, header: header, cluster: cluster,
        lineage: lineage, lineageHome: lineageHome,
      });
    }
    return out;
  }

  /**
   * Everything this shell moves into the strip, in the order it should appear there.
   *
   * The subagent count comes first, then the action wrappers — which is what "next to the
   * mode chip" means, and the order they keep inside the group. One list, because width,
   * collision, placement and the way back all have to agree on the same set.
   *
   * The crumb segment is where the lineage chip belongs to when it is not moved, and it is
   * derived from the header every pass rather than remembered: the client rebuilds this
   * header for a different session, and a remembered parent is then a detached node that
   * can neither receive the chip back nor be recognised as gone.
   *
   * @returns {Array<{node: Element, measure: Element, home: ?Element, mark: string}>} the movable nodes.
   */
  function headerItems() {
    var rows = headerRows();
    if (rows.length === 0) return [];
    var items = [];
    var first = rows[0];
    if (first.lineage) {
      // The slot wrapper is display:contents by design — it generates no box at all, so its
      // own rect is 0x0 while the chip inside it is 80px wide. Measuring the wrapper would
      // have counted the subagent count as nothing and let the group overflow the strip;
      // the element that has to be moved is still the wrapper, because that is the node the
      // slot host owns and the one whose child comes and goes.
      items.push({
        node: first.lineage,
        measure: first.lineage.firstElementChild || first.lineage,
        home: first.lineageHome,
        mark: HEADER_LINEAGE_MARK,
      });
    }
    for (var index = 0; index < rows.length; index += 1) {
      items.push({
        node: rows[index].actions,
        measure: rows[index].actions,
        home: rows[index].cluster,
        mark: HEADER_ACTIONS_MARK,
      });
    }
    return items;
  }

  /**
   * Whether a node is one this shell moved, or lives inside one.
   *
   * The collision walk has to skip them: once the group is in the strip, the chips' own
   * buttons are in the strip's button list, and counting the last of them as "the last tab"
   * made the row look too narrow, the chips were handed back, they fitted again, and the
   * two states alternated every frame.
   *
   * @param {Array<{node: Element}>} items - the moved nodes.
   * @param {Element} node - a control found in the strip.
   * @returns {boolean} true when the control belongs to the moved group.
   */
  function insideMoved(items, node) {
    for (var index = 0; index < items.length; index += 1) {
      if (items[index].node === node || items[index].node.contains(node)) return true;
    }
    return false;
  }

  /**
   * Our container inside a given strip, if it is there.
   *
   * A direct-child walk rather than a query: the document can hold another header with a
   * group of its own, and the question is always about *this* strip.
   *
   * @param {Element} tabs - the tab strip.
   * @returns {?Element} the group, or null.
   */
  function headerGroup(tabs) {
    for (var index = 0; index < tabs.children.length; index += 1) {
      if (tabs.children[index].hasAttribute(HEADER_GROUP_MARK)) return tabs.children[index];
    }
    return null;
  }

  /**
   * The first of them, for callers that only need the geometry.
   *
   * @returns {?{actions: Element, tabs: Element, header: Element, cluster: Element}} the first wrapper, or null.
   */
  function headerRow() {
    return headerRows()[0] || null;
  }

  /**
   * Whether the chips fit on the strip's line.
   *
   * Pure arithmetic, split out so it can be checked with real numbers. The room is
   * measured from the strip's **own** right edge, not from the viewport: a flex line that
   * runs out of space overflows to the right, so a chip that "fits the window" can still
   * stick out past the strip — measured at 320px, where a 177px chip landed 11px beyond
   * the strip's edge.
   *
   * @param {{right: number}} tabs - the tab strip's rect.
   * @param {{width: number}} chip - the chip container's box.
   * @param {number} gap - the strip's own gap between items.
   * @param {number} [limitLeft] - the right edge of the last tab; the chips must clear it.
   * @returns {boolean} true when the chips fit beside the tabs.
   */
  function headerFits(tabs, chip, gap, limitLeft) {
    var room = Math.round(tabs.right - (limitLeft || tabs.left) - (gap || 0) - 8);
    return chip.width <= room;
  }

  /**
   * Put the header's action chips into the tab strip, in the DOM.
   *
   * See the stylesheet rule above for why this is a move rather than a placement: a
   * viewport-fixed box stayed on screen when the header did not, and every way to notice
   * that was a monitor with a window in which it was wrong. In the strip's flow the chips
   * are painted where the header is painted, which is a property of the tree.
   *
   * @returns {void}
   */
  function syncHeaderActions() {
    state.syncs += 1;
    var rows = headerRows();
    if (rows.length === 0) {
      // Reported once, not per frame: a header without a tab strip is a client this
      // shell cannot place the chips in, and saying so every frame would bury the panel.
      if (state.headerActions !== 'missing') {
        state.headerActions = 'missing';
        note('没找到页签行（' + HEADER_TABS_SUFFIX + '），页头的模式/任务 chip 留在原处');
      }
      return;
    }
    var tabs = rows[0].tabs;
    var items = headerItems();
    // The rightmost tab is what the chips must clear — found by walking the strip's
    // controls rather than taking its last child, which this build pads with an element
    // that has no width: using that one left the check unapplied and the chips sat on 轨迹.
    // Everything this shell moved is skipped (see insideMoved for why that is load-bearing).
    var limitLeft = 0;
    var stripControls = tabs.querySelectorAll('button,[role="tab"]');
    for (var control = 0; control < stripControls.length; control += 1) {
      if (insideMoved(items, stripControls[control])) continue;
      var controlBox = stripControls[control].getBoundingClientRect();
      if (controlBox.width > 0 && controlBox.right > limitLeft) limitLeft = controlBox.right;
    }
    // What has to fit is the group's own width. Summed from the chips and the group's gap
    // instead of measured off the group, because on the pass that first moves them the
    // group does not exist yet — and the estimate has to be available *before* the move, or
    // the decision would have to be taken after it and then taken back, which is exactly
    // the flip-flop this code has already been through once.
    var chipWidth = 0;
    var chipHeight = 0;
    var moved = 0;
    for (var index = 0; index < items.length; index += 1) {
      var box = items[index].measure.getBoundingClientRect();
      if (box.width <= 0) continue;
      moved += 1;
      chipWidth += box.width;
      if (box.height > chipHeight) chipHeight = box.height;
    }
    if (moved > 1) chipWidth += HEADER_GROUP_GAP * (moved - 1);
    var stripStyle = window.getComputedStyle(tabs);
    var gap = parseFloat(stripStyle.columnGap || stripStyle.gap) || 0;
    var fits = headerFits(
      tabs.getBoundingClientRect(),
      { width: chipWidth, height: chipHeight },
      gap,
      limitLeft,
    );
    if (!fits) {
      // A very narrow phone (320px) cannot hold the tab strip and the chips on one line,
      // and there is no good third option: capping the row was tried and a capped flex
      // row *wraps*, which made it 43px tall and poke out under the header. So the official
      // layout is left exactly as the client laid it out for that width, and the panel says
      // why. With only the mode chip — no background job — this never happens.
      clearHeaderActions();
      state.headerActions = 'narrow';
      return;
    }
    var group = headerGroup(tabs);
    if (!group) {
      group = document.createElement('div');
      group.setAttribute(HEADER_GROUP_MARK, MOVED_TO_TABS);
      tabs.appendChild(group);
    }
    for (var at = 0; at < items.length; at += 1) {
      var node = items[at].node;
      if (node.parentElement !== group) {
        group.appendChild(node);
        state.movesIn += 1;
      }
      // The mark goes on even when the node is empty: it is the way back for the next pass
      // and the way triage tells "moved" from "never found", and React rewrites the host
      // attributes it owns, so anything conditional here would flicker.
      if (node.getAttribute(items[at].mark) !== MOVED_TO_TABS) {
        node.setAttribute(items[at].mark, MOVED_TO_TABS);
      }
    }
    state.headerActions = MOVED_TO_TABS;
  }

  /**
   * Put the hamburger inside the session header's title row, at its left end.
   *
   * The same move as the chips, for the same reason: as a fixed overlay it stayed on screen
   * when the header did not, so it had to be hidden by hand whenever the client put a
   * control in that corner ("the file browser's tab strip is there"). Inside the row it is
   * covered with the header, and the row's own layout makes space for it — which is also
   * what removes the padding hack this shell used to add to the title row.
   *
   * @returns {void}
   */
  function syncBurger() {
    if (!burger) return;
    var rows = headerRows();
    var titleRow = rows.length > 0
      ? rows[0].header.querySelector('[class*="' + HEADER_TITLE_ROW_SUFFIX + '"]')
      : null;
    if (!titleRow) {
      // No conversation header on screen — the first launch, or the settings pages. The
      // hamburger is how the user reaches the session list, so it has to stay usable: it
      // falls back to the floating button it used to be, outside the client's root.
      if (chrome && burger.parentElement !== chrome) chrome.appendChild(burger);
      burger.setAttribute(BURGER_PLACED, 'float');
      state.burger = 'float';
      return;
    }
    if (burger.parentElement !== titleRow) titleRow.insertBefore(burger, titleRow.firstChild);
    burger.setAttribute(BURGER_PLACED, 'header');
    state.burger = 'header';
  }

  /**
   * Take the hamburger back out of the client's tree.
   *
   * It has to live outside the client's root whenever this shell is not placing it — React
   * owns that subtree, and a stale button left in it would be either deleted or rendered
   * wherever the row happens to be.
   *
   * @returns {void}
   */
  function clearBurger() {
    if (!burger) return;
    burger.removeAttribute(BURGER_PLACED);
    if (chrome && burger.parentElement !== chrome) chrome.appendChild(burger);
    state.burger = 'chrome';
  }

  /** Give every chip back to the row it belongs to, and take the group away. */
  function clearHeaderActions() {
    var rows = headerRows();
    var items = headerItems();
    // Found by class rather than by our own marker: React rewrites the attributes of the
    // host elements it renders, so the marker can be gone while a chip is still sitting
    // in the strip — and then nothing would ever bring it back. Measured at desktop width:
    // the marker was gone and the wrapper stayed in the strip.
    //
    // The lineage chip has no class of ours to fall back on either, which is why it is
    // found through its slot marker every pass (see headerItems) and handed back by the
    // same loop as the wrappers.
    for (var index = 0; index < items.length; index += 1) {
      var node = items[index].node;
      var home = items[index].home;
      node.removeAttribute(items[index].mark);
      node.style.top = '';
      node.style.right = '';
      node.style.maxWidth = '';
      if (home && home.isConnected && node.isConnected && node.parentElement !== home) {
        home.appendChild(node);
        state.movesBack += 1;
      }
    }
    for (var row = 0; row < rows.length; row += 1) {
      var group = headerGroup(rows[row].tabs);
      if (group && group.parentElement) group.parentElement.removeChild(group);
    }
    state.headerActions = 'row';
  }

  /**
   * How far down the app's own session header reaches.
   *
   * A popover anchored to a control inside the header is placed at trigger.bottom + 5,
   * which is *inside* the header — measured on the real subagent panel: top 52, header
   * bottom 87, so its first rows were drawn over the tab strip.
   *
   * @returns {number} the header's bottom in viewport coordinates, 0 when unknown.
   */
  function headerBottom() {
    var row = headerRow();
    return row ? Math.round(row.header.getBoundingClientRect().bottom) : 0;
  }

  /**
   * Where the header's chips are, for the self-check panel.
   *
   * @returns {string} a line for the panel.
   */
  function headerActionsReport() {
    if (state.headerActions === MOVED_TO_TABS) {
      // Measured on the group, not on a chip: the group is the one box in the strip whose
      // width says whether everything moved there actually fits, and it is the box whose
      // right edge the phone screen shows.
      var row = headerRow();
      var group = row ? headerGroup(row.tabs) : null;
      var box = group ? group.getBoundingClientRect() : null;
      var lineage = row && row.lineage ? '（含子代理 chip）' : '';
      return '已搬进页签行 ✓' + lineage + (box ? '（' + Math.round(box.width) + 'px 宽，右边距 '
        + Math.round(window.innerWidth - box.right) + 'px）' : '');
    }
    if (state.headerActions === 'narrow') return '这一屏太窄，页签行放不下 chip，留在标题行（官方布局）';
    if (state.headerActions === 'missing') return '没找到页签行，没搬（不影响其他功能）';
    return '还在标题行（本机不适用，或宽度超过阈值）';
  }

  /**
   * This build's identity, as the page sees it.
   *
   * @returns {string} a token like "PulseApp/1.2".
   */
  function appTag() {    var match = /(PulseApp\\/[\\w.]+)/.exec(navigator.userAgent || '');
    return match ? match[1] : '';
  }

  /**
   * Which app is running, for the panel's first lines.
   *
   * Worth its own line because it answers a question nothing else can: whether the
   * APK on the phone is the build that has a given fix. Without it, "have I
   * installed the new one?" is unanswerable from the phone.
   *
   * @returns {string} a human-readable answer.
   */
  function appVersion() {
    var tag = appTag();
    if (tag) return 'App 版本 ' + tag.replace('PulseApp/', '');
    return '不在 App 里（浏览器），或是没有版本标记的 APK';
  }

  /**
   * Render the panel from live measurements.
   *
   * Every value is probed here rather than read out of the cached state. The
   * cached version reported 应用外框 and 主列 as 未找到 on a phone where both were
   * plainly present: those two were only ever computed in refresh(), which runs at
   * boot and on resize, and at boot the client had not mounted yet. A diagnostic
   * that reports what it remembers instead of what it sees is worse than none —
   * the whole point of this panel is to be trusted when something looks wrong.
   */
  function renderDiag() {    if (!diagBody) return;
    var column = sidebarColumn();
    var rail = one('[class*="' + RIGHTBAR_SUFFIX + '"]');
    var attach = attachControl();
    var lines = [
      '<b>这是自检，不是功能按钮</b>',
      '手机端跑的还是官方界面，外壳只改布局。外壳靠官方的类名后缀找元素，',
      '官方改版后可能找不到——那种情况界面只是"有点不对"，不会报错，',
      '所以把每一项找到了什么写在这里。上面全是 ✓ 就说明外壳工作正常。',
      '',
      '视口宽度: ' + window.innerWidth + 'px（阈值 ' + TABLET_MAX + '）',
      'App: ' + appVersion(),
      '应用外框: ' + (withSuffix(FRAME_SUFFIX).length > 0 ? '已找到 ✓' : '未找到 ✗'),
      '侧栏列: ' + (column ? '已找到 ✓' : '未找到 ✗'),
      '主列: ' + (withSuffix(CENTER_SUFFIX).length > 0 ? '已找到 ✓' : '未找到 ✗'),
      '侧栏状态: ' + (sidebarExpanded() ? '已展开（抽屉打开）' : '收起（图标栏）'),
      '右侧栏: ' + (rail
        ? (rail.hasAttribute(RIGHTBAR_EMPTY_ATTR) ? '空着（已让出宽度）' : '有内容（保持原样）')
        : '未找到'),
      '左上角被占用: ' + (state.corner ? '是（汉堡已隐藏）' : '否') + '<br>' +
      '官方开关: ' + (toggleButton() ? '已找到 ✓' : '未找到 ✗'),
      '官方添加入口: ' + (attach ? '已找到 ✓' + (state.attachLabel || '') : '未找到'),
      '页头模式/任务 chip: ' + headerActionsReport(),
      '会话文件路径: ' + fileLinkReport(),
      '',
      '锚点后缀: ' + ${anchorsForReport}
    ];
    if (state.notes.length) lines.push('', '<b>提示</b>', state.notes.join('\\n'));
    diagBody.innerHTML = lines.join('<br>');
  }

  /**
   * Open or close the panel, keeping the toggle's own appearance honest.
   *
   * Every way in and out goes through here, and it lives beside showDiag rather
   * than inside build() so both can reach it. It did not, once: the close button
   * cleared the hidden flag on its own, so the toggle kept the × it was given when
   * the panel opened and never went back to a question mark.
   *
   * @param {boolean} open - whether the panel should be showing.
   */
  function setDiagOpen(open) {
    if (!diagPanel) return;
    diagPanel.hidden = !open;
    if (diagToggle) {
      diagToggle.textContent = open ? '\\u00d7' : '?';
      diagToggle.setAttribute('aria-label', open ? '关闭自检' : '移动外壳自检');
    }
    if (open) renderDiag();
  }

  /**
   * How the transcript's file links fared, for the self-check panel.
   *
   * The injector reads React internals to recover an absolute path, so "it worked on
   * my machine" is not evidence that it worked on this client. This is the sentence
   * that answers it on the phone, where there is no console to open.
   *
   * @returns {string} a line for the panel.
   */
  function fileLinkReport() {
    var decorated = 0;
    var unresolved = 0;
    try {
      decorated = document.querySelectorAll('[' + FILE_LINK_MARK + ']').length;
      unresolved = document.querySelectorAll('[' + FILE_LINK_UNRESOLVED + ']').length;
    } catch (error) {
      return '查不了';
    }
    if (decorated === 0 && unresolved === 0) return '这一屏没有（翻到有工具调用的地方再看）';
    return decorated + ' 处已加下载/转发' + (unresolved > 0 ? '，' + unresolved + ' 处没解析出路径 ✗' : ' ✓');
  }

  function showDiag() {
    setDiagOpen(true);
  }

  function refresh() {
    state.refreshes += 1;
    if (!shouldActivate()) {
      document.documentElement.classList.remove('pulse-has-sidebar', 'pulse-drawer-open');
      if (chrome) chrome.style.display = 'none';
      state.active = false;
      unclampPopovers();
      // The placement is ours, so leaving it behind would follow the user to the
      // desktop layout — where the chips belong in the title row.
      clearHeaderActions();
      clearBurger();
      return;
    }
    state.active = true;
    state.width = window.innerWidth;
    if (chrome) chrome.style.display = '';
    state.frame = withSuffix(FRAME_SUFFIX).length > 0;
    state.center = withSuffix(CENTER_SUFFIX).length > 0;
    syncSidebar();
    syncRightbar();
    syncAttach();
    syncCorner();
    syncBurger();
    syncHeaderActions();
    clampPopovers();
    renderDiag();
  }

  // ---- popovers that hang off the right edge -------------------------------
  //
  // The background-jobs menu is position:absolute, left:0, width:336px on a
  // wrapper around its trigger. On a desktop window there is room beside the trigger
  // and nothing ever checks; on a 390px phone the trigger sits around x=144 (after
  // the mode chip) and the menu therefore ends ~90px past the right edge, so it is
  // clipped and its right-hand columns cannot be read at all.
  //
  // Nothing in CSS can fix this: whether the menu fits depends on where its trigger
  // happened to land, which only a measurement knows. So this is the one thing the
  // shell does in JavaScript beyond its own chrome, and it is deliberately generic —
  // any popover that overflows gets slid back, not just this one — and reversible,
  // because it only ever writes a transform it can take away again.

  /** Elements that were slid, and what their transform was before. */
  var clamped = [];

  function unclampPopovers() {
    for (var index = 0; index < clamped.length; index += 1) {
      var entry = clamped[index];
      if (entry.node.isConnected) entry.node.style.transform = entry.was;
    }
    clamped = [];
  }

  /**
   * Slide any open popover back inside the viewport.
   */
  /**
   * How far a popover has to move to sit inside the viewport and below the header.
   *
   * Split out as arithmetic because jsdom has no layout: a DOM fixture there reports
   * every rect as zero and this rule cannot be exercised at all. With the numbers passed
   * in, both halves — the horizontal slide that already existed and the vertical one
   * that stops a menu from opening over the tab strip — are checkable without a browser.
   *
   * @param {{top: number, left: number, right: number, bottom: number, height: number}} rect - the popover's rect.
   * @param {number} width - the viewport width.
   * @param {number} height - the viewport height.
   * @param {number} below - the y the popover must not start above (the header's bottom); 0 when unknown.
   * @returns {{x: number, y: number}} the shift, in pixels.
   */
  function popoverShift(rect, width, height, below) {
    var margin = 8;
    var limitRight = width - margin;
    var limitTop = below + margin;
    var limitBottom = height - margin;
    var x = 0;
    if (rect.right > limitRight) x = limitRight - rect.right;
    if (rect.left + x < margin) x = margin - rect.left;
    var y = 0;
    // Only when it actually fits between the header and the bottom: a panel taller than
    // that cannot be helped by moving it, and pushing it down would hide its last rows
    // instead of its first.
    if (rect.height <= limitBottom - limitTop) {
      if (rect.top < limitTop) y = limitTop - rect.top;
      else if (rect.bottom > limitBottom) y = limitBottom - rect.bottom;
      if (rect.top + y < limitTop) y = limitTop - rect.top;
    }
    return { x: x, y: y };
  }

  function clampPopovers() {
    unclampPopovers();
    // Only these: an element the client positions itself, over a menu-like role.
    // Dialogs and sheets are excluded on purpose — they are already centred or
    // full-width, and a shift there would move something the user is reading. The
    // subagent panel matches on its own class (ZKlsPq_menu), which is how it is
    // reached without widening this selector.
    var nodes;
    try {
      nodes = document.querySelectorAll('[class*="_menu"],[role="menu"],[role="listbox"]');
    } catch (error) {
      return;
    }
    // The vertical limit, which did not exist until a menu was measured opening at
    // top 52 over a header that ends at 87 — its first rows landed on 对话/轨迹.
    var below = headerBottom();
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      var style = window.getComputedStyle(node);
      if (style.position !== 'absolute' && style.position !== 'fixed') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      var before = node.style.transform;
      // Measured with our own shift removed, or a second pass would measure the
      // first pass's result and walk the menu across the screen.
      node.style.transform = '';
      var rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        node.style.transform = before;
        continue;
      }
      var shift = popoverShift(rect, window.innerWidth, window.innerHeight, below);
      if (shift.x === 0 && shift.y === 0) {
        node.style.transform = before;
        continue;
      }
      clamped.push({ node: node, was: before });
      node.style.transform = 'translate(' + Math.round(shift.x) + 'px,' + Math.round(shift.y) + 'px)';
    }
  }

  /**
   * Put the moved chips back where the shell has them, before the browser paints.
   *
   * The subagent count is React's node, and the client re-inserts it into the crumb row on
   * its own re-renders. Correcting that from the next animation frame is a frame too late:
   * the chip gets **painted** 33px higher for that frame, and a tap that begins in it
   * delivers no click at all — measured with a forced move every 60ms, four taps in five
   * (pointerdown touchstart pointerup touchend, and then nothing, because the second half
   * of the gesture landed where the chip no longer was). A MutationObserver callback runs as
   * a microtask, before paint, so this correction lands in the same frame as the client's
   * insert and the wrong position is never drawn.
   *
   * Deliberately without arithmetic: it re-places and re-orders what the shell already
   * decided to move, and nothing else. Whether the chips belong in the strip at all — the fit
   * decision, the marks, the hand-back — is still taken by the full pass on the animation
   * frame below, which is the only place that measures anything.
   *
   * The order is restored as well as the parent, and that is not a detail: appending the chip
   * to the group puts it *last*, so a client re-insert that was corrected by appending alone
   * left the subagent count to the right of the mode chip — visible as the two swapping
   * places, and measured as index 1 instead of 0 on the real page.
   *
   * @returns {void}
   */
  function holdHeaderPlacement() {
    if (state.headerActions !== MOVED_TO_TABS) return;
    var rows = headerRows();
    if (rows.length === 0) return;
    var group = headerGroup(rows[0].tabs);
    if (!group) return;
    var items = headerItems();
    // Backwards, so each item is placed before the one that follows it and one pass is
    // enough. Nothing is written when the order already holds, which is what keeps this out
    // of the mutation record and therefore out of a loop with the observer that calls it.
    var anchor = null;
    for (var index = items.length - 1; index >= 0; index -= 1) {
      var node = items[index].node;
      if (node.parentElement !== group || node.nextElementSibling !== anchor) {
        group.insertBefore(node, anchor);
      }
      anchor = node;
    }
  }

  function boot() {
    build();
    refresh();

    // The client mounts asynchronously and re-renders freely, so both the drawer
    // attribute and the mirrored expanded state are re-derived rather than
    // assumed to persist.
    var pending = false;
    var observer = new MutationObserver(function () {
      // Before the frame is painted — see holdHeaderPlacement for what a frame of delay
      // costs a finger.
      holdHeaderPlacement();
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        if (!state.active) return;
        syncSidebar();
        syncRightbar();
        syncAttach();
        syncCorner();
        syncBurger();
        syncHeaderActions();
        clampPopovers();
      });
    });
    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'aria-label']
    });

    window.addEventListener('resize', refresh);
    window.addEventListener('orientationchange', refresh);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && sidebarExpanded()) clickToggle();
    });
  }

  /**
   * A read-only handle on the shell's own probes.
   *
   * These selectors are the likeliest thing to rot, and a selector that stops
   * matching fails silently by construction. This makes the mismatch inspectable
   * from the verification script and from on-device triage, where the alternative
   * is guessing at a page you cannot open a console on.
   */
  window.__PULSE_SHELL_DEBUG__ = {
    state: state,
    sidebarColumn: sidebarColumn,
    sidebarExpanded: sidebarExpanded,
    toggleButton: toggleButton,
    attachControl: attachControl,
    rightbar: function () { return one('[class*="' + RIGHTBAR_SUFFIX + '"]'); },
    shouldActivate: shouldActivate,
    refresh: refresh,
    // Exposed because "the menu still runs off the edge" is otherwise only visible
    // on a phone: the probe opens the real menu and reads this.
    clampPopovers: clampPopovers,
    clamped: function () { return clamped.length; },
    // The header move, for the same reason: whether the chips are in the tab strip and
    // whether the arithmetic put them in the right place is measured, not assumed.
    headerRow: headerRow,
    headerRows: headerRows,
    headerItems: headerItems,
    headerGroup: function () {
      var row = headerRow();
      return row ? headerGroup(row.tabs) : null;
    },
    headerActions: function () { return state.headerActions; },
    headerPlacement: headerFits,
    headerBottom: headerBottom,
    syncHeaderActions: syncHeaderActions,
    // Exposed so a probe can measure both directions of the move on one page instead of
    // asserting that "the chips are in the strip" on a page where they always are.
    clearHeaderActions: clearHeaderActions,
    // ... and so the pre-paint hold can be checked in the shape it is used in: the client
    // re-inserts the chip, and calling this must put it back without waiting for a frame.
    holdHeaderPlacement: holdHeaderPlacement,
    popoverShift: popoverShift
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
}
