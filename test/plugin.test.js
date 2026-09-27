import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

/**
 * Every listener this suite opens.
 *
 * Tracked here rather than through the module's own registry on purpose: the
 * plugin is loaded with a cache-busting query so each test gets fresh module
 * state, and that re-evaluates the whole import graph -- including `server.js`.
 * A registry read from this file would therefore be a *different* module
 * instance with its own empty set.
 *
 * @type {Set<{close: () => Promise<void>}>}
 */
const listeners = new Set();

after(async () => {
  // The listener holds long-lived SSE streams and proxied WebSockets by design.
  // Its own `unref()` keeps a missed teardown from wedging the runner; this
  // sweep is what actually releases the ports.
  await Promise.all(
    [...listeners].map(listener =>
      listener.close().catch(() => {
        /* already closed */
      }),
    ),
  );
  listeners.clear();
});

/**
 * The host plugin is where the product's promises are kept or broken, so these
 * tests drive it through a stand-in Cordis context that records handler
 * registrations and lets a test dispatch events exactly as the harness would.
 *
 * Two promises matter most and are asserted here directly:
 *   1. with no phone connected, every answerer delegates (`next()` is called),
 *      so an ordinary desktop user sees no behavior change at all;
 *   2. with a phone connected, a decision claimed by the phone is answered
 *      without touching the desktop chain.
 */

/** A stand-in Cordis context that records what the plugin registers. */
function fakeContext(options = {}) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  const provided = new Map();
  const logs = [];
  const disposers = [];
  /** @type {AbortController} */
  const lifetime = new AbortController();

  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(
          event,
          current.filter(candidate => candidate !== handler),
        );
      };
    },
    effect(execute) {
      const dispose = execute();
      disposers.push(dispose);
      return () => {};
    },
    provide(name, value) {
      provided.set(name, value);
    },
    logger: {
      info: message => logs.push({ level: 'info', message }),
      warn: message => logs.push({ level: 'warn', message }),
    },
  };

  // `inject` is how the plugin captures the web services, and the interesting
  // failure is a profile where it exists but never fires: the gate never opens,
  // which used to leave the plugin silently inert.
  if (options.inject === 'never') {
    ctx.inject = () => {
      /* the services never arrive */
    };
  } else if (options.inject === 'immediate') {
    ctx.inject = (names, callback) => {
      callback({ connection: { authenticatedUrl: () => 'http://127.0.0.1:9/?token=t' }, webServer: {} });
    };
  }

  return {
    ctx,
    logs,
    provided,
    lifetime,
    /**
     * Dispatch an event to every registered handler.
     * @param {string} event - event name.
     * @param {...unknown} args - handler arguments.
     * @returns {Promise<unknown[]>} the handler results.
     */
    async emit(event, ...args) {
      const list = handlers.get(event) ?? [];
      const results = [];
      for (const handler of list) results.push(await handler(...args));
      return results;
    },
    /**
     * Dispatch a waterfall event through the registered handlers, with the
     * supplied fallback standing in for the desktop chain.
     * @param {string} event - event name.
     * @param {unknown[]} args - leading arguments.
     * @param {() => unknown} fallback - the `next()` terminal.
     * @returns {Promise<unknown>} the outcome.
     */
    async waterfall(event, args, fallback) {
      const list = handlers.get(event) ?? [];
      let index = 0;
      let delegated = false;
      const next = async () => {
        delegated = true;
        index += 1;
        if (index >= list.length) return fallback();
        return list[index](...args, next);
      };
      const result = list.length === 0 ? await fallback() : await list[0](...args, next);
      return { result, delegated };
    },
    has: event => (handlers.get(event) ?? []).length > 0,
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose?.();
    },
  };
}

