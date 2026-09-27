/**
 * Semantic distillation: turn the raw DeepSeek Harness agent event stream into
 * the only three things a person away from the keyboard actually needs —
 * what the agent is doing, where it is stuck, and what it wants decided.
 *
 * This module is the product. It is deliberately pure: a builder accumulates
 * raw observations and an `emit()` boundary produces wire-safe frames. No I/O,
 * no timers, no Cordis imports — so it is testable in isolation and reusable
 * by any transport (SSE today, WebSocket or push later).
 *
 * Design rules:
 * - A frame is one already-summarized LINE, never a raw payload. The phone is
 *   never a mirror of the desktop stream.
 * - Tool detail is compressed to intent plus a short subject: `读取 config.ts`,
 *   not a JSON argument dump.
 * - Repetition collapses. Forty `读取 x.ts` lines become one `读取 12 个文件`.
 * - Nothing is invented: every frame traces back to an observed event.
 *
 * @module pulse-remote/distill
 */

/** Frame severity, ordered by how much it deserves the user's attention. */
export const SEVERITY = Object.freeze({
  /** Ambient progress; safe to ignore and safe to batch. */
  progress: 0,
  /** The agent finished, delivered, or recovered something notable. */
  notice: 1,
  /** Something failed, or the agent changed direction. */
  warning: 2,
  /** The agent is blocked and only the user can unblock it. */
  decision: 3,
});

/** The frame kinds the phone renders. */
export const FRAME_KIND = Object.freeze({
  /** One line of "what it is doing right now". */
  activity: 'activity',
  /** A macro summary of a collapsed run of similar activity. */
  summary: 'summary',
  /** The agent stopped and needs a human decision. */
  decision: 'decision',
  /** A decision was answered. */
  decisionResolved: 'decision-resolved',
  /** A decision expired without an answer. */
  decisionExpired: 'decision-expired',
  /** A turn started. */
  turnStart: 'turn-start',
  /** A turn ended; carries the outcome digest. */
  turnEnd: 'turn-end',
  /** A failure worth surfacing even if the turn continues. */
  failure: 'failure',
  /** Session lifecycle (created / disposed / status flip). */
  session: 'session',
});

const MAX_LINE = 160;

/**
 * Collapse whitespace and clamp a line to a single readable row.
 * @param {unknown} value - raw text.
 * @param {number} [max] - maximum length before elision.
 * @returns {string} one trimmed line.
 */
export function oneLine(value, max = MAX_LINE) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Shorten a filesystem path to its last one or two segments, which is all a
 * phone reader needs to recognize the subject.
 * @param {unknown} value - a path or path-like string.
 * @param {number} [keep] - trailing segments to keep.
 * @returns {string} shortened path.
 */
export function shortPath(value, keep = 2) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return raw;
  return parts.slice(-keep).join('/');
}

/**
 * Pull the most informative single argument out of a tool call, without ever
 * dumping the whole object.
 * @param {Record<string, unknown> | undefined} args - tool arguments.
 * @returns {string} a short subject, or an empty string.
 */
export function toolSubject(args) {
  if (!args || typeof args !== 'object') return '';
  const preferred = [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'pattern',
    'query',
    'url',
    'command',
    'cmd',
    'script',
    'skill',
    'name',
    'prompt',
    'description',
  ];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      if (/(path|file)/i.test(key)) return shortPath(value);
      return oneLine(value, 70);
    }
  }
  // A tool with no recognized argument still gets identity from its first
  // string field, which is more useful than an empty subject.
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return oneLine(value, 70);
  }
  return '';
}

/**
 * Human phrasing per tool. Unknown tools degrade to their raw name, which is
 * still honest and still useful.
 */
const TOOL_PHRASE = Object.freeze({
  read: '读取',
  write: '写入',
  edit: '修改',
  insert: '插入',
  str_replace_editor: '编辑',
  apply_patch: '应用补丁',
  glob: '查找文件',
  grep: '搜索内容',
  bash: '执行命令',
  pwsh: '执行命令',
  shell: '执行命令',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  todo_write: '更新任务清单',
  ask_user_question: '向你提问',
  present: '提交交付物',
  subagent: '派出子代理',
  subagent_fork: '派生子代理',
  list_agents: '查看子代理',
  send_message: '给子代理发消息',
  skill: '加载技能',
  workflow: '运行工作流',
  ralph: '迭代执行',
  goal: '操作目标',
  exit_plan_mode: '提交计划待批',
});

const GROUP_LABEL = Object.freeze({
  read: '读取',
  write: '写入',
  search: '搜索',
  command: '执行命令',
  web: '联网',
  subagent: '子代理',
  other: '工具调用',
});

/**
 * Bucket a tool by what the user would call the activity, so collapsed runs
 * read as one sentence.
 * @param {string} name - tool name.
 * @returns {keyof typeof GROUP_LABEL} the bucket.
 */
