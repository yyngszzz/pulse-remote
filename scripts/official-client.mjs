#!/usr/bin/env node
/**
 * Read a client plugin's own source and stylesheet out of what the server serves.
 *
 *   const jobs = await officialModule(base, cookie, '@deepseek-ai/dsh-client-ui-jobs');
 *   jobs.prefix   // 'QsffPG' — the hash its class names are built on
 *   jobs.css      // its stylesheet, as a string
 *
 * ## Why this is shared rather than inlined twice
 *
 * Probes that plant a fixture need the *real* class names and the *real* stylesheet,
 * or they end up asserting against markup nobody renders: the first files-tree probe
 * built its own class names and happily passed eighteen checks against a bare
 * `<button>` with the browser's default look — borders, `<ul>` bullets and all.
 * Two copies of that extraction is two chances to get it wrong.
 *
 * The URL comes from the served document, so this needs no knowledge of where the
 * harness is installed, and it reads exactly the bytes the phone receives.
 *
 * ## The trap it exists to avoid
 *
 * `/plugins/??a/client.js,b/client.js,…` is one response containing fifty plugins,
 * so the first match for a class suffix in it belongs to whichever module happens to
 * come first — not to the one being asked about. The module is therefore cut out by
 * its loader id first, and a miss is reported rather than guessed at.
 *
 * @module pulse-remote/scripts/official-client
 */

/** One fetch per base URL; the bundle is megabytes and never changes mid-run. */
const cache = new Map();

/**
 * Fetch the concatenated client bundle the page loads.
 *
 * @param {string} base - plugin base URL, no trailing slash.
 * @param {string} cookie - the paired session cookie.
 * @returns {Promise<string>} the bundle source, or an empty string.
 */
async function bundle(base, cookie) {
  if (cache.has(base)) return cache.get(base);
  const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  const url = (/\/plugins\/\?\?[^"'\s]*client\.js[^"'\s]*/.exec(html) || [])[0];
  const source = url
    ? await (await fetch(new URL(url.replace(/&amp;/g, '&'), base).href, { headers: { cookie } })).text()
    : '';
  cache.set(base, source);
  return source;
}

/**
 * Locate one plugin inside the bundle and read its identity off its own code.
 *
 * @param {string} base - plugin base URL, no trailing slash.
 * @param {string} cookie - the paired session cookie.
 * @param {string} id - the module id, e.g. `@deepseek-ai/dsh-client-ui-jobs`.
 * @returns {Promise<{section: string, prefix: string, css: string, marker: string}>} what was found.
 */
export async function officialModule(base, cookie, id) {
  const source = await bundle(base, cookie);
  const marker = JSON.stringify(id);
  const start = source.indexOf(marker);
  const end = start === -1 ? -1 : source.indexOf('__ModuleLoader__.load(', start + marker.length);
  const section = start === -1 ? '' : source.slice(start, end === -1 ? undefined : end);

  // The class hash is whatever precedes the first generated rule in this module's
  // stylesheet, which is the only place it is written down as a bare string.
  const cssText = [...section.matchAll(/css = "([^"]+)"/g)].map(match => match[1]);
  const prefix = (/([A-Za-z0-9_-]+)_[a-zA-Z]+\{/.exec(cssText.join('')) || [])[1] || '';
  const css = cssText.find(text => prefix && text.includes(`${prefix}_`)) || '';

  return { section, prefix, css, marker };
}

/**
 * Count how many generated class names in a stylesheet carry one suffix.
 *
 * @param {string} css - a plugin stylesheet.
 * @param {string} suffix - e.g. `_menu`.
 * @returns {number} how many distinct classes matched.
 */
export function classesEndingWith(css, suffix) {
  const names = new Set();
  for (const match of css.matchAll(/\.([A-Za-z0-9_-]+)\{/g)) {
    if (match[1].endsWith(suffix)) names.add(match[1]);
  }
  return names.size;
}