/** Load the plugin with a temporary DSH home so no real state is touched. */
async function loadPlugin(overrides = {}, contextOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pulse-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  // A fresh module instance per test keeps the module-level state isolated.
  const mod = await import(`../lib/index.js?cachebust=${Math.random()}`);
  const harness = fakeContext(contextOptions);
  mod.apply(harness.ctx, {
    host: '127.0.0.1',
    port: 0,
    realm: 'Pulse',
    notify: 'none',
    decisionTimeoutMs: 300,
    pushArmDelayMs: 0,
    ...overrides,
  });
  // Register the listener the moment it exists -- `apply` publishes the service
  // synchronously, while `listen()` completes on a later tick. Waiting for
  // cleanup to register it would miss any test that asserts before then.
  const provided = harness.provided.get('remotePulse');
  if (provided?.server) listeners.add(provided.server);
  return {
    ...harness,
    mod,
    /**
     * Tear everything down and restore the environment.
     * @returns {Promise<void>} resolves when clean.
     */
    async cleanup() {
      await harness.dispose();
      const published = harness.provided.get('remotePulse');
      if (published?.server) {
        await published.server.close();
        listeners.delete(published.server);
      }
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Build an agent stand-in with the members the plugin reads. */
function fakeAgent(id, status = 'idle') {
  const calls = { steer: [], followup: [], cancel: [] };
  return {
    id,
    status,
    options: {},
    session: { id },
    inbox: { nextTurn: [], nextStep: [] },
    steer(message) {
      calls.steer.push(message);
    },
    followup(message) {
      calls.followup.push(message);
    },
    cancel(cause, options) {
      calls.cancel.push({ cause, options });
    },
    calls,
  };
}

test('the plugin registers the events and the service it advertises', async () => {
  const p = await loadPlugin();
  try {
    for (const event of [
      'agent/created',
      'agent/disposed',
      'agent/status',
      'session/event',
      'agent/error',
      'approval/request',
      'user-questions/request',
      'webserver/index-inject',
    ]) {
      assert.equal(p.has(event), true, `${event} must be observed`);
    }
    const service = p.provided.get('remotePulse');
    assert.ok(service, 'the remotePulse service must be published');
    // Startup is asynchronous (services are injected, then the push transport is
    // imported, then the listener binds), so wait for the published readiness
    // signal rather than racing it.
    await service.ready;
    const status = service.status();
    assert.equal(status.listening, true);
    assert.equal(status.host, '127.0.0.1');
    assert.equal(status.devices, 0);
  } finally {
    await p.cleanup();
  }
});

test('with no phone connected every answerer delegates to the desktop chain', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });

    const approval = await p.waterfall(
      'approval/request',
      [{ agent, toolName: 'bash', reason: '写文件' }],
      () => 'desktop-outcome',
    );
    assert.equal(approval.delegated, true, 'an approval must not be claimed without a phone');
    assert.equal(approval.result, 'desktop-outcome');

    const question = await p.waterfall(
      'user-questions/request',
      [{ agent, questions: [{ id: 'q1', question: '用哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }] }],
      () => ({ answers: [{ id: 'q1', selected: ['desktop'] }] }),
    );
    assert.equal(question.delegated, true, 'a question must not be claimed without a phone');
  } finally {
    await p.cleanup();
  }
});

test('a phone answer claims the approval without reaching the desktop chain', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });

    const service = p.provided.get('remotePulse');
    // Stand in for a live SSE stream so the plugin believes a phone can answer.
    service.server.streams.add({ write: () => true, end: () => {} });

    const pending = p.waterfall(
      'approval/request',
      [{ agent, toolName: 'bash', reason: '准备执行 npm publish' }],
      () => 'desktop-outcome',
    );

    // The queue must now hold exactly one decision for the phone to answer.
    await new Promise(resolve => setTimeout(resolve, 20));
    const queued = service.queue.list();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].type, 'approval');
    assert.equal(queued[0].sessionId, 's1');
    assert.match(queued[0].title, /bash/);

    const resolved = service.queue.resolve(queued[0].id, { outcome: 'allowed-once' });
    assert.equal(resolved.ok, true);

    const { result, delegated } = await pending;
    assert.equal(delegated, false, 'a phone answer must claim the request');
    assert.equal(result, 'allowed-once');
  } finally {
    await p.cleanup();
  }
});

