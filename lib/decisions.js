/**
 * The decisions queue — the half of the product that earns its keep when the
 * user is not at the keyboard.
 *
 * DeepSeek Harness asks a human for two things: permission to run a risky tool
 * call, and an answer to a structured question. Both travel a Cordis answerer
 * waterfall where any listener may claim the request by returning a value or
 * delegate by calling `next()`.
 *
 * This queue claims those requests *only when a phone can actually answer*:
 *
 * - no paired phone, or no live phone connection → delegate immediately, so a
 *   desktop-only user never pays for a feature they are not using;
 * - a live phone connection → hold the request, push it, and wait;
 * - the wait expires or the phone disconnects → delegate, so the desktop card
 *   still appears and the agent is never left blocked.
 *
 * That last rule is the whole design. A remote-control layer that can strand a
 * running agent waiting for a phone that went into a tunnel is worse than no
 * remote-control layer at all, so every path here ends in an answer.
 *
 * @module pulse-remote/decisions
 */

/** Terminal states of a queued decision. */
export const DECISION_STATE = Object.freeze({
  /** Waiting for a human, on the phone or afterwards on the desktop. */
  pending: 'pending',
  /** The phone answered. */
  answered: 'answered',
  /** The window closed with no phone answer; the desktop chain owns it now. */
  deferred: 'deferred',
  /** The caller's signal aborted. */
  cancelled: 'cancelled',
});

let counter = 0;

/**
 * Mint a decision id that is unique within the process and sortable by time.
 * @param {() => number} now - clock.
 * @returns {string} the id.
 */
