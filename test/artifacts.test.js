/**
 * The artifacts index.
 *
 * The list itself is bookkeeping; the part that needs proving is the content
 * route, which serves file bytes over HTTP. Its guarantee is stronger than
 * validation — a path is serverable only if the harness already produced it —
 * and these tests pin that guarantee along with the denylist that sits on top.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ARTIFACT_CAPACITY,
  ArtifactIndex,
  TEXT_PREVIEW_LIMIT,
  artifactPathFrom,
  contentTypeFor,
  isServablePath,
  previewKindFor,
  readArtifact,
} from '../lib/artifacts.js';

/**
 * Run a body against a fresh temporary directory.
 * @param {(dir: string) => void} body - the test body.
 * @returns {void}
 */
function withTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-artifacts-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a known write tool naming a file yields that path', () => {
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    assert.equal(artifactPathFrom('write', { [key]: '/w/report.md' }), '/w/report.md', key);
  }
  for (const tool of ['write', 'edit', 'insert', 'str_replace_editor', 'apply_patch', 'multi_edit']) {
    assert.equal(artifactPathFrom(tool, { file_path: '/w/a.txt' }), '/w/a.txt', tool);
  }
  // Case and whitespace in the tool name should not matter.
  assert.equal(artifactPathFrom('  Write ', { file_path: '/w/a.txt' }), '/w/a.txt');
});

test('a read-only or unknown tool produces no artifact', () => {
  // A false positive would offer the user a file the agent never wrote.
  for (const tool of ['read', 'bash', 'grep', 'glob', 'todo_write', 'ls', '']) {
    assert.equal(artifactPathFrom(tool, { file_path: '/w/a.txt' }), null, tool);
  }
  assert.equal(artifactPathFrom('write', {}), null);
  assert.equal(artifactPathFrom('write', { file_path: '   ' }), null);
  assert.equal(artifactPathFrom('write', undefined), null);
  assert.equal(artifactPathFrom('write', { file_path: 42 }), null);
  assert.equal(artifactPathFrom(undefined, { file_path: '/w/a.txt' }), null);
});

test('credentials and this plugin\'s own state are never servable', () => {
  const denied = [
    '/home/u/.dsh/.credentials.yaml',
    '/home/u/.dsh/.credentials.yml',
    '/home/u/.ssh/id_ed25519',
    'C:\\Users\\u\\.ssh\\id_rsa',
    '/home/u/.aws/credentials',
    '/home/u/.dsh/remote-pulse/local-token',
    '/home/u/.dsh/remote-pulse/session.key',
    '/home/u/.dsh/remote-pulse/push.json',
  ];
  for (const path of denied) {
    assert.equal(isServablePath(path), false, path);
    // The denylist also runs at extraction time, so a denied path never even
    // enters the index.
    assert.equal(artifactPathFrom('write', { file_path: path }), null, path);
  }
  assert.equal(isServablePath('/w/report.md'), true);
  assert.equal(isServablePath(''), false);
  assert.equal(isServablePath(undefined), false);
});

test('preview kinds and content types follow the extension', () => {
  assert.equal(previewKindFor('/w/a.png'), 'image');
  assert.equal(previewKindFor('/w/a.SVG'), 'image');
  assert.equal(previewKindFor('/w/a.md'), 'text');
  assert.equal(previewKindFor('/w/a.json'), 'text');
  assert.equal(previewKindFor('/w/a.zip'), 'binary');
  assert.equal(previewKindFor('/w/noext'), 'binary');
  assert.equal(contentTypeFor('/w/a.png'), 'image/png');
  assert.match(contentTypeFor('/w/a.md'), /text\/plain/);
  assert.equal(contentTypeFor('/w/a.zip'), 'application/octet-stream');
});

test('the index is newest-first, deduplicated, and bounded', () => {
  const index = new ArtifactIndex({ capacity: 3 });
  index.record({ path: '/w/a.txt', tool: 'write' });
  index.record({ path: '/w/b.txt', tool: 'write' });
  index.record({ path: '/w/a.txt', tool: 'edit' });
  assert.equal(index.size, 2, 're-recording must not duplicate');
  assert.deepEqual(index.list().map(entry => entry.path), ['/w/a.txt', '/w/b.txt']);
  assert.equal(index.list()[0].tool, 'edit', 'the newest touch wins');

  index.record({ path: '/w/c.txt' });
  index.record({ path: '/w/d.txt' });
  assert.equal(index.size, 3, 'capacity is enforced');
  assert.deepEqual(index.list().map(entry => entry.path), ['/w/d.txt', '/w/c.txt', '/w/a.txt']);
  assert.equal(ARTIFACT_CAPACITY > 0, true);
});

