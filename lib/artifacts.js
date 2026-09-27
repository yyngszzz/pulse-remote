/**
 * The artifacts index: what the agent produced, as seen from the phone.
 *
 * ## Where the list comes from
 *
 * Not from walking the filesystem, and not from a second file API. Pulse already
 * consumes the session event stream, and every tool call carries its arguments —
 * so the set of files the agent touched is *already* flowing through this
 * process. Recording it costs no new coupling to the harness, and it means the
 * list is exactly "what the agent did", which is the question the phone is
 * asking. The official file browser answers a different question ("what exists").
 *
 * ## Why the allowlist is the security boundary
 *
 * Serving file bytes over HTTP is the one genuinely dangerous thing in this
 * module, because a path that arrives in a query string is attacker-controlled.
 * A normalising check ("is this inside the workspace root?") is easy to get
 * subtly wrong, so the content route never accepts a path as an *instruction*:
 * it accepts a path only if that exact path is already in the index, i.e. only
 * if the harness itself just wrote it. Traversal is therefore not defended
 * against, it is *unreachable* — there is no code path that opens a path the
 * agent did not produce.
 *
 * A small denylist sits on top of that for the cases where the agent *did* write
 * something that must not land on a phone's lock screen: credential stores and
 * this plugin's own state.
 *
 * @module pulse-remote/artifacts
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

/**
 * Tools whose arguments name a file they produced or changed.
 *
 * Derived from the harness's own tool surface: `toolGroup` in `distill.js`
 * already buckets `write`/`edit`/`insert`/`str_replace_editor`/`apply_patch` as
 * mutations, and the extra names here cover the same idea under other spellings.
 */
export const WRITE_TOOLS = Object.freeze(
  new Set([
    'write',
    'edit',
    'insert',
    'str_replace_editor',
    'apply_patch',
    'create',
    'create_file',
    'multi_edit',
    'notebook_edit',
    'write_file',
  ]),
);

/** Argument keys a tool uses to name its file, most specific first. */
const PATH_KEYS = Object.freeze(['file_path', 'filePath', 'notebook_path', 'path', 'target_file']);

/**
 * Argument keys holding a list of files rather than a single one.
 *
 * `present` — the tool an agent uses to hand files to the user — carries
 * `files: [{ path, description }]`. Nothing recorded those, which is why the file
 * list contained only files that had been written with an editor tool and never
 * a single image: every screenshot in this project was produced by running a
 * script, and so only ever passed through `present`.
 */
const FILE_LIST_KEYS = Object.freeze(['files', 'artifacts', 'attachments']);

/** How many artifacts are remembered. Old ones fall out; this is a recent view. */
export const ARTIFACT_CAPACITY = 200;

/** Largest text preview returned inline. */
export const TEXT_PREVIEW_LIMIT = 256 * 1024;

/** Largest binary (image) served at all. */
export const BINARY_SERVE_LIMIT = 8 * 1024 * 1024;

/**
 * Paths that are never served, whatever the agent did to them.
 *
 * The allowlist already makes an arbitrary read impossible; this covers the case
 * where the agent itself wrote a secret and Pulse would otherwise cheerfully
 * mirror it to a lock screen.
 */
const DENY_PATTERNS = Object.freeze([
  /(^|[\\/])\.credentials\.ya?ml$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  // This plugin's own state: the local-operator token lives here, and that token
  // is the boundary protecting the management subtree.
  /(^|[\\/])remote-pulse([\\/]|$)/i,
  /(^|[\\/])session\.key$/i,
  /(^|[\\/])devices\.json$/i,
  /(^|[\\/])local-token$/i,
]);

/** Extensions rendered as text, mapped to the type sent to the browser. */
const TEXT_TYPES = Object.freeze({
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.cjs': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
});

/** Extensions rendered as images. */
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
});

/**
 * Whether a produced path may be served to a phone at all.
 *
 * @param {string} path - the artifact path.
 * @returns {boolean} true when it may be listed and served.
 */