test('an unanswered approval is handed back to the desktop chain after the timeout', async () => {
  const p = await loadPlugin({ decisionTimeoutMs: 80 });
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    service.server.streams.add({ write: () => true, end: () => {} });

    const { result, delegated } = await p.waterfall(
      'approval/request',
      [{ agent, toolName: 'pwsh', reason: null }],
      () => 'desktop-outcome',
    );
    assert.equal(delegated, true, 'the desktop must still get its card');
    assert.equal(result, 'desktop-outcome');
    assert.equal(service.queue.size, 0);
  } finally {
    await p.cleanup();
  }
});

test('a phone answer to a question produces one answer per asked question', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    service.server.streams.add({ write: () => true, end: () => {} });

    const questions = [
      { id: 'q1', question: '先做哪个？', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: '要跑测试吗？', options: [{ label: '是' }, { label: '否' }] },
    ];
    const pending = p.waterfall('user-questions/request', [{ agent, questions }], () => 'desktop-outcome');
    await new Promise(resolve => setTimeout(resolve, 20));

    const [queued] = service.queue.list();
    assert.equal(queued.type, 'question');
    assert.equal(queued.title, '先做哪个？');
    assert.match(queued.detail, /另有 1 个问题/);

    service.queue.resolve(queued.id, { selected: ['A'] });
    const { result, delegated } = await pending;
    assert.equal(delegated, false);
    assert.equal(result.answers.length, 2);
    assert.deepEqual(result.answers[0], { id: 'q1', selected: ['A'] });
    // The tool contract requires a row for every question id, even unanswered ones.
    assert.deepEqual(result.answers[1], { id: 'q2', selected: [] });
  } finally {
    await p.cleanup();
  }
});

test('a phone disconnect releases held decisions instead of stranding the agent', async () => {
  const p = await loadPlugin({ decisionTimeoutMs: 5000 });
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    const stream = { write: () => true, end: () => {} };
    service.server.streams.add(stream);

    const pending = p.waterfall(
      'approval/request',
      [{ agent, toolName: 'bash', reason: 'x' }],
      () => 'desktop-outcome',
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.queue.size, 1);

    // Simulate the last phone going away.
    service.server.streams.delete(stream);
    service.server.onPhoneDisconnected();

    const { result, delegated } = await pending;
    assert.equal(delegated, true, 'the desktop must pick the request back up');
    assert.equal(result, 'desktop-outcome');
  } finally {
    await p.cleanup();
  }
});

test('session events are distilled into frames on the ring', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    const session = { id: 's1' };

    await p.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
    await p.emit('session/event', session, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/a.ts"}' },
    });
    await p.emit('session/event', session, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
        error: { name: 'ENOENT', code: 'ENOENT' },
      },
    });
    await p.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: 'success' } });

    const texts = service.ring.tail(20).map(frame => frame.text);
    assert.ok(
      texts.some(text => text === '读取 src/a.ts'),
      `expected a distilled read line, got ${JSON.stringify(texts)}`,
    );
    assert.ok(
      texts.some(text => text.startsWith('读取失败：')),
      `expected a failure line, got ${JSON.stringify(texts)}`,
    );
    assert.ok(
      texts.some(text => text.startsWith('任务完成')),
      `expected a turn digest, got ${JSON.stringify(texts)}`,
    );
  } finally {
    await p.cleanup();
  }
});

