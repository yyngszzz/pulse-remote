/**
 * The phone surface assets: a single-file PWA with no build step and no
 * third-party code, so what ships is exactly what can be audited.
 *
 * Presentation rules this UI follows, all of them consequences of the
 * distillation design rather than decoration:
 *
 * - The activity feed shows distilled lines only. There is no way to expand a
 *   frame into a raw payload, because the phone is not meant to be a mirror.
 * - Decisions sit above the feed and never scroll away, because they are the
 *   only elements that block the agent.
 * - Everything is rendered with `textContent`. Model output and file paths are
 *   untrusted strings, and this page holds a device credential.
 *
 * @module dsh-remote-pulse/ui
 */

/**
 * Escape a value for safe interpolation into an HTML text position.
 * @param {unknown} value - raw value.
 * @returns {string} escaped text.
 */
function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

/**
 * The pairing gate: the only thing an unpaired phone ever receives.
 *
 * It is deliberately a separate document from the Pulse console rather than a
 * hidden section, because the unpaired root is a security boundary — an
 * unpaired caller must not be handed the UI that assumes a credential.
 *
 * @param {object} options - gate options.
 * @param {string} options.realm - display name.
 * @param {boolean} options.exposed - whether the listener is network-reachable.
 * @returns {string} HTML.
 */
// The gate deliberately says nothing about the bind address: a phone reaches
// this page over a LAN, a tunnel, or a reverse proxy, and only the operator can
// tell which. A scary "the listener is loopback-only" notice would be wrong in
// the tunnel case, which is a supported deployment.
export function gateHtml({ realm }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<meta name="color-scheme" content="dark light">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>连接 ${esc(realm)}</title>
<link rel="stylesheet" href="/pulse.css">
</head>
<body class="gate-body">
<main class="gate">
  <h1>连接这台电脑</h1>
  <p class="muted">在电脑上打开 DeepSeek Harness → 设置 → <strong>${esc(realm)}</strong>，点「生成配对码」，把它填在下面。</p>
  <p class="muted small">配对后这台手机将能像在电脑上一样使用 Harness——包括看会话、看对话和派活。请只配对你自己控制的设备。</p>
  <form id="pair-form">
    <input id="pair-code" inputmode="latin" autocomplete="off" autocapitalize="characters" placeholder="配对码" aria-label="配对码">
    <input id="pair-label" autocomplete="off" placeholder="给这台手机起个名字（可选）" aria-label="设备名称">
    <button type="submit" id="pair-submit">配对</button>
  </form>
  <p class="muted small" id="pair-error" hidden></p>
  <p class="muted small">配对码只能用一次、5 分钟内有效，且同一时间只有一个——在电脑上重新生成会让旧的立刻失效。</p>
</main>
<div id="toast" class="toast" hidden></div>
<script src="/pulse.js"></script>
</body>
</html>
`;
}

/**
 * The Pulse console shell: pending decisions, the distilled activity stream, and
 * a way into the full GUI.
 * @param {object} options - shell options.
 * @param {string} options.realm - display name.
 * @param {boolean} options.exposed - whether the listener is network-reachable.
 * @returns {string} HTML.
 */
export function indexHtml({ realm, exposed }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<meta name="color-scheme" content="dark light">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>${esc(realm)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/pulse.css">
</head>
<body>
<header class="bar">
  <div class="brand">
    <span class="dot" id="conn" data-state="connecting" aria-hidden="true"></span>
    <span class="title">${esc(realm)}</span>
  </div>
  <div class="bar-actions">
    <span class="chip" id="queue-chip" hidden></span>
    <a class="enter" href="/">完整界面</a>
    <button type="button" id="settings-toggle" class="icon" aria-label="设置">⚙</button>
  </div>
</header>

<section id="unpaired" class="gate" hidden>
  <h2>连接这台电脑</h2>
  <p class="muted">在电脑上打开 DeepSeek Harness 的设置页，找到 <strong>${esc(realm)}</strong>，点「生成配对码」，然后把它填在下面。</p>
  <form id="pair-form">
    <input id="pair-code" inputmode="latin" autocomplete="off" autocapitalize="characters" placeholder="配对码" aria-label="配对码">
    <input id="pair-label" autocomplete="off" placeholder="给这台手机起个名字（可选）" aria-label="设备名称">
    <button type="submit" id="pair-submit">配对</button>
  </form>
  <p class="muted small" id="pair-error" hidden></p>
</section>

<main id="app" hidden>
  <a class="hero" href="/">
    <span class="hero-title">打开完整界面</span>
    <span class="hero-sub">和电脑上一样的 Harness：会话、对话、文件改动、派活</span>
  </a>

  <section class="panel" id="decisions-panel" hidden>
    <h2 class="panel-title">
      <span>需要你决定</span>
      <span class="badge" id="decisions-count">0</span>
    </h2>
    <div id="decisions"></div>
  </section>

  <section class="panel" id="artifacts-panel" hidden>
    <h2 class="panel-title">
      <span>刚生成的产物</span>
      <span class="badge" id="artifacts-count">0</span>
    </h2>
    <div id="artifacts" class="artifacts"></div>
  </section>

  <section class="panel">
    <h2 class="panel-title">
      <span>正在发生</span>
      <span class="badge muted" id="live-count"></span>
    </h2>
    <div id="feed" class="feed"></div>
    <p class="empty" id="feed-empty">还没有活动。电脑上的 agent 一开始工作，这里就会有动静。</p>
  </section>

  <section class="panel">
    <h2 class="panel-title"><span>现在状态</span></h2>
    <div id="status" class="status"></div>
  </section>
</main>

<form id="composer" class="composer" hidden>
  <textarea id="composer-text" rows="1" placeholder="给电脑上的 agent 发指令…" aria-label="指令"></textarea>
  <button type="submit" id="composer-send" aria-label="发送">发送</button>
  <button type="button" id="composer-stop" class="danger" aria-label="停止">停止</button>
</form>

<section id="settings" class="sheet" hidden>
  <div class="sheet-body">
    <h2>设置</h2>
    <dl class="kv">
      <dt>服务地址</dt><dd id="s-url"></dd>
      <dt>连接状态</dt><dd id="s-conn"></dd>
      <dt>最近序号</dt><dd id="s-seq"></dd>
      <dt>待发指令</dt><dd id="s-outbox"></dd>
      <dt>网络暴露</dt><dd id="s-exposed"></dd>
      <dt>锁屏通知</dt><dd id="s-push">检查中…</dd>
    </dl>
    <div class="sheet-actions">
      <button type="button" id="push-enable">开启锁屏通知</button>
      <button type="button" id="reconnect">立即重连</button>
      <button type="button" id="unpair" class="danger">解除配对</button>
      <button type="button" id="settings-close">关闭</button>
    </div>
    <p class="muted small" id="push-hint" hidden></p>
    <p class="muted small">解绑后需要重新用电脑上的配对码连接。</p>
  </div>
</section>

<div id="toast" class="toast" hidden></div>
<script src="/app.js"></script>
</body>
</html>
`;
}

