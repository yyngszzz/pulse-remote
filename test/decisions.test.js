import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DECISION_STATE, DecisionQueue } from '../lib/decisions.js';

/** Queue wired to a controllable clock and phone presence. */
function harness(options = {}) {
  let now = 1_000_000;
  let live = options.live ?? true;
  let canPush = options.canPush ?? false;
  const pushed = [];
  const changes = [];
  const queue = new DecisionQueue({
    now: () => now,
    timeoutMs: options.timeoutMs ?? 1000,
    armDelayMs: options.armDelayMs ?? 500,
    hasLivePhone: () => live,
    canPush: () => canPush,
    onPush: decision => pushed.push(decision),
    onChange: event => changes.push(event),
  });
  return {
    queue,
    pushed,
    changes,
    advance: ms => {
      now += ms;
    },
    setLive: value => {
      live = value;
    },
    setCanPush: value => {
      canPush = value;
    },
  };
}

test('with no live phone the request defers immediately and is never held', async () => {
  const { queue, pushed } = harness({ live: false });
  const result = await queue.ask({ type: 'approval', sessionId: 's1', title: '允许？' });
  assert.equal(result.state, DECISION_STATE.deferred);
  assert.equal(result.answer, null);
  assert.equal(pushed.length, 0);
  assert.equal(queue.size, 0);
});

test('with a live phone the request is held, pushed, and listed', async () => {
  const { queue, pushed } = harness();
  const pending = queue.ask({ type: 'approval', sessionId: 's1', title: '允许执行 npm publish？' });
  // The ask() body runs synchronously up to its first await, so the queue is
  // already populated here.
  assert.equal(queue.size, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].title, '允许执行 npm publish？');

  const [entry] = queue.list();
  assert.equal(entry.state, DECISION_STATE.pending);
  const resolved = queue.resolve(entry.id, { outcome: 'allowed-once' });
  assert.equal(resolved.ok, true);

  const result = await pending;
  assert.equal(result.state, DECISION_STATE.answered);
  assert.deepEqual(result.answer, { outcome: 'allowed-once' });
  assert.equal(queue.size, 0);
});

test('an unanswered request defers after the timeout instead of blocking forever', async () => {
  const { queue } = harness({ timeoutMs: 50, armDelayMs: 0 });
  const result = await queue.ask({ type: 'approval', sessionId: 's1', title: '允许？' });
  assert.equal(result.state, DECISION_STATE.deferred);
  assert.equal(result.answer, null);
  assert.equal(queue.size, 0);
});

test('a push channel buys extra hold time before falling back', async () => {
  const { queue, advance } = harness({ timeoutMs: 40, armDelayMs: 40, canPush: true });
  const pending = queue.ask({ type: 'approval', sessionId: 's1', title: '允许？' });
  await new Promise(resolve => setTimeout(resolve, 60));
  // The base window has passed, but the push allowance keeps it alive.
  assert.equal(queue.size, 1);
  const [entry] = queue.list();
  queue.resolve(entry.id, { outcome: 'rejected' });
  const result = await pending;
  assert.equal(result.state, DECISION_STATE.answered);
  void advance;
});

test('without a push channel no extra hold time is granted', async () => {
  const { queue } = harness({ timeoutMs: 30, armDelayMs: 10_000, canPush: false });
  const result = await queue.ask({ type: 'approval', sessionId: 's1', title: '允许？' });
  assert.equal(result.state, DECISION_STATE.deferred);
});

test('resolving an unknown or already-settled decision is refused', async () => {
  const { queue } = harness({ timeoutMs: 30 });
  const pending = queue.ask({ type: 'approval', sessionId: 's1', title: '允许？' });
  const [entry] = queue.list();
  assert.equal(queue.resolve(entry.id, { outcome: 'allowed-once' }).ok, true);
  assert.equal(queue.resolve(entry.id, { outcome: 'allowed-once' }).ok, false);
  assert.equal(queue.resolve('nope', {}).reason, 'unknown-or-settled');
  await pending;
});

test('an aborted caller settles as cancelled and leaves nothing queued', async () => {
  const { queue } = harness();
  const controller = new AbortController();
  const pending = queue.ask({ type: 'approval', sessionId: 's1', title: '允许？', signal: controller.signal });
  assert.equal(queue.size, 1);
  controller.abort();
  const result = await pending;
  assert.equal(result.state, DECISION_STATE.cancelled);
  assert.equal(queue.size, 0);
});

