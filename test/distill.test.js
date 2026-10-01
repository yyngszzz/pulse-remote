import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Distiller,
  FRAME_KIND,
  SEVERITY,
  errorLine,
  humanDuration,
  oneLine,
  shortPath,
  toolGroup,
  toolLine,
  toolSubject,
} from '../lib/distill.js';

/** A clock the test advances by hand, so run-collapse boundaries are exact. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = ms => {
    now += ms;
  };
  return clock;
}

/** Collect every frame a distiller emits. */
function collect(options = {}) {
  const clock = options.clock ?? fakeClock();
  const frames = [];
  const distiller = new Distiller({ ...options, clock, now: clock, onFrame: frame => frames.push(frame) });
  return { distiller, frames, clock };
}

test('oneLine collapses whitespace and elides long text', () => {
  assert.equal(oneLine('  hello \n  world  '), 'hello world');
  assert.equal(oneLine('x'.repeat(200)).length, 160);
  assert.equal(oneLine(undefined), '');
});

test('every frame carries the workspace it belongs to', () => {
  // "Which project finished" has to survive the trip to a lock screen, and the only
  // thing that knows it is the host: the frame is stamped on the way out rather than
  // looked up by the phone, which has no session list of its own.
  const { distiller, frames } = collect({ projectOf: sessionId => (sessionId === 'a' ? 'deepseek harness' : '') });
  distiller.turnStart({ sessionId: 'a', turn: 1 });
  distiller.turnEnd({ sessionId: 'a', turn: 1, outcome: 'done' });
  distiller.turnStart({ sessionId: 'b', turn: 1 });
  assert.deepEqual(frames.map(frame => frame.project), ['deepseek harness', 'deepseek harness', undefined]);

  // A frame may name its own project, which is what a delegated session or a
  // decision from elsewhere would do.
  const explicit = distiller.emit({ sessionId: 'a', kind: FRAME_KIND.activity, text: 'x', project: 'other' });
  assert.equal(explicit.project, 'other');
  assert.equal(frames.at(-1).project, 'other');
});

test('a subagent frame says so, and a top-level one stays quiet about it', () => {
  // "Something finished" and "your conversation finished" are different events, and only
  // the consumer knows which of them it wants to be interrupted for — so the frame
  // carries the delegation depth and the phone decides. Five of the thirteen sessions on
  // this machine sit at depth 1, so this is not a hypothetical distinction.
  const { distiller, frames } = collect({ depthOf: sessionId => (sessionId === 'sub' ? 1 : 0) });
  distiller.turnEnd({ sessionId: 'sub', turn: 1, outcome: 'done' });
  distiller.turnEnd({ sessionId: 'main', turn: 1, outcome: 'done' });
  assert.equal(frames[0].depth, 1);
  assert.equal(frames[1].depth, undefined, 'depth 0 is the ordinary case and is not stamped');
});

test('shortPath keeps only the last segments', () => {
  assert.equal(shortPath('D:\\deepseek harness\\src\\lib\\index.ts'), 'lib/index.ts');
  assert.equal(shortPath('/home/user/project/file.js'), 'project/file.js');
  assert.equal(shortPath('/single'), 'single');
  assert.equal(shortPath(''), '');
});

test('toolSubject prefers the path-like argument and shortens it', () => {
  assert.equal(toolSubject({ file_path: 'D:\\a\\b\\c\\config.ts' }), 'c/config.ts');
  assert.equal(toolSubject({ query: 'harness remote' }), 'harness remote');
  assert.equal(toolSubject({}), '');
  assert.equal(toolSubject(undefined), '');
});

test('toolSubject falls back to the first string field for unknown tools', () => {
  assert.equal(toolSubject({ weird_field: 'some value' }), 'some value');
});

test('toolLine renders intent plus subject and degrades honestly', () => {
  assert.equal(toolLine('read', { file_path: 'a/b/c.ts' }), '读取 b/c.ts');
  assert.equal(toolLine('grep', { pattern: 'TODO' }), '搜索内容 TODO');
  assert.equal(toolLine('read', {}), '读取');
  assert.equal(toolLine('mystery_tool', { name: 'x' }), 'mystery_tool x');
});

test('toolGroup buckets tools into reader-facing categories', () => {
  assert.equal(toolGroup('read'), 'read');
  assert.equal(toolGroup('edit'), 'write');
  assert.equal(toolGroup('str_replace_editor'), 'write');
  assert.equal(toolGroup('grep'), 'search');
  assert.equal(toolGroup('pwsh'), 'command');
  assert.equal(toolGroup('web_fetch'), 'web');
  assert.equal(toolGroup('subagent_fork'), 'subagent');
  assert.equal(toolGroup('todo_write'), 'other');
  assert.equal(toolGroup(undefined), 'other');
});

