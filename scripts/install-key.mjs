/**
 * One-time key installation over password auth.
 *
 * Windows OpenSSH cannot take a password from the command line, so this uses
 * the ssh2 library to log in once, install the public key, and harden the
 * permissions that OpenSSH enforces strictly for root.
 *
 * The password is read from argv and never written to disk or logged.
 *
 * Usage:
 *   node scripts/install-key.mjs <user@host> <password> <publicKeyFile> [port]
 */

import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';

const [target, password, publicKeyFile, portArg] = process.argv.slice(2);
if (!target || !password || !publicKeyFile) {
  console.error('usage: node scripts/install-key.mjs <user@host> <password> <publicKeyFile> [port]');
  process.exit(2);
}

const at = target.lastIndexOf('@');
const username = at === -1 ? 'root' : target.slice(0, at);
const host = at === -1 ? target : target.slice(at + 1);
const port = Number(portArg) || 22;

const publicKey = readFileSync(publicKeyFile, 'utf8').trim();
if (!publicKey.startsWith('ssh-') && !publicKey.startsWith('ecdsa-')) {
  console.error(`not a public key: ${publicKeyFile}`);
  process.exit(2);
}

/**
 * Run one command and resolve with its combined output.
 * @param {Client} conn - the connected client.
 * @param {string} command - the shell command.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} the result.
 */
function run(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', chunk => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', code => resolve({ code, stdout, stderr }));
    });
  });
}

const conn = new Client();

conn.on('ready', async () => {
  try {
    console.log(`connected as ${username}@${host}:${port}`);
    const who = await run(conn, 'whoami; uname -sr');
    console.log(`remote: ${who.stdout.trim().replace(/\n/g, ' | ')}`);

    // mkdir -p, then append the key only when it is not already present, so a
    // re-run is idempotent rather than piling up duplicates.
    const escaped = publicKey.replace(/'/g, `'\\''`);
    const script = [
      'mkdir -p ~/.ssh',
      'chmod 700 ~/.ssh',
      'touch ~/.ssh/authorized_keys',
      `grep -qxF '${escaped}' ~/.ssh/authorized_keys || printf '%s\\n' '${escaped}' >> ~/.ssh/authorized_keys`,
      'chmod 600 ~/.ssh/authorized_keys',
      'chown -R "$(id -u):$(id -g)" ~/.ssh 2>/dev/null || true',
      'restorecon -R ~/.ssh 2>/dev/null || true',
      'echo "--- state ---"',
      'ls -ld ~/.ssh',
      'ls -l ~/.ssh/authorized_keys',
      'wc -l < ~/.ssh/authorized_keys',
    ].join(' && ');

    const installed = await run(conn, script);
    console.log(installed.stdout.trim());
    if (installed.stderr.trim()) console.log(`stderr: ${installed.stderr.trim()}`);

    // Read back the last key so the operator can confirm the right one landed.
    const tail = await run(conn, 'tail -n 1 ~/.ssh/authorized_keys | cut -c1-60');
    console.log(`last key on server: ${tail.stdout.trim()}`);
    conn.end();
    process.exit(installed.code === 0 ? 0 : 1);
  } catch (error) {
    console.error(`failed: ${error.message}`);
    conn.end();
    process.exit(1);
  }
});

conn.on('error', error => {
  console.error(`connection failed: ${error.message}`);
  process.exit(1);
});

conn.connect({
  host,
  port,
  username,
  password,
  readyTimeout: 20_000,
  // The host key was already accepted by the ssh client during the probe; this
  // run only needs to move a public key.
  algorithms: undefined,
});