test('observeToolCall records only real writes', () => {
  const index = new ArtifactIndex();
  assert.deepEqual(
    index.observeToolCall({ sessionId: 's1', toolName: 'read', args: { file_path: '/w/a' } }),
    [],
    'a read records nothing',
  );
  const [entry] = index.observeToolCall({ sessionId: 's1', toolName: 'write', args: { file_path: '/w/a.md' } });
  assert.equal(entry.sessionId, 's1');
  assert.equal(entry.name, 'a.md');
  assert.equal(index.has('/w/a.md'), true);
  assert.equal(index.has('/etc/passwd'), false);
});

test('a present call records every file it hands over', () => {
  // The gap that made the file list useless for images: every screenshot in this
  // project was produced by running a script, so the only tool call that ever
  // named it was `present` — and nothing read the array it carries. The list came
  // back with 36 text files and zero images.
  const index = new ArtifactIndex();
  const recorded = index.observeToolCall({
    sessionId: 's2',
    toolName: 'present',
    args: {
      files: [
        { path: '/w/shot-one.png', description: 'first' },
        { path: '/w/shot-two.png' },
        '/w/notes.md',
      ],
    },
  });
  assert.deepEqual(recorded.map(entry => entry.name), ['shot-one.png', 'shot-two.png', 'notes.md']);
  assert.equal(recorded[0].kind, 'image', 'and an image is listed as an image');
  assert.equal(index.size, 3);

  // A relative entry cannot be served, so it must not appear at all.
  const mixed = new ArtifactIndex();
  const kept = mixed.observeToolCall({
    sessionId: 's3', toolName: 'present', args: { files: [{ path: 'relative.png' }, { path: '/w/ok.png' }] },
  });
  assert.deepEqual(kept.map(entry => entry.name), ['ok.png'], 'only absolute paths are servable');
});

test('content is served for a recorded artifact', () => {
  withTempDir(dir => {
    const file = join(dir, 'report.md');
    writeFileSync(file, '# hello\nbody\n');
    const index = new ArtifactIndex();
    index.record({ path: file, tool: 'write' });
    const result = readArtifact(index, file);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'text');
    assert.equal(result.body.toString('utf8'), '# hello\nbody\n');
    assert.equal(result.truncated, false);
    assert.equal(result.size, Buffer.byteLength('# hello\nbody\n'));
  });
});

test('a path that was never produced is refused, however it is spelled', () => {
  withTempDir(dir => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'do not serve');
    const index = new ArtifactIndex();
    index.record({ path: join(dir, 'report.md'), tool: 'write' });

    // The decisive property: traversal is not defended against, it is
    // unreachable — the route has no code path that opens a caller-chosen path.
    for (const attempt of [
      secret,
      `${join(dir, 'report.md')}/../../../etc/passwd`,
      '../secret.txt',
      '',
      '.',
      join(dir, 'report.md') + ' ',
    ]) {
      const result = readArtifact(index, attempt);
      assert.equal(result.ok, false, `must refuse ${JSON.stringify(attempt)}`);
      assert.equal(result.reason, 'not-an-artifact');
    }
  });
});

test('a recorded path that has since vanished reports missing, not content', () => {
  withTempDir(dir => {
    const file = join(dir, 'gone.txt');
    writeFileSync(file, 'x');
    const index = new ArtifactIndex();
    index.record({ path: file, tool: 'write' });
    rmSync(file);
    const result = readArtifact(index, file);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing');
  });
});

test('a recorded directory is refused', () => {
  withTempDir(dir => {
    const index = new ArtifactIndex();
    index.record({ path: dir, tool: 'write' });
    const result = readArtifact(index, dir);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-a-file');
  });
});

