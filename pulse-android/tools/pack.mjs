#!/usr/bin/env node
/**
 * Assemble the final APK: aapt2's resource package plus the compiled dex.
 *
 * ## Why this exists instead of a one-liner
 *
 * An APK is a zip, and an app targeting API 30+ **fails to install** if
 * `resources.arsc` is deflated — the platform mmaps that file and refuses a
 * compressed one with `INSTALL_PARSE_FAILED_RESOURCES_ARSC_COMPRESSED`. aapt2
 * chooses the right method (stored for `resources.arsc`, deflate for the rest),
 * so the only job here is to add `classes.dex` **without disturbing the entries
 * that are already correct**.
 *
 * Two attempts to do that cheaply went wrong, which is why this is a real zip
 * reader and writer rather than a library call:
 *
 *   * .NET's `CompressionLevel.NoCompression` does not store an entry — it
 *     deflates with level 0, which still produced `resources.arsc` as method 8;
 *   * any archive library that re-encodes entries from decoded bytes loses the
 *     original writer's choices, and with them the guarantee.
 *
 * So each entry's compression method is read from the source and preserved
 * exactly, and only the new dex entry picks its own.
 *
 * Usage: node tools/pack.mjs <base.apk> <classes.dex> <out.apk>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

const STORED = 0;
const DEFLATED = 8;

/**
 * Read every entry out of a zip.
 * @param {Buffer} buffer - the whole archive.
 * @returns {Array<{name: string, method: number, data: Buffer}>} the entries, in order.
 */
function readZip(buffer) {
  // Locate the end-of-central-directory record, scanning back over any comment.
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index >= buffer.length - 22 - 0xffff; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip: no end-of-central-directory record');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.push({
      name,
      method,
      data: method === STORED ? Buffer.from(raw) : inflateRawSync(raw),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Write a zip, compressing each entry the way it asks to be compressed.
 * @param {Array<{name: string, method: number, data: Buffer}>} entries - the entries.
 * @returns {Buffer} the archive.
 */
function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data) >>> 0;
    // The two methods are re-derived from the payload, so an entry that arrived
    // stored stays stored byte-for-byte.
    const payload = entry.method === STORED ? entry.data : deflateRawSync(entry.data, { level: 9 });

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags: sizes are known up front
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10);              // mod time
    local.writeUInt16LE(0x21, 12);           // mod date (1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);             // version made by
    header.writeUInt16LE(20, 6);             // version needed
    header.writeUInt16LE(0, 8);              // flags
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);             // extra
    header.writeUInt16LE(0, 32);             // comment
    header.writeUInt16LE(0, 34);             // disk
    header.writeUInt16LE(0, 36);             // internal attributes
    header.writeUInt32LE(0, 38);             // external attributes
    header.writeUInt32LE(offset, 42);        // local header offset
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

// ---- main -------------------------------------------------------------------

const [baseApk, dexPath, outApk] = process.argv.slice(2);
if (!baseApk || !dexPath || !outApk) {
  console.error('usage: node tools/pack.mjs <base.apk> <classes.dex> <out.apk>');
  process.exit(2);
}

const base = readFileSync(baseApk);
const entries = readZip(base);
const dex = readFileSync(dexPath);

if (entries.some(entry => entry.name === 'classes.dex')) {
  throw new Error('base apk already contains classes.dex');
}

// The dex is bulky and highly compressible; the resources are not ours to
// re-decide, which is why their methods came from the source archive.
entries.push({ name: 'classes.dex', method: DEFLATED, data: dex });

const output = writeZip(entries);
writeFileSync(outApk, output);

// Read the result back rather than trusting the writer: a wrong method here is
// an install failure on the phone, hours after the build looked fine.
const check = readZip(output);
const arsc = check.find(entry => entry.name === 'resources.arsc');
if (!arsc) throw new Error('resources.arsc disappeared');
if (arsc.method !== STORED) {
  throw new Error(`resources.arsc must be stored, got method ${arsc.method}`);
}
const written = check.find(entry => entry.name === 'classes.dex');
if (!written || written.data.length !== dex.length) {
  throw new Error('classes.dex was not written intact');
}

console.log(`  entries: ${check.length}`);
console.log(`  resources.arsc: stored (${arsc.data.length} bytes)`);
console.log(`  classes.dex: deflated (${dex.length} bytes)`);
