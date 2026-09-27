import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameRing } from '../lib/ring.js';

/** Build a frame with just enough shape for the ring. */
const frame = text => ({ sessionId: 's1', kind: 'activity', text });

test('push assigns a monotonic sequence and preserves the payload', () => {
  const ring = new FrameRing({ capacity: 10 });
  const a = ring.push(frame('a'));
  const b = ring.push(frame('b'));
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(b.text, 'b');
  assert.equal(ring.lastSeq, 2);
});

test('since() replays exactly the frames the reader missed', () => {
  const ring = new FrameRing({ capacity: 10 });
  for (let i = 1; i <= 5; i += 1) ring.push(frame(`f${i}`));

  const replay = ring.since(2);
  assert.deepEqual(
    replay.frames.map(f => f.text),
    ['f3', 'f4', 'f5'],
  );
  assert.equal(replay.gap, false);
  assert.equal(replay.lastSeq, 5);
});

test('since(0) replays the whole window without claiming a gap', () => {
  const ring = new FrameRing({ capacity: 3 });
  for (let i = 1; i <= 3; i += 1) ring.push(frame(`f${i}`));
  const replay = ring.since(0);
  assert.equal(replay.frames.length, 3);
  assert.equal(replay.gap, false);
});

test('a reader caught up receives nothing', () => {
  const ring = new FrameRing({ capacity: 5 });
  ring.push(frame('a'));
  const replay = ring.since(1);
  assert.deepEqual(replay.frames, []);
  assert.equal(replay.gap, false);
});

test('eviction bounds memory and reports how many were dropped', () => {
  const ring = new FrameRing({ capacity: 3 });
  for (let i = 1; i <= 10; i += 1) ring.push(frame(`f${i}`));
  assert.equal(ring.frames.length, 3);
  assert.equal(ring.dropped, 7);
  assert.deepEqual(
    ring.frames.map(f => f.text),
    ['f8', 'f9', 'f10'],
  );
});

test('a reader behind the window is told about the gap rather than shown a silent one', () => {
  const ring = new FrameRing({ capacity: 3 });
  for (let i = 1; i <= 10; i += 1) ring.push(frame(`f${i}`));
  // The reader rendered up to seq 2, but the window starts at seq 8.
  const replay = ring.since(2);
  assert.equal(replay.gap, true);
  assert.deepEqual(
    replay.frames.map(f => f.seq),
    [8, 9, 10],
  );
});

test('since() tolerates garbage sequence input', () => {
  const ring = new FrameRing({ capacity: 5 });
  ring.push(frame('a'));
  assert.equal(ring.since(undefined).frames.length, 1);
  assert.equal(ring.since(NaN).frames.length, 1);
  assert.equal(ring.since(-5).frames.length, 1);
  assert.equal(ring.since(1.9).frames.length, 0);
});

test('tail returns the newest frames oldest-first', () => {
  const ring = new FrameRing({ capacity: 10 });
  for (let i = 1; i <= 6; i += 1) ring.push(frame(`f${i}`));
  assert.deepEqual(
    ring.tail(2).map(f => f.text),
    ['f5', 'f6'],
  );
  assert.deepEqual(ring.tail(0), []);
  assert.equal(ring.tail(100).length, 6);
});

test('an empty ring replays nothing and claims no gap', () => {
  const ring = new FrameRing();
  const replay = ring.since(5);
  assert.deepEqual(replay.frames, []);
  assert.equal(replay.gap, false);
  assert.equal(replay.lastSeq, 0);
});

test('clear empties frames but the sequence keeps advancing', () => {
  const ring = new FrameRing({ capacity: 5 });
  ring.push(frame('a'));
  ring.push(frame('b'));
  ring.clear();
  assert.equal(ring.frames.length, 0);
  assert.equal(ring.push(frame('c')).seq, 3);
  assert.equal(ring.lastSeq, 3);
});

test('capacity is coerced to at least one frame', () => {
  const ring = new FrameRing({ capacity: 0 });
  ring.push(frame('a'));
  ring.push(frame('b'));
  assert.equal(ring.frames.length, 1);
  assert.equal(ring.frames[0].text, 'b');
});