test('humanDuration picks the coarsest informative unit', () => {
  assert.equal(humanDuration(250), '250 毫秒');
  assert.equal(humanDuration(3000), '3 秒');
  assert.equal(humanDuration(130_000), '2 分 10 秒');
  assert.equal(humanDuration(120_000), '2 分');
  assert.equal(humanDuration(3_900_000), '1 小时 5 分');
  assert.equal(humanDuration(-5), '0 毫秒');
});

test('errorLine extracts a message from every thrown shape', () => {
  assert.equal(errorLine(new Error('boom')), 'boom');
  assert.equal(errorLine('plain'), 'plain');
  assert.equal(errorLine({ message: 'object message' }), 'object message');
  assert.equal(errorLine({ code: 'E_X' }), '{"code":"E_X"}');
  assert.equal(errorLine(null), '未知错误');
});

test('emit stamps a monotonic sequence per session and fills defaults', () => {
  const { distiller, frames } = collect();
  distiller.emit({ sessionId: 's1', kind: FRAME_KIND.activity, text: 'a' });
  distiller.emit({ sessionId: 's1', kind: FRAME_KIND.activity, text: 'b' });
  distiller.emit({ sessionId: 's2', kind: FRAME_KIND.activity, text: 'c' });
  assert.deepEqual(
    frames.map(f => f.seq),
    [1, 2, 1],
  );
  assert.equal(frames[0].severity, SEVERITY.progress);
  assert.equal(frames[0].kind, 'activity');
  assert.ok(frames[0].ts > 0);
});

test('consecutive same-group tool calls collapse into one summary', () => {
  const { distiller, frames, clock } = collect();
  const read = n => ({ sessionId: 's1', toolName: 'read', args: { file_path: `src/file${n}.ts` } });

  distiller.turnStart({ sessionId: 's1', turn: 1 });
  for (let n = 1; n <= 5; n += 1) {
    distiller.toolCall(read(n));
    clock.advance(100);
  }
  distiller.flushRun();

  const kinds = frames.map(f => f.kind);
  // turn-start, the opening activity line, then one collapsed summary — not five lines.
  assert.deepEqual(kinds, [FRAME_KIND.turnStart, FRAME_KIND.activity, FRAME_KIND.summary]);
  const summary = frames.at(-1);
  assert.equal(summary.text, '读取 ×5');
  assert.match(summary.detail, /file1\.ts/);
  assert.equal(summary.ref.count, 5);
});

test('a run closes when the idle gap exceeds flushMs', () => {
  const { distiller, frames, clock } = collect({ flushMs: 1000 });
  distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'a.ts' } });
  clock.advance(5000);
  distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'b.ts' } });
  const activities = frames.filter(f => f.kind === FRAME_KIND.activity);
  assert.equal(activities.length, 2);
});

test('a different group breaks the run and flushes the previous one', () => {
  const { distiller, frames } = collect();
  distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'a.ts' } });
  distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'b.ts' } });
  distiller.toolCall({ sessionId: 's1', toolName: 'bash', args: { command: 'npm test' } });

  const kinds = frames.map(f => f.kind);
  assert.deepEqual(kinds, [FRAME_KIND.activity, FRAME_KIND.summary, FRAME_KIND.activity]);
  assert.equal(frames[1].text, '读取 ×2');
  assert.equal(frames[2].text, '执行命令 npm test');
});

test('a single-call run emits no redundant summary', () => {
  const { distiller, frames } = collect();
  distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'a.ts' } });
  distiller.flushRun();
  assert.equal(frames.filter(f => f.kind === FRAME_KIND.summary).length, 0);
});

test('the run counter is bounded so a loop cannot grow it without limit', () => {
  const { distiller, frames } = collect();
  for (let i = 0; i < 600; i += 1) {
    distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'same.ts' } });
  }
  distiller.flushRun();
  const summary = frames.find(f => f.kind === FRAME_KIND.summary);
  assert.equal(summary.ref.count, 500);
});

test('a failed tool result surfaces as a warning frame', () => {
  const { distiller, frames } = collect();
  distiller.toolResult({
    sessionId: 's1',
    toolName: 'read',
    ok: false,
    error: new Error('ENOENT: no such file'),
  });
  const failure = frames.at(-1);
  assert.equal(failure.kind, FRAME_KIND.failure);
  assert.equal(failure.severity, SEVERITY.warning);
  assert.equal(failure.text, '读取失败：ENOENT: no such file');
});

test('a successful tool result emits nothing', () => {
  const { distiller, frames } = collect();
  distiller.toolResult({ sessionId: 's1', toolName: 'read', ok: true });
  assert.equal(frames.length, 0);
});

