/**
 * Shared helpers for the local operator scripts.
 *
 * Every script that drives `/api/local/*` runs on the machine that hosts Pulse,
 * so it can read the local-operator token from the state directory. Nothing
 * here is available to a remote caller, which is the entire point of the token:
 * the socket address cannot tell a local process from a tunnelled one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCAL_TOKEN_HEADER, readLocalToken } from '../lib/local-token.js';

/**
 * Resolve the harness home directory the way DSH and the plugin do.
 * @returns {string} the absolute DSH home.
 */
export function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
}

/**
 * Path of the plugin state directory.
 * @returns {string} the absolute path.
 */
export function pulseStateDir() {
  return join(dshHome(), 'remote-pulse');
}

/**
 * The origin the local management API is reached at.
 *
 * Always loopback: a request that arrives through the public edge is refused
 * the management subtree, so administration cannot travel over the tunnel.
 * @type {string}
 */
export const localBase = (process.env.PULSE_LOCAL_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

/**
 * Read the local-operator token, with a clear failure when it is missing.
 * @param {object} [options] - tuning.
 * @param {boolean} [options.optional] - return '' instead of exiting.
 * @returns {string} the token, or '' when optional and absent.
 */
export function localToken(options = {}) {
  // An explicit override keeps this usable from a script that was handed the
  // token out of band (a service manager, a CI job) without a state directory.
  const fromEnv = String(process.env.PULSE_LOCAL_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;

  const token = readLocalToken(pulseStateDir());
  if (token) return token;
  if (options.optional) return '';

  console.error(
    [
      '找不到本机管理令牌。',
      '',
      `  期望位置：${join(pulseStateDir(), 'local-token')}`,
      '',
      '这个令牌由 Pulse 插件在启动时创建。请确认：',
      '  1) DSH 正在运行，且已加载 dsh-remote-pulse 插件；',
      '  2) DSH_HOME 指向同一个目录（当前：' + dshHome() + '）；',
      '  3) 或直接设置 PULSE_LOCAL_TOKEN 环境变量。',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * Headers that authenticate a local operator.
 * @param {object} [options] - tuning; see {@link localToken}.
 * @returns {Record<string, string>} the headers.
 */
export function localHeaders(options = {}) {
  const token = localToken(options);
  return token ? { [LOCAL_TOKEN_HEADER]: token } : {};
}

/**
 * Read a file as trimmed UTF-8 text, or return a fallback.
 * @param {string} path - the file.
 * @param {string} fallback - returned when the read fails.
 * @returns {string} the text.
 */
export function readText(path, fallback = '') {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return fallback;
  }
}