test('a long text file is truncated rather than refused', () => {
  withTempDir(dir => {
    const file = join(dir, 'big.log');
    // One byte over the limit, so truncation must actually happen.
    writeFileSync(file, 'a'.repeat(TEXT_PREVIEW_LIMIT + 1));
    const index = new ArtifactIndex();
    index.record({ path: file, tool: 'write' });
    const result = readArtifact(index, file);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.body.length, TEXT_PREVIEW_LIMIT);
  });
});

test('an oversized binary is refused rather than streamed to a phone', () => {
  withTempDir(dir => {
    const file = join(dir, 'huge.bin');
    writeFileSync(file, Buffer.alloc(64, 7));
    const index = new ArtifactIndex();
    index.record({ path: file, tool: 'write' });

    // Within the cap it is served as an opaque binary.
    const served = readArtifact(index, file, { binary: 128 });
    assert.equal(served.ok, true);
    assert.equal(served.kind, 'binary');
    assert.equal(served.body.length, 64);

    // Past the cap it is refused, because streaming an oversized opaque blob to
    // a phone on a tunnel helps nobody.
    const refused = readArtifact(index, file, { binary: 16 });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'too-large');

    // A text file over the cap is truncated instead, because a partial log is
    // still the answer to "what did it write".
    const log = join(dir, 'big.log');
    writeFileSync(log, 'x'.repeat(64));
    index.record({ path: log, tool: 'write' });
    const truncated = readArtifact(index, log, { text: 16 });
    assert.equal(truncated.ok, true);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.body.length, 16);
  });
});

test('clear empties the index', () => {
  const index = new ArtifactIndex();
  index.record({ path: '/w/a.txt' });
  index.clear();
  assert.equal(index.size, 0);
  assert.deepEqual(index.list(), []);
});

test('an index survives a restart with its recency intact', () => {
  const first = new ArtifactIndex({ now: () => 1000 });
  first.record({ path: '/w/a.txt', tool: 'write', sessionId: 's1' });
  first.record({ path: '/w/b.txt', tool: 'edit', sessionId: 's2' });

  // The files themselves outlive the process, so the list must too.
  const persisted = JSON.parse(JSON.stringify(first.toJSON()));
  const second = new ArtifactIndex({ now: () => 2000 });
  assert.equal(second.restore(persisted), 2);
  assert.deepEqual(second.list().map(entry => entry.path), ['/w/b.txt', '/w/a.txt']);
  assert.equal(second.list()[1].tool, 'write');
  assert.equal(second.list()[1].sessionId, 's1');
  assert.equal(second.list()[1].at, 1000, 'the original timestamp is kept');
  // Derived fields are recomputed rather than trusted from the file.
  assert.equal(second.list()[1].name, 'a.txt');
  assert.equal(second.list()[1].kind, 'text');
});

test('a stale persisted file cannot reintroduce a denied path', () => {
  // The file is plain JSON in the harness home; a hand-edited or outdated one
  // must not be able to widen what the content route will serve.
  const index = new ArtifactIndex();
  const restored = index.restore([
    { path: '/home/u/.dsh/remote-pulse/local-token', tool: 'write' },
    { path: '/home/u/.ssh/id_ed25519', tool: 'write' },
    { path: '/w/ok.txt', tool: 'write' },
    { path: '' },
    null,
    'nope',
  ]);
  assert.equal(restored, 1);
  assert.deepEqual(index.list().map(entry => entry.path), ['/w/ok.txt']);
  assert.equal(index.has('/home/u/.ssh/id_ed25519'), false);
});

test('restoring enforces the capacity and tolerates junk', () => {
  const index = new ArtifactIndex({ capacity: 2 });
  assert.equal(index.restore(undefined), 0);
  assert.equal(index.restore(null), 0);
  assert.equal(index.restore('not a list'), 0);
  assert.equal(index.restore([]), 0);

  const many = Array.from({ length: 5 }, (_, i) => ({ path: `/w/${i}.txt`, at: i }));
  assert.equal(index.restore(many), 5);
  assert.equal(index.size, 2, 'capacity still applies');
  // The newest survive.
  assert.deepEqual(index.list().map(entry => entry.path), ['/w/4.txt', '/w/3.txt']);
});

test('an entry with a missing timestamp gets one rather than NaN', () => {
  const index = new ArtifactIndex({ now: () => 4242 });
  index.restore([{ path: '/w/a.txt' }]);
  assert.equal(index.list()[0].at, 4242);
});
