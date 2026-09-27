/**
 * One-tap decisions from the lock screen.
 *
 * Two halves that must agree: the plugin decides which actions a decision may
 * offer and what each one submits, and the worker turns a pressed action into
 * exactly that request. A mismatch here is silent — the button appears, the tap
 * does nothing useful, and the agent stays blocked.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PUSH_ACTIONS, normalizeActions, pushWorkerScript } from '../lib/push.js';
import { lockScreenDecision } from '../lib/decisions.js';

test('an approval offers exactly its two outcomes', () => {
  const described = lockScreenDecision({ id: 'd1', type: 'approval', title: '允许执行 rm？' });
  assert.deepEqual(
    described.actions.map(action => action.action),
    ['allow-once', 'reject'],
  );
  assert.deepEqual(described.actions.map(action => action.title), ['允许一次', '拒绝']);
  // The tokens must map onto the exact answer shape the queue validator expects.
  assert.deepEqual(described.data.decision.answers['allow-once'], { outcome: 'allowed-once' });
  assert.deepEqual(described.data.decision.answers.reject, { outcome: 'rejected' });
});

test('a plain tap deep-links to that decision', () => {
  const described = lockScreenDecision({ id: 'd 1/2', type: 'approval' });
  assert.equal(described.url, '/pulse#decision-d%201%2F2');
  assert.equal(described.data.decision.id, 'd 1/2');
});

test('a two-option question offers both option labels', () => {
  const described = lockScreenDecision({
    id: 'd2',
    type: 'question',
    title: '用哪种方案？',
    options: [
      { value: 'ts', label: 'TypeScript' },
      { value: 'js', label: 'JavaScript' },
    ],
  });
  assert.deepEqual(described.actions, [
    { action: 'option-0', title: 'TypeScript' },
    { action: 'option-1', title: 'JavaScript' },
  ]);
  // Positional tokens, because an option value is arbitrary text and the token
  // has to be a platform-safe literal.
  assert.deepEqual(described.data.decision.answers['option-0'], { selected: ['ts'] });
  assert.deepEqual(described.data.decision.answers['option-1'], { selected: ['js'] });
});

test('a question with more than two options gets no one-tap buttons', () => {
  // Two buttons cannot express three answers; a button that submits the wrong
  // thing is worse than no button, because the user believes they answered.
  const described = lockScreenDecision({
    id: 'd3',
    type: 'question',
    options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }],
  });
  assert.deepEqual(described.actions, []);
  assert.deepEqual(described.data.decision.answers, {});
  assert.equal(described.url, '/pulse#decision-d3');
});

test('a multi-select question gets no one-tap buttons', () => {
  // A multi-select answer is a set, so no single tap can complete it.
  const described = lockScreenDecision({
    id: 'd4',
    type: 'question',
    multiSelect: true,
    options: [{ value: 'a' }, { value: 'b' }],
  });
  assert.deepEqual(described.actions, []);
});

test('an option missing a value or label is skipped rather than guessed', () => {
  // Two options, so the set is eligible; one of them is unusable. Only the
  // usable one may become a button — guessing a value would submit an answer
  // the user never chose.
  const described = lockScreenDecision({
    id: 'd5',
    type: 'question',
    options: [{ value: 'a', label: 'A' }, { value: '', label: 'B' }],
  });
  assert.deepEqual(described.actions, [{ action: 'option-0', title: 'A' }]);
  assert.deepEqual(Object.keys(described.data.decision.answers), ['option-0']);
});

test('a three-option question is rejected whole rather than trimmed to two', () => {
  // Trimming would offer a choice that silently excludes the real answer.
  const described = lockScreenDecision({
    id: 'd5b',
    type: 'question',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: '', label: '' }],
  });
  assert.deepEqual(described.actions, []);
});

test('a decision with no id still yields a usable console link', () => {
  const described = lockScreenDecision({ type: 'approval' });
  assert.equal(described.url, '/pulse');
  assert.equal(described.data.decision.id, '');
});

test('action tokens are bounded and sanitized for the platform', () => {
  const normalized = normalizeActions([
    { action: 'ok', title: 'A' },
    { action: 'has space', title: 'B' },
    { action: 'UPPER', title: 'C' },
    { action: '', title: 'D' },
    { action: 'fine', title: '' },
    { action: 'third', title: 'E' },
    null,
    'nope',
  ]);
  // The four malformed entries are dropped and the two valid ones are kept, in
  // order: the cap is what bounds the list, not a filter.
  assert.deepEqual(normalized.actions, [
    { action: 'ok', title: 'A' },
    { action: 'third', title: 'E' },
  ]);
  assert.equal(normalizeActions([]).actions, undefined);
  assert.equal(normalizeActions(undefined).actions, undefined);
  assert.equal(normalizeActions('x').actions, undefined);
});

test('the action count is bounded to what a platform will render', () => {
  const many = Array.from({ length: 6 }, (_, index) => ({ action: `a${index}`, title: `T${index}` }));
  const normalized = normalizeActions(many);
  assert.equal(normalized.actions.length, MAX_PUSH_ACTIONS);
  // Everything the plugin itself generates must survive normalization, or the
  // button would be dropped between deciding on it and sending it.
  for (const decision of [
    { id: 'd', type: 'approval' },
    { id: 'd', type: 'question', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  ]) {
    const described = lockScreenDecision(decision);
    assert.deepEqual(normalizeActions(described.actions).actions, described.actions);
  }
});

test('the worker submits exactly the answer the plugin described', () => {
  const worker = pushWorkerScript();
  assert.ok(worker.includes("fetch('/api/decisions/resolve'"), 'the worker must call the resolve route');
  // Credentials matter: the notification carries no token, so the session
  // cookie is the only thing authenticating the request.
  assert.ok(/credentials:\s*'same-origin'/.test(worker));
  assert.ok(worker.includes('answers[action]'), 'the worker must look up the token it was sent');
  // A failure must be visible: a silent one leaves the agent blocked while the
  // user believes they answered.
  assert.ok(worker.includes('回复失败'));
  assert.ok(worker.includes('已回复'));
});

test('the worker shows the actions it was sent and keeps no fetch handler', () => {
  const worker = pushWorkerScript();
  assert.ok(worker.includes('actions: Array.isArray(data.actions)'));
  // The push worker must never sit in front of the network.
  assert.ok(!worker.includes("addEventListener('fetch'"));
  assert.ok(!worker.includes('addEventListener("fetch"'));
});

test('the worker tolerates a notification with no decision attached', () => {
  const worker = pushWorkerScript();
  // A turn-complete notification has no decision; pressing it must still open
  // the console rather than throw inside the click handler.
  assert.ok(/var payload = event\.notification\.data \|\| \{\}/.test(worker));
  assert.ok(worker.includes('var decision = payload.decision'));
  assert.ok(/if \(action && decision && Object\.prototype\.hasOwnProperty\.call\(answers, action\)\)/.test(worker));
});