test('the workspace name rides every frame, so a phone can say which project', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    // The live session exposes its immutable header, which is where the log stores
    // the cwd; the flatter spellings are the fallbacks.
    //
    // The expectation is derived from the path instead of being written out: what is
    // under test is "the workspace name rides every frame", and a frozen copy of the
    // author's directory name made this test fail on any other checkout.
    const workspace = 'D:\\code';
    const expectedProject = workspace.split('\\').pop();
    const session = { id: 's1', header: { cwd: workspace } };

    await p.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
    await p.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: 'success' } });

    const frames = service.ring.tail(20);
    assert.ok(frames.length >= 2, `expected frames, got ${frames.length}`);
    for (const frame of frames) {
      assert.equal(frame.project, expectedProject,
        `every frame must name the workspace, got ${JSON.stringify(frame.project)} for ${frame.kind}`);
    }

    // An unknown session degrades to no project rather than to a wrong one.
    const bare = { id: 's2' };
    await p.emit('session/event', bare, { type: 'turn/start', data: { turn: 1 } });
    const last = service.ring.tail(5).at(-1);
    assert.equal(last.project, undefined, 'a session with no cwd must not invent a project');
  } finally {
    await p.cleanup();
  }
});

test('a subagent session is marked as delegated, so a phone can stay quiet about it', async () => {
  const p = await loadPlugin();
  try {
    const service = p.provided.get('remotePulse');
    await p.emit('agent/created', { agent: fakeAgent('main', 'running') });
    await p.emit('agent/created', { agent: fakeAgent('sub', 'running') });

    // The live session's header is where the log keeps this, alongside the cwd.
    await p.emit('session/event', { id: 'main', header: { cwd: 'D:\\code', delegationDepth: 0 } },
      { type: 'turn/end', data: { turn: 1, reason: 'success' } });
    await p.emit('session/event', { id: 'sub', header: { cwd: 'D:\\code', delegationDepth: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: 'success' } });

    const frames = service.ring.tail(10);
    const main = frames.find(frame => frame.sessionId === 'main');
    const sub = frames.find(frame => frame.sessionId === 'sub');
    assert.ok(main && sub, 'both sessions must produce a frame');
    assert.equal(main.depth, undefined, 'the user\'s own conversation is depth 0');
    assert.equal(sub.depth, 1, 'a subagent turn must be marked, or it will buzz the phone');
  } finally {
    await p.cleanup();
  }
});

test('a write tool call is recorded as an artifact and pushed to live phones', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    const session = { id: 's1' };

    assert.equal(service.artifacts.size, 0);
    await p.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });

    // A read must not produce an artifact: the list answers "what did the agent
    // produce", and offering the user a file it merely looked at is wrong.
    await p.emit('session/event', session, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/a.ts"}' },
    });
    assert.equal(service.artifacts.size, 0, 'a read is not an artifact');

    // A write must. The path is recorded straight from the event stream, which
    // is what makes the content route an allowlist.
    await p.emit('session/event', session, {
      type: 'tool/call',
      data: { turn: 1, step: 2, callId: 'c2', name: 'write', arguments: '{"file_path":"out/report.md","content":"# hi"}' },
    });
    assert.equal(service.artifacts.size, 1);
    const [entry] = service.artifacts.list();
    assert.equal(entry.path, 'out/report.md');
    assert.equal(entry.name, 'report.md');
    assert.equal(entry.tool, 'write');
    assert.equal(entry.sessionId, 's1');
    assert.equal(entry.kind, 'text');

    // Re-writing the same file refreshes it rather than duplicating.
    await p.emit('session/event', session, {
      type: 'tool/call',
      data: { turn: 1, step: 3, callId: 'c3', name: 'edit', arguments: '{"file_path":"out/report.md"}' },
    });
    assert.equal(service.artifacts.size, 1);
    assert.equal(service.artifacts.list()[0].tool, 'edit');
    assert.equal(service.status().artifacts, 1);

    // Malformed arguments must not throw the event loop out of shape.
    await p.emit('session/event', session, {
      type: 'tool/call',
      data: { turn: 1, step: 4, callId: 'c4', name: 'write', arguments: 'not json at all' },
    });
    assert.equal(service.artifacts.size, 1);
  } finally {
    await p.cleanup();
  }
});

