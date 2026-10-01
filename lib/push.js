/**
 * Web Push — the channel that reaches a phone that is not looking at it.
 *
 * Everything else in this plugin assumes the user is holding the phone. A
 * completion notice is the opposite problem: the task finished while the phone
 * was in a pocket, and the whole point is the lock screen. Web Push is the only
 * standard browser mechanism that does that without a third-party relay account,
 * so it is the primary channel; the webhook/Server酱/Bark transports stay as
 * fallbacks for deployments where push cannot be used at all.
 *
 * Two constraints shape this module:
 *
 * - **Service workers require a secure context.** A self-signed certificate over
 *   a bare IP is not one on most mobile browsers, so push registration can fail
 *   for reasons this plugin cannot fix. Every failure here is therefore
 *   non-fatal and reported as a status string: the phone keeps working, it just
 *   falls back to the other channels.
 * - **A subscription is a capability.** Anyone holding it can make the phone
 *   buzz, so subscriptions are stored per device and dropped the moment the push
 *   service reports them gone (410/404), which is also the only reliable way to
 *   notice a browser that uninstalled the app.
 *
 * @module dsh-remote-pulse/push
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Outcomes of a send attempt, so callers can react without parsing errors. */
export const PUSH_RESULT = Object.freeze({
  sent: 'sent',
  /** No subscriptions at all — not an error, just nothing to do. */
  empty: 'empty',
  /** The push service says this subscription is finished; it was removed. */
  gone: 'gone',
  failed: 'failed',
});

/**
 * Wire shape of a browser PushSubscription, validated at the boundary because
 * it arrives from a device.
 * @param {unknown} value - the posted subscription.
 * @returns {{endpoint: string, keys: {p256dh: string, auth: string}} | null} the
 *   validated subscription, or null when it is not usable.
 */