/**
 * The client application. Served as a plain script; no framework, no bundler.
 * @returns {string} JavaScript source.
 */
export function pulseScript() {
  return `'use strict';
(function () {
  var STORE_KEY = 'pulse.device.v1';
  var OUTBOX_KEY = 'pulse.outbox.v1';
  var SEQ_KEY = 'pulse.seq.v1';

  var el = function (id) { return document.getElementById(id); };
  var state = {
    device: load(STORE_KEY, null),
    seq: Number(load(SEQ_KEY, 0)) || 0,
    outbox: load(OUTBOX_KEY, []) || [],
    decisions: [],
    sessions: [],
    artifacts: [],
    es: null,
    retry: 0,
    retryTimer: null,
    lastFrameAt: 0,
    // True from the moment a pairing request starts until it either fails (so a
    // corrected code can be retried) or succeeds (so it never runs again).
    pairing: false
  };

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  /**
   * Write text into an element if this page has it.
   *
   * The gate page and the console share one script but not one set of elements.
   * An unguarded write to a missing node throws during init and takes every
   * later binding with it -- that is exactly how the pairing button once ended
   * up silently doing nothing, so every id-based write goes through here.
   */
  function setText(id, value) {
    var node = el(id);
    if (node) node.textContent = value;
  }

  function toast(message, bad) {
    var node = el('toast');
    if (!node) return;
    node.textContent = message;
    node.className = 'toast' + (bad ? ' bad' : '');
    node.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { node.hidden = true; }, 3600);
  }

  function authHeaders() {
    return {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + state.device.id + '.' + state.device.token
    };
  }

  function setConn(status) {
    // Both nodes are console-only. The gate page shares this script but has
    // neither, and an unguarded write here used to throw on the very first
    // line of init() -- which killed the submit listener and made the pairing
    // button silently do nothing on the one page that needs it most.
    var dot = el('conn');
    if (dot) dot.dataset.state = status;
    var label = { live: '已连接', connecting: '连接中', offline: '已断开', unpaired: '未配对' }[status] || status;
    var text = el('s-conn');
    if (text) text.textContent = label;
    if (status === 'offline') document.body.dataset.offline = '1';
    else delete document.body.dataset.offline;
  }

  // ---- rendering -----------------------------------------------------------

  var KIND_ICON = {
    'activity': '·', 'summary': '≡', 'decision': '!', 'decision-resolved': '✓',
    'decision-expired': '⌛', 'turn-start': '▶', 'turn-end': '■', 'failure': '✕', 'session': '◦'
  };

  function frameNode(frame) {
    var row = document.createElement('div');
    row.className = 'frame sev-' + (frame.severity || 0);
    var icon = document.createElement('span');
    icon.className = 'frame-icon';
    icon.textContent = KIND_ICON[frame.kind] || '·';
    var body = document.createElement('div');
    body.className = 'frame-body';
    var text = document.createElement('div');
    text.className = 'frame-text';
    text.textContent = frame.text;
    body.appendChild(text);
    if (frame.detail) {
      var detail = document.createElement('div');
      detail.className = 'frame-detail';
      detail.textContent = frame.detail;
      body.appendChild(detail);
    }
    var time = document.createElement('time');
    time.className = 'frame-time';
    time.textContent = new Date(frame.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(time);
    return row;
  }

  function appendFrame(frame) {
    var feed = el('feed');
    el('feed-empty').hidden = true;
    var atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40;
    feed.appendChild(frameNode(frame));
    while (feed.childElementCount > 400) feed.removeChild(feed.firstElementChild);
    if (atBottom) feed.scrollTop = feed.scrollHeight;
    state.lastFrameAt = Date.now();
  }

  function renderDecisions() {
    var panel = el('decisions-panel');
    var box = el('decisions');
    if (!panel || !box) return;
    box.textContent = '';
    var list = state.decisions;
    panel.hidden = list.length === 0;
    setText('decisions-count', String(list.length));
    var chip = el('queue-chip');
    if (chip) {
      chip.hidden = list.length === 0;
      chip.textContent = list.length + ' 项待决';
    }

    list.forEach(function (decision) {
      var card = document.createElement('div');
      card.className = 'decision';
      // A lock-screen notification deep-links to #decision-<id>; giving the
      // card that id is what makes the tap land on the right one.
      if (decision.id) card.id = 'decision-' + decision.id;

      var head = document.createElement('div');
      head.className = 'decision-head';
      var kind = document.createElement('span');
      kind.className = 'decision-kind';
      kind.textContent = decision.type === 'approval' ? '权限请求' : '提问';
      var session = document.createElement('span');
      session.className = 'decision-session';
      session.textContent = decision.sessionId;
      head.appendChild(kind);
      head.appendChild(session);

      var title = document.createElement('div');
      title.className = 'decision-title';
      title.textContent = decision.title;

      card.appendChild(head);
      card.appendChild(title);
      if (decision.detail) {
        var detail = document.createElement('div');
        detail.className = 'decision-detail';
        detail.textContent = decision.detail;
        card.appendChild(detail);
      }

      var actions = document.createElement('div');
      actions.className = 'decision-actions';
      var options = decision.options && decision.options.length
        ? decision.options
        : [{ value: 'approved', label: '同意' }, { value: 'rejected', label: '拒绝' }];
      var selected = [];
      options.forEach(function (option) {
        var value = typeof option === 'string' ? option : option.value;
        var label = typeof option === 'string' ? optionLabel(option) : (option.label || option.value);
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'decision-option';
        button.textContent = label;
        button.dataset.value = value;
        button.addEventListener('click', function () {
          if (decision.multiSelect) {
            var at = selected.indexOf(value);
            if (at === -1) selected.push(value); else selected.splice(at, 1);
            button.classList.toggle('on', at === -1);
            return;
          }
          answer(decision, { value: value });
        });
        actions.appendChild(button);
      });
      if (decision.multiSelect) {
        var confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'decision-option primary';
        confirm.textContent = '提交选择';
        confirm.addEventListener('click', function () { answer(decision, { selected: selected.slice() }); });
        actions.appendChild(confirm);
      }
      var custom = document.createElement('button');
      custom.type = 'button';
      custom.className = 'decision-option ghost';
      custom.textContent = '回电脑处理';
      custom.addEventListener('click', function () { dismiss(decision); });
      actions.appendChild(custom);

      card.appendChild(actions);
      box.appendChild(card);
    });

    focusHashedDecision();
  }

  /**
   * Render the files the agent produced, newest first.
   *
   * Every entry links to the content route, which serves bytes only for a path
   * it already recorded — so this view can never be turned into a file browser
   * by editing the URL.
   */
  function renderArtifacts() {
    var panel = el('artifacts-panel');
    var box = el('artifacts');
    if (!panel || !box) return;
    var list = state.artifacts || [];
    panel.hidden = list.length === 0;
    setText('artifacts-count', String(list.length));
    box.textContent = '';

    list.forEach(function (artifact) {
      var row = document.createElement('div');
      row.className = 'artifact';

      var head = document.createElement('div');
      head.className = 'artifact-head';
      var name = document.createElement('span');
      name.className = 'artifact-name';
      name.textContent = artifact.name || artifact.path;
      var kind = document.createElement('span');
      kind.className = 'artifact-kind';
      kind.textContent = artifact.kind === 'image' ? '图片' : artifact.kind === 'text' ? '文本' : '文件';
      head.appendChild(name);
      head.appendChild(kind);

      var path = document.createElement('div');
      path.className = 'artifact-path';
      path.textContent = artifact.path;

      var actions = document.createElement('div');
      actions.className = 'artifact-actions';
      var query = '?path=' + encodeURIComponent(artifact.path);
      if (artifact.kind === 'image') {
        var image = document.createElement('img');
        image.className = 'artifact-image';
        image.loading = 'lazy';
        image.alt = artifact.name || 'artifact';
        image.src = '/api/artifacts/content' + query;
        row.appendChild(head);
        row.appendChild(image);
      } else if (artifact.kind === 'text') {
        var preview = document.createElement('pre');
        preview.className = 'artifact-preview';
        preview.dataset.loaded = '0';
        preview.textContent = '点「预览」读取内容';
        preview.dataset.src = '/api/artifacts/content' + query;
        row.appendChild(head);
        row.appendChild(path);
        row.appendChild(preview);
      } else {
        row.appendChild(head);
        row.appendChild(path);
      }

      var actions = document.createElement('div');
      actions.className = 'artifact-actions';
      var inline = row.querySelector ? row.querySelector('.artifact-preview') : null;
      if (artifact.kind === 'text') {
        // Read in place: opening a raw text file in a new tab leaves the app and
        // costs the phone a full page load over a tunnel.
        var look = document.createElement('button');
        look.type = 'button';
        look.className = 'artifact-open';
        look.textContent = '预览';
        look.addEventListener('click', function () { loadPreview(inline); });
        actions.appendChild(look);
      } else if (artifact.kind === 'image') {
        var openImage = document.createElement('a');
        openImage.className = 'artifact-open';
        openImage.href = '/api/artifacts/content' + query;
        openImage.target = '_blank';
        openImage.rel = 'noopener';
        openImage.textContent = '原图';
        actions.appendChild(openImage);
      }

      // The app gets a forward action and the browser does not. On a phone the
      // point of having the file is to send it on — the share sheet reaches WeChat
      // and QQ in one tap, while a Downloads folder is several steps away and hard
      // to find afterwards. A browser has no share sheet, so there the download is
      // the only ending that makes sense.
      // Double-escaped on purpose: this source is itself inside a template
      // literal, where a single backslash before a slash is swallowed and the
      // generated regex becomes /PulseApp// — a syntax error in the served script.
      if (/PulseApp\\//.test(navigator.userAgent || '')) {
        var forward = document.createElement('a');
        forward.className = 'artifact-open';
        // The marker is what the app intercepts; the server ignores it.
        forward.href = '/api/artifacts/content' + query + '&share=1';
        forward.textContent = '转发';
        actions.appendChild(forward);
      }

      var save = document.createElement('a');
      save.className = 'artifact-open';
      save.href = '/api/artifacts/content' + query + '&download=1';
      save.setAttribute('download', artifact.name || 'artifact');
      save.textContent = '下载';
      actions.appendChild(save);

      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  /**
   * Load one text preview, at most once per row.
   * @param {HTMLElement} node - the preview element, carrying its own src.
   * @returns {void}
   */
  function loadPreview(node) {
    if (!node || node.dataset.loaded === '1') return;
    node.dataset.loaded = '1';
    node.textContent = '读取中…';
    fetch(node.dataset.src, { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error(String(res.status))); })
      .then(function (text) {
        // A preview can be long; the phone shows the head of it rather than
        // scrolling a megabyte of log.
        node.textContent = text.length > 20000 ? text.slice(0, 20000) + '\\n…（已截断）' : text;
      })
      .catch(function () {
        node.dataset.loaded = '0';
        node.textContent = '读不到了（可能已被移动或删除）';
      });
  }

  /**
   * Bring the decision named in the URL hash into view.
   *
   * This is how a lock-screen tap finishes: the notification deep-links to
   * #decision-<id>, and without this the console would open at the top of a
   * possibly long queue with no indication of which item was tapped.
   */
  function focusHashedDecision() {
    var id = '';
    try {
      var hash = String(location.hash || '');
      if (hash.indexOf('#decision-') === 0) id = decodeURIComponent(hash.slice('#decision-'.length));
    } catch (error) {
      return;
    }
    if (!id) return;
    var card = document.getElementById('decision-' + id);
    if (!card) return;
    card.classList.add('focused');
    if (typeof card.scrollIntoView === 'function') {
      try {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (error) {
        card.scrollIntoView();
      }
    }
  }

  function optionLabel(value) {
    return {
      'allowed-once': '允许一次', 'rejected': '拒绝', 'approved': '同意',
      'allow': '允许', 'deny': '拒绝', 'yes': '是', 'no': '否'
    }[value] || value;
  }

  function answer(decision, payload) {
    var body = decision.type === 'approval'
      ? { id: decision.id, answer: { outcome: payload.value } }
      : { id: decision.id, answer: payload.selected ? { selected: payload.selected } : { selected: [payload.value] } };
    fetch('/api/decisions/resolve', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (result.ok && result.data.ok) {
          state.decisions = state.decisions.filter(function (d) { return d.id !== decision.id; });
          renderDecisions();
          toast('已回复');
        } else {
          toast('这条已经不需要回答了', true);
          state.decisions = state.decisions.filter(function (d) { return d.id !== decision.id; });
          renderDecisions();
        }
      })
      .catch(function () { toast('网络不通，稍后重试', true); });
  }

  function dismiss(decision) {
    state.decisions = state.decisions.filter(function (d) { return d.id !== decision.id; });
    renderDecisions();
    toast('已交回电脑端处理');
  }

  function renderStatus() {
    var box = el('status');
    if (!box) return;
    box.textContent = '';
    if (!state.sessions.length) {
      var none = document.createElement('p');
      none.className = 'empty';
      none.textContent = '没有正在运行的会话。';
      box.appendChild(none);
      setText('live-count', '');
      return;
    }
    var running = state.sessions.filter(function (s) { return s.running; });
    setText('live-count', running.length ? running.length + ' 个在跑' : '');
    state.sessions.forEach(function (session) {
      var row = document.createElement('div');
      row.className = 'session' + (session.running ? ' running' : '');
      var name = document.createElement('span');
      name.className = 'session-name';
      name.textContent = session.sessionId;
      var meta = document.createElement('span');
      meta.className = 'session-meta';
      meta.textContent = session.running ? '进行中' : '空闲';
      row.appendChild(name);
      row.appendChild(meta);
      box.appendChild(row);
    });
  }

  function renderOutbox() {
    setText('s-outbox', state.outbox.length ? state.outbox.length + ' 条' : '无');
  }

  // ---- transport -----------------------------------------------------------

  function connect() {
    if (!state.device) { setConn('unpaired'); showGate(); return; }
    if (state.es) { state.es.close(); state.es = null; }
    setConn('connecting');
    var url = '/api/stream?since=' + encodeURIComponent(state.seq) +
      '&device=' + encodeURIComponent(state.device.id) +
      '&token=' + encodeURIComponent(state.device.token);
    var es = new EventSource(url);
    state.es = es;

    es.addEventListener('hello', function (event) {
      var data = JSON.parse(event.data);
      if (data.gap) toast('中间有一段活动没收到，已从最新内容继续', true);
      state.retry = 0;
      setConn('live');
      el('app').hidden = false;
      el('composer').hidden = false;
      el('unpaired').hidden = true;
      flushOutbox();
    });
    es.addEventListener('frame', function (event) {
      var frame = JSON.parse(event.data);
      if (frame.seq <= state.seq) return;
      state.seq = frame.seq;
      save(SEQ_KEY, state.seq);
      appendFrame(frame);
      setText('s-seq', String(state.seq));
    });
    es.addEventListener('decisions', function (event) {
      var data = JSON.parse(event.data);
      state.decisions = data.decisions || [];
      renderDecisions();
    });
    es.addEventListener('artifacts', function (event) {
      var data = JSON.parse(event.data);
      state.artifacts = data.artifacts || [];
      renderArtifacts();
    });
    es.onopen = function () { setConn('live'); };
    es.onerror = function () {
      // EventSource reconnects on its own, but a 401 from a revoked device does
      // not recover; back off and surface it instead of spinning.
      setConn('offline');
      es.close();
      state.es = null;
      state.retry = Math.min(state.retry + 1, 6);
      var delay = Math.min(30000, 1000 * Math.pow(2, state.retry));
      clearTimeout(state.retryTimer);
      state.retryTimer = setTimeout(function () {
        if (state.device) probeThenConnect(); else showGate();
      }, delay);
    };
  }

  function probeThenConnect() {
    fetch('/api/snapshot', { headers: authHeaders() })
      .then(function (res) {
        if (res.status === 401 || res.status === 429) {
          toast('这台手机已失效，请重新配对', true);
          state.device = null;
          save(STORE_KEY, null);
          showGate();
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        applySnapshot(data);
        connect();
      })
      .catch(function () { connect(); });
  }

  function applySnapshot(data) {
    state.sessions = data.sessions || [];
    state.decisions = data.decisions || [];
    state.artifacts = data.artifacts || [];
    if (typeof data.lastSeq === 'number' && data.lastSeq < state.seq) {
      // The machine restarted; the old sequence means nothing any more.
      state.seq = 0;
      save(SEQ_KEY, 0);
    }
    renderStatus();
    renderDecisions();
    renderArtifacts();
    setText('s-url', location.origin);
    setText('s-exposed', data.exposed ? '局域网/公网可达' : '仅本机');
    setText('s-seq', String(state.seq));
  }

  function refreshSnapshot() {
    if (!state.device) return;
    fetch('/api/snapshot', { headers: authHeaders() })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data) applySnapshot(data); })
      .catch(function () { /* the stream will recover */ });
  }

  // ---- outbox: instructions survive a dead network -------------------------

  function queueInstruction(text, sessionId) {
    state.outbox.push({ text: text, sessionId: sessionId || null, at: Date.now() });
    save(OUTBOX_KEY, state.outbox);
    renderOutbox();
  }

  function flushOutbox() {
    if (!state.outbox.length) return;
    var pending = state.outbox.slice();
    state.outbox = [];
    save(OUTBOX_KEY, state.outbox);
    renderOutbox();
    pending.forEach(function (item) {
      sendInstruction(item.text, item.sessionId).then(function (ok) {
        if (!ok) {
          state.outbox.push(item);
          save(OUTBOX_KEY, state.outbox);
          renderOutbox();
        }
      });
    });
  }

  function sendInstruction(text, sessionId) {
    return fetch('/api/instruct', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: text, sessionId: sessionId || undefined })
    })
      .then(function (res) { return res.json().then(function (data) { return res.ok && data.ok !== false; }); })
      .catch(function () { return false; });
  }

  // ---- pairing -------------------------------------------------------------

  function showGate() {
    setConn('unpaired');
    el('unpaired').hidden = false;
    el('app').hidden = true;
    el('composer').hidden = true;
  }

  function submitPair(event) {
    event.preventDefault();
    // A scanned link pairs on load by calling this directly, so a tap on the
    // button can race that request. Without this guard the second request
    // arrives after the one-shot code has already been spent, the server
    // correctly answers "this code is no longer valid", and the page paints a
    // failure message over a pairing that in fact succeeded.
    if (state.pairing) return;
    var code = el('pair-code').value.trim();
    if (!code) return;
    state.pairing = true;
    el('pair-submit').disabled = true;
    fetch('/api/pair', {
      method: 'POST',
      // Explicit: the response sets the session cookie the official GUI needs.
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code, label: el('pair-label').value.trim() })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) {
          // A retry must be possible, so the guard is released only on failure.
          state.pairing = false;
          el('pair-submit').disabled = false;
          el('pair-error').hidden = false;
          el('pair-error').textContent = result.data.message || '配对失败';
          return;
        }
        state.device = { id: result.data.deviceId, token: result.data.token };
        save(STORE_KEY, state.device);
        state.seq = 0;
        save(SEQ_KEY, 0);

        // The official GUI authenticates with the session cookie the pairing
        // response set, not with this token. If the browser refused to store it
        // -- cookies disabled, or a restrictive in-app browser -- every later
        // request lands back on this gate, which looks exactly like a failed
        // pairing. Confirm the cookie took before navigating.
        fetch('/api/whoami', {
          credentials: 'same-origin',
          headers: { authorization: 'Bearer ' + state.device.id + '.' + state.device.token }
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (info) {
            if (info && info.cookieReceived) {
              // On the gate page there is no console to reveal, so go straight
              // to the full interface.
              if (!el('app')) location.href = '/';
              else {
                el('pair-code').value = '';
                el('pair-error').hidden = true;
                el('unpaired').hidden = true;
                toast('配对成功');
                probeThenConnect();
              }
              return;
            }
            el('pair-submit').disabled = false;
            el('pair-error').hidden = false;
            el('pair-error').textContent =
              '配对已成功，但浏览器没有保存登录凭据（Cookie）。请在浏览器设置里允许本站 Cookie，' +
              '或改用系统自带浏览器（微信/QQ 内置浏览器常会拦截）重新打开链接。';
          })
          .catch(function () {
            el('pair-submit').disabled = false;
            el('pair-error').hidden = false;
            el('pair-error').textContent = '配对成功但无法确认登录状态，请刷新页面重试。';
          });
      })
      .catch(function () {
        // The request never landed, so nothing was consumed: allow a retry.
        state.pairing = false;
        el('pair-submit').disabled = false;
        el('pair-error').hidden = false;
        el('pair-error').textContent = '连不上服务器，检查地址和网络';
      });
  }

  // ---- lock-screen notifications -------------------------------------------
  //
  // Web Push is the only channel that reaches a phone nobody is looking at, but
  // it needs a secure context and an explicit user gesture. Both can fail in
  // ways this code cannot fix (a self-signed certificate over a bare IP is not a
  // secure context on most mobile browsers), so every failure is reported in
  // words rather than swallowed.

  function setPushStatus(text, hint) {
    var node = el('s-push');
    if (node) node.textContent = text;
    var hintNode = el('push-hint');
    if (hintNode) {
      if (hint) { hintNode.hidden = false; hintNode.textContent = hint; }
      else { hintNode.hidden = true; hintNode.textContent = ''; }
    }
  }

  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(normalized);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
  }

  function pushUnsupportedReason() {
    if (!('serviceWorker' in navigator)) return '这个浏览器不支持 Service Worker';
    if (!('PushManager' in window)) return '这个浏览器不支持推送';
    if (!('Notification' in window)) return '这个浏览器不支持通知';
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return '需要 HTTPS 才能开启锁屏通知';
    return null;
  }

  function enablePush() {
    var unsupported = pushUnsupportedReason();
    if (unsupported) { setPushStatus('不可用', unsupported); return; }

    setPushStatus('请求权限…');
    Notification.requestPermission()
      .then(function (permission) {
        if (permission !== 'granted') {
          setPushStatus('已拒绝', '你拒绝了通知权限。可在浏览器站点设置里重新允许，然后回到这里再点一次。');
          return null;
        }
        setPushStatus('注册中…');
        // updateViaCache: 'none' keeps the browser from serving sw.js out of the
        // HTTP cache, which is the usual reason a deployed change never lands.
        return navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
          .then(function (registration) { return registration.update(); })
          .then(function () { return navigator.serviceWorker.ready; });
      })
      .then(function (registration) {
        if (!registration) return null;
        return fetch('/api/push/key', { credentials: 'same-origin' })
          .then(function (res) { return res.json(); })
          .then(function (info) {
            if (!info || !info.publicKey) {
              setPushStatus('服务端未启用', '电脑端的 Pulse 没能生成 VAPID 密钥，请查看电脑端日志。');
              return null;
            }
            return registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(info.publicKey)
            });
          });
      })
      .then(function (subscription) {
        if (!subscription) return null;
        return fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: authHeaders(),
          body: JSON.stringify({ subscription: subscription.toJSON() })
        }).then(function (res) { return res.json(); });
      })
      .then(function (result) {
        if (!result) return;
        if (result.ok) setPushStatus('已开启', '任务完成或需要你决策时，会推送到手机锁屏。');
        else setPushStatus('登记失败', '订阅已建立但服务端拒绝了登记：' + (result.reason || '未知原因'));
      })
      .catch(function (error) {
        var message = String((error && error.message) || error);
        // The most common real-world cause is worth naming explicitly.
        var hint = /secure context|not allowed|denied/i.test(message)
          ? '当前地址不是浏览器认可的安全上下文（自签证书 + IP 常会这样）。改用域名 + 受信任证书后可开启。'
          : '注册失败：' + message;
        setPushStatus('失败', hint);
      });
  }

  function refreshPushStatus() {
    var unsupported = pushUnsupportedReason();
    if (unsupported) { setPushStatus('不可用', unsupported); return; }
    if (Notification.permission === 'denied') {
      setPushStatus('已拒绝', '可在浏览器站点设置里重新允许通知。');
      return;
    }
    if (!state.device) { setPushStatus('待配对'); return; }
    fetch('/api/push/status', { credentials: 'same-origin', headers: authHeaders() })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (info) {
        if (!info) { setPushStatus('未知'); return; }
        if (!info.ready) { setPushStatus('服务端未启用'); return; }
        setPushStatus(info.mine > 0 ? '已开启' : '未开启',
          info.mine > 0 ? '' : '点「开启锁屏通知」，任务完成和待决策就能推到锁屏。');
      })
      .catch(function () { setPushStatus('未知'); });
  }

  // ---- wiring --------------------------------------------------------------

  function init() {
    // The gate page and the console share this script, so every binding is
    // guarded: a missing element means "this page does not have that control",
    // never a thrown error that would take the pairing form down with it.
    var on = function (id, event, handler) {
      var node = el(id);
      if (node) node.addEventListener(event, handler);
    };

    // Bind the pairing form FIRST. A scanned link must pair on load, and that
    // path calls submitPair directly -- if anything above it can throw, the
    // handler is never attached and the button does nothing.
    on('pair-form', 'submit', submitPair);

    // The gate page can be reached with the code already in the URL, which is
    // how a scanned QR pairs in one step instead of asking for a code that can
    // expire while the link is copied between apps.
    var preset = null;
    try {
      preset = new URLSearchParams(location.search).get('code');
    } catch (error) {
      preset = null;
    }
    var isGatePage = !el('app');
    if (preset && el('pair-code')) {
      el('pair-code').value = preset.toUpperCase();
      if (el('pair-label') && !el('pair-label').value) {
        el('pair-label').value = '手机';
      }
      submitPair({ preventDefault: function () {} });
      return;
    }

    setConn('connecting');
    on('settings-toggle', 'click', function () {
      el('settings').hidden = false;
      refreshSnapshot();
    });
    on('settings-close', 'click', function () { el('settings').hidden = true; });
    on('reconnect', 'click', function () { state.retry = 0; probeThenConnect(); });
    on('unpair', 'click', function () {
      state.device = null;
      save(STORE_KEY, null);
      state.seq = 0;
      save(SEQ_KEY, 0);
      if (state.es) { state.es.close(); state.es = null; }
      el('settings').hidden = true;
      showGate();
      toast('已解除配对');
    });

    var composer = el('composer');
    if (composer) {
      composer.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = el('composer-text').value.trim();
        if (!text) return;
        var target = null;
        for (var i = 0; i < state.sessions.length; i += 1) {
          if (state.sessions[i].running) { target = state.sessions[i].sessionId; break; }
        }
        el('composer-text').value = '';
        el('composer-text').style.height = 'auto';
        if (!navigator.onLine) {
          queueInstruction(text, target);
          toast('当前离线，指令已排队');
          return;
        }
        sendInstruction(text, target).then(function (ok) {
          if (ok) toast('已发送');
          else { queueInstruction(text, target); toast('发送失败，已排队重试', true); }
        });
      });
    }

    on('composer-stop', 'click', function () {
      var target = null;
      for (var i = 0; i < state.sessions.length; i += 1) {
        if (state.sessions[i].running) { target = state.sessions[i].sessionId; break; }
      }
      sendInstruction('/stop', target).then(function (ok) {
        toast(ok ? '已请求停止' : '停止失败', !ok);
      });
    });

    var area = el('composer-text');
    if (area) {
      area.addEventListener('input', function () {
        area.style.height = 'auto';
        area.style.height = Math.min(160, area.scrollHeight) + 'px';
      });
    }

    window.addEventListener('online', function () { state.retry = 0; probeThenConnect(); });
    window.addEventListener('offline', function () { setConn('offline'); });
    // A lock-screen tap can land on an already-open console, which navigates to
    // a new hash rather than reloading.
    window.addEventListener('hashchange', focusHashedDecision);

    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    // Register the push worker (no offline shell: an earlier cache-first worker
    // repeatedly served stale client code to a phone whose server had already
    // been updated, so this one installs no fetch handler and clears every
    // cache on activate). Registration is best-effort -- on a self-signed
    // certificate over a bare IP the browser may refuse a secure context, and
    // that must not break the page.
    if ('serviceWorker' in navigator && secure) {
      var hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then(function (registration) { return registration.update(); })
        .catch(function () { /* push unavailable; the page still works */ });
      // A new worker taking over an already-controlled page means the build
      // changed; reload once so the page stops running the previous script.
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController) return;
        if (sessionStorage.getItem('pulse.swreload') === '1') return;
        sessionStorage.setItem('pulse.swreload', '1');
        location.reload();
      });
    }

    on('push-enable', 'click', enablePush);
    on('settings-toggle', 'click', refreshPushStatus);

    // On the gate page there is no console. Reaching here means no code was in
    // the URL, so just leave the form ready for manual entry. Everything below
    // touches console-only nodes, so the return comes first.
    if (isGatePage) return;

    renderOutbox();

    if (state.device) probeThenConnect(); else showGate();

    // A phone left open on a desk should show current state, not stale state.
    setInterval(function () {
      if (document.visibilityState === 'visible' && Date.now() - state.lastFrameAt > 60000) refreshSnapshot();
    }, 45000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
}

/**
 * The stylesheet: dark by default, safe-area aware, touch-sized targets.
 * @returns {string} CSS.
 */
export function pulseStylesheet() {
  return `:root {
  --bg: #0b1220;
  --panel: #131c2e;
  --panel-2: #18233a;
  --text: #e8edf7;
  --muted: #8a97b1;
  --line: #22304c;
  --accent: #4d6bfe;
  --warn: #f0a33a;
  --bad: #ef5f5f;
  --ok: #3fbf7f;
  --radius: 14px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  padding-bottom: calc(84px + var(--safe-bottom));
  -webkit-text-size-adjust: 100%;
}
.bar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: calc(env(safe-area-inset-top, 0px) + 12px) 14px 12px;
  background: rgba(11, 18, 32, .92);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.title { font-weight: 650; letter-spacing: .2px; }
.bar-actions { display: flex; align-items: center; gap: 8px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot[data-state="live"] { background: var(--ok); box-shadow: 0 0 0 3px rgba(63,191,127,.18); }
.dot[data-state="connecting"] { background: var(--warn); animation: pulse 1.4s infinite; }
.dot[data-state="offline"] { background: var(--bad); }
.dot[data-state="unpaired"] { background: var(--muted); }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
.chip {
  font-size: 12px; padding: 3px 9px; border-radius: 999px;
  background: rgba(240,163,58,.16); color: var(--warn); border: 1px solid rgba(240,163,58,.35);
}
button {
  font: inherit; color: var(--text); background: var(--panel-2);
  border: 1px solid var(--line); border-radius: 10px;
  padding: 10px 14px; min-height: 42px; cursor: pointer;
}
button:active { transform: scale(.98); }
button:disabled { opacity: .5; }
button.icon { min-width: 42px; padding: 10px 12px; background: transparent; }
button.primary { background: var(--accent); border-color: var(--accent); }
button.danger { color: var(--bad); border-color: rgba(239,95,95,.4); }
main { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.panel-title {
  display: flex; align-items: center; justify-content: space-between;
  margin: 0; padding: 12px 14px; font-size: 13px; font-weight: 650;
  color: var(--muted); text-transform: none; letter-spacing: .3px;
  border-bottom: 1px solid var(--line);
}
.badge {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: rgba(77,107,254,.18); color: #a8b8ff;
}
.badge.muted { background: transparent; color: var(--muted); }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.empty { color: var(--muted); margin: 0; padding: 16px 14px; font-size: 13.5px; }

.gate { margin: 16px; padding: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.gate h1 { margin: 0 0 8px; font-size: 19px; }
.gate h2 { margin: 0 0 8px; font-size: 17px; }
.gate form { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.gate input {
  font: inherit; padding: 12px; border-radius: 10px; min-height: 46px;
  background: var(--bg); color: var(--text); border: 1px solid var(--line);
}
.gate button { background: var(--accent); border-color: var(--accent); font-weight: 600; }
.gate-body { display: block; padding-bottom: 0; }
.gate-body .gate { max-width: 460px; margin: 12vh auto 0; }
.warn { color: var(--warn); }

/* The entry into the full GUI, which is the phone's real workspace. */
a.enter {
  font-size: 13px; padding: 8px 12px; border-radius: 999px;
  background: var(--accent); color: #fff; text-decoration: none; white-space: nowrap;
}
.hero {
  display: block; padding: 16px; text-decoration: none; color: inherit;
  background: linear-gradient(135deg, rgba(77,107,254,.22), rgba(77,107,254,.06));
  border: 1px solid rgba(77,107,254,.4); border-radius: var(--radius);
}
.hero-title { display: block; font-weight: 680; font-size: 16px; }
.hero-sub { display: block; color: var(--muted); font-size: 12.5px; margin-top: 4px; }

.decision {
  padding: 14px; border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(240,163,58,.07), transparent);
}
.decision:last-child { border-bottom: 0; }
/* The card a lock-screen notification deep-linked to, so it is obvious which
   one the tap was about when the queue holds several. */
.decision.focused { box-shadow: inset 3px 0 0 var(--warn); background: linear-gradient(180deg, rgba(240,163,58,.16), transparent); }
.decision-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.decision-kind { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: rgba(240,163,58,.18); color: var(--warn); }
.decision-session { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.decision-title { font-weight: 600; word-break: break-word; }
.decision-detail { color: var(--muted); font-size: 13px; margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
.decision-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.decision-option.on { background: var(--accent); border-color: var(--accent); }
.decision-option.ghost { color: var(--muted); background: transparent; }
.artifacts { display: flex; flex-direction: column; }
.artifact { padding: 12px 14px; border-bottom: 1px solid var(--line); }
.artifact:last-child { border-bottom: 0; }
.artifact-head { display: flex; align-items: center; gap: 8px; }
.artifact-name { font-weight: 600; word-break: break-all; }
.artifact-kind { flex: none; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: rgba(90,160,255,.16); color: var(--accent); }
.artifact-path { margin-top: 4px; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.artifact-preview {
  margin: 8px 0 0; padding: 10px; max-height: 320px; overflow: auto;
  background: rgba(0,0,0,.28); border-radius: 8px;
  font-size: 12px; line-height: 1.5; color: var(--text); white-space: pre-wrap; word-break: break-word;
}
.artifact-image { display: block; margin-top: 8px; max-width: 100%; height: auto; border-radius: 8px; }
.artifact-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.artifact-open {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 36px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: transparent; color: var(--text);
  font: inherit; font-size: 13px; text-decoration: none;
}

.feed { max-height: 52vh; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.frame { display: flex; align-items: flex-start; gap: 9px; padding: 9px 14px; border-bottom: 1px solid rgba(34,48,76,.5); }
.frame:last-child { border-bottom: 0; }
.frame-icon { width: 16px; flex: none; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.6; }
.frame-body { flex: 1; min-width: 0; }
.frame-text { word-break: break-word; }
.frame-detail { color: var(--muted); font-size: 12.5px; margin-top: 3px; word-break: break-word; }
.frame-time { color: var(--muted); font-size: 11px; flex: none; padding-top: 2px; }
.sev-1 .frame-icon { color: var(--ok); }
.sev-2 .frame-icon { color: var(--warn); }
.sev-2 .frame-text { color: #ffdca8; }
.sev-3 { background: rgba(240,163,58,.08); }
.sev-3 .frame-icon { color: var(--warn); }

.status { padding: 6px 0; }
.session { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-bottom: 1px solid rgba(34,48,76,.5); }
.session:last-child { border-bottom: 0; }
.session-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
.session-meta { font-size: 12px; color: var(--muted); flex: none; }
.session.running .session-meta { color: var(--ok); }

.composer {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
  display: flex; align-items: flex-end; gap: 8px;
  padding: 10px 12px calc(10px + var(--safe-bottom));
  background: rgba(11,18,32,.94);
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--line);
}
.composer textarea {
  flex: 1; font: inherit; resize: none; max-height: 160px;
  padding: 11px 12px; border-radius: 12px; min-height: 46px;
  background: var(--bg); color: var(--text); border: 1px solid var(--line);
}
.composer button { flex: none; }
.composer .danger { color: var(--bad); }

.sheet { position: fixed; inset: 0; z-index: 40; background: rgba(4,8,16,.7); display: flex; align-items: flex-end; }
.sheet-body {
  width: 100%; max-height: 86vh; overflow-y: auto;
  background: var(--panel); border-radius: 18px 18px 0 0;
  border-top: 1px solid var(--line); padding: 18px 16px calc(18px + var(--safe-bottom));
}
.sheet h2 { margin: 0 0 14px; font-size: 17px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; margin: 0 0 16px; font-size: 13.5px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; word-break: break-all; text-align: right; }
.sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }

.toast {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(96px + var(--safe-bottom)); z-index: 50;
  background: var(--panel-2); border: 1px solid var(--line);
  padding: 10px 16px; border-radius: 999px; font-size: 13.5px;
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
.toast.bad { color: #ffc9c9; border-color: rgba(239,95,95,.45); }

@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f7fb; --panel: #ffffff; --panel-2: #eef2f8; --text: #14203a;
    --muted: #66738d; --line: #dde4ef;
  }
  .bar, .composer { background: rgba(245,247,251,.94); }
}
`;
}

/**
 * The web app manifest, so the phone can install the surface to its home screen.
 * @param {object} options - manifest options.
 * @param {string} options.realm - display name.
 * @returns {string} JSON.
 */
export function manifestJson({ realm }) {
  return JSON.stringify({
    name: realm,
    short_name: realm,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b1220',
    theme_color: '#0b1220',
    orientation: 'portrait',
    icons: [],
  });
}

/**
 * A minimal service worker. It caches only the shell; data always comes from
 * the network, because a stale activity feed is worse than no activity feed.
 * @returns {string} JavaScript source.
 */
/** User-facing denial copy, keyed by the auth layer's reason codes. */
export const ACCESS_DENIED = Object.freeze({
  locked: '尝试次数过多，请稍后再试',
  'no-open-pairing': '配对码已失效，请在电脑上重新生成',
  'bad-code': '配对码不正确',
  'device-limit': '已达到设备数量上限，请先在电脑上移除一台',
  'unknown-device': '设备未授权或已被移除',
  'bad-token': '设备凭据无效',
});