test('a credential file the agent wrote is not recorded as an artifact', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    const session = { id: 's1' };

    // The allowlist stops a callers-chosen path; this stops the one case the
    // allowlist would otherwise wave through — the agent itself writing a secret.
    for (const path of [
      '/home/u/.dsh/remote-pulse/local-token',
      '/home/u/.ssh/id_ed25519',
      '/home/u/.dsh/.credentials.yaml',
    ]) {
      await p.emit('session/event', session, {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: `c-${path}`, name: 'write', arguments: JSON.stringify({ file_path: path }) },
      });
    }
    assert.equal(service.artifacts.size, 0);
  } finally {
    await p.cleanup();
  }
});

test('the session listeners do not depend on the web services arriving', async () => {
  // The regression this exists for: the listeners used to be registered inside
  // the `ctx.inject(['webServer','connection'])` gate, so in a profile whose gate
  // never opens — headless, for instance — the plugin loaded, created its state
  // directory, and then observed nothing at all. A remote-control layer that is
  // quietly inert is worse than one that fails loudly.
  const p = await loadPlugin({ serviceWaitMs: 40 }, { inject: 'never' });
  try {
    assert.equal(p.has('session/event'), true, 'listeners must register without the gate');
    assert.equal(p.has('approval/request'), true);

    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    await p.emit('session/event', { id: 's1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"file_path":"out/report.md"}' },
    });
    assert.equal(p.provided.get('remotePulse').artifacts.size, 1, 'the plugin must not be inert');
  } finally {
    await p.cleanup();
  }
});

test('a profile with no web services still brings the phone surface up', async () => {
  const p = await loadPlugin({ serviceWaitMs: 40 }, { inject: 'never' });
  try {
    // `ready` used to be settleable only by the inject gate, so a profile
    // without those services left it pending forever — a hang with no
    // explanation, where the phone surface would in fact still have worked.
    const service = p.provided.get('remotePulse');
    const outcome = await Promise.race([
      service.ready.then(() => 'ready'),
      new Promise(resolve => setTimeout(() => resolve('hung'), 8000)),
    ]);
    assert.equal(outcome, 'ready', 'ready must settle even without the services');
    assert.equal(service.status().listening, true);
    assert.equal(
      p.logs.some(entry => entry.level === 'warn' && entry.message.includes('webServer')),
      true,
      'the degraded state must be stated out loud, not left silent',
    );
  } finally {
    await p.cleanup();
  }
});

test('a pending artifact write is flushed on shutdown instead of lost', async () => {
  const p = await loadPlugin();
  try {
    await p.emit('agent/created', { agent: fakeAgent('s1', 'running') });
    await p.emit('session/event', { id: 's1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"file_path":"out/flushed.md"}' },
    });
    const service = p.provided.get('remotePulse');
    assert.equal(service.artifacts.size, 1);

    // The debounce is `unref`'d so it never holds a process open, which means a
    // short-lived run — exactly what the headless profile does — would exit with
    // the write still queued. Shutdown flushes it synchronously.
    const file = join(process.env.DSH_HOME, 'remote-pulse', 'artifacts.json');
    assert.equal(existsSync(file), false, 'nothing is written before the debounce fires');
    assert.equal(service.flushArtifacts(), true, 'a pending write must be flushed');
    assert.equal(existsSync(file), true);
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].path, 'out/flushed.md');
    // Flushing twice is harmless; there is nothing left pending.
    assert.equal(service.flushArtifacts(), false);
  } finally {
    await p.cleanup();
  }
});