export function isServablePath(path) {
  const value = String(path ?? '').trim();
  if (!value) return false;
  return !DENY_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Extract the file a tool call produced, if it produced one.
 *
 * Conservative by design: a tool that is not known to write, or that names no
 * file, yields nothing. A false negative means a missing row; a false positive
 * would mean offering the user a file the agent never wrote.
 *
 * @param {string} toolName - the tool name.
 * @param {Record<string, unknown> | undefined} args - parsed tool arguments.
 * @returns {string | null} the path, or null.
 */
export function artifactPathFrom(toolName, args) {
  const name = String(toolName ?? '').trim().toLowerCase();
  if (!WRITE_TOOLS.has(name)) return null;
  if (!args || typeof args !== 'object') return null;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      const path = value.trim();
      return isServablePath(path) ? path : null;
    }
  }
  return null;
}

/**
 * Every file a tool call named, for tools that carry a list.
 *
 * Separate from artifactPathFrom because the shapes differ: one path in a named
 * key, versus an array of entries. A tool that is not known to write still gets
 * its list read, because naming a file in a `files` array *is* the agent saying
 * these are files for the user — and a path that does not exist simply fails to
 * resolve later rather than offering anything misleading.
 *
 * @param {string} toolName - the tool name.
 * @param {Record<string, unknown> | undefined} args - parsed tool arguments.
 * @returns {string[]} the servable paths, deduplicated.
 */
export function artifactPathsFrom(toolName, args) {
  const found = [];
  const single = artifactPathFrom(toolName, args);
  if (single) found.push(single);
  if (!args || typeof args !== 'object') return found;

  for (const key of FILE_LIST_KEYS) {
    const list = args[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const candidate = typeof entry === 'string'
        ? entry
        : (entry && typeof entry === 'object' ? entry.path ?? entry.file_path : null);
      if (typeof candidate !== 'string') continue;
      const path = candidate.trim();
      // Absolute only. isServablePath answers "is this a location we refuse to
      // serve", which is the right question for a path an editor tool just wrote;
      // it is not the right question for a list of files being handed to the user,
      // where a relative entry resolves against nothing and can only ever produce
      // a row that fails to read.
      if (path && isAbsolute(path) && isServablePath(path)) found.push(path);
    }
  }
  return [...new Set(found)];
}

/**
 * How the phone should render a path.
 *
 * @param {string} path - the artifact path.
 * @returns {'image' | 'text' | 'binary'} the preview kind.
 */
export function previewKindFor(path) {
  const extension = extname(String(path ?? '')).toLowerCase();
  if (IMAGE_TYPES[extension]) return 'image';
  if (TEXT_TYPES[extension]) return 'text';
  return 'binary';
}

/**
 * The content type to serve a path with.
 *
 * @param {string} path - the artifact path.
 * @returns {string} a MIME type.
 */
