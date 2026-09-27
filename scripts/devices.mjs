/**
 * Local device administration: see which phones are paired, and revoke one.
 *
 * Usage:
 *   node scripts/devices.mjs list
 *   node scripts/devices.mjs revoke <deviceId|all>
 *   node scripts/devices.mjs status
 *   node scripts/devices.mjs pairing [--close]
 *
 * This is the local-operator counterpart to the phone surface. It must run on
 * the machine hosting Pulse, because revoking a lost phone is a `local` action:
 * a remote caller is refused the management subtree even with a valid token, by
 * design (see lib/local-token.js).
 *
 * Revoking is immediate and permanent for that device — the phone falls back to
 * the pairing gate on its next request, and any Web Push subscriptions bound to
 * it are dropped so it stops receiving task content on the lock screen.
 */

import { localBase, localHeaders } from './local-operator.mjs';

const base = localBase;
const action = (process.argv[2] ?? 'list').toLowerCase();
const argument = process.argv[3] ?? '';

/**
 * Call a local management endpoint.
 * @param {string} path - the endpoint path.
 * @param {object} [init] - fetch options.
 * @returns {Promise<{status: number, body: any}>} the response.
 */
async function local(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...localHeaders(), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    console.error(`HTTP ${response.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    process.exit(1);
  }
  return { status: response.status, body };
}

/**
 * Render an age in the largest sensible unit.
 * @param {number} ms - the age in milliseconds.
 * @returns {string} a short human string.
 */
function age(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

if (action === 'list') {
  const { body } = await local('/api/local/devices');
  const devices = body.devices ?? [];
  if (devices.length === 0) {
    console.log('没有已配对的设备。用 node scripts/pair-qr.mjs <公网地址> 生成配对码。');
    process.exit(0);
  }
  console.log(`已配对 ${devices.length} 台设备：\n`);
  for (const device of devices) {
    console.log(`  ${device.id}  ${(device.label ?? '').padEnd(10)}  最近活跃 ${age(Date.now() - device.lastSeenAt)}`);
  }
  console.log('\n撤销：node scripts/devices.mjs revoke <id>     全部撤销：node scripts/devices.mjs revoke all');
} else if (action === 'revoke') {
  if (!argument) {
    console.error('usage: node scripts/devices.mjs revoke <deviceId|all>');
    process.exit(2);
  }
  if (argument.toLowerCase() === 'all') {
    const { body } = await local('/api/local/devices', { method: 'DELETE' });
    console.log(`已撤销 ${body.revoked} 台设备，全部手机需要重新配对。`);
  } else {
    const { body } = await local(`/api/local/devices/${encodeURIComponent(argument)}`, { method: 'DELETE' });
    console.log(body.ok ? `已撤销 ${argument}。` : `没有找到设备 ${argument}（可能已撤销）。`);
  }
} else if (action === 'status') {
  const { body } = await local('/api/local/status');
  console.log(`  监听        ：${body.host}:${body.port}${body.exposed ? '（对外）' : '（仅本机）'}`);
  console.log(`  已配对设备  ：${body.devices?.length ?? 0}`);
  console.log(`  在线手机    ：${body.phones ?? 0}`);
  console.log(
    `  配对通道    ：${
      body.pairingOpen
        ? `开启，${Math.max(0, Math.round((body.pairingExpiresAt - Date.now()) / 1000))} 秒后失效`
        : '关闭'
    }`,
  );
} else if (action === 'pairing') {
  if (process.argv.includes('--close')) {
    await local('/api/local/pairing', { method: 'DELETE' });
    console.log('配对通道已关闭。');
  } else {
    const { body } = await local('/api/local/pairing', { method: 'POST' });
    const seconds = Math.max(0, Math.round((body.expiresAt - Date.now()) / 1000));
    console.log(`配对码：${body.code}（${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后失效，一次性）`);
    console.log('注意：这会让上一个配对码立刻失效。要连二维码一起打印，用 scripts/pair-qr.mjs。');
  }
} else {
  console.error('usage: node scripts/devices.mjs [list|status|revoke <id|all>|pairing [--close]]');
  process.exit(2);
}