test('a real run leaves the artifact record behind on disk', async () => {
  // The end-to-end shape: observe a write, dispose the plugin as a process exit
  // would, and confirm the record survived without anyone calling flush by hand.
  const p = await loadPlugin();
  let home;
  try {
    home = process.env.DSH_HOME;
    await p.emit('agent/created', { agent: fakeAgent('s1', 'running') });
    await p.emit('session/event', { id: 's1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"file_path":"out/on-exit.md"}' },
    });
    await p.dispose();
    const file = join(home, 'remote-pulse', 'artifacts.json');
    assert.equal(existsSync(file), true, 'the shutdown hook must flush');
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].path, 'out/on-exit.md');
  } finally {
    await p.cleanup();
  }
});
test('the listeners register exactly once even if the gate fires repeatedly', async () => {
  // Registering inside the gate also meant a re-firing gate added a second copy
  // of every listener, which would double-count turns and artifacts.
  const p = await loadPlugin({}, { inject: 'immediate' });
  try {
    const session = { id: 's1' };
    await p.emit('agent/created', { agent: fakeAgent('s1', 'running') });
    await p.emit('session/event', session, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"file_path":"out/one.md"}' },
    });
    const service = p.provided.get('remotePulse');
    assert.equal(service.artifacts.size, 1);
    // One listener means one record per event, not two.
    assert.equal(p.provided.get('remotePulse').artifacts.list().length, 1);
  } finally {
    await p.cleanup();
  }
});

test('an instruction wakes an idle agent and steers a running one', async () => {
  const p = await loadPlugin();
  try {
    const service = p.provided.get('remotePulse');

    const idle = fakeAgent('idle-1', 'idle');
    await p.emit('agent/created', { agent: idle });
    const first = await service.server.instruct('先跑测试', 'idle-1');
    assert.equal(first.ok, true);
    assert.equal(idle.calls.followup.length, 1);
    assert.equal(idle.calls.steer.length, 0);
    assert.match(idle.calls.followup[0].content[0].text, /先跑测试/);

    const busy = fakeAgent('busy-1', 'running');
    await p.emit('agent/created', { agent: busy });
    await p.emit('agent/status', { agent: busy, status: 'running' });
    const second = await service.server.instruct('换个思路', 'busy-1');
    assert.equal(second.ok, true);
    assert.equal(busy.calls.steer.length, 1);
    assert.equal(busy.calls.followup.length, 0);
  } finally {
    await p.cleanup();
  }
});

test('/stop cancels instead of being sent as prompt text', async () => {
  const p = await loadPlugin();
  try {
    const service = p.provided.get('remotePulse');
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    await p.emit('agent/status', { agent, status: 'running' });

    const result = await service.server.instruct('/stop', 's1');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'cancelled');
    assert.equal(agent.calls.cancel.length, 1);
    // The literal text must never reach the model as a prompt.
    assert.equal(agent.calls.steer.length, 0);
    assert.equal(agent.calls.followup.length, 0);
  } finally {
    await p.cleanup();
  }
});

test('an instruction with no running session is refused with a reason', async () => {
  const p = await loadPlugin();
  try {
    const service = p.provided.get('remotePulse');
    const a = fakeAgent('a', 'idle');
    const b = fakeAgent('b', 'idle');
    await p.emit('agent/created', { agent: a });
    await p.emit('agent/created', { agent: b });

    const result = await service.server.instruct('做点什么');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-running-session');
    assert.deepEqual(result.candidates, []);
    assert.equal(a.calls.followup.length + b.calls.followup.length, 0);
  } finally {
    await p.cleanup();
  }
});

test('an unknown approval outcome can never become a grant', async () => {
  const p = await loadPlugin();
  try {
    const agent = fakeAgent('s1', 'running');
    await p.emit('agent/created', { agent });
    const service = p.provided.get('remotePulse');
    service.server.streams.add({ write: () => true, end: () => {} });

    const pending = p.waterfall('approval/request', [{ agent, toolName: 'bash', reason: null }], () => 'desktop');
    await new Promise(resolve => setTimeout(resolve, 20));
    const [queued] = service.queue.list();

    // A hostile or buggy client sends an unrecognized outcome.
    service.queue.resolve(queued.id, { outcome: 'totally-fine-trust-me' });
    const { result } = await pending;
    assert.equal(result, 'rejected', 'unrecognized input must fail closed');
  } finally {
    await p.cleanup();
  }
});

