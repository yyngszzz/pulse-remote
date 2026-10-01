/**
 * Pulse — the DeepSeek Harness plugin half.
 *
 * Two jobs, in order of importance:
 *
 * 1. **The phone is a remote control.** A paired device reaches the harness's
 *    own Web GUI through a loopback proxy, so the phone can see sessions, read
 *    conversations, watch changes and hand the agent work — all with the same
 *    feature set as the desktop, because it is the same client.
 * 2. **The phone is a beeper when you are away.** A distilled activity stream
 *    and a decisions queue mean the phone can tell you what is happening, what
 *    is stuck, and what wants a decision, without mirroring the whole session.
 *
 * The load-bearing design decisions:
 *
 * - **The desktop is never degraded.** The approval and question answerers claim
 *   a request only while a phone is actually connected. Every other path calls
 *   `next()`, so a desktop-only user's experience is byte-for-byte what it was
 *   without this plugin installed.
 * - **A phone can never strand the agent.** Every held request ends in an
 *   answer: the phone's decision, the caller's abort, or a timeout that hands
 *   the request back to the desktop chain.
 * - **An unpaired caller gets nothing.** The pairing gate is the only thing an
 *   unpaired phone receives, and the harness credential never leaves this
 *   process — it is attached server-side on the way out.
 *
 * @module dsh-remote-pulse
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';

import { AccessControl } from './auth.js';
import { ArtifactIndex, readArtifact } from './artifacts.js';
import { CredentialBootstrap } from './bootstrap.js';
import { DecisionQueue, DECISION_STATE, lockScreenDecision } from './decisions.js';
import { Distiller } from './distill.js';
import { LoopbackGateway } from './gateway.js';
import { loadOrCreateLocalToken } from './local-token.js';
import { isEmbeddable, mobileStylesheet } from './mobile.js';
import {
  deliverableActionsScript,
  fileLinkActionsScript,
  isEmbeddableScript,
  mobileShellScript,
  mobileShellStyles,
  previewActionsScript,
} from './mobile-shell.js';
import { PushChannel } from './push.js';
import { FrameRing } from './ring.js';
import { PulseServer } from './server.js';

/** Default bind port for the phone surface. */
const DEFAULT_PORT = 3199;

/** How long to wait for the injected web services before proceeding without them. */
const SERVICE_WAIT_MS = 10_000;

/**
 * Resolve early with whether a promise settled in time.
 *
 * Used instead of `await` so a dependency that never arrives degrades to "not
 * available" rather than hanging the caller forever.
 *
 * @param {Promise<unknown>} promise - the promise to bound.
 * @param {number} ms - how long to wait.
 * @returns {Promise<boolean>} whether it settled in time.
 */
function settlesWithin(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/**
 * Resolve the harness home directory the same way the rest of DSH does.
 * @returns {string} absolute path to the DSH home.
 */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
}

/**
 * Write JSON to a file atomically.
 *
 * An interrupted write must never leave a half-file behind: for the device
 * roster that would silently drop a pairing the user believes exists, and for
 * the artifact list it would be an unparseable file on the next start.
 *
 * @param {string} file - destination path.
 * @param {unknown} value - the value to serialize.
 * @param {object} [options] - tuning.
 * @param {number} [options.mode] - file mode.
 * @param {boolean} [options.pretty] - indent the output.
 * @returns {void}
 * @throws {Error} when the write fails.
 */
function writeJsonAtomic(file, value, options = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, options.pretty ? 2 : 0), options.mode ? { mode: options.mode } : {});
  renameSync(temporary, file);
}

/**
 * Read the current harness-time id of an object, tolerating a getter.
 * @param {object} value - the candidate.
 * @param {string} key - property name.
 * @returns {string} the id, or an empty string.
 */
function idOf(value, key) {
  try {
    const raw = value?.[key];
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * Extract the plain text of a message's content blocks.
 * @param {object} message - an LLM message.
 * @returns {string} the concatenated text.
 */
function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim();
}

/**
 * Parse a tool call's raw JSON arguments without ever throwing.
 * @param {string} raw - the model-produced JSON string.
 * @returns {Record<string, unknown>} the parsed object, or an empty one.
 */
function parseArgs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Build a harness user message. Prefers the official constructor so the message
 * carries a proper branded identity, and degrades to an equivalent literal.
 * @param {string} text - the instruction text.
 * @returns {Promise<object>} the message.
 */
async function buildUserMessage(text) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm/message');
    if (typeof mod.createUserMessage === 'function') {
      return mod.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
    }
  } catch {
    // The SDK is not resolvable from this package; fall through.
  }
  return {
    id: `pulse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/** Notification transports this plugin can speak, and how to phrase each. */
const NOTIFIERS = {
  /** No push; the PWA shows state when opened. */
  none: null,
  /** A generic JSON POST: `{ title, body, severity, sessionId, decisionId }`. */
  webhook: ({ config, decision, summary }) => ({
    url: config.notifyUrl,
    body: {
      title: decision ? '需要你决定' : 'DeepSeek 任务动态',
      body: decision ? decision.title : summary,
      severity: decision ? 'decision' : 'notice',
      sessionId: decision?.sessionId ?? null,
      decisionId: decision?.id ?? null,
    },
  }),
  /** Server酱 (WeChat) push. */
  serverchan: ({ config, decision, summary }) => ({
    url: `https://sctapi.ftqq.com/${encodeURIComponent(config.notifyKey)}.send`,
    body: {
      title: decision ? `需要你决定：${decision.title}` : 'DeepSeek 任务动态',
      desp: decision ? `${decision.title}\n\n${decision.detail ?? ''}` : summary,
    },
  }),
  /** Bark (iOS) push. */
  bark: ({ config, decision, summary }) => ({
    url: `${String(config.notifyUrl).replace(/\/+$/, '')}/${encodeURIComponent(
      decision ? decision.title : summary,
    )}`,
    body: undefined,
  }),
};

