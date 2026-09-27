/**
 * Mint a scan-to-pair code and print it for hand-off.
 *
 * Usage: node scripts/pair-qr.mjs <publicBaseUrl> [localPulseUrl]
 *
 * Prints the link, a large-type code, and a real expiry countdown, and writes a
 * PNG next to the working directory. The code is single-use; minting a new one
 * invalidates the previous one, so this must be the LAST step before scanning.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import qrcodeRender from 'qrcode';
import terminal from 'qrcode-terminal';

import { localHeaders } from './local-operator.mjs';

const publicBase = (process.argv[2] ?? '').replace(/\/+$/, '');
const localBase = (process.argv[3] ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');

if (!publicBase) {
  console.error('usage: node scripts/pair-qr.mjs <publicBaseUrl> [localPulseUrl]');
  process.exit(2);
}

// Minting is a local-operator action: the peer address cannot prove locality,
// because the phone reaches Pulse through a reverse tunnel and therefore also
// arrives from 127.0.0.1.
const opened = await fetch(`${localBase}/api/local/pairing`, { method: 'POST', headers: localHeaders() });
if (!opened.ok) {
  console.error(`could not mint a pairing code: HTTP ${opened.status} ${await opened.text()}`);
  process.exit(1);
}
const { code, expiresAt } = await opened.json();

// The code rides the URL so a scan pairs in one step. It is single-use and
// time-limited, which is what makes putting it in a URL acceptable.
const link = `${publicBase}/?code=${encodeURIComponent(code)}`;
const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));

terminal.generate(link, { small: true });

const pngPath = join(process.cwd(), 'pulse-pair-qr.png');
await qrcodeRender.toFile(pngPath, link, { width: 720, margin: 2, errorCorrectionLevel: 'M' });

console.log('');
console.log('  ┌─────────────────────────────────────────────────┐');
console.log(`  │   配对码：  ${code.padEnd(36)}│`);
console.log('  └─────────────────────────────────────────────────┘');
console.log('');
console.log(`  链接     ：${link}`);
console.log(`  有效期   ：${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后失效（一次性）`);
console.log(`  二维码   ：${pngPath}`);
console.log('');
console.log('  手机上：');
console.log('    1) 用「系统相机 / 浏览器」扫上面的二维码，或手动输入上面的链接');
console.log('    2) 证书警告点「高级 → 继续前往」（自签证书，正常）');
console.log('    3) 配对码会自动填入，点「配对」');
console.log('');
console.log('  注意：生成新配对码会让这一个立刻失效，别重复运行本命令。');
console.log('');
