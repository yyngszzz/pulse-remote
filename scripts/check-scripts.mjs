/**
 * Compile every script this shell injects, and refuse a stray backtick.
 *
 * The template-literal trap has cost this file six separate outages: a backtick inside a
 * comment that lives *inside* the returned template ends the literal early, and the
 * failure surfaces as a syntax error in the page rather than at build time. So the
 * generators are compiled here for real, and the returned text is also scanned for the
 * characters that would end a template or a script tag.
 *
 *   node scripts/check-scripts.mjs
 */

import {
  DELIVERABLE_PATH_ATTRIBUTE,
  deliverableActionsScript,
  fileLinkActionsScript,
  mobileShellScript,
  mobileShellStyles,
  previewActionsScript,
} from '../lib/mobile-shell.js';

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

const scripts = {
  mobileShellScript,
  deliverableActionsScript,
  previewActionsScript,
  fileLinkActionsScript,
};

for (const [name, build] of Object.entries(scripts)) {
  const source = build();
  let error = '';
  try {
    new Function(source);
  } catch (problem) {
    error = problem.message;
  }
  record(`${name}() 返回的脚本能编译`, error === '' && source.length > 200,
    error || `${source.length} 字节`);
  record(`${name}() 里没有会截断脚本的字符`,
    !source.includes('</script') && !source.includes('`'),
    source.includes('`') ? '出现了反引号' : '没有反引号');
}

const css = mobileShellStyles();
record('样式表能作为 CSS 插入', css.length > 500 && !css.includes('</style'), `${css.length} 字节`);
record('样式表里没有反引号', !css.includes('`'), css.includes('`') ? '出现了反引号' : '没有反引号');

const deliverables = deliverableActionsScript();
record('交付控件标记了它代表哪个文件',
  deliverables.includes(DELIVERABLE_PATH_ATTRIBUTE) && deliverables.includes('SOURCE'),
  DELIVERABLE_PATH_ATTRIBUTE);
record('交付控件在折叠行里也认 _paths',
  deliverables.includes('"_paths"') && deliverables.includes('pathsFromSummary'),
  'suffix 与解析函数都在');
record('点折叠行上的控件不会顺手展开那一行',
  deliverables.includes('stopPropagation'), 'stopPropagation 在');

console.log('');
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? `   (${result.detail})` : ''}`);
}
console.log('');
console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