test('turnEnd produces a digest with duration, call count and breakdown', () => {
  const { distiller, frames, clock } = collect();
  distiller.turnStart({ sessionId: 's1', turn: 7 });
  distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'a.ts' } });
  distiller.toolCall({ sessionId: 's1', toolName: 'grep', args: { pattern: 'x' } });
  distiller.toolCall({ sessionId: 's1', toolName: 'edit', args: { file_path: 'b.ts' } });
  clock.advance(45_000);
  const frame = distiller.turnEnd({ sessionId: 's1', turn: 7, finalText: 'done' });

  assert.equal(frame.kind, FRAME_KIND.turnEnd);
  assert.equal(frame.severity, SEVERITY.notice);
  assert.match(frame.text, /^任务完成 · 45 秒 · 3 次工具调用/);
  assert.equal(frame.ref.tools, 3);
  assert.equal(frame.detail, 'done');
});

test('turnEnd reports failures and errors distinctly', () => {
  const a = collect();
  a.distiller.turnStart({ sessionId: 's1', turn: 1 });
  a.distiller.toolResult({ sessionId: 's1', toolName: 'bash', ok: false, error: 'exit 1' });
  assert.match(a.distiller.turnEnd({ sessionId: 's1', turn: 1 }).text, /^任务完成（1 次工具失败）/);

  const b = collect();
  b.distiller.turnStart({ sessionId: 's1', turn: 1 });
  const failed = b.distiller.turnEnd({ sessionId: 's1', turn: 1, outcome: 'error' });
  assert.match(failed.text, /^任务失败/);
  assert.equal(failed.severity, SEVERITY.warning);

  const c = collect();
  c.distiller.turnStart({ sessionId: 's1', turn: 1 });
  assert.match(c.distiller.turnEnd({ sessionId: 's1', turn: 1, outcome: 'cancelled' }).text, /^任务已停止/);
});

test('turn counters reset between turns', () => {
  const { distiller } = collect();
  distiller.turnStart({ sessionId: 's1', turn: 1 });
  distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'a.ts' } });
  distiller.turnEnd({ sessionId: 's1', turn: 1 });
  distiller.turnStart({ sessionId: 's1', turn: 2 });
  const second = distiller.turnEnd({ sessionId: 's1', turn: 2 });
  assert.equal(second.ref.tools, 0);
});

test('status frames only fire on an actual flip', () => {
  const { distiller, frames } = collect();
  distiller.status({ sessionId: 's1', status: 'running' });
  distiller.status({ sessionId: 's1', status: 'running' });
  distiller.status({ sessionId: 's1', status: 'idle' });
  distiller.status({ sessionId: 's1', status: 'idle' });
  assert.deepEqual(
    frames.map(f => f.text),
    ['开始工作', '空闲'],
  );
});

test('a decision frame carries a machine-readable handle for the phone', () => {
  const { distiller, frames } = collect();
  distiller.decision({
    sessionId: 's1',
    id: 'd-1',
    type: 'approval',
    title: '允许执行 npm publish？',
    detail: '该命令会发布到公共 registry',
    options: ['allowed-once', 'rejected'],
  });
  const frame = frames.at(-1);
  assert.equal(frame.kind, FRAME_KIND.decision);
  assert.equal(frame.severity, SEVERITY.decision);
  assert.equal(frame.ref.decisionId, 'd-1');
  assert.deepEqual(frame.ref.options, ['allowed-once', 'rejected']);
});

test('a resolved decision reports the chosen label, an expired one says so', () => {
  const { distiller, frames } = collect();
  distiller.decisionResolved({ sessionId: 's1', id: 'd-1', outcome: 'allowed-once', label: '允许' });
  distiller.decisionResolved({ sessionId: 's1', id: 'd-2', outcome: 'expired' });
  assert.equal(frames[0].text, '已回复：允许');
  assert.equal(frames[0].kind, FRAME_KIND.decisionResolved);
  assert.equal(frames[1].text, '决策超时，已交回电脑端');
  assert.equal(frames[1].kind, FRAME_KIND.decisionExpired);
});

test('an out-of-band error becomes a warning frame', () => {
  const { distiller, frames } = collect();
  distiller.error({ sessionId: 's1', error: new Error('socket closed') });
  assert.equal(frames.at(-1).text, '出错：socket closed');
  assert.equal(frames.at(-1).severity, SEVERITY.warning);
});

test('snapshot reflects running state and elapsed time', () => {
  const { distiller, clock } = collect();
  distiller.turnStart({ sessionId: 's1', turn: 1 });
  clock.advance(2000);
  const [row] = distiller.snapshot();
  assert.equal(row.sessionId, 's1');
  assert.equal(row.running, true);
  assert.equal(row.elapsedMs, 2000);
  distiller.turnEnd({ sessionId: 's1', turn: 1 });
  assert.equal(distiller.snapshot()[0].running, false);
});
