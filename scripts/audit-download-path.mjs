#!/usr/bin/env node
/**
 * Find out how the official client hands a file to the browser.
 *
 *   node scripts/audit-download-path.mjs [--url http://127.0.0.1:3199]
 *
 * ## Why this matters
 *
 * An Android WebView only sees a download through DownloadListener, and that
 * listener is handed a *URL*. A plain https URL can be fetched. A blob: URL
 * cannot — it exists only inside the page, so an app that saves files by creating
 * a Blob and clicking an anchor with the download attribute is unreachable from
 * the shell no matter what the app does.
 *
 * Those two possibilities need different fixes, and the difference is invisible
 * from the phone, so it is read out of the bytes the phone actually downloads.
 *
 * @module dsh-remote-pulse/scripts/audit-download-path
 */

import { localHeaders } from './local-operator.mjs';

const args = process.argv.slice(2);

/**
 * Read a flag's value.
 * @param {string} name - flag name.
 * @param {string} fallback - value when absent.
 * @returns {string} the value.
 */
function flag(name, fallback) {
  const at = args.indexOf(name);
  return at === -1 ? fallback : String(args[at + 1] ?? fallback);
}

const base = flag('--url', process.env.PULSE_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

/** Patterns that decide which mechanism the client uses, and the shell's answer. */
const PROBES = [
  { pattern: 'createObjectURL', verdict: 'blob 下载：WebView 拿不到 URL，DownloadListener 救不了' },
  { pattern: 'showSaveFilePicker', verdict: 'File System Access API：Android WebView 没有这个 API' },
  { pattern: "download = ''", verdict: 'a[download]：会给 DownloadListener 一个真实 URL' },
  { pattern: 'download=', verdict: 'URL 里带 download 参数：真实 URL' },
  { pattern: 'content-disposition', verdict: '服务端 attachment：真实 URL' },
  { pattern: 'fileBinaries', verdict: '按二进制接口取文件' },
  { pattern: 'uploadFileBinary', verdict: '上传接口（对照）' },
];

const opened = await fetch(`${base}/api/local/pairing`, { method: 'POST', headers: localHeaders() }).then(r => r.json());
const paired = await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: opened.code, label: 'download-audit' }),
});
const identity = await paired.json();
const cookie = (paired.headers.getSetCookie?.() ?? [])[0].split(';')[0];

try {
  const html = await fetch(`${base}/`, { headers: { cookie } }).then(r => r.text());
  // HTML-escaped ampersands matter: a plugin bundle URL arrives with &amp; in it
  // and fetching that literally returns zero bytes, which reads as "no matches".
  const unescape = value => value.replace(/&amp;/g, '&');
  const assets = [...new Set([
    ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => unescape(match[1])),
    ...[...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(match => unescape(match[1])),
  ])];

  /**
   * Fetch one asset.
   * @param {string} asset - its URL.
   * @returns {Promise<string>} its text, or empty when it is not text.
   */
  const load = async asset => {
    const url = new URL(asset, `${base}/`).href;
    try {
      const response = await fetch(url, { headers: { cookie } });
      return response.ok ? await response.text() : '';
    } catch {
      return '';
    }
  };

  // The entry bundle names its own chunks; the interesting code is usually in one
  // of those rather than in the entry, so they are followed one level deep.
  const queue = [...assets];
  const seen = new Set();
  const found = new Map();
  let budget = 24;

  console.log('官方客户端资源：');
  while (queue.length && budget > 0) {
    const asset = queue.shift();
    if (seen.has(asset)) continue;
    seen.add(asset);
    budget -= 1;
    const source = await load(asset);
    const hits = [];
    for (const probe of PROBES) {
      const count = source.split(probe.pattern).length - 1;
      if (count === 0) continue;
      found.set(probe.pattern, (found.get(probe.pattern) ?? 0) + count);
      hits.push(`${probe.pattern}×${count}`);
    }
    console.log(`  ${asset.slice(0, 70)}  len=${source.length}  ${hits.join('  ') || ''}`);
    // Print what the bundle references, so a chunk naming scheme that the regex
    // below does not anticipate is visible instead of silently skipping code.
    const references = [...new Set([...source.matchAll(/["'`]([^"'`\s]*\.js)["'`]/g)].map(match => match[1]))]
      .filter(name => !name.startsWith('http'))
      .slice(0, 8);
    if (references.length) console.log(`      引用: ${references.join('  ')}`);
    for (const match of source.matchAll(/["'`](\.?\/?assets\/[A-Za-z0-9_.-]+\.js)["'`]/g)) {
      const chunk = match[1].startsWith('.') ? match[1] : `./${match[1]}`;
      if (!seen.has(chunk)) queue.push(chunk);
    }
    for (const match of source.matchAll(/["'`]([A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.js)["'`]/g)) {
      const chunk = `./assets/${match[1]}`;
      if (!seen.has(chunk)) queue.push(chunk);
    }
  }

  console.log('');
  console.log(`结论（读了 ${seen.size} 个资源）：`);
  for (const probe of PROBES) {
    const count = found.get(probe.pattern) ?? 0;
    if (count === 0) continue;
    console.log(`  ${probe.pattern} 命中 ${count} 次 —— ${probe.verdict}`);
  }
  if (![...found.keys()].length) console.log('  （没有命中任何已知的下载机制）');
} finally {
  await fetch(`${base}/api/local/devices/${identity.deviceId}`, { method: 'DELETE', headers: localHeaders() }).catch(() => {});
}
