import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PushChannel, PUSH_RESULT, normalizeSubscription, pushWorkerScript, subscriptionKey } from '../lib/push.js';

/** A stand-in for the `web-push` package. */
function fakeWebPush(options = {}) {
  const impl = {
    /** Every notification this fake was asked to deliver. */
    sentTo: [],
    generateVAPIDKeys: () => ({ publicKey: 'PUBLIC_TEST_KEY', privateKey: 'PRIVATE_TEST_KEY' }),
    setVapidDetails: (...args) => {
      impl.vapid = args;
    },
    sendNotification: async (subscription, body, opts) => {
      impl.sentTo.push({ subscription, body: JSON.parse(body), opts });
      const status = options.failWith?.(subscription);
      if (status) {
        const error = new Error(`push failed ${status}`);
        error.statusCode = status;
        throw error;
      }
      return { statusCode: 201 };
    },
  };
  return impl;
}

/** A channel on a throwaway store with a fake transport. */
function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-push-'));
  const webpush = fakeWebPush(options);
  const warnings = [];
  const channel = new PushChannel({
    storeFile: join(dir, 'push.json'),
    onWarn: message => warnings.push(message),
    webpush,
  });
  return {
    channel,
    webpush,
    warnings,
    dir,
    store: () => JSON.parse(readFileSync(join(dir, 'push.json'), 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A plausible browser subscription. */
const sub = (id = 'a') => ({
  endpoint: `https://push.example.com/${id}`,
  keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
});

test('normalizeSubscription accepts a browser subscription and rejects junk', () => {
  assert.deepEqual(normalizeSubscription(sub('x')), sub('x'));
  assert.equal(normalizeSubscription(null), null);
  assert.equal(normalizeSubscription({}), null);
  // A non-HTTPS endpoint is not a push service.
  assert.equal(normalizeSubscription({ endpoint: 'http://push.example.com/a', keys: sub().keys }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://x/a' }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://x/a', keys: { p256dh: 'k' } }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://x/a', keys: { p256dh: 'k', auth: '  ' } }), null);
});

test('init generates and persists a VAPID identity once', async () => {
  const h = harness();
  try {
    assert.equal(await h.channel.init(), true);
    assert.equal(h.channel.ready, true);
    assert.equal(h.channel.publicKey, 'PUBLIC_TEST_KEY');
    // The keys must be written, or a restart would rotate them and silently
    // invalidate every existing subscription.
    assert.deepEqual(h.store().keys, { publicKey: 'PUBLIC_TEST_KEY', privateKey: 'PRIVATE_TEST_KEY' });
  } finally {
    h.cleanup();
  }
});

test('a restart reuses the persisted VAPID identity', async () => {
  const h = harness();
  try {
    await h.channel.init();
    h.channel.subscribe({ subscription: sub('persist'), deviceId: 'dev-1', label: '手机' });

    // Same store, fresh instance: the identity and the subscription survive.
    const revived = new PushChannel({ storeFile: h.channel.storeFile, onWarn: () => {}, webpush: fakeWebPush() });
    assert.equal(await revived.init(), true);
    assert.equal(revived.publicKey, 'PUBLIC_TEST_KEY');
    assert.equal(revived.roster().length, 1);
    assert.equal(revived.roster()[0].deviceId, 'dev-1');
  } finally {
    h.cleanup();
  }
});

test('subscribe validates, upserts, and reports the count', async () => {
  const h = harness();
  try {
    await h.channel.init();
    assert.equal(h.channel.subscribe({ subscription: sub('a') }).count, 1);
    // The same endpoint refreshes rather than duplicating.
    const again = h.channel.subscribe({ subscription: sub('a'), label: '改名' });
    assert.equal(again.count, 1);
    assert.equal(h.channel.roster()[0].label, '改名');
    assert.equal(h.channel.subscribe({ subscription: { endpoint: 'nope' } }).ok, false);
  } finally {
    h.cleanup();
  }
});

test('send delivers an encrypted-payload-shaped body to every device', async () => {
  const h = harness();
  try {
    await h.channel.init();
    h.channel.subscribe({ subscription: sub('a') });
    h.channel.subscribe({ subscription: sub('b') });

    const result = await h.channel.send({ title: '任务完成', body: '8 秒 · 2 次工具调用', severity: 1 });
    assert.equal(result.result, PUSH_RESULT.sent);
    assert.equal(result.sent, 2);
    assert.equal(h.webpush.sentTo.length, 2);
    assert.equal(h.webpush.sentTo[0].body.title, '任务完成');
    // A tap lands on the console by default.
    assert.equal(h.webpush.sentTo[0].body.url, '/pulse');
    assert.equal(h.webpush.sentTo[0].opts.TTL, 3600);
  } finally {
    h.cleanup();
  }
});

test('send reports empty rather than failing when nothing is registered', async () => {
  const h = harness();
  try {
    await h.channel.init();
    const result = await h.channel.send({ title: 'x' });
    assert.equal(result.result, PUSH_RESULT.empty);
    assert.equal(result.sent, 0);
  } finally {
    h.cleanup();
  }
});

test('a subscription the push service reports gone is dropped, not retried forever', async () => {
  const h = harness({ failWith: s => (s.endpoint.endsWith('/dead') ? 410 : undefined) });
  try {
    await h.channel.init();
    h.channel.subscribe({ subscription: sub('live') });
    h.channel.subscribe({ subscription: sub('dead') });

    const result = await h.channel.send({ title: 'x' });
    assert.equal(result.sent, 1);
    assert.equal(result.removed, 1);
    // Only the live one remains, and the removal was persisted.
    assert.equal(h.channel.roster().length, 1);
    assert.equal(h.store().subscriptions.length, 1);
  } finally {
    h.cleanup();
  }
});

test('a transient push failure keeps the subscription', async () => {
  const h = harness({ failWith: () => 500 });
  try {
    await h.channel.init();
    h.channel.subscribe({ subscription: sub('flaky') });
    const result = await h.channel.send({ title: 'x' });
    assert.equal(result.sent, 0);
    assert.equal(result.removed, 0);
    // A 500 is the push service having a bad day, not a dead subscription.
    assert.equal(h.channel.roster().length, 1);
    assert.equal(h.warnings.length, 1);
  } finally {
    h.cleanup();
  }
});

test('dropping a device removes exactly that device subscriptions', async () => {
  const h = harness();
  try {
    await h.channel.init();
    h.channel.subscribe({ subscription: sub('a'), deviceId: 'dev-1' });
    h.channel.subscribe({ subscription: sub('b'), deviceId: 'dev-1' });
    h.channel.subscribe({ subscription: sub('c'), deviceId: 'dev-2' });

    assert.equal(h.channel.dropDevice('dev-1'), 2);
    assert.equal(h.channel.roster().length, 1);
    assert.equal(h.channel.roster()[0].deviceId, 'dev-2');
    // Revocation must survive a restart, so the removal is persisted.
    assert.equal(h.store().subscriptions.length, 1);
    assert.equal(h.channel.dropDevice('ghost'), 0);
  } finally {
    h.cleanup();
  }
});

test('unsubscribe removes one endpoint', async () => {
  const h = harness();
  try {
    await h.channel.init();
    h.channel.subscribe({ subscription: sub('a') });
    assert.equal(h.channel.unsubscribe(sub('a').endpoint), true);
    assert.equal(h.channel.unsubscribe(sub('a').endpoint), false);
    assert.equal(h.channel.roster().length, 0);
  } finally {
    h.cleanup();
  }
});

test('the roster never exposes a full endpoint, which is a capability', async () => {
  const h = harness();
  try {
    await h.channel.init();
    h.channel.subscribe({ subscription: sub('secret-path-token'), deviceId: 'd', label: '手机' });
    const row = h.channel.roster()[0];
    // Only the host is reported: anyone holding the endpoint can buzz the phone.
    assert.equal(row.host, 'push.example.com');
    assert.equal(JSON.stringify(row).includes('secret-path-token'), false);
    assert.equal(JSON.stringify(h.channel.status()).includes('secret-path-token'), false);
  } finally {
    h.cleanup();
  }
});

test('a corrupt store is discarded rather than trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-push-bad-'));
  try {
    const storeFile = join(dir, 'push.json');
    const warnings = [];
    const channel = new PushChannel({ storeFile, onWarn: m => warnings.push(m), webpush: fakeWebPush() });
    // Malformed entries inside an otherwise valid document are skipped, not
    // allowed to become a live subscription.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      storeFile,
      JSON.stringify({
        version: 1,
        subscriptions: [
          { subscription: sub('ok'), deviceId: 'd' },
          { subscription: { endpoint: 'ftp://nope' }, deviceId: 'd' },
          { subscription: null },
          'not-an-object',
        ],
      }),
    );
    assert.equal(await channel.init(), true);
    assert.equal(channel.roster().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subscriptionKey is the endpoint, so key rotation refreshes in place', () => {
  assert.equal(subscriptionKey(sub('a')), 'https://push.example.com/a');
});

test('the push worker has no fetch handler', () => {
  const script = pushWorkerScript();
  // The whole point: a notification worker must never sit in front of the
  // network, because a cache-first handler is what served stale code before.
  assert.equal(script.includes("addEventListener('fetch'"), false);
  assert.match(script, /addEventListener\('push'/);
  assert.match(script, /addEventListener\('notificationclick'/);
  assert.match(script, /caches\.delete/);
  // The notification body must not be able to close the script element early.
  assert.equal(script.includes('</script'), false);
});