export function normalizeSubscription(value) {
  if (!value || typeof value !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : '';
  if (!/^https:\/\//.test(endpoint)) return null;
  const keys = record.keys;
  if (!keys || typeof keys !== 'object') return null;
  const keyRecord = /** @type {Record<string, unknown>} */ (keys);
  const p256dh = typeof keyRecord.p256dh === 'string' ? keyRecord.p256dh.trim() : '';
  const auth = typeof keyRecord.auth === 'string' ? keyRecord.auth.trim() : '';
  if (!p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * A stable key for one subscription. The endpoint is the identity; the keys can
 * rotate for the same endpoint when a browser refreshes its subscription.
 * @param {{endpoint: string}} subscription - the subscription.
 * @returns {string} the key.
 */
export function subscriptionKey(subscription) {
  return String(subscription.endpoint);
}

/**
 * Holds VAPID identity and per-device subscriptions, and sends notifications.
 */
export class PushChannel {
  /**
   * @param {object} options - wiring.
   * @param {string} options.storeFile - where subscriptions and the VAPID key live.
   * @param {(message: string) => void} [options.onWarn] - diagnostics sink.
   * @param {object} [options.webpush] - injectable `web-push` implementation.
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor(options) {
    this.storeFile = options.storeFile;
    this.onWarn = options.onWarn ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    /** @type {any} injected or lazily imported */
    this.webpush = options.webpush ?? null;
    /** @type {{publicKey: string, privateKey: string} | null} */
    this.keys = null;
    /** @type {Map<string, {subscription: object, deviceId: string|null, label: string, createdAt: number}>} */
    this.subscriptions = new Map();
    /** Last send outcome, surfaced in status output. */
    this.lastResult = null;
    this.sent = 0;
    this.removed = 0;
    this.ready = false;
  }

  /**
   * Load persisted state and prepare VAPID keys.
   *
   * A missing or unreadable store is not fatal: push degrades to unavailable and
   * the other notification channels carry on.
   *
   * @returns {Promise<boolean>} whether push is usable.
   */
  async init() {
    try {
      this.webpush = this.webpush ?? (await import('web-push')).default;
    } catch (error) {
      this.onWarn(`[remote-pulse] Web Push 不可用（依赖缺失）：${error?.message ?? error}`);
      return false;
    }

    let store = null;
    try {
      store = JSON.parse(readFileSync(this.storeFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.onWarn(`[remote-pulse] 推送订阅记录不可用，已重建：${error?.message ?? error}`);
      }
    }

    // Reuse persisted keys: rotating them silently invalidates every existing
    // subscription, which would look like push randomly breaking.
    if (store?.keys?.publicKey && store?.keys?.privateKey) {
      this.keys = { publicKey: store.keys.publicKey, privateKey: store.keys.privateKey };
    } else {
      this.keys = this.webpush.generateVAPIDKeys();
    }

    for (const row of Array.isArray(store?.subscriptions) ? store.subscriptions : []) {
      const subscription = normalizeSubscription(row?.subscription);
      if (!subscription) continue;
      this.subscriptions.set(subscriptionKey(subscription), {
        subscription,
        deviceId: typeof row?.deviceId === 'string' ? row.deviceId : null,
        label: typeof row?.label === 'string' ? row.label : '手机',
        createdAt: Number(row?.createdAt) || this.now(),
      });
    }

    try {
      this.webpush.setVapidDetails('mailto:pulse@localhost', this.keys.publicKey, this.keys.privateKey);
      this.ready = true;
    } catch (error) {
      this.onWarn(`[remote-pulse] VAPID 初始化失败：${error?.message ?? error}`);
      this.ready = false;
    }

    this.save();
    return this.ready;
  }

  /** @returns {string | null} the public key the browser needs, if ready. */
  get publicKey() {
    return this.ready ? this.keys?.publicKey ?? null : null;
  }

  /**
   * Persist subscriptions and the VAPID identity.
   * @returns {void}
   */
  save() {
    try {
      mkdirSync(dirname(this.storeFile), { recursive: true });
      const temporary = `${this.storeFile}.tmp`;
      const document = {
        version: 1,
        keys: this.keys,
        subscriptions: [...this.subscriptions.values()].map(row => ({
          subscription: row.subscription,
          deviceId: row.deviceId,
          label: row.label,
          createdAt: row.createdAt,
        })),
      };
      // Atomic replace for the same reason as the device roster: a truncated
      // file would silently drop every phone's notification registration.
      writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
      renameSync(temporary, this.storeFile);
    } catch (error) {
      this.onWarn(`[remote-pulse] 推送订阅写入失败：${error?.message ?? error}`);
    }
  }

  /**
   * Register or refresh a device's subscription.
   * @param {object} request - `{subscription, deviceId, label}`.
   * @returns {{ok: boolean, reason?: string, count: number}} the result.
   */
  subscribe(request) {
    const subscription = normalizeSubscription(request?.subscription);
    if (!subscription) return { ok: false, reason: 'invalid-subscription', count: this.subscriptions.size };
    const key = subscriptionKey(subscription);
    const existing = this.subscriptions.get(key);
    this.subscriptions.set(key, {
      subscription,
      deviceId: request?.deviceId ? String(request.deviceId) : existing?.deviceId ?? null,
      label: String(request?.label ?? existing?.label ?? '手机').slice(0, 60),
      createdAt: existing?.createdAt ?? this.now(),
    });
    this.save();
    return { ok: true, count: this.subscriptions.size };
  }

  /**
   * Drop one subscription by endpoint.
   * @param {string} endpoint - the subscription endpoint.
   * @returns {boolean} whether something was removed.
   */
  unsubscribe(endpoint) {
    const removed = this.subscriptions.delete(String(endpoint ?? ''));
    if (removed) this.save();
    return removed;
  }

  /**
   * Drop every subscription belonging to a revoked device.
   *
   * Revocation has to reach the lock screen too: leaving subscriptions behind
   * would let a removed phone keep receiving task content.
   *
   * @param {string} deviceId - the device to purge.
   * @returns {number} how many subscriptions were removed.
   */
  dropDevice(deviceId) {
    let removed = 0;
    for (const [key, row] of this.subscriptions) {
      if (row.deviceId === deviceId) {
        this.subscriptions.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  /** @returns {Array<object>} a redacted roster for status output. */
  roster() {
    return [...this.subscriptions.values()].map(row => ({
      deviceId: row.deviceId,
      label: row.label,
      createdAt: row.createdAt,
      // The endpoint is a capability, so only its host is ever reported.
      host: (() => {
        try {
          return new URL(row.subscription.endpoint).host;
        } catch {
          return 'unknown';
        }
      })(),
    }));
  }

  /**
   * Send one notification to every registered device.
   *
   * @param {object} payload - `{title, body, url, tag, severity, actions, data}`.
   * @returns {Promise<{result: string, sent: number, removed: number}>} the outcome.
   */
  async send(payload) {
    if (!this.ready || this.subscriptions.size === 0) {
      this.lastResult = PUSH_RESULT.empty;
      return { result: PUSH_RESULT.empty, sent: 0, removed: 0 };
    }

    const body = JSON.stringify({
      title: String(payload?.title ?? 'DeepSeek').slice(0, 120),
      body: String(payload?.body ?? '').slice(0, 400),
      url: typeof payload?.url === 'string' ? payload.url : '/pulse',
      // A stable tag replaces an earlier notice instead of stacking duplicates.
      tag: typeof payload?.tag === 'string' ? payload.tag : 'pulse',
      severity: Number(payload?.severity ?? 1),
      // Answering a blocked agent from the lock screen. `actions` are the
      // buttons; `data` carries what the worker needs to submit the answer.
      ...normalizeActions(payload?.actions),
      ...(payload?.data && typeof payload.data === 'object' ? { data: payload.data } : {}),
    });

    let sent = 0;
    let removed = 0;
    for (const [key, row] of [...this.subscriptions]) {
      try {
        await this.webpush.sendNotification(row.subscription, body, { TTL: 3600 });
        sent += 1;
      } catch (error) {
        const status = error?.statusCode;
        // 404/410 mean the browser dropped the subscription; anything else is
        // transient and worth keeping the subscription for.
        if (status === 404 || status === 410) {
          this.subscriptions.delete(key);
          removed += 1;
        } else {
          this.onWarn(`[remote-pulse] 推送发送失败（${status ?? 'network'}）：${error?.message ?? error}`);
        }
      }
    }
    if (removed > 0) this.save();

    this.sent += sent;
    this.removed += removed;
    this.lastResult = sent > 0 ? PUSH_RESULT.sent : removed > 0 ? PUSH_RESULT.gone : PUSH_RESULT.failed;
    return { result: this.lastResult, sent, removed };
  }

  /** @returns {object} status for diagnostics. */
  status() {
    return {
      ready: this.ready,
      subscriptions: this.subscriptions.size,
      sent: this.sent,
      removed: this.removed,
      lastResult: this.lastResult,
    };
  }
}

/**
 * Bound on notification action buttons.
 *
 * The Notification API reliably renders at most two actions; the ones beyond
 * that are dropped by the platform without an error, so the payload is bounded
 * here rather than left to silently disappear.
 */
export const MAX_PUSH_ACTIONS = 2;

/**
 * Validate and bound a notification action list.
 *
 * An action's `action` string is what `notificationclick` reports back and is
 * then matched against a known decision answer, so it is constrained to a token
 * rather than free text.
 *
 * @param {unknown} actions - candidate actions.
 * @returns {{actions?: Array<{action: string, title: string}>}} a spreadable fragment.
 */
export function normalizeActions(actions) {
  if (!Array.isArray(actions)) return {};
  const cleaned = [];
  for (const candidate of actions) {
    if (!candidate || typeof candidate !== 'object') continue;
    const action = String(candidate.action ?? '').trim();
    const title = String(candidate.title ?? '').trim();
    if (!/^[a-z0-9-]{1,24}$/.test(action) || !title) continue;
    cleaned.push({ action, title: title.slice(0, 24) });
    if (cleaned.length >= MAX_PUSH_ACTIONS) break;
  }
  return cleaned.length > 0 ? { actions: cleaned } : {};
}

/**
 * The browser half of the notification channel, served at `/sw.js`.
 *
 * Deliberately minimal and **fetch-free**. An earlier build shipped a
 * cache-first offline shell and it repeatedly served stale client code to a
 * phone whose server had already been updated; the lesson was that a service
 * worker whose only job is notifications must not sit in front of the network.
 *
 * @returns {string} JavaScript source.
 */
export function pushWorkerScript() {
  return `'use strict';
// Pulse push worker. No fetch handler on purpose: this exists to receive push
// and show notifications, never to intercept the app's requests.

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      (typeof caches !== 'undefined' && caches.keys)
        ? caches.keys().then(function (keys) {
            // Retire any cache an earlier build left behind.
            return Promise.all(keys.map(function (key) { return caches.delete(key); }));
          })
        : Promise.resolve(),
    ]).catch(function () { /* nothing to clean */ })
  );
});

self.addEventListener('push', function (event) {
  var data = { title: 'DeepSeek', body: '', url: '/pulse', tag: 'pulse', severity: 1 };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (error) {
    try { data.body = event.data ? event.data.text() : ''; } catch (ignored) { /* keep defaults */ }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      renotify: true,
      requireInteraction: data.severity >= 3,
      // Answering from the lock screen. The action tokens are opaque to the
      // platform; this worker is what maps them onto a decision answer.
      actions: Array.isArray(data.actions) ? data.actions : [],
      data: { url: data.url, decision: data.data && data.data.decision ? data.data.decision : null },
    })
  );
});

/**
 * Answer a decision without opening the app.
 *
 * The session cookie is what authenticates this: a service worker's fetch is
 * same-origin and carries credentials, so the request authenticates exactly as
 * the console's own request would. Nothing secret is stored in the notification
 * — it holds a decision id and an answer token, both meaningless without the
 * cookie, and the device can be revoked to invalidate that cookie.
 */
function submitAnswer(decision, answer) {
  return fetch('/api/decisions/resolve', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: decision.id, answer: answer }),
  }).then(function (response) {
    return response.ok;
  }).catch(function () {
    return false;
  });
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var payload = event.notification.data || {};
  var decision = payload.decision;
  var action = event.action;
  var answers = (decision && decision.answers) || {};

  // An action button press is the one-tap path.
  if (action && decision && Object.prototype.hasOwnProperty.call(answers, action)) {
    event.waitUntil(
      submitAnswer(decision, answers[action]).then(function (ok) {
        // Report the outcome on the lock screen. A silent failure here is the
        // worst case: the agent stays blocked and the user believes they
        // answered.
        return self.registration.showNotification(ok ? '已回复' : '回复失败', {
          body: ok ? decision.title : '没能提交，打开 DeepSeek 手动回复',
          tag: 'pulse-answer',
          data: { url: '/pulse' },
        });
      })
    );
    return;
  }

  // A plain tap opens the console, deep-linked to the decision that is waiting.
  var target = payload.url || '/pulse';
  if (decision && decision.id) {
    target = '/pulse#decision-' + encodeURIComponent(decision.id);
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i += 1) {
        var client = clientList[i];
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
`;
}
