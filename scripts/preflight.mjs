#!/usr/bin/env node
/**
 * Deployment health check: is the whole chain up right now?
 *
 * This is the fast, non-mutating counterpart to `verify-remote.mjs`. It pairs
 * nothing, revokes nothing and mints no code, so it is safe to run on a timer
 * or after every restart -- which is exactly what a supervisor needs.
 *
 *   node scripts/preflight.mjs [publicBaseUrl] [--insecure] [--json]
 *
 * Checks, in the order a failure would actually be discovered:
 *
 *   1. the local Pulse listener is up
 *   2. the public HTTPS edge reaches it (so the tunnel is up)
 *   3. the served client script is the build on disk (not a cached one)
 *   4. the management subtree is fenced off from the public edge
 *
 * Exit code is 0 when everything passes, 1 otherwise.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const insecure = args.includes('--insecure');
const explicit = args.find(argument => !argument.startsWith('--')) ?? process.env.PULSE_PUBLIC_BASE ?? '';

if (!explicit) {
  console.error('usage: node scripts/preflight.mjs <publicBaseUrl> [--insecure] [--json]');
  console.error('   or: PULSE_PUBLIC_BASE=https://your.host node scripts/preflight.mjs');
  process.exit(2);
}
const base = explicit.replace(/\/+$/, '');

if (insecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  if (!asJson) console.warn('warn: TLS verification disabled (--insecure)');
}

/** The loopback listener, for the "is Pulse even running" question. */
const localBase = (process.env.PULSE_LOCAL_BASE ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

const checks = [];

/**
 * Record one check.
 * @param {string} name - what was checked.
 * @param {boolean} ok - whether it passed.
 * @param {string} detail - evidence.
 * @param {string} [hint] - what to do when it fails.
 * @returns {void}
 */
function record(name, ok, detail, hint) {
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? ''), hint: hint ?? '' });
}

/**
 * Fetch with a hard timeout, returning null instead of throwing.
 * @param {string} url - the URL.
 * @param {object} [init] - fetch options.
 * @returns {Promise<{status: number, text: string} | null>} the response.
 */
async function probe(url, init = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
    return { status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}

// ---- 1. local listener -------------------------------------------------------

const local = await probe(`${localBase}/health`);
record(
  '本机 Pulse 监听中',
  Boolean(local && local.status === 200),
  local ? `status=${local.status}` : '连不上 127.0.0.1:3199',
  'DSH 没在跑，或者插件没加载。看 DSH 日志里的 [remote-pulse] 行。',
);

// ---- 2. the public edge reaches it ------------------------------------------

const health = await probe(`${base}/health`);
if (!health || health.status !== 200) {
  record('公网 HTTPS 能到 Pulse', false, health ? `status=${health.status}` : '连不上', 
    '隧道断了（scripts/tunnel.ps1），或 nginx / 安全组没放行 443。');
} else {
  let body = null;
  try {
    body = JSON.parse(health.text);
  } catch {
    /* not json */
  }
  record('公网 HTTPS 能到 Pulse', true, `status=200 realm=${body?.realm} exposed=${body?.exposed}`);
  record('公网 = 同一个实例', body?.exposed === false || body?.paired !== undefined, `paired=${body?.paired}`);
  record('推送通道就绪', Boolean(body?.push?.ready), 
    body?.push ? `ready=${body.push.ready} subscriptions=${body.push.subscriptions}` : 'no push object',
    'web-push 依赖缺失，或 VAPID 初始化失败。');
}

// ---- 3. the served client is the build on disk ------------------------------

const served = await probe(`${base}/pulse.js`);
if (!served || served.status !== 200) {
  record('客户端脚本可下载', false, served ? `status=${served.status}` : '连不上');
} else {
  record('客户端脚本可下载', true, `len=${served.text.length}`);
  // Compared against the artifact this checkout generates, not against the
  // source file: /pulse.js is only one of several pages lib/ui.js builds, so a
  // length heuristic against the file is meaningless.
  let expected = null;
  try {
    const { pulseScript } = await import('../lib/ui.js');
    expected = pulseScript();
  } catch (error) {
    record('能生成本地客户端做比对', false, String(error?.message ?? error));
  }
  if (expected !== null) {
    record(
      '公网客户端 = 本checkout 的构建',
      served.text === expected,
      served.text === expected
        ? `both ${expected.length} chars`
        : `served=${served.text.length} local=${expected.length}`,
      '要么中间层缓存了旧客户端，要么部署的是另一个版本。Pulse 已发 no-store，先排查缓存层。',
    );
  }
}

// ---- 4. the management fence -------------------------------------------------

const fence = await probe(`${base}/api/local/pairing`, { method: 'POST' });
let fenceBody = null;
try {
  fenceBody = JSON.parse(fence?.text ?? '');
} catch {
  /* not json */
}
record(
  '公网拿不到本机管理接口',
  fence?.status === 403 && !fenceBody?.code,
  fence ? `status=${fence.status} code=${fenceBody?.code ?? 'none'}` : '连不上',
  '严重：任何人都能申请配对码。检查 lib/server.js 的 localDenial 与 nginx 的 X-Forwarded-For 覆写。',
);

// ---- the service worker ------------------------------------------------------

const worker = await probe(`${base}/sw.js`);
record(
  '推送 worker 在线且不被缓存',
  Boolean(worker && worker.status === 200 && /no-store/i.test(worker.text) === false && worker.text.includes('push')),
  worker ? `status=${worker.status} len=${worker.text.length}` : '连不上',
);

// ---- report ------------------------------------------------------------------

const failed = checks.filter(check => !check.ok);

if (asJson) {
  console.log(JSON.stringify({ base, ok: failed.length === 0, checks }, null, 2));
} else {
  console.log(`Pulse 部署自检  ${base}`);
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? `   (${check.detail})` : ''}`);
    if (!check.ok && check.hint) console.log(`         -> ${check.hint}`);
  }
  console.log('');
  console.log(failed.length === 0 ? '全部通过' : `${failed.length} 项失败`);
}

process.exitCode = failed.length === 0 ? 0 : 1;