/**
 * Register the plugin on a Cordis context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} config - resolved plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = {
    host: config?.host ?? '127.0.0.1',
    port: config?.port ?? DEFAULT_PORT,
    realm: config?.realm ?? 'Pulse',
    notify: config?.notify ?? 'none',
    notifyUrl: config?.notifyUrl ?? '',
    notifyKey: config?.notifyKey ?? '',
    /** How long a phone may hold a request before the desktop chain takes it back. */
    decisionTimeoutMs: config?.decisionTimeoutMs ?? 120_000,
    /** Extra hold granted only when a push channel can actually reach the phone. */
    pushArmDelayMs: config?.pushArmDelayMs ?? 20_000,
    /** Retained distilled frames available for replay after a reconnect. */
    ringCapacity: config?.ringCapacity ?? 800,
    /** Whether to push every completed turn or only ones the user must see. */
    notifyTurns: config?.notifyTurns ?? true,
    /** Whether to push tool failures. */
    notifyFailures: config?.notifyFailures ?? false,
    /**
     * How long to wait for the injected web services before bringing the phone
     * surface up without the GUI proxy. A profile that has no `webServer`
     * service never satisfies the gate, and waiting forever would mean the
     * plugin never starts at all.
     */
    serviceWaitMs: config?.serviceWaitMs ?? SERVICE_WAIT_MS,
  };

  const home = dshHome();
  const stateDir = join(home, 'remote-pulse');
  const stateFile = join(stateDir, 'devices.json');
  const secretFile = join(stateDir, 'session.key');

  // Proof of locality for the management subtree. The peer address cannot carry
  // that meaning here: the phone reaches this listener through an SSH reverse
  // tunnel, so an internet caller and the machine's own user are both
  // 127.0.0.1. See `local-token.js`.
  const localOperator = loadOrCreateLocalToken(stateDir, {
    onWarn: message => ctx.logger?.warn?.(message),
  });

  const access = new AccessControl();

  /** Files the agent produced, recorded from the tool calls already flowing past. */
  const artifacts = new ArtifactIndex();
  const artifactsFile = join(stateDir, 'artifacts.json');

  // The files are still on disk after a restart, so the list should not be
  // amnesia about them.
  try {
    const restored = artifacts.restore(JSON.parse(readFileSync(artifactsFile, 'utf8')));
    if (restored > 0) ctx.logger?.info?.(`[remote-pulse] 已恢复 ${restored} 条产物记录`);
  } catch {
    /* first run, or an unreadable file: start empty */
  }

  /** Debounced so a burst of tool calls writes once. */
  let artifactsSaveTimer = null;
  const saveArtifacts = () => {
    clearTimeout(artifactsSaveTimer);
    artifactsSaveTimer = setTimeout(() => {
      artifactsSaveTimer = null;
      persistArtifacts();
    }, 1500);
    // Never hold the process open just to flush a convenience list.
    artifactsSaveTimer.unref?.();
  };

  /** @returns {void} */
  function persistArtifacts() {
    try {
      writeJsonAtomic(artifactsFile, artifacts.toJSON());
    } catch (error) {
      ctx.logger?.warn?.(`[remote-pulse] 产物记录写入失败：${error?.message ?? error}`);
    }
  }

  /**
   * Write any pending artifact record now.
   *
   * The debounce is `unref`'d so it never keeps a process alive, which means a
   * short-lived run — exactly what the headless profile does — would otherwise
   * exit with the write still queued and lose it silently. Graceful shutdown
   * therefore flushes synchronously.
   *
   * @returns {boolean} whether a pending write was flushed.
   */
  function flushArtifacts() {
    if (!artifactsSaveTimer) return false;
    clearTimeout(artifactsSaveTimer);
    artifactsSaveTimer = null;
    persistArtifacts();
    return true;
  }

  /** Persisted so a phone session survives a harness restart. */
  const readOrCreateSecret = () => {
    try {
      const raw = readFileSync(secretFile, 'utf8').trim();
      if (raw) return Buffer.from(raw, 'base64url');
    } catch {
      /* first run */
    }
    const secret = randomBytes(32);
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(secretFile, secret.toString('base64url'), { mode: 0o600 });
    } catch (error) {
      ctx.logger?.warn?.(
        `[remote-pulse] 会话密钥写入失败，本次运行后手机需要重新配对：${error?.message ?? error}`,
      );
    }
    return secret;
  };
  const sessionSecret = readOrCreateSecret();

  /**
   * Sign a phone session cookie.
   *
   * The official GUI authenticates with cookies, not headers, so a phone needs
   * one after pairing: its own assets, RPC calls and WebSocket handshake all
   * travel with whatever the browser attaches automatically.
   *
   * @param {string} deviceId - the paired device.
   * @param {string} phoneAuthority - the authority the phone used.
   * @returns {string} the cookie value.
   */
  const mintSession = (deviceId, phoneAuthority) => {
    const payload = Buffer.from(
      JSON.stringify({ d: deviceId, a: phoneAuthority, t: Date.now() }),
      'utf8',
    ).toString('base64url');
    const mac = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  };

  /**
   * Verify a phone session cookie.
   * @param {string} cookie - the presented value.
   * @returns {string | null} the device id, or null when the cookie is not ours.
   */
  const verifySession = cookie => {
    if (typeof cookie !== 'string' || !cookie.includes('.')) return null;
    const [payload, mac] = cookie.split('.');
    if (!payload || !mac) return null;
    const expected = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const deviceId = typeof decoded?.d === 'string' ? decoded.d : null;
      // A correctly signed cookie for a device that has since been revoked must
      // not resurrect access, so the roster stays the authority.
      return deviceId && access.devices.has(deviceId) ? deviceId : null;
    } catch {
      return null;
    }
  };

  const ring = new FrameRing({ capacity: settings.ringCapacity });

  /** Which sessions exist and which are currently working. */
  const sessions = new Map();
  /** Session id → the workspace's own name, for "which project finished". */
  const projects = new Map();
  /** Session id → delegation depth: 0 for the user's own conversation, 1+ for subagents. */
  const depths = new Map();
  /** Tool name by call id, so a result can be attributed to the tool that made it. */
  const toolNames = new Map();

  /**
   * The last path segment of a session's working directory.
   *
   * Every reader is tried because the object reaching this plugin is a live session,
   * and only its header is contractual: `session.header.cwd` is the immutable record
   * the log itself stores, while the flatter spellings are what an agent or an event
   * happens to carry. An empty answer is fine — the frame simply goes out without a
   * project, and the phone falls back to its own wording.
   *
   * @param {...object} candidates - session, agent, event, in that order.
   * @returns {string} the workspace name, or an empty string.
   */
  function projectNameOf(...candidates) {
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const cwd = candidate.header?.cwd ?? candidate.cwd ?? candidate.meta?.cwd ?? candidate.data?.cwd;
      if (typeof cwd !== 'string' || !cwd) continue;
      const trimmed = cwd.replace(/[/\\]+$/, '');
      const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
      if (name) return name;
    }
    return '';
  }

  /**
   * How deep in the delegation tree a session sits.
   *
   * Read from the same immutable header the log stores. An unknown session counts as
   * depth 0 — a missing answer means "probably the user's own conversation", and
   * suppressing a real notification is worse than one extra.
   *
   * @param {...object} candidates - session, agent, event, in that order.
   * @returns {number} 0 for a conversation the user started, 1+ for a subagent.
   */
  function delegationDepthOf(...candidates) {
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const depth = candidate.header?.delegationDepth
        ?? candidate.delegationDepth
        ?? candidate.meta?.delegationDepth
        ?? candidate.data?.delegationDepth;
      if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return depth;
    }
    return 0;
  }

  /**
   * Emit one frame to every transport: the ring, and live SSE streams.
   * @param {object} frame - a distilled frame.
   * @returns {void}
   */
  const publish = frame => {
    const stored = ring.push(frame);
    server.broadcast(stored);
    if (stored.kind === 'decision') server.broadcastDecisions();
  };

  const distiller = new Distiller({
    onFrame: publish,
    // The workspace a session was created in, by its last path segment: "deepseek
    // harness" rather than "D:\deepseek harness". It comes off the session's own
    // header — the same immutable record the log stores — so it costs one property
    // read and never needs the client to ask.
    projectOf: sessionId => projects.get(sessionId) ?? '',
    // And how deep in the delegation tree it sits, for the same reason: a subagent
    // finishing its own turn is not the user's conversation finishing. Five of thirteen
    // sessions on this machine are depth 1, so this is not a hypothetical distinction.
    depthOf: sessionId => depths.get(sessionId) ?? 0,
  });

  /** Live agents by session id, for instruction delivery and cancellation. */
  const agents = new Map();

  /**
   * Captured inside the `inject` gate. Cordis only exposes a service through an
   * injected context, so references have to be kept rather than re-read later —
   * reading `ctx.webServer` outside the gate silently yields nothing, and the
   * inner origin then degrades to a guessed default port.
   *
   * @type {{authenticatedUrl?: (base: string) => string} | null}
   */
  let connectionService = null;
  /** @type {{host?: string, port?: number} | null} */
  let webserverService = null;

  /**
   * The harness's own loopback GUI, as reachable from this process.
   * @returns {{base: string, authority: string}} the inner origin.
   */
  const innerOrigin = () => {
    const host = webserverService?.host === '0.0.0.0' ? '127.0.0.1' : (webserverService?.host ?? '127.0.0.1');
    const port = webserverService?.port ?? 3080;
    return { base: `http://${host}:${port}`, authority: `${host}:${port}` };
  };

  const bootstrap = new CredentialBootstrap({
    // Resolved per use: the harness's real port is only known once `webServer`
    // has been injected, which happens after this holder is constructed.
    authority: () => innerOrigin().authority,
    onWarn: message => ctx.logger?.warn?.(message),
    authenticatedUrl: () => {
      const connection = connectionService;
      if (!connection || typeof connection.authenticatedUrl !== 'function') return null;
      return connection.authenticatedUrl(innerOrigin().base);
    },
  });

  const gateway = new LoopbackGateway({
    bootstrap,
    authority: () => innerOrigin().authority,
    onWarn: message => ctx.logger?.warn?.(message),
  });

  const push = new PushChannel({
    storeFile: join(stateDir, 'push.json'),
    onWarn: message => ctx.logger?.warn?.(message),
  });

  const server = new PulseServer({
    access,
    host: settings.host,
    port: settings.port,
    realm: settings.realm,
    gateway,
    push,
    mintSession,
    verifySession,
    localToken: localOperator.token,
    replay: since => {
      const { frames, gap, lastSeq } = ring.since(since);
      return { frames, gap, lastSeq };
    },
    snapshot: () => ({
      realm: settings.realm,
      host: settings.host,
      port: server.port,
      exposed: server.exposed,
      phones: server.streams.size,
      lastSeq: ring.lastSeq,
      artifacts: artifacts.list(),
      sessions: [...sessions.entries()].map(([sessionId, state]) => ({
        sessionId,
        running: state.running,
        startedAt: state.startedAt,
      })),
    }),
    pendingDecisions: () => queue.list(),
    listArtifacts: () => artifacts.list(),
    readArtifact: path => readArtifact(artifacts, path),
    resolveDecision: (id, answer) => {
      // Capture the descriptor before resolving: a successful resolve removes
      // the entry from the queue.
      const requested = queue.pending.get(id);
      if (!requested) return { ok: false, reason: 'unknown-or-settled' };
      const result = queue.resolve(id, answer);
      if (result.ok) {
        distiller.decisionResolved({
          sessionId: requested.sessionId,
          id,
          outcome: result.answer?.outcome ?? 'answered',
          label: describeAnswer(requested, result.answer ?? {}),
        });
      }
      return result;
    },
    instruct: (text, sessionId) => instruct(text, sessionId),
    onPhoneConnected: () => {
      publish({
        sessionId: 'system',
        kind: 'session',
        text: '手机已连接，决策会优先送给手机',
      });
    },
    onPhoneDisconnected: () => {
      const released = queue.releaseAll();
      publish({
        sessionId: 'system',
        kind: 'session',
        text: released > 0 ? `手机已断开，${released} 项决策交回电脑端` : '手机已断开',
      });
    },
    onDeviceRevoked: deviceId => {
      // Revocation must reach the lock screen: a removed phone that kept its
      // push subscription would go on receiving task content.
      const dropped = push.dropDevice(deviceId);
      if (dropped > 0) {
        ctx.logger?.info?.(`[remote-pulse] 已清理吊销设备的 ${dropped} 条推送订阅`);
      }
    },
  });

  /**
   * Coerce phone input into one of the closed approval outcomes.
   * @param {unknown} value - the raw value.
   * @returns {string} a valid `ApprovalOutcome`.
   */
  function normalizeApprovalOutcome(value) {
    const raw = String(value ?? '').trim();
    if (['allowed-once', 'allow', 'approved', 'approve', 'yes', 'once'].includes(raw)) return 'allowed-once';
    if (['rejected', 'reject', 'deny', 'denied', 'no'].includes(raw)) return 'rejected';
    if (['cancelled', 'cancel'].includes(raw)) return 'cancelled';
    // An unrecognized value must never silently become a grant.
    return 'rejected';
  }

  /**
   * Coerce phone input into the structured `AskUserQuestionAnswer` shape.
   * @param {object} answer - the raw payload.
   * @returns {object} the answer to hand the caller.
   */
  function normalizeQuestionAnswer(answer) {
    const raw = answer ?? {};
    const selected = Array.isArray(raw.selected)
      ? raw.selected.map(String)
      : raw.value !== undefined
        ? [String(raw.value)]
        : [];
    return {
      selected,
      ...(typeof raw.custom === 'string' && raw.custom.trim() ? { custom: raw.custom } : {}),
      ...(raw.id ? { id: String(raw.id) } : {}),
    };
  }

  /**
   * Human label for a resolved decision, shown in the activity feed.
   * @param {object} decision - the queued descriptor.
   * @param {object} answer - the normalized answer.
   * @returns {string} the label.
   */
  function describeAnswer(decision, answer) {
    if (decision.type === 'approval') {
      if (answer.outcome === 'allowed-once') return '允许一次';
      return answer.outcome === 'rejected' ? '拒绝' : '取消';
    }
    const selected = Array.isArray(answer.selected) ? answer.selected : [];
    return selected.length ? selected.join('、') : (answer.custom || '已回复');
  }

  const queue = new DecisionQueue({
    timeoutMs: settings.decisionTimeoutMs,
    armDelayMs: settings.pushArmDelayMs,
    hasLivePhone: () => server.hasLivePhone,
    canPush: () => NOTIFIERS[settings.notify] !== null && Boolean(settings.notifyUrl || settings.notifyKey),
    onPush: decision => {
      // Severity 3 marks a blocking decision, which is the only notification
      // that asks the lock screen to keep it visible until answered.
      pushNotification({ decision, summary: decision.title, severity: 3 });
      distiller.decision(decision);
      server.broadcastDecisions();
    },
    onChange: () => server.broadcastDecisions(),
  });

  /**
   * Deliver one notification through every configured channel.
   *
   * Web Push is the primary path because it is the only one that reaches a
   * phone that is not being looked at; the webhook/Server酱/Bark transports stay
   * as fallbacks for deployments where push cannot be used (a self-signed
   * certificate over a bare IP is not a secure context, so the browser may
   * refuse to register a service worker and push is simply unavailable there).
   *
   * @param {object} payload - `{decision?, summary, severity?}`.
   * @returns {void}
   */
  function pushNotification(payload) {
    const decision = payload?.decision;
    const severity = Number(payload?.severity ?? (decision ? 3 : 1));
    const lockScreen = decision ? lockScreenDecision(decision) : { url: '/pulse', actions: [], data: {} };

    // A decision is the one notification that must interrupt: the agent is
    // blocked and nothing moves until the user answers.
    void push.send({
      title: decision ? '需要你决定' : 'DeepSeek 任务动态',
      body: decision ? decision.title : String(payload?.summary ?? ''),
      // A plain tap lands on that exact decision, not merely on the console.
      url: decision ? lockScreen.url : '/pulse',
      tag: decision ? `decision:${decision.id}` : 'pulse-turn',
      severity,
      actions: lockScreen.actions,
      data: lockScreen.data,
    });

    const build = NOTIFIERS[settings.notify];
    if (!build) return;
    const request = build({ config: settings, ...payload });
    if (!request?.url) return;
    fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(8000),
    }).catch(error => {
      ctx.logger?.warn?.(`[remote-pulse] 推送失败：${error?.message ?? error}`);
    });
  }

  // ---- persistence ---------------------------------------------------------

  /**
   * Load the device roster from disk. A corrupt file is discarded rather than
   * trusted, because the safe failure is "re-pair", not "accept a stale grant".
   * @returns {void}
   */
  function loadDevices() {
    try {
      const raw = readFileSync(stateFile, 'utf8');
      access.load(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger?.warn?.(`[remote-pulse] 设备记录不可用，已忽略：${error?.message ?? error}`);
      }
    }
  }

  /** @returns {void} */
  function saveDevices() {
    try {
      writeJsonAtomic(stateFile, access.toJSON(), { mode: 0o600, pretty: true });
    } catch (error) {
      ctx.logger?.warn?.(`[remote-pulse] 设备记录写入失败：${error?.message ?? error}`);
    }
  }

  // ---- instruction delivery ------------------------------------------------

  /**
   * Deliver a phone instruction to a live agent, waking it if it is idle.
   *
   * This is the fallback path for the Pulse console's composer. The primary way
   * a phone gives the agent work is the full GUI itself, which needs no code
   * here because it is talking to the harness over the proxy.
   *
   * @param {string} text - the instruction text.
   * @param {string} [sessionId] - target session, or the only running one.
   * @returns {Promise<object>} `{ok, sessionId?, reason?}`.
   */
  async function instruct(text, sessionId) {
    let target = sessionId ? agents.get(sessionId) : undefined;
    if (!target) {
      const running = [...agents.entries()].filter(([id]) => sessions.get(id)?.running);
      if (running.length === 1) target = running[0][1];
      else if (!sessionId && agents.size === 1) target = [...agents.values()][0];
      else {
        return {
          ok: false,
          reason: running.length === 0 ? 'no-running-session' : 'ambiguous-session',
          candidates: running.map(([id]) => id),
        };
      }
    }

    // A slash command is a stop request, not prompt text.
    if (text === '/stop') {
      try {
        target.cancel({ kind: 'user' }, { keepInbox: false });
        return { ok: true, action: 'cancelled', sessionId: idOf(target, 'id') };
      } catch (error) {
        return { ok: false, reason: `cancel-failed: ${error?.message ?? error}` };
      }
    }

    const message = await buildUserMessage(text);
    try {
      // Steering is for a working agent; a follow-up turn is for an idle one.
      if (target.status === 'running') target.steer(message);
      else target.followup(message);
      const targetId = idOf(target, 'id');
      publish({
        sessionId: targetId,
        kind: 'session',
        severity: 1,
        text: `收到手机指令：${text}`,
      });
      return { ok: true, sessionId: targetId };
    } catch (error) {
      return { ok: false, reason: `deliver-failed: ${error?.message ?? error}` };
    }
  }

  // ---- event wiring --------------------------------------------------------

  /** Resolves once the injected services are in hand. */
  let servicesReady = Promise.resolve();

  /**
   * Register the event listeners, then wait for the services the proxy needs.
   *
   * The listeners come first, and deliberately outside the inject gate. They
   * read the session stream and drive the phone surface, none of which has
   * anything to do with the web server. Registering them *inside* the gate was a
   * real bug: in a profile with no `webServer` service — headless, for instance —
   * the gate never opens, so the plugin loaded, created its state directory, and
   * then silently observed nothing at all. A remote-control layer that is
   * quietly inert is worse than one that fails loudly.
   *
   * @returns {void}
   */
  function subscribe() {
    registerListeners();

    if (typeof ctx.inject !== 'function') return;

    // Only the loopback proxy needs these: `webServer` for the inner origin,
    // `connection` for the loopback credential. Gating on `inject` is not just a
    // formality — Cordis throws if a service property is read outside its gate,
    // and the injected context is the only sanctioned way to keep hold of one.
    let settle;
    servicesReady = new Promise(resolve => {
      settle = resolve;
    });
    ctx.inject(['webServer', 'connection'], injected => {
      connectionService = injected?.connection ?? null;
      webserverService = injected?.webServer ?? null;
      settle();
    });
  }

  /**
   * Register every event listener.
   * @returns {void}
   */
  function registerListeners() {
    // Agent lifecycle: the only place a session becomes addressable.
    ctx.on('agent/created', ({ agent }) => {
      const sessionId = idOf(agent, 'id');
      if (!sessionId) return;
      agents.set(sessionId, agent);
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { running: agent.status === 'running', startedAt: Date.now() });
      }
    });

    ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = idOf(agent, 'id');
      if (!sessionId) return;
      agents.delete(sessionId);
      sessions.delete(sessionId);
    });

    ctx.on('agent/status', ({ agent, status }) => {
      const sessionId = idOf(agent, 'id');
      if (!sessionId) return;
      const state = sessions.get(sessionId) ?? { startedAt: Date.now() };
      state.running = status === 'running';
      sessions.set(sessionId, state);
      distiller.status({ sessionId, status });
      server.broadcastDecisions();
    });

    // The durable session log is where tool calls and turn boundaries live.
    ctx.on('session/event', (session, event) => {
      const sessionId = idOf(session, 'id') || idOf(event, 'sessionId');
      if (!sessionId || !event?.type) return;
      if (!projects.has(sessionId)) {
        const name = projectNameOf(session, event);
        if (name) projects.set(sessionId, name);
      }
      if (!depths.has(sessionId)) {
        const depth = delegationDepthOf(session, event);
        // Recorded even when it is zero: "this session is the user's own" is information
        // too, and leaving it unknown would make every check repeat the walk.
        depths.set(sessionId, depth);
      }
      switch (event.type) {
        case 'turn/start': {
          const state = sessions.get(sessionId) ?? { startedAt: Date.now() };
          state.running = true;
          sessions.set(sessionId, state);
          distiller.turnStart({ sessionId, turn: event.data?.turn });
          break;
        }
        case 'turn/end': {
          const state = sessions.get(sessionId) ?? { startedAt: Date.now() };
          state.running = false;
          sessions.set(sessionId, state);
          const reason = String(event.data?.reason ?? 'done');
          const outcome = reason === 'cancelled' ? 'cancelled' : reason === 'error' ? 'error' : 'done';
          const frame = distiller.turnEnd({
            sessionId,
            turn: event.data?.turn,
            outcome,
            finalText: state.lastAssistantText,
          });
          state.lastAssistantText = '';
          toolNames.clear();
          if (settings.notifyTurns || frame.severity >= 2) {
            pushNotification({ summary: frame.text });
          }
          server.broadcastDecisions();
          break;
        }
        case 'assistant/message': {
          const text = messageText(event.data?.message);
          if (text) {
            const state = sessions.get(sessionId) ?? { startedAt: Date.now() };
            state.lastAssistantText = text.slice(0, 400);
            sessions.set(sessionId, state);
          }
          break;
        }
        case 'tool/call': {
          const callId = String(event.data?.callId ?? '');
          if (callId) toolNames.set(callId, String(event.data?.name ?? 'tool'));
          const args = parseArgs(event.data?.arguments);
          distiller.toolCall({
            sessionId,
            toolName: event.data?.name,
            args,
          });
          // The files the agent produced are already flowing past here, so the
          // artifacts view costs no new coupling to the harness. See
          // lib/artifacts.js for why the recorded path is also the allowlist
          // that the content route serves from.
          if (artifacts.observeToolCall({ sessionId, toolName: event.data?.name, args }).length > 0) {
            saveArtifacts();
            server.broadcastArtifacts();
          }
          break;
        }
        case 'tool/result': {
          const callId = String(event.data?.message?.content?.[0]?.toolCallId ?? '');
          const toolName = toolNames.get(callId) ?? 'tool';
          toolNames.delete(callId);
          const isError = event.data?.message?.content?.[0]?.isError === true || Boolean(event.data?.error);
          distiller.toolResult({
            sessionId,
            toolName,
            ok: !isError,
            error: event.data?.error?.name ?? event.data?.error?.code ?? '工具返回错误',
          });
          break;
        }
        default:
          break;
      }
    });

    // Out-of-band failures, so a stuck session is visible even mid-turn.
    ctx.on('agent/error', ({ agent, error }) => {
      const sessionId = idOf(agent, 'id');
      if (!sessionId) return;
      distiller.error({ sessionId, error });
      if (settings.notifyFailures) pushNotification({ summary: `出错：${error?.message ?? error}` });
    });

    // ---- the answerer waterfalls ------------------------------------------
    //
    // These exist for the case the full GUI cannot serve: you are not looking
    // at the screen. When a phone is live, a blocking request is pushed to it
    // and answered with one tap; when no phone is live, `next()` runs and the
    // desktop flow is exactly as it was.

    ctx.on('approval/request', async (request, next) => {
      // No phone, no claim: the desktop flow must be untouched.
      if (!server.hasLivePhone) return next();

      const sessionId = idOf(request?.agent, 'id') || 'unknown';
      // An asker that supplied a reason is telling the user *why*; without one
      // the request was implicit in the tool call itself.
      const title = request?.reason
        ? `${request.toolName} 需要授权`
        : `允许执行 ${request.toolName}？`;
      const result = await queue.ask({
        type: 'approval',
        sessionId,
        title,
        detail: request?.reason,
        options: ['allowed-once', 'rejected'],
        signal: request?.signal,
        armed: true,
        validator: answer => ({
          ok: true,
          answer: { outcome: normalizeApprovalOutcome(answer?.outcome ?? answer?.value) },
        }),
      });

      if (result.state === DECISION_STATE.answered) return result.answer.outcome;
      // Deferred: hand the request to whatever answerer comes next, so the
      // desktop still gets its card.
      if (result.state === DECISION_STATE.cancelled) return 'cancelled';
      return next();
    });

    ctx.on('user-questions/request', async (request, next) => {
      if (!server.hasLivePhone) return next();

      const sessionId = idOf(request?.agent, 'id') || 'unknown';
      const questions = Array.isArray(request?.questions) ? request.questions : [];
      const first = questions[0] ?? {};
      const result = await queue.ask({
        type: 'question',
        sessionId,
        title: first.question ?? '需要你回答',
        detail:
          first.detail ?? (questions.length > 1 ? `另有 ${questions.length - 1} 个问题` : undefined),
        options: (first.options ?? []).map(option => ({ value: option.label, label: option.label })),
        multiSelect: Boolean(first.multiSelect),
        signal: request?.signal,
        armed: true,
        validator: answer => ({ ok: true, answer: normalizeQuestionAnswer(answer) }),
      });

      if (result.state !== DECISION_STATE.answered) {
        return result.state === DECISION_STATE.cancelled ? { answers: [] } : next();
      }
      // The tool contract wants one answer per question id, in request order.
      return {
        answers: questions.map(question => {
          const selected = result.answer.selected ?? [];
          return {
            id: question.id,
            selected: question.id === first.id ? selected : [],
            ...(question.id === first.id && result.answer.custom ? { custom: result.answer.custom } : {}),
          };
        }),
      };
    });

    // ---- desktop page hint and remote host grant ---------------------------

    ctx.on('webserver/index-inject', table => {
      if (!Array.isArray(table)) return;
      table.push(
        remoteShellInjection({
          realm: settings.realm,
          host: settings.host,
          port: server.port,
          exposed: server.exposed,
        }),
      );
      // The phone runs the official client, so the only honest way to adapt it
      // for a narrow screen is a stylesheet. It rides the same supported row
      // mechanism, and every rule sits inside a media query, so a desktop window
      // is unaffected. See lib/mobile.js for why it goes no further than this.
      const mobileCss = mobileStylesheet();
      if (isEmbeddable(mobileCss)) table.push({ kind: 'style', text: mobileCss });
      else ctx.logger?.warn?.('[remote-pulse] 窄屏样式表包含 </style，已跳过注入');

      // The mobile shell: our own chrome for the phone, plus the rules that turn
      // the official sidebar into a drawer. It lives outside the client's React
      // root so a re-render cannot remove it, and it fails visibly rather than
      // quietly when an official selector stops matching. See lib/mobile-shell.js.
      const shellCss = mobileShellStyles();
      if (isEmbeddable(shellCss)) table.push({ kind: 'style', text: shellCss });
      else ctx.logger?.warn?.('[remote-pulse] 移动外壳样式包含 </style，已跳过注入');

      const shellScript = mobileShellScript();
      if (isEmbeddableScript(shellScript)) table.push({ kind: 'script', placement: 'body', text: shellScript });
      else ctx.logger?.warn?.('[remote-pulse] 移动外壳脚本包含 </script，已跳过注入');

      // A download-or-forward control on the official deliverables cards. Same
      // reasoning as the row above: the user is looking at the file there, and the
      // desktop needs it as much as the phone does.
      const deliverableActions = deliverableActionsScript();
      if (isEmbeddableScript(deliverableActions)) {
        table.push({ kind: 'script', placement: 'body', text: deliverableActions });
      } else {
        ctx.logger?.warn?.('[remote-pulse] 交付卡片脚本包含 </script，已跳过注入');
      }

      // ... and in the header of a file the user has opened. Tapping a file in the tree
      // (or its path in the transcript) opens the preview, and that header is where one
      // unmistakable download/forward button belongs — rather than a control on every
      // row of the tree, which is what the sidebar carried before and what the user
      // asked to have moved.
      const previewActions = previewActionsScript();
      if (isEmbeddableScript(previewActions)) {
        table.push({ kind: 'script', placement: 'body', text: previewActions });
      } else {
        ctx.logger?.warn?.('[remote-pulse] 预览头部脚本包含 </script，已跳过注入');
      }

      // ... and beside every underlined file path in the transcript, which is where
      // the user reads the file's name in the first place.
      const fileLinkActions = fileLinkActionsScript();
      if (isEmbeddableScript(fileLinkActions)) {
        table.push({ kind: 'script', placement: 'body', text: fileLinkActions });
      } else {
        ctx.logger?.warn?.('[remote-pulse] 会话文件链接脚本包含 </script，已跳过注入');
      }
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  let started = false;

  /** @returns {Promise<void>} resolves once the listener is up. */
  async function start() {
    if (started) return;
    started = true;
    loadDevices();
    subscribe();
    // Push has no hard dependency on the harness services, so it can come up
    // before them; a failure here only disables the lock-screen channel.
    await push.init();
    // The proxy needs the injected services, so briefly wait for them rather
    // than racing their activation. The wait is bounded because in a profile
    // that has no `webServer` service the gate never opens, and waiting forever
    // would turn "the proxy is unavailable" into "Pulse never comes up" — a hang
    // with no explanation, where the phone surface would in fact still work.
    if (!(await settlesWithin(servicesReady, settings.serviceWaitMs))) {
      ctx.logger?.warn?.(
        `[remote-pulse] ${settings.serviceWaitMs / 1000} 秒内没有等到 webServer/connection 服务：` +
          '官方界面代理不可用（/ 会返回 503），但 Pulse 自身的控制台与接口正常。' +
          '这通常意味着当前 profile 不是 web/desktop。',
      );
    }
    try {
      const bound = await server.listen();
      ctx.logger?.info?.(
        `[remote-pulse] ${settings.realm} 已监听 http://${bound.host}:${bound.port}` +
          (server.exposed
            ? '（手机可连；需要配对）'
            : '（仅本机；把 host 设为 0.0.0.0 才能让手机连上）'),
      );
      publish({
        sessionId: 'system',
        kind: 'session',
        text: `Pulse 已就绪（${server.exposed ? `http://${localAddress()}:${bound.port}` : '本机'}）`,
      });
      if (server.exposed) {
        // Worth saying out loud: the management subtree is not protected by the
        // peer address, because a tunnel makes remote callers look local.
        ctx.logger?.info?.(
          `[remote-pulse] 本机管理令牌：${localOperator.path}` +
            (localOperator.persisted ? '' : '（未能写盘，重启后会变化）') +
            '；配对码只能由本机工具读取该令牌后申请',
        );
      }

      // Mint the loopback credential at startup rather than discovering a
      // problem on the phone's first request. A wrong inner port is the failure
      // this catches, and it would otherwise surface as an opaque 503.
      void (async () => {
        const minted = await bootstrap.ensure();
        const inner = innerOrigin();
        ctx.logger?.[minted ? 'info' : 'warn']?.(
          `[remote-pulse] 官方界面代理${minted ? '就绪' : '不可用'}（内环回 ${inner.authority}）` +
            (minted ? '' : `：${bootstrap.status().lastError ?? '未知原因'}`),
        );
      })();
    } catch (error) {
      ctx.logger?.warn?.(`[remote-pulse] 监听失败：${error?.message ?? error}`);
    }

    // Persist the roster whenever it changes; pairing is rare, so a
    // change-driven write is cheaper and more reliable than a timer.
    const persist = setInterval(saveDevices, 2000);
    persist.unref?.();
  }

  /**
   * Best-effort LAN address for the link the user types on their phone.
   * @returns {string} an address, or a loopback placeholder.
   */
  function localAddress() {
    try {
      for (const list of Object.values(networkInterfaces())) {
        for (const net of list ?? []) {
          if (net.family === 'IPv4' && !net.internal) return net.address;
        }
      }
    } catch {
      /* fall through */
    }
    return '127.0.0.1';
  }

  /** @returns {Promise<void>} resolves once everything is torn down. */
  async function stop() {
    if (!started) return;
    started = false;
    queue.releaseAll();
    saveDevices();
    await server.close();
  }

  // `ctx.effect()` ties the plugin's lifetime to the fiber's, so a profile
  // Startup is asynchronous (services must be injected and the push transport
  // imported before the listener binds), so the plugin publishes a promise that
  // settles once it is genuinely ready. Without it, a caller can only poll --
  // and a test that asserts too early reports a race as a failure.
  let signalReady;
  let signalReadyFailed;
  const ready = new Promise((resolve, reject) => {
    signalReady = resolve;
    signalReadyFailed = reject;
  });
  // A rejection nobody awaits would become an unhandled rejection and take the
  // process down, so the promise carries a no-op handler and consumers opt in.
  ready.catch(() => {});

  // reload or process shutdown closes the listener rather than leaking it.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      start().then(signalReady, signalReadyFailed);
      return () => {
        // Flush before stopping: a run that exits promptly after its last tool
        // call must still leave its artifact record behind.
        flushArtifacts();
        stop();
      };
    });
  } else {
    start().then(signalReady, signalReadyFailed);
  }

  // Expose the surface for tests and for other plugins that want to drive it.
  ctx.provide?.('remotePulse', {
    server,
    queue,
    ring,
    access,
    artifacts,
    distiller,
    gateway,
    bootstrap,
    push,
    /**
     * The local-operator token, for in-process callers (tests, other plugins).
     * It is intentionally not reachable over HTTP: only a process that can read
     * the state directory may hold it.
     */
    localOperator: { token: localOperator.token, path: localOperator.path, persisted: localOperator.persisted },
    /** Resolves once the listener is bound (or rejects if startup failed). */
    ready,
    openPairing: () => access.openPairing(),
    /** Write any pending artifact record now, for shutdown paths outside ctx.effect. */
    flushArtifacts,
    status: () => ({
      listening: server.server !== null,
      host: settings.host,
      port: server.port,
      exposed: server.exposed,
      phones: server.streams.size,
      devices: access.roster().length,
      pendingDecisions: queue.size,
      artifacts: artifacts.size,
      proxy: bootstrap.status(),
    }),
  });
}