function mintId(now) {
  counter += 1;
  return `d${now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Holds pending decisions and resolves them from phone input.
 */
export class DecisionQueue {
  /**
   * @param {object} [options] - tuning.
   * @param {() => number} [options.now] - clock, injectable for tests.
   * @param {number} [options.timeoutMs] - how long to hold a request while a phone is live.
   * @param {number} [options.armDelayMs] - extra hold granted only when a push channel exists.
   * @param {() => boolean} [options.hasLivePhone] - whether a phone can answer right now.
   * @param {(decision: object) => void} [options.onPush] - push hook for new decisions.
   * @param {(event: object) => void} [options.onChange] - observed-state hook.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.armDelayMs = options.armDelayMs ?? 20_000;
    this.hasLivePhone = options.hasLivePhone ?? (() => false);
    this.canPush = options.canPush ?? (() => false);
    this.onPush = options.onPush ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
    /** @type {Map<string, object>} pending entries by id. */
    this.pending = new Map();
  }

  /** @returns {number} pending count. */
  get size() {
    return this.pending.size;
  }

  /**
   * List pending decisions, oldest first, without their internal resolvers.
   * @returns {Array<object>} public descriptors.
   */
  list() {
    return [...this.pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(entry => this.#public(entry));
  }

  /**
   * Project an entry to its wire shape.
   * @param {object} entry - internal entry.
   * @returns {object} the public descriptor.
   */
  #public(entry) {
    return {
      id: entry.id,
      type: entry.type,
      sessionId: entry.sessionId,
      title: entry.title,
      detail: entry.detail,
      options: entry.options,
      multiSelect: entry.multiSelect,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      state: entry.state,
    };
  }

  /**
   * Ask the phone a question and wait for the answer or the fallback.
   *
   * @param {object} request - the decision to put to the user.
   * @param {string} request.type - `approval` or `question`.
   * @param {string} request.sessionId - owning session.
   * @param {string} request.title - the one line the phone shows.
   * @param {string} [request.detail] - supporting detail.
   * @param {Array<object>} [request.options] - selectable options.
   * @param {boolean} [request.multiSelect] - whether several options may be chosen.
   * @param {AbortSignal} [request.signal] - the caller's cancellation lifetime.
   * @param {boolean} [request.armed] - whether holding is worth it at all.
   * @param {(answer: object) => ({ok: boolean, reason?: string, answer?: object})} [request.validator] -
   *   normalizes or rejects the answer; runs at resolve time.
   * @returns {Promise<{state: string, answer: object|null, decision: object}>} the
   *   queue outcome; `answer` is non-null only for `answered`.
   */
  async ask(request) {
    const armed = request.armed ?? this.hasLivePhone();
    const id = mintId(this.now);
    const createdAt = this.now();
    const holdMs = this.timeoutMs + (this.canPush() && armed ? this.armDelayMs : 0);

    const entry = {
      id,
      type: request.type,
      sessionId: String(request.sessionId ?? 'unknown'),
      title: request.title,
      detail: request.detail,
      options: request.options ?? [],
      multiSelect: Boolean(request.multiSelect),
      createdAt,
      expiresAt: createdAt + holdMs,
      state: DECISION_STATE.pending,
      resolve: null,
      validator: request.validator,
    };

    if (!armed) {
      entry.state = DECISION_STATE.deferred;
      return { state: entry.state, answer: null, decision: this.#public(entry) };
    }

    this.pending.set(id, entry);
    this.onChange({ type: 'queued', decision: this.#public(entry) });
    this.onPush(this.#public(entry));

    const queued = this.#public(entry);
    const answer = await new Promise(resolve => {
      let settled = false;
      /** Assigned before any path can call `finish`. */
      let timer = null;
      let onAbort = null;
      /** @param {{state: string, answer: object|null}} result - the outcome. */
      const finish = result => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (onAbort) request.signal?.removeEventListener?.('abort', onAbort);
        this.pending.delete(id);
        entry.state = result.state;
        resolve(result);
      };
      entry.resolve = (value, terminal) =>
        finish({ state: terminal ?? DECISION_STATE.answered, answer: value });
      timer = setTimeout(() => finish({ state: DECISION_STATE.deferred, answer: null }), holdMs);
      // Node keeps the process alive for a pending timer; this timer must never
      // be the reason a shutting-down harness waits.
      timer.unref?.();
      onAbort = () => finish({ state: DECISION_STATE.cancelled, answer: null });
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    this.onChange({ type: answer.state, decision: { ...queued, state: answer.state } });
    return { state: answer.state, answer: answer.answer, decision: { ...queued, state: answer.state } };
  }

  /**
   * Resolve a pending decision from phone input.
   *
   * The validator runs *here* rather than at the HTTP boundary on purpose: the
   * queue is the single choke point every answer must pass, so a caller that
   * bypasses HTTP cannot smuggle in an arbitrary payload. A validator that
   * returns an error rejects the answer and leaves the decision pending.
   *
   * @param {string} id - decision id.
   * @param {object} answer - the payload the caller's `ask()` will receive.
   * @returns {{ok: boolean, reason?: string, decision?: object, answer?: object}} the
   *   result; `answer` is the normalized payload actually handed to `ask()`.
   */
  resolve(id, answer) {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, reason: 'unknown-or-settled' };
    if (entry.state !== DECISION_STATE.pending) return { ok: false, reason: entry.state };

    if (typeof entry.validator === 'function') {
      const verdict = entry.validator(answer);
      if (verdict && verdict.ok === false) {
        return { ok: false, reason: verdict.reason ?? 'invalid-answer' };
      }
      if (verdict && verdict.ok === true && verdict.answer !== undefined) answer = verdict.answer;
    }

    const decision = this.#public(entry);
    entry.resolve?.(answer);
    return { ok: true, decision, answer };
  }

  /**
   * Release every pending decision back to the desktop chain, e.g. because the
   * last phone went away.
   * @returns {number} how many were released.
   */
  releaseAll() {
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      const entry = this.pending.get(id);
      // Same terminal path the timeout takes, so there is exactly one fallback
      // implementation and the reported state stays truthful.
      entry.resolve?.(null, DECISION_STATE.deferred);
    }
    return ids.length;
  }
}

/**
 * Describe a decision for the lock screen, including one-tap answers.
 *
 * ## What gets an action button, and what does not
 *
 * A notification action answers the decision without opening the app, so it is
 * only offered where the meaning is unambiguous and complete from the button
 * label alone:
 *
 * - an **approval** always offers exactly its two outcomes;
 * - a **single-select question with at most two options** offers those options,
 *   because the label *is* the answer;
 * - everything else — multi-select, three or more options, free text — gets no
 *   actions at all and only a deep link. A one-tap button that cannot express
 *   the real answer is worse than no button, because it would let the user
 *   believe they answered when they did not.
 *
 * The returned `data` is what the push worker needs to submit the answer. It
 * carries a decision id and answer tokens and nothing else: no credential, and
 * nothing that is meaningful without the session cookie the worker's own
 * same-origin request carries.
 *
 * @param {{id: string, type: string, title?: string, options?: unknown, multiSelect?: boolean}} decision - the decision.
 * @returns {{url: string, actions: Array<{action: string, title: string}>, data: object}} the lock-screen description.
 */
export function lockScreenDecision(decision) {
  const id = String(decision?.id ?? '');
  const title = String(decision?.title ?? '').slice(0, 80);
  const url = id ? `/pulse#decision-${encodeURIComponent(id)}` : '/pulse';
  /** @type {Record<string, object>} action token → the answer it submits. */
  const answers = {};
  /** @type {Array<{action: string, title: string}>} */
  const actions = [];

  /**
   * Register one action.
   * @param {string} token - the action token the platform reports back.
   * @param {string} label - the button label.
   * @param {object} answer - the answer payload for this token.
   * @returns {void}
   */
  const add = (token, label, answer) => {
    actions.push({ action: token, title: label });
    answers[token] = answer;
  };

  if (decision?.type === 'approval') {
    add('allow-once', '允许一次', { outcome: 'allowed-once' });
    add('reject', '拒绝', { outcome: 'rejected' });
  } else if (!decision?.multiSelect) {
    const options = Array.isArray(decision?.options) ? decision.options : [];
    if (options.length > 0 && options.length <= 2) {
      options.forEach((option, index) => {
        const value = typeof option === 'string' ? option : String(option?.value ?? '');
        const label = typeof option === 'string' ? option : String(option?.label ?? option?.value ?? '');
        if (!value || !label) return;
        // The token must be a platform-safe literal, so it is positional rather
        // than derived from the option value, which is arbitrary text.
        add(`option-${index}`, label, { selected: [value] });
      });
    }
  }

  return {
    url,
    actions,
    data: { decision: { id, title, answers } },
  };
}

export default DecisionQueue;
