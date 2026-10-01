#!/usr/bin/env node
/**
 * Produce the public export of this plugin, with the private-looking strings taken out.
 *
 *   node scripts/export-public.mjs [--into D:\pulse-remote] [--dry]
 *
 * The export is a curated copy of the working tree, not the working tree: this repository lives
 * inside a workspace that also holds sessions, credentials and unrelated projects, so publishing
 * "everything" would publish those. The manifest below is the whole of what goes out.
 *
 * Three things happen to each file, in order: the redactions (a host name and a user name that are
 * nobody's business), the copy, and then a scan of what was written. The scan is the point: it runs
 * over the *output*, so a redaction that fails to match is caught by the same pass that catches a
 * secret arriving from a file nobody thought about. Any hit is a failure, non-zero exit, and the
 * list of offending lines — because the alternative is finding out after the push.
 *
 * @module dsh-remote-pulse/scripts/export-public
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : String(args[at + 1] ?? fallback);
};
const root = process.cwd();
const into = flag('--into', 'D:\\pulse-remote');
const dry = args.includes('--dry');

/** Strings that must not leave this machine, and what replaces them. */
const REDACTIONS = [
  // The deployment host, which appears in the tunnel script and the nginx sample.
  [/134\.175\.116\.155/g, 'YOUR_HOST'],
  // This checkout's user name, which appears in build and helper scripts.
  [/C:\\Users\\12971/g, 'C:\\Users\\<you>'],
  [/C:\/Users\/12971/g, 'C:/Users/<you>'],
];