export function toolGroup(name) {
  const n = String(name ?? '').toLowerCase();
  if (n === 'read') return 'read';
  if (['write', 'edit', 'insert', 'str_replace_editor', 'apply_patch'].includes(n)) return 'write';
  if (['glob', 'grep'].includes(n)) return 'search';
  if (['bash', 'pwsh', 'shell'].includes(n)) return 'command';
  if (['web_search', 'web_fetch'].includes(n)) return 'web';
  if (['subagent', 'subagent_fork', 'send_message', 'list_agents'].includes(n)) return 'subagent';
  return 'other';
}

/**
 * Render one tool call as a single activity line.
 * @param {string} name - tool name.
 * @param {Record<string, unknown> | undefined} args - tool arguments.
 * @returns {string} the line.
 */
export function toolLine(name, args) {
  const phrase = TOOL_PHRASE[String(name ?? '').toLowerCase()] ?? String(name ?? '工具调用');
  const subject = toolSubject(args);
  return subject ? `${phrase} ${subject}` : phrase;
}

/**
 * How long something took, in the coarsest unit that still informs.
 * @param {number} ms - duration in milliseconds.
 * @returns {string} e.g. `3 秒`, `2 分 10 秒`, `1 小时 4 分`.
 */
export function humanDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return `${total} 毫秒`;
  const seconds = Math.round(total / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

/**
 * Compress an unknown thrown value into one honest line.
 * @param {unknown} error - whatever was thrown.
 * @returns {string} the message.
 */
export function errorLine(error) {
  if (error instanceof Error) return oneLine(error.message || error.name);
  if (typeof error === 'string') return oneLine(error);
  if (error && typeof error === 'object') {
    const message = /** @type {{ message?: unknown }} */ (error).message;
    if (typeof message === 'string' && message.trim()) return oneLine(message);
    try {
      return oneLine(JSON.stringify(error));
    } catch {
      return '未知错误';
    }
  }
  return oneLine(String(error ?? '未知错误'));
}

/** Upper bound on collapsed-run counters, so a runaway loop cannot leak memory. */
const MAX_RUN = 500;

/**
 * Assembles raw agent observations into distilled frames.
 *
 * One builder serves one session. `emit()` is the only way frames leave, so a
 * transport can never accidentally forward a raw event.
 */
export class Distiller {
  /**
   * @param {object} [options] - tuning.
   * @param {(frame: object) => void} [options.onFrame] - sink for every frame.
   * @param {() => number} [options.now] - clock, injectable for tests.
   * @param {number} [options.flushMs] - idle gap that closes an open run.
   * @param {(sessionId: string) => string} [options.projectOf] - the human name of the
   *     workspace a session belongs to. Stamped onto every frame so a phone can say
   *     *which* project finished without a second round trip: a notification that
   *     only says "任务完成" is ambiguous the moment two sessions are open.
   * @param {(sessionId: string) => number} [options.depthOf] - how deep in the
   *     delegation tree a session sits: 0 for the conversation the user started, 1+ for
   *     a subagent working inside it. Stamped onto the frame because "something
   *     finished" and "your conversation finished" are different events, and only the
   *     consumer knows which of them it wants to be interrupted for.
   */
  constructor(options = {}) {
    this.onFrame = options.onFrame ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.flushMs = options.flushMs ?? 2500;
    this.projectOf = options.projectOf ?? (() => '');
    this.depthOf = options.depthOf ?? (() => 0);

    /** Open collapsed run, if any. */
    this.run = null;
    /** Per-session bookkeeping keyed by session id. */
    this.sessions = new Map();
    /** Counters for the current turn, consumed by the turn digest. */
    this.turn = new Map();
  }

  /**
   * Per-session state, created on first sight.
   * @param {string} sessionId - session identity.
   * @returns {{id: string, startedAt: number, lastSeq: number, running: boolean}} state.
   */
  #state(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { id: sessionId, startedAt: this.now(), lastSeq: 0, running: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Advance the per-session sequence counter.
   * @param {string} sessionId - session identity.
   * @returns {number} the new sequence number.
   */
  nextSeq(sessionId) {
    const state = this.#state(sessionId);
    state.lastSeq += 1;
    return state.lastSeq;
  }

  /**
   * Build and forward one frame.
   * @param {object} frame - partial frame; `ts` and `seq` are filled when absent.
   * @returns {object} the complete frame.
   */
  emit(frame) {
    const sessionId = String(frame.sessionId ?? 'unknown');
    // Resolved per frame rather than cached at construction: a session's workspace is
    // known from the moment its header is read, which can be after the distiller was
    // built, and a frame is cheap enough to stamp on the way out.
    const project = frame.project ?? this.projectOf(sessionId) ?? '';
    const depth = frame.depth ?? this.depthOf(sessionId) ?? 0;
    const complete = {
      seq: frame.seq ?? this.nextSeq(sessionId),
      ts: frame.ts ?? this.now(),
      sessionId,
      kind: frame.kind,
      severity: frame.severity ?? SEVERITY.progress,
      text: oneLine(frame.text),
      ...(project ? { project: oneLine(project, 60) } : {}),
      ...(depth > 0 ? { depth } : {}),
      ...(frame.detail ? { detail: oneLine(frame.detail, 400) } : {}),
      ...(frame.ref ? { ref: frame.ref } : {}),
    };
    this.onFrame(complete);
    return complete;
  }

  /**
   * Close any open collapsed run, emitting its summary.
   * @returns {object | null} the emitted summary frame, if a run was open.
   */
  flushRun() {
    const run = this.run;
    if (!run) return null;
    this.run = null;
    if (run.count < 2) return null;
    const subject = run.subjects.size === 1 ? ` (${[...run.subjects][0]})` : '';
    return this.emit({
      sessionId: run.sessionId,
      kind: FRAME_KIND.summary,
      severity: SEVERITY.progress,
      text: `${GROUP_LABEL[run.group]} ×${run.count}${subject}`,
      detail: [...run.subjects].slice(0, 8).join('、'),
      ref: { group: run.group, count: run.count },
    });
  }

  /**
   * Fold one activity line, collapsing consecutive same-group activity.
   * @param {string} sessionId - session identity.
   * @param {string} group - activity bucket.
   * @param {string} text - the line.
   * @param {string} subject - the short subject, for run detail.
   * @returns {object | null} a frame when one was emitted.
   */
  #activity(sessionId, group, text, subject) {
    const now = this.now();
    const open = this.run;
    const continues =
      open && open.sessionId === sessionId && open.group === group && now - open.lastAt <= this.flushMs;

    if (continues) {
      open.count = Math.min(open.count + 1, MAX_RUN);
      open.lastAt = now;
      if (subject) open.subjects.add(subject);
      // A collapsing run emits nothing per step: that is the point.
      return null;
    }

    const flushed = this.flushRun();
    this.run = {
      sessionId,
      group,
      count: 1,
      subjects: new Set(subject ? [subject] : []),
      startedAt: now,
      lastAt: now,
      firstText: text,
    };
    // Emit the first line of the new run so the phone still sees live motion.
    void flushed;
    return this.emit({
      sessionId,
      kind: FRAME_KIND.activity,
      severity: SEVERITY.progress,
      text,
      ref: { group },
    });
  }

  /**
   * Count a tool call toward the current turn digest.
   * @param {string} sessionId - session identity.
   * @param {string} group - activity bucket.
   * @returns {void}
   */
  #countTurn(sessionId, group) {
    let counters = this.turn.get(sessionId);
    if (!counters) {
      counters = { tools: 0, groups: new Map(), startedAt: this.now() };
      this.turn.set(sessionId, counters);
    }
    counters.tools += 1;
    counters.groups.set(group, (counters.groups.get(group) ?? 0) + 1);
  }

  /**
   * Observe a tool call.
   * @param {object} event - `{sessionId, toolName, args}`.
   * @returns {object | null} a frame when one was emitted.
   */
  toolCall(event) {
    const sessionId = String(event.sessionId ?? 'unknown');
    const name = String(event.toolName ?? 'tool');
    const group = toolGroup(name);
    const subject = toolSubject(event.args);
    this.#countTurn(sessionId, group);
    return this.#activity(sessionId, group, toolLine(name, event.args), subject);
  }

  /**
   * Observe a tool result, which surfaces failures the turn digest would hide.
   * @param {object} event - `{sessionId, toolName, ok, error, summary}`.
   * @returns {object | null} a frame when one was emitted.
   */
  toolResult(event) {
    if (event.ok !== false) return null;
    const sessionId = String(event.sessionId ?? 'unknown');
    const name = String(event.toolName ?? 'tool');
    const phrase = TOOL_PHRASE[name.toLowerCase()] ?? name;
    const reason = errorLine(event.error ?? event.summary ?? '失败');
    this.flushRun();
    // A failing tool often retries immediately; only the first failure of a
    // session's current turn deserves a push, so the phone is not spammed.
    const counters = this.turn.get(sessionId);
    if (counters) counters.failures = (counters.failures ?? 0) + 1;
    return this.emit({
      sessionId,
      kind: FRAME_KIND.failure,
      severity: SEVERITY.warning,
      text: `${phrase}失败：${reason}`,
      ref: { tool: name },
    });
  }

  /**
   * Observe a turn start.
   * @param {object} event - `{sessionId, turn}`.
   * @returns {object} the frame.
   */
  turnStart(event) {
    const sessionId = String(event.sessionId ?? 'unknown');
    this.flushRun();
    this.turn.set(sessionId, { tools: 0, groups: new Map(), startedAt: this.now() });
    const state = this.#state(sessionId);
    state.running = true;
    return this.emit({
      sessionId,
      kind: FRAME_KIND.turnStart,
      severity: SEVERITY.progress,
      text: '开始处理',
      ref: { turn: event.turn ?? null },
    });
  }

  /**
   * Observe a turn end and produce the digest that makes a completion push
   * worth reading: what happened, how long it took, how much work it was.
   * @param {object} event - `{sessionId, turn, outcome, finalText}`.
   * @returns {object} the frame.
   */
  turnEnd(event) {
    const sessionId = String(event.sessionId ?? 'unknown');
    this.flushRun();
    const counters = this.turn.get(sessionId) ?? { tools: 0, groups: new Map(), startedAt: this.now() };
    this.turn.delete(sessionId);
    const state = this.#state(sessionId);
    state.running = false;

    const elapsed = humanDuration(this.now() - counters.startedAt);
    const failed = counters.failures ?? 0;
    const outcome = String(event.outcome ?? 'done');
    const head =
      outcome === 'error'
        ? '任务失败'
        : outcome === 'cancelled'
          ? '任务已停止'
          : failed > 0
            ? `任务完成（${failed} 次工具失败）`
            : '任务完成';

    const parts = [`${elapsed}`];
    if (counters.tools > 0) parts.push(`${counters.tools} 次工具调用`);
    const breakdown = [...counters.groups.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([group, count]) => `${GROUP_LABEL[group]}${count}`)
      .join('、');
    if (breakdown) parts.push(breakdown);

    return this.emit({
      sessionId,
      kind: FRAME_KIND.turnEnd,
      severity: outcome === 'error' ? SEVERITY.warning : SEVERITY.notice,
      text: `${head} · ${parts.join(' · ')}`,
      ...(event.finalText ? { detail: oneLine(event.finalText, 400) } : {}),
      ref: { turn: event.turn ?? null, outcome, tools: counters.tools },
    });
  }

  /**
   * Observe an error that surfaced outside a normal tool result.
   * @param {object} event - `{sessionId, error}`.
   * @returns {object} the frame.
   */
  error(event) {
    const sessionId = String(event.sessionId ?? 'unknown');
    this.flushRun();
    return this.emit({
      sessionId,
      kind: FRAME_KIND.failure,
      severity: SEVERITY.warning,
      text: `出错：${errorLine(event.error)}`,
    });
  }

  /**
   * Observe an agent status flip.
   * @param {object} event - `{sessionId, status}`.
   * @returns {object | null} a frame when the flip is worth showing.
   */
  status(event) {
    const sessionId = String(event.sessionId ?? 'unknown');
    const state = this.#state(sessionId);
    const status = String(event.status ?? '');
    const running = status === 'running';
    if (state.running === running && state.seen) return null;
    state.running = running;
    state.seen = true;
    return this.emit({
      sessionId,
      kind: FRAME_KIND.session,
      severity: SEVERITY.progress,
      text: running ? '开始工作' : '空闲',
      ref: { status },
    });
  }

  /**
   * Observe a pending decision and render it as a frame the phone can act on.
   * @param {object} event - the decision descriptor.
   * @returns {object} the frame.
   */
  decision(event) {
    const sessionId = String(event.sessionId ?? 'unknown');
    this.flushRun();
    const { id, type, title, detail, options } = event;
    return this.emit({
      sessionId,
      kind: FRAME_KIND.decision,
      severity: SEVERITY.decision,
      text: oneLine(title),
      ...(detail ? { detail: oneLine(detail, 400) } : {}),
      ref: { decisionId: id, decisionType: type, options: options ?? [] },
    });
  }

  /**
   * Observe a decision outcome.
   * @param {object} event - `{sessionId, id, outcome, label}`.
   * @returns {object} the frame.
   */
  decisionResolved(event) {
    const expired = event.outcome === 'expired';
    return this.emit({
      sessionId: String(event.sessionId ?? 'unknown'),
      kind: expired ? FRAME_KIND.decisionExpired : FRAME_KIND.decisionResolved,
      severity: SEVERITY.notice,
      text: expired ? '决策超时，已交回电脑端' : `已回复：${oneLine(event.label ?? event.outcome, 60)}`,
      ref: { decisionId: event.id },
    });
  }

  /**
   * Current per-session snapshot for the phone's "right now" header.
   * @returns {Array<object>} one row per known session.
   */
  snapshot() {
    return [...this.sessions.values()].map(state => ({
      sessionId: state.id,
      running: state.running,
      lastSeq: state.lastSeq,
      startedAt: state.startedAt,
      elapsedMs: this.now() - state.startedAt,
    }));
  }
}

export default Distiller;