/**
 * Build the index-injection row the phone's harness shell needs.
 *
 * Two jobs, and the second is the important one:
 *
 * 1. Advertise where the Pulse phone surface lives. No credential is in here.
 * 2. **Grant remote host mode.** The harness client decides `isLoopback` from
 *    `transport.ownsHost === true || isLoopbackHostname(location.hostname)`
 *    (dsh-client-connection). A phone's hostname is never loopback, so without
 *    this grant every settings-scoped RPC degrades to `memory` and the settings
 *    surface — models, plugin config — goes blank with "settings are
 *    unavailable in this browser".
 *
 * The grant is safe here because it rides the proxied shell: this row is only
 * ever served for an index request that arrived through the pairing gate, so an
 * unpaired caller never receives it. The loopback credential that makes the
 * harness trust these requests stays in the proxy process and is never handed
 * to the device.
 *
 * @param {object} options - row options.
 * @param {string} options.realm - display name.
 * @param {string} options.host - the bound host.
 * @param {number} options.port - the bound port.
 * @param {boolean} options.exposed - whether the listener is network-reachable.
 * @returns {object} an `IndexInjection` row.
 */
function remoteShellInjection({ realm, host, port, exposed }) {
  // Escape anything that could close the element early.
  const safeRealm = String(realm).replace(
    /[<>&"]/g,
    char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char],
  );
  const payload = JSON.stringify({ realm, host, port, exposed });
  return {
    kind: 'script',
    placement: 'body',
    text:
      `globalThis.__DSH_REMOTE_PULSE__ = Object.assign(${payload}, {` +
      ` base: 'http://' + location.hostname + ':${Number(port)}' });` +
      `globalThis.__DSH_REMOTE_PULSE_LABEL__ = ${JSON.stringify(safeRealm)};` +
      // Set before any module script runs, so the connection client reads it.
      // Only `ownsHost` is claimed; `fetch`/`openStream` stay undefined so the
      // client keeps its own same-origin carriers, which the proxy serves.
      `globalThis.__DSH_TRANSPORT__ = Object.assign(globalThis.__DSH_TRANSPORT__ || {}, { ownsHost: true });`,
  };
}

export default { apply };