test('an already-aborted signal settles immediately without leaking the entry', async () => {
  const { queue, pushed } = harness();
  const controller = new AbortController();
  controller.abort();
  const result = await queue.ask({ type: 'approval', sessionId: 's1', title: '允许？', signal: controller.signal });
  assert.equal(result.state, DECISION_STATE.cancelled);
  assert.equal(queue.size, 0);
  // The push happened before the abort was observed; the queue must still be clean.
  assert.equal(pushed.length, 1);
});

test('releaseAll hands every pending request back to the desktop chain', async () => {
  const { queue } = harness();
  const a = queue.ask({ type: 'approval', sessionId: 's1', title: 'A' });
  const b = queue.ask({ type: 'question', sessionId: 's2', title: 'B' });
  assert.equal(queue.size, 2);

  const released = queue.releaseAll();
  assert.equal(released, 2);

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.state, DECISION_STATE.deferred);
  assert.equal(rb.state, DECISION_STATE.deferred);
  assert.equal(queue.size, 0);
});

test('an explicit armed flag overrides phone detection', async () => {
  const { queue } = harness({ live: false });
  const pending = queue.ask({ type: 'approval', sessionId: 's1', title: '允许？', armed: true });
  assert.equal(queue.size, 1);
  const [entry] = queue.list();
  queue.resolve(entry.id, { outcome: 'allowed-once' });
  assert.equal((await pending).state, DECISION_STATE.answered);
});

test('list() orders pending decisions oldest first and hides internals', async () => {
  const { queue } = harness();
  const a = queue.ask({ type: 'approval', sessionId: 's1', title: 'first' });
  const b = queue.ask({ type: 'approval', sessionId: 's1', title: 'second' });
  const rows = queue.list();
  assert.deepEqual(
    rows.map(r => r.title),
    ['first', 'second'],
  );
  assert.equal('resolve' in rows[0], false);
  queue.releaseAll();
  await Promise.all([a, b]);
});

test('state changes are reported to observers', async () => {
  const { queue, changes } = harness({ timeoutMs: 30 });
  const pending = queue.ask({ type: 'approval', sessionId: 's1', title: '允许？' });
  await pending;
  assert.deepEqual(
    changes.map(c => c.type),
    ['queued', DECISION_STATE.deferred],
  );
});

test('a validator normalizes the answer before the caller sees it', async () => {
  const { queue } = harness();
  const pending = queue.ask({
    type: 'approval',
    sessionId: 's1',
    title: '允许？',
    validator: answer => ({ ok: true, answer: { outcome: String(answer.outcome).toLowerCase() } }),
  });
  const [entry] = queue.list();
  const result = queue.resolve(entry.id, { outcome: 'ALLOWED-ONCE' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer, { outcome: 'allowed-once' });
  assert.deepEqual((await pending).answer, { outcome: 'allowed-once' });
});

test('a rejecting validator leaves the decision pending for a valid answer', async () => {
  const { queue } = harness();
  const pending = queue.ask({
    type: 'approval',
    sessionId: 's1',
    title: '允许？',
    validator: answer =>
      ['allowed-once', 'rejected'].includes(answer.outcome)
        ? { ok: true, answer }
        : { ok: false, reason: 'invalid-outcome' },
  });
  const [entry] = queue.list();

  const bogus = queue.resolve(entry.id, { outcome: 'trust-me' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.reason, 'invalid-outcome');
  // The decision is still answerable: a bad payload must not burn the request.
  assert.equal(queue.size, 1);

  const good = queue.resolve(entry.id, { outcome: 'rejected' });
  assert.equal(good.ok, true);
  assert.deepEqual((await pending).answer, { outcome: 'rejected' });
});

test('a validator that marks input invalid cannot be bypassed by any caller', async () => {
  const { queue } = harness({ timeoutMs: 30 });
  const pending = queue.ask({
    type: 'approval',
    sessionId: 's1',
    title: '允许？',
    validator: () => ({ ok: false, reason: 'never' }),
  });
  const [entry] = queue.list();
  assert.equal(queue.resolve(entry.id, { outcome: 'allowed-once' }).ok, false);
  // It falls through to the timeout instead of being answered.
  assert.equal((await pending).state, DECISION_STATE.deferred);
});