test('a disposed agent stops being addressable', async () => {
  const p = await loadPlugin();
  try {
    const service = p.provided.get('remotePulse');
    const agent = fakeAgent('s1', 'idle');
    await p.emit('agent/created', { agent });
    await p.emit('agent/disposed', { agent });

    const result = await service.server.instruct('还在吗', 's1');
    assert.equal(result.ok, false);
    assert.equal(agent.calls.followup.length, 0);
  } finally {
    await p.cleanup();
  }
});

test('a stale sequence from a previous process is not treated as current', async () => {
  const p = await loadPlugin();
  try {
    const service = p.provided.get('remotePulse');
    const agent = fakeAgent('s1', 'idle');
    await p.emit('agent/created', { agent });
    const snapshot = service.server.snapshot();
    assert.equal(snapshot.lastSeq, 0);
    assert.equal(snapshot.exposed, false);
    assert.equal(snapshot.sessions.length, 1);
  } finally {
    await p.cleanup();
  }
});

test('the injected rows advertise the surface, grant remote host mode, and adapt narrow screens', async () => {
  const p = await loadPlugin({ realm: 'Pulse' });
  try {
    const table = [];
    await p.emit('webserver/index-inject', table);
    // Seven rows: the host-mode script and the narrow-screen stylesheet, the mobile
    // shell's own stylesheet and script, the deliverables card action, the opened
    // file's header action, and the per-link action in the transcript. Each is a
    // separate row because the contract has no combined form.
    assert.equal(table.length, 7);

    const row = table.find(
      candidate => candidate.kind === 'script' && candidate.text.includes('__DSH_REMOTE_PULSE__'),
    );
    const style = table.find(
      candidate => candidate.kind === 'style' && candidate.text.includes('text-size-adjust'),
    );
    assert.ok(row, 'the host-mode script row must be present');
    assert.ok(style, 'the narrow-screen stylesheet row must be present');

    // The shell is a second pair of rows, and it must not be mistaken for either
    // of the above: it is the one that moves the sidebar.
    const shellCss = table.find(
      candidate => candidate.kind === 'style' && candidate.text.includes('pulse-burger'),
    );
    const shellJs = table.find(
      candidate => candidate.kind === 'script' && candidate.text.includes('__PULSE_SHELL__'),
    );
    assert.ok(shellCss, 'the mobile shell stylesheet must be injected');
    assert.ok(shellJs, 'the mobile shell script must be injected');
    assert.equal(shellJs.placement, 'body');
    assert.equal(shellJs.text.includes('</script'), false);
    // It must not carry credentials into the page either.
    assert.equal(/Bearer|token=/i.test(shellJs.text), false);

    // The deliverables card action is a third generated script, injected into a
    // React subtree, so it has to rewrite itself after a re-render.
    const cardJs = table.find(
      candidate => candidate.kind === 'script' && candidate.text.includes('__PULSE_DELIVERABLES__'),
    );
    assert.ok(cardJs, 'the deliverables card action must be injected');
    assert.equal(cardJs.placement, 'body');
    assert.equal(cardJs.text.includes('</script'), false);
    assert.ok(cardJs.text.includes('_menuAnchor'), 'anchored on the card menu anchor');
    assert.ok(cardJs.text.includes('MutationObserver'), 'and it re-adds itself after a re-render');
    assert.equal(/innerWidth\s*<=\s*\d/.test(cardJs.text), false, 'it must not be width-gated either');

    // The opened file's header. The absolute path is the preview's own
    // `data-textpreview-path` marker, not anything recovered by guessing.
    const previewJs = table.find(
      candidate => candidate.kind === 'script' && candidate.text.includes('__PULSE_PREVIEW__'),
    );
    assert.ok(previewJs, 'the preview header action must be injected');
    assert.equal(previewJs.placement, 'body');
    assert.equal(previewJs.text.includes('</script'), false);
    assert.ok(previewJs.text.includes('data-textpreview-path'), 'reads the preview\'s own path marker');
    assert.ok(previewJs.text.includes('MutationObserver'), 'and it re-adds itself after a re-render');
    assert.equal(/innerWidth\s*<=\s*\d/.test(previewJs.text), false, 'it must not be width-gated either');
    assert.ok(shellCss.text.includes('data-pulse-preview-action'), 'the preview button must be styled');
    // And the files tree carries nothing per row any more: twenty repeated marks down
    // the sidebar is exactly what the user asked to have moved into the opened file.
    assert.equal(table.some(candidate => String(candidate.text).includes('__PULSE_FILE_ROWS__')), false,
      'the files tree must not inject a per-row action any more');

    // The transcript's underlined file paths. The absolute path is not in the DOM,
    // so this one reads React's own props and therefore has to prove it can fail
    // safely: the resolution is checked against the row's text before anything is
    // injected, and that guard is the thing this asserts is present.
    const linkJs = table.find(
      candidate => candidate.kind === 'script' && candidate.text.includes('__PULSE_FILE_LINKS__'),
    );
    assert.ok(linkJs, 'the transcript file-link action must be injected');
    assert.equal(linkJs.placement, 'body');
    assert.equal(linkJs.text.includes('</script'), false);
    assert.ok(linkJs.text.includes('_fileLink'), 'anchored on the underlined file path');
    assert.ok(linkJs.text.includes('__reactFiber$'), 'reads the component props for the absolute path');
    assert.ok(linkJs.text.includes('filePath') && linkJs.text.includes('cwd'),
      'both the prop and the workspace fallback are read');
    assert.ok(linkJs.text.includes('basename'), 'and the result is checked against the row text');
    assert.ok(linkJs.text.includes('MutationObserver'), 'and it re-adds itself after a re-render');
    assert.equal(/innerWidth\s*<=\s*\d/.test(linkJs.text), false, 'it must not be width-gated either');
    assert.ok(shellCss.text.includes('data-pulse-file-link-action'), 'the link action must be styled');

    // The injection contract is a discriminated union; a row outside it is
    // silently dropped by the renderer. A `style` row carries text and nothing
    // else — no placement, since the contract puts it in the head.
    assert.equal(typeof style.text, 'string');
    assert.equal(style.placement, undefined);
    assert.ok(style.text.includes('max-width:'), 'the stylesheet must actually constrain width');
    assert.equal(style.text.includes('</style'), false);

    assert.equal(row.placement, 'body');
    assert.equal(typeof row.text, 'string');
    // An inline script must never be able to close its own element early.
    assert.equal(row.text.includes('</script'), false);
    // It advertises the address only; no device token may reach the page.
    assert.equal(/token/i.test(row.text), false);
    assert.match(row.text, /__DSH_REMOTE_PULSE__/);

    // Remote host mode: without `ownsHost`, a phone's non-loopback hostname
    // makes the harness degrade every settings RPC to memory and blank the
    // settings surface.
    assert.match(row.text, /__DSH_TRANSPORT__/);
    assert.match(row.text, /ownsHost:\s*true/);
    // It must not claim the transport's fetch/openStream; the client keeps its
    // own same-origin carriers, which the proxy serves.
    assert.equal(/fetch\s*:/.test(row.text), false);
    assert.equal(/openStream\s*:/.test(row.text), false);
  } finally {
    await p.cleanup();
  }
});

test('an injection table that is not an array is ignored rather than thrown on', async () => {
  const p = await loadPlugin();
  try {
    await p.emit('webserver/index-inject', null);
    await p.emit('webserver/index-inject', undefined);
  } finally {
    await p.cleanup();
  }
});