/** Everything that must never be found in the output, whether or not a redaction was meant to catch it. */
const FORBIDDEN = [
  { what: 'a scrypt password hash', re: /scrypt:[0-9a-f]{16}:[0-9a-f]{64}/ },
  { what: 'a private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { what: 'a live session cookie', re: /pulse_session=[A-Za-z0-9%._-]{12,}/ },
  { what: 'the local API token', re: /\blocalToken\s*[:=]\s*['"][A-Za-z0-9_-]{16,}/ },
  { what: 'a VAPID/private push key', re: /"privateKey"\s*:\s*"/ },
  // Not the file *name*: the tests use '/home/u/.ssh/id_ed25519' as a fixture precisely to prove that
  // private keys stay out of the artifact index, and flagging those would be flagging the test that
  // protects this. What matters is this machine's own key location, and the key's contents above.
  { what: 'this machine\'s ssh key directory', re: /D:\\tools\\gh-ssh/ },
  // The keystore *file* is kept out by path (and by .gitignore), so naming it in the README's file
  // table or in the build script's own variable is not a leak — and flagging those would train
  // whoever runs this to ignore the report. What must never appear is its password.
  { what: 'a keystore password', re: /(storePass|keyPass|storepass|keypass)\s*[:=]\s*['"][^'"]{3,}['"]/ },
  { what: 'the deployment host', re: /134\.175\.116\.155/ },
  { what: 'this machine\'s user name', re: /C:\\Users\\12971/ },
];

/** Files that exist to drive *this* machine and mean nothing to anyone else. */
const EXCLUDED = new Set([
  // Hard-codes this checkout's path and restarts the local development server.
  'scripts/restart-and-verify.ps1',
]);

/**
 * The Android tree goes out with the plugin, minus the parts that are this deployment's.
 *
 * `keystore/` is the signing key — anyone holding it could publish an update Android would accept
 * over the installed app. `app/res/raw/pulse_ca.crt` carries this server's address in its subject,
 * so a placeholder goes in its place and the README says how to build with your own. `dist/` and
 * `build/` hold an APK with that address baked in, and the password in `build.ps1` is this machine's.
 */
const ANDROID_TREE = 'pulse-android';
// A sibling of the plugin, not a child: this workspace keeps the Android app next to it.
const ANDROID_ROOT = join(root, '..', ANDROID_TREE);
const EXCLUDED_PATTERNS = [
  /^pulse-android\/(keystore|dist|build)\//,
  /\.(jks|apk|aab|idsig)$/,
];
const PLACEHOLDER_CERT = 'D:\\tools\\pulse-placeholder-ca.crt';
const REPLACEMENT_FILES = new Map([
  ['pulse-android/app/res/raw/pulse_ca.crt', PLACEHOLDER_CERT],
]);
/** Lines that have to read differently in public, because they are about this machine. */
const LINE_FIXES = [
  {
    file: 'pulse-android/build.ps1',
    from: /^\$storePass = '.*'$/m,
    to: "$storePass = if ($env:PULSE_STORE_PASS) { $env:PULSE_STORE_PASS } else { 'CHANGE_ME' }",
    about: 'the signing keystore password, which must never be committed',
  },
];

/** Every file of the Android tree, minus the excluded ones. */
function androidFiles() {
  const at = ANDROID_ROOT;
  if (!existsSync(at)) return [];
  const found = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const name = `${ANDROID_TREE}/${relative(at, full).split('\\').join('/')}`;
      if (EXCLUDED_PATTERNS.some(pattern => pattern.test(name))) continue;
      if (entry.isDirectory()) walk(full);
      else found.push(name);
    }
  };
  walk(at);
  return found.sort();
}

/** Fixed files, then every source file of each kind. */
function manifest() {
  const fixed = [
    'README.md', 'LICENSE', 'SECURITY.md', 'package.json', 'package-lock.json',
    'cordis.patch.yml', '.gitignore', '.gitattributes', 'deploy/nginx-pulse.conf',
  ];
  const list = fixed.filter(name => existsSync(join(root, name)));
  for (const [dir, extensions] of [['lib', ['.js']], ['scripts', ['.mjs', '.ps1']], ['test', ['.js']]]) {
    const at = join(root, dir);
    if (!existsSync(at)) continue;
    for (const entry of readdirSync(at).sort()) {
      if (!extensions.some(extension => entry.endsWith(extension))) continue;
      if (EXCLUDED.has(`${dir}/${entry}`)) continue;
      list.push(`${dir}/${entry}`);
    }
  }
  return list.concat(androidFiles());
}

const files = manifest();
const report = [];
let failures = 0;

/** Where one export name is read from: the Android tree is a sibling, everything else is here. */
function sourcePath(name) {
  if (name.startsWith(`${ANDROID_TREE}/`)) {
    return join(ANDROID_ROOT, name.slice(ANDROID_TREE.length + 1));
  }
  return join(root, name);
}

for (const name of files) {
  const from = REPLACEMENT_FILES.has(name) ? REPLACEMENT_FILES.get(name) : sourcePath(name);
  const to = join(into, name);
  let text = readFileSync(from, 'utf8');
  const redacted = [];
  for (const [pattern, replacement] of REDACTIONS) {
    if (pattern.test(text)) {
      redacted.push(String(pattern));
      text = text.replace(pattern, replacement);
    }
  }
  const fixed = [];
  for (const fix of LINE_FIXES) {
    if (fix.file !== name || !fix.from.test(text)) continue;
    text = text.replace(fix.from, fix.to);
    fixed.push(fix.about);
  }
  // Scan the text that is about to be written, line by line, so a hit names the line.
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of FORBIDDEN) {
      if (!rule.re.test(lines[index])) continue;
      failures += 1;
      report.push(`  FAIL ${name}:${index + 1} contains ${rule.what}`);
    }
  }
  if (!dry) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text, 'utf8');
  }
  report.push(`  ${dry ? 'would write' : 'wrote'} ${name} (${statSync(from).size} bytes`
    + `${redacted.length ? `, redacted ${redacted.length}` : ''}`
    + `${fixed.length ? `, fixed ${fixed.join('; ')}` : ''})`);
}

console.log(`${dry ? 'dry run: ' : ''}${files.length} files -> ${into}`);
for (const line of report) console.log(line);
if (failures > 0) {
  console.error(`\n${failures} forbidden string(s) found — nothing should be pushed until they are gone`);
  process.exit(1);
}
console.log('\nno forbidden strings found in the export');
