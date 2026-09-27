/**
 * Encoding invariants for the operator scripts.
 *
 * This is not a style test. Windows PowerShell 5.1 -- the interpreter that
 * actually runs on a fresh Windows box, and the one this project's scripts are
 * invoked by -- reads a `.ps1` with no byte-order mark as **ANSI** (the machine's
 * legacy code page). A UTF-8 Chinese string then decodes into mojibake, and a
 * multi-byte sequence can end in a byte that looks like a quote or a backtick,
 * which corrupts the parse.
 *
 * That is exactly how `install-tunnel-task.ps1` failed: a valid-looking script
 * reported "Missing closing '}'" on a line that was perfectly balanced, because
 * the parser was reading a different byte stream than the one on disk.
 *
 * Node always reads UTF-8, so the `.mjs` scripts are unaffected and need no BOM.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** Every PowerShell script in the scripts directory. */
const powershellScripts = readdirSync(scriptsDir).filter(name => name.endsWith('.ps1'));

/** Every Node script in the scripts directory. */
const nodeScripts = readdirSync(scriptsDir).filter(name => name.endsWith('.mjs'));

/**
 * Read a file's raw bytes.
 * @param {string} name - file name inside scripts/.
 * @returns {Buffer} the bytes.
 */
function bytesOf(name) {
  return readFileSync(join(scriptsDir, name));
}

test('there are PowerShell scripts to check', () => {
  assert.ok(powershellScripts.length >= 2, `found ${powershellScripts.length} .ps1 files`);
});

test('a PowerShell script with non-ASCII bytes carries a UTF-8 BOM', () => {
  for (const name of powershellScripts) {
    const bytes = bytesOf(name);
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const firstNonAscii = bytes.findIndex(byte => byte > 127);
    if (firstNonAscii === -1) continue;
    assert.ok(
      hasBom,
      `${name} has non-ASCII bytes (first at offset ${firstNonAscii}) but no UTF-8 BOM; ` +
        'Windows PowerShell 5.1 would decode it as ANSI and misparse it',
    );
  }
});

test('a BOM-carrying script still decodes to valid UTF-8', () => {
  for (const name of powershellScripts) {
    const bytes = bytesOf(name);
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (!hasBom) continue;
    const text = bytes.subarray(3).toString('utf8');
    // Buffer.toString replaces invalid sequences with U+FFFD rather than throwing.
    assert.ok(!text.includes('\uFFFD'), `${name} is not valid UTF-8 after the BOM`);
  }
});

test('a BOM never appears in the middle of a script', () => {
  for (const name of powershellScripts) {
    const bytes = bytesOf(name);
    for (let index = 3; index < bytes.length - 2; index += 1) {
      const isBom = bytes[index] === 0xef && bytes[index + 1] === 0xbb && bytes[index + 2] === 0xbf;
      assert.ok(!isBom, `${name} has a stray BOM at offset ${index}`);
    }
  }
});

/**
 * Remove comments and quoted strings, leaving only executable PowerShell.
 *
 * Comments matter here: a comment that *documents* "PowerShell 5.1 has no '??'
 * operator" must not itself trip the rule that looks for `??`.
 *
 * @param {string} text - the script source.
 * @returns {string} the source with comments and string literals blanked out.
 */
