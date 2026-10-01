/**
 * Compile every script this shell injects, and refuse a stray backtick.
 *
 * The template-literal trap has cost this file more than ten separate outages: a backtick
 * inside a comment that lives *inside* the returned template ends the literal early, and the
 * failure surfaces as a **module-level parse error** — which means this checker could not even
 * load to report it, and the only symptom was a stack trace from whatever imported the module.
 *
 * So the source text is scanned *first*, before anything is imported, for a backtick between
 * the `return \`` of a generator and its closing backtick. That check runs on the file as text
 * and therefore still works when the file cannot be parsed; the compile checks below then run
 * as before.
 *
 *   node scripts/check-scripts.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Backticks that live inside a generator's returned template literal.
 *
 * @param {string} text - the module source.
 * @param {string} name - the exported generator's name.
 * @returns {Array<number>} 1-based line numbers of offending backticks.
 */
function strayBackticks(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`export function ${name}(`));
  if (start === -1) return [];
  let open = -1;
  for (let at = start; at < lines.length; at += 1) {
    if (open === -1) {
      if (/^\s*return `/.test(lines[at])) open = at;
      continue;
    }
    // The literal ends at the first line that is only a backtick and a semicolon.
    if (/^`;\s*$/.test(lines[at])) break;
    if (lines[at].includes('`')) {
      const found = [];
      for (let scan = open + 1; scan <= at; scan += 1) {
        if (lines[scan].includes('`')) found.push(scan + 1);
      }
      return found;
    }
  }
  return [];
}

const generators = ['mobileShellScript', 'deliverableActionsScript', 'previewActionsScript', 'fileLinkActionsScript'];
const sourceText = readFileSync(join(here, '..', 'lib', 'mobile-shell.js'), 'utf8');
const trapped = generators
  .map(name => ({ name, lines: strayBackticks(sourceText, name) }))
  .filter(entry => entry.lines.length > 0);
if (trapped.length > 0) {
  console.log('');
  for (const entry of trapped) {
    console.log(`  FAIL ${entry.name}() 里的模板字符串被反引号截断了，行号：${entry.lines.join(', ')}`);
    console.log('       反引号在生成的脚本里会让模板提前结束 —— 注释里也不行，换成「」或去掉。');
  }
  console.log('\n这就是那条反复出现的坑；先修它，再谈编译。');
  process.exit(1);
}

const {
  DELIVERABLE_PATH_ATTRIBUTE,
  deliverableActionsScript,
  fileLinkActionsScript,
  mobileShellScript,
  mobileShellStyles,
  previewActionsScript,
} = await import('../lib/mobile-shell.js');

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
  // The other half of the same trap: escape sequences are eaten by the template literal the
  // script is written in. A single backslash-b is a **backspace** character by the time the
  // page sees it, so a regex written as /^width\b/ silently matches nothing — measured, and it
  // put `width=device-width` into the viewport meta twice. Any control character at all is a
  // sign of that, so the whole class is refused rather than one instance of it.
  const controls = [...source]
    .filter(character => {
      const code = character.charCodeAt(0);
      return code < 32 && character !== '\n' && character !== '\t' && character !== '\r';
    })
    .map(character => `0x${character.charCodeAt(0).toString(16)}`);
  record(`${name}() 里没有被模板吃掉的转义（控制字符）`,
    controls.length === 0,
    controls.length === 0 ? '没有控制字符' : `出现 ${[...new Set(controls)].join(', ')} —— 反斜杠要写两个`);
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