export function contentTypeFor(path) {
  const extension = extname(String(path ?? '')).toLowerCase();
  return IMAGE_TYPES[extension] ?? TEXT_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * A bounded, insertion-ordered record of what the agent produced.
 */
export class ArtifactIndex {
  /**
   * @param {object} [options] - tuning.
   * @param {() => number} [options.now] - clock.
   * @param {number} [options.capacity] - how many paths to remember.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.capacity = options.capacity ?? ARTIFACT_CAPACITY;
    /** @type {Map<string, object>} path → entry, insertion ordered. */
    this.entries = new Map();
  }

  /**
   * Record one produced file. Re-recording a path refreshes it and moves it to
   * the front, so the list reads as "most recently touched first".
   *
   * @param {object} event - `{path, tool, sessionId}`.
   * @returns {object | null} the entry, or null when the path is not servable.
   */
  record(event) {
    const path = String(event?.path ?? '').trim();
    if (!isServablePath(path)) return null;
    // Re-insert so the newest touch sorts last in the map and first in the list.
    this.entries.delete(path);
    const entry = {
      path,
      name: basename(path),
      tool: String(event?.tool ?? ''),
      sessionId: String(event?.sessionId ?? ''),
      at: this.now(),
      kind: previewKindFor(path),
    };
    this.entries.set(path, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return entry;
  }

  /**
   * Observe a tool call, recording every file it named.
   *
   * A call may name several — a `present` of four screenshots is one call and four
   * artifacts — so this returns what was recorded rather than a single entry.
   *
   * @param {object} event - `{sessionId, toolName, args}`.
   * @returns {object[]} the entries recorded, possibly empty.
   */
  observeToolCall(event) {
    const paths = artifactPathsFrom(event?.toolName, event?.args);
    const recorded = [];
    for (const path of paths) {
      const entry = this.record({ path, tool: event?.toolName, sessionId: event?.sessionId });
      if (entry) recorded.push(entry);
    }
    return recorded;
  }

  /**
   * Whether a path is one the agent produced.
   * @param {string} path - the candidate.
   * @returns {boolean} true when it is in the index.
   */
  has(path) {
    return this.entries.has(String(path ?? ''));
  }

  /**
   * The recorded entry for a path.
   * @param {string} path - the candidate.
   * @returns {object | null} the entry, or null.
   */
  get(path) {
    return this.entries.get(String(path ?? '')) ?? null;
  }

  /**
   * List artifacts, most recently touched first.
   * @returns {Array<object>} the entries.
   */
  list() {
    return [...this.entries.values()].reverse();
  }

  /** @returns {number} how many artifacts are remembered. */
  get size() {
    return this.entries.size;
  }

  /** @returns {void} */
  clear() {
    this.entries.clear();
  }

  /**
   * Serialize for persistence, oldest first so restoring preserves recency.
   *
   * The files themselves live on disk and are unaffected by a restart, so losing
   * the list on every harness restart would be a needless amnesia: the artifacts
   * are still there, and the phone should still see them.
   *
   * @returns {Array<object>} a JSON-serializable list.
   */
  toJSON() {
    return [...this.entries.values()];
  }

  /**
   * Rebuild an index from persisted entries.
   *
   * Entries are re-validated on the way in rather than trusted: the file is a
   * plain file in the harness home, and a stale one must not be able to
   * reintroduce a path the denylist now rejects.
   *
   * @param {unknown} data - the persisted list.
   * @returns {number} how many entries were restored.
   */
  restore(data) {
    if (!Array.isArray(data)) return 0;
    let restored = 0;
    for (const entry of data) {
      const path = String(entry?.path ?? '').trim();
      if (!isServablePath(path)) continue;
      this.entries.set(path, {
        path,
        name: basename(path),
        tool: String(entry?.tool ?? ''),
        sessionId: String(entry?.sessionId ?? ''),
        at: Number.isFinite(entry?.at) ? Number(entry.at) : this.now(),
        kind: previewKindFor(path),
      });
      restored += 1;
    }
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return restored;
  }
}

/**
 * Read a recorded artifact for preview or download.
 *
 * @param {ArtifactIndex} index - the allowlist.
 * @param {string} path - the requested path; must already be in the index.
 * @param {object} [limits] - cap overrides, so the branches are testable.
 * @param {number} [limits.text] - largest text preview.
 * @param {number} [limits.binary] - largest binary served.
 * @returns {{ok: true, kind: string, contentType: string, body: Buffer, size: number, truncated: boolean}
 *   | {ok: false, reason: string}} the result.
 */
export function readArtifact(index, path, limits = {}) {
  if (!index.has(path)) return { ok: false, reason: 'not-an-artifact' };
  const entry = index.get(path);
  const kind = entry?.kind ?? previewKindFor(path);
  const textLimit = limits.text ?? TEXT_PREVIEW_LIMIT;
  const binaryLimit = limits.binary ?? BINARY_SERVE_LIMIT;

  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!stats.isFile()) return { ok: false, reason: 'not-a-file' };

  const limit = kind === 'text' ? textLimit : binaryLimit;
  // A text file that is merely long is still worth a truncated preview; a binary
  // over the cap is not worth streaming to a phone at all.
  if (kind !== 'text' && stats.size > limit) return { ok: false, reason: 'too-large' };

  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const body = raw.length > limit ? raw.subarray(0, limit) : raw;
  return {
    ok: true,
    kind,
    contentType: contentTypeFor(path),
    body,
    size: stats.size,
    truncated: raw.length > body.length,
  };
}