function executableOnly(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    // Block comment.
    if (text.startsWith('<#', index)) {
      const end = text.indexOf('#>', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    // Line comment.
    if (text[index] === '#') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    // Here-string: consume whole, it is data rather than code.
    if (text.startsWith('@"', index) || text.startsWith("@'", index)) {
      const terminator = text[index + 1] === '"' ? '"@' : "'@";
      const end = text.indexOf(terminator, index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    // Single- or double-quoted string, honouring the backtick escape.
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      index += 1;
      while (index < text.length) {
        if (quote === '"' && text[index] === '`') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          // A doubled quote inside a single-quoted string is an escaped quote.
          if (quote === "'" && text[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += ' ';
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}

test('PowerShell scripts avoid syntax that Windows PowerShell 5.1 lacks', () => {
  // The harness on this machine reports itself as pwsh but is PowerShell 5.1,
  // and a scheduled task may launch either. These constructs parse in 7 and
  // fail in 5.1, so they must not appear in executable code.
  const forbidden = [
    { pattern: /\?\?/, why: 'the null-coalescing operator (PowerShell 7+)' },
    { pattern: /\?\./, why: 'the null-conditional operator (PowerShell 7+)' },
    { pattern: /-Parallel\b/, why: 'ForEach-Object -Parallel (PowerShell 7+)' },
    { pattern: /^\s*#requires\s+-Version\s+7/m, why: 'a hard requirement on PowerShell 7' },
  ];
  for (const name of powershellScripts) {
    const text = executableOnly(bytesOf(name).toString('utf8'));
    for (const { pattern, why } of forbidden) {
      assert.ok(!pattern.test(text), `${name} uses ${why}, which breaks on Windows PowerShell 5.1`);
    }
  }
});

test('the 5.1 syntax check can actually see a violation', () => {
  // A guard that cannot fail is worse than no guard: prove the stripper does not
  // simply erase everything it is supposed to inspect.
  const violating = '$x = $a ?? "fallback"\n';
  const commented = '# PowerShell 5.1 has no \'??\' operator\n$x = 1\n';
  assert.match(executableOnly(violating), /\?\?/, 'a real use must survive stripping');
  assert.doesNotMatch(executableOnly(commented), /\?\?/, 'a comment must not be flagged');
});


test('Node scripts are UTF-8 without a BOM', () => {
  // Node reads UTF-8 regardless, and a BOM would become a stray character in a
  // shebang line, silently breaking direct execution on a POSIX host.
  for (const name of nodeScripts) {
    const bytes = bytesOf(name);
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    assert.ok(!hasBom, `${name} should not carry a BOM`);
    assert.ok(!bytes.toString('utf8').includes('\uFFFD'), `${name} is not valid UTF-8`);
  }
});

test('no backtick hides inside an injected template literal', () => {
  // The trap that has cost this project seven outages, the last one written while
  // fixing the sixth: `lib/mobile-shell.js` builds every injected script as a template
  // literal, so a single backtick in a *comment* inside one of them ends the literal
  // early and the whole module stops being parseable. The symptom is a
  // "SyntaxError: Unexpected identifier" pointing at prose, and nothing that imports
  // the module can report it — importing is the failure. So the source is read as
  // text, and the scan is proven able to see a backtick that really is one.
  const source = readFileSync(join(scriptsDir, '..', 'lib', 'mobile-shell.js'), 'utf8');
  // CRLF-tolerant: this checkout has DOS line endings, and a literal `\n` before the
  // closing backtick silently matched zero literals — the guard would have passed by
  // finding nothing at all, which is why the count is asserted too.
  const bodies = [...source.matchAll(/return `([\s\S]*?)`;\r?\n/g)].map(match => match[1]);
  assert.ok(bodies.length >= 5, `expected every injected script, found ${bodies.length} template literals`);
  for (const body of bodies) {
    const stray = body.indexOf('`');
    assert.equal(stray, -1, stray === -1 ? '' : `a backtick at offset ${stray} ends the literal early: `
      + JSON.stringify(body.slice(Math.max(0, stray - 70), stray + 20)));
  }

  // The guard has to be able to fail, and on this very file: a backtick planted inside
  // one of its own template literals must be found by the same scan, or "no backtick
  // found" would only mean the scan looked somewhere else.
  const poisoned = source.replace(/(return `)(\r?\n)/, '$1$2  /* a stray ` backtick */$2');
  assert.notEqual(poisoned, source, 'the plant must actually change the file text');
  const poisonedBodies = [...poisoned.matchAll(/return `([\s\S]*?)`;\r?\n/g)].map(match => match[1]);
  const found = poisonedBodies.filter(body => body.includes('`')).length;
  assert.ok(found >= 1, `the scan must report the planted backtick, saw ${found} of ${poisonedBodies.length}`);
});
