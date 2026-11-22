const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}ч ${String(m).padStart(2, '0')}м`;
  if (m) return `${m}м ${String(s % 60).padStart(2, '0')}с`;
  return `${s}с`;
}

function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function progressText(quest) {
  if (!quest.target) return '—';
  return `${formatDuration(Math.min(quest.value, quest.target))} / ${formatDuration(quest.target)}`;
}

function expiryText(quest) {
  if (!quest.expiresAt) return '';
  const left = quest.expiresAt - Date.now();
  if (left <= 0) return 'истёк';
  return `ещё ${formatDuration(left / 1000)}`;
}

function statusClass(quest) {
  if (quest.claimed || quest.completed) return 'ok';
  if (!quest.active) return 'bad';
  if (!quest.supported) return 'warn';
  if (quest.enrolled) return 'run';
  return 'warn';
}

const app = {
  snap: null,
  selected: new Set(),
  initialized: false,
  lastSeq: 0,
  signature: '',
  timer: null,
  busy: false,
};

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, 4200);
}

/* ── render ─────────────────────────────────────────────── */

function render(snap) {
  app.snap = snap;

  const box = $('#userbox');
  if (snap.user) {
    box.className = 'userbox on';
    box.innerHTML = `
      ${snap.user.avatar ? `<img src="${esc(snap.user.avatar)}" alt="" />` : '<span class="dot"></span>'}
      <b>${esc(snap.user.globalName)}</b>
      <span class="tag">${esc(snap.user.id)}</span>`;
  } else {
    box.className = 'userbox';
    box.innerHTML = snap.tokenPresent
      ? '<span class="dot"></span><span class="muted">токен есть, нет связи</span>'
      : '<span class="dot"></span><span class="muted">нет токена</span>';
  }

  const running = snap.phase === 'running' || snap.phase === 'stopping';
  $('#btnStart').disabled = running || app.busy || !snap.tokenPresent;
  $('#btnStart').classList.toggle('hidden', running);
  $('#btnStop').classList.toggle('hidden', !running);
  $('#btnStop').disabled = snap.phase === 'stopping';
  $('#btnRefresh').disabled = running || app.busy;

  const phase = $('#phase');
  phase.textContent = { idle: 'ожидание', running: 'работает', stopping: 'остановка' }[snap.phase] || snap.phase;
  phase.className = `phase ${snap.phase}`;

  renderBanner(snap);
  renderStats(snap);
  renderQuests(snap);
  renderSession(snap);
}

function renderBanner(snap) {
  const banner = $('#banner');
  let text = '';
  let kind = '';

  if (snap.warning) {
    text = snap.warning;
    kind = 'error';
  } else if (snap.enrollmentBlockedUntil && snap.enrollmentBlockedUntil > Date.now()) {
    text = `Discord временно запретил запись на квесты до ${formatDateTime(snap.enrollmentBlockedUntil)}. Это ограничение на стороне Discord.`;
  } else if (!snap.tokenPresent) {
    text = 'Токен Discord не задан. Открой «Настройки» и вставь user token — без него программа ничего не увидит.';
    kind = 'info';
  } else if (snap.lastError) {
    text = snap.lastError;
    kind = 'error';
  }

  banner.textContent = text;
  banner.className = `banner ${kind} ${text ? '' : 'hidden'}`;
}

function eligible(quest) {
  return quest.active && !quest.completed && !quest.claimed && quest.supported && quest.runnableTasks?.length;
}

function renderStats(snap) {
  const active = snap.quests.filter((q) => q.active && !q.completed && !q.claimed);
  const runnable = active.filter((q) => q.supported && q.runnableTasks?.length);
  const selectedQuests = runnable.filter((q) => app.selected.has(q.id));
  const sum = selectedQuests.reduce((total, q) => total + (q.target || 0) + 40, 0);
  const gaps = selectedQuests.length > 1 ? (snap.config.engine.gapMinutes[0] + snap.config.engine.gapMinutes[1]) / 2 * 60 * (selectedQuests.length - 1) : 0;
  const estimate = sum + gaps;

  $('#stats').innerHTML = `
    <div class="stat"><div class="label">Активных</div><div class="value">${active.length}</div></div>
    <div class="stat"><div class="label">Выполнимых</div><div class="value">${runnable.length}</div></div>
    <div class="stat"><div class="label">Выбрано</div><div class="value">${selectedQuests.length}</div></div>
    <div class="stat"><div class="label">Примерно по времени</div><div class="value">${estimate ? formatDuration(estimate) : '—'}</div></div>`;

  $('#questCount').textContent = `· ${snap.quests.length}`;
}

function questCard(quest) {
  const disabled = !eligible(quest);
  const checked = app.selected.has(quest.id);
  const mode = quest.primary?.mode || '';
  const reason = quest.primary?.reason || '';
  const image = quest.image ? `style="background-image:url('${esc(quest.image)}')"` : '';

  return `
    <article class="quest ${disabled ? 'is-disabled' : ''}" data-id="${esc(quest.id)}">
      <div class="quest-media" ${image}>
        <div class="media-fade"></div>
        <span class="chip ${mode}">${esc(quest.typeLabel)}</span>
        <label class="pick" title="${disabled ? esc(reason || 'недоступно') : 'выбрать'}">
          <input type="checkbox" data-pick="${esc(quest.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
          <span></span>
        </label>
      </div>
      <div class="quest-body">
        <h3 title="${esc(quest.name)}">${esc(quest.name)}</h3>
        <p class="sub">${esc(quest.game || '')}${quest.publisher ? ' · ' + esc(quest.publisher) : ''}</p>
        <div class="meter"><div class="meter-fill" data-fill="${esc(quest.id)}" style="width:${quest.progressPct || 0}%"></div></div>
        <div class="meta-row">
          <span data-progress="${esc(quest.id)}">${progressText(quest)}</span>
          <span data-expiry="${esc(quest.id)}">${expiryText(quest)}</span>
        </div>
        <div class="foot">
          <span class="status ${statusClass(quest)}" data-status="${esc(quest.id)}" ${reason ? `title="${esc(reason)}"` : ''}>${esc(quest.statusText)}</span>
          <span class="muted small">${quest.supported ? (quest.enrolled ? 'принято' : 'не принято') : 'не поддерживается'}</span>
        </div>
      </div>
    </article>`;
}

function renderQuests(snap) {
  if (!app.initialized && snap.quests.length) {
    for (const quest of snap.quests) if (eligible(quest)) app.selected.add(quest.id);
    app.initialized = true;
  }

  const bigSig = snap.quests
    .map((q) => `${q.id}:${q.enrolled ? 1 : 0}${q.completed ? 1 : 0}${q.claimed ? 1 : 0}${q.active ? 1 : 0}${q.supported ? 1 : 0}`)
    .join('|');

  if (bigSig !== app.signature) {
    app.signature = bigSig;
    $('#quests').innerHTML = snap.quests.map(questCard).join('');
  }

  for (const quest of snap.quests) {
    const fill = $(`[data-fill="${quest.id}"]`);
    if (fill) fill.style.width = `${quest.progressPct || 0}%`;
    const progress = $(`[data-progress="${quest.id}"]`);
    if (progress) progress.textContent = progressText(quest);
    const expiry = $(`[data-expiry="${quest.id}"]`);
    if (expiry) expiry.textContent = expiryText(quest);
    const status = $(`[data-status="${quest.id}"]`);
    if (status) {
      status.textContent = quest.statusText;
      status.className = `status ${statusClass(quest)}`;
    }
  }

  const empty = $('#empty');
  empty.classList.toggle('hidden', snap.quests.length > 0);
  if (!snap.quests.length) {
    $('#emptyText').textContent = snap.tokenPresent
      ? 'Квестов нет или они не загрузились. Нажми «Обновить».'
      : 'Сначала вставь токен Discord в настройках.';
  }

  const runnable = snap.quests.filter(eligible);
  const checkAll = $('#checkAll');
  checkAll.checked = runnable.length > 0 && runnable.every((q) => app.selected.has(q.id));
  checkAll.indeterminate = !checkAll.checked && runnable.some((q) => app.selected.has(q.id));
}

function renderSession(snap) {
  const box = $('#sessionInfo');
  const session = snap.session;

  if (!session) {
    box.innerHTML = `
      <div class="session-empty">
        Сессия не запущена. Выбери задания и нажми «Старт» — программа сама примет их
        и будет держать прогресс, пока каждый не закроется.
      </div>`;
    return;
  }

  const running = !session.finishedAt;
  const current = snap.quests.find((q) => q.id === session.currentId);
  const elapsed = ((session.finishedAt || Date.now()) - session.startedAt) / 1000;

  let currentHtml = '';
  if (running) {
    if (current) {
      currentHtml = `
        <div class="session-current">
          <div class="name">${esc(current.name)}</div>
          <div class="line">${esc(current.typeLabel)} · ${progressText(current)} ${current.target ? `(${Math.min(100, Math.round((current.value / current.target) * 100))}%)` : ''}</div>
          <div class="meter" style="margin-top:8px"><div class="meter-fill" style="width:${current.progressPct || 0}%"></div></div>
        </div>`;
    } else if (session.nextAt) {
      const left = Math.max(0, (session.nextAt - Date.now()) / 1000);
      currentHtml = `
        <div class="session-current">
          <div class="name">Пауза перед следующим квестом</div>
          <div class="line">≈ ${formatDuration(left)} · так выглядит «человечнее»</div>
        </div>`;
    } else {
      currentHtml = '<div class="session-current"><div class="name">Готовлю следующий квест…</div></div>';
    }
  }

  const statusLabel = {
    completed: ['готово', 'ok'],
    failed: ['ошибка', 'bad'],
    skipped: ['пропуск', 'warn'],
    incomplete: ['недобрал', 'warn'],
    stopped: ['остановлен', 'warn'],
  };

  const queue = session.queue
    .map((item) => {
      const result = session.results.find((r) => r.questId === item.id);
      const isCurrent = running && session.currentId === item.id;
      const [label, kind] = result
        ? statusLabel[result.status] || ['—', '']
        : running
          ? ['в очереди', '']
          : ['не начат', ''];
      return `<div class="queue-item ${isCurrent ? 'current' : ''}">
        <span class="q-name">${esc(item.name)}</span>
        <span class="q-state ${kind}">${isCurrent && !result ? 'идёт' : label}</span>
      </div>`;
    })
    .join('');

  const summary = `
    <div class="summary">
      <div><span>Прошло</span><b>${formatDuration(elapsed)}</b></div>
      <div><span>Выполнено</span><b>${session.completed} / ${session.queue.length}</b></div>
    </div>`;

  const unfinished = session.results.filter((r) => ['failed', 'incomplete'].includes(r.status));
  const notes = unfinished.length
    ? `<div class="muted small">${unfinished
        .slice(0, 4)
        .map((r) => `${esc(r.name)}: ${esc(r.note || '')}`)
        .join('<br>')}</div>`
    : '';

  box.innerHTML = `
    ${currentHtml}
    ${summary}
    <div class="queue">${queue}</div>
    ${notes}
    ${!running ? '<div class="muted small">Сессия завершена. Награды забирай в Discord: Настройки → Подарки.</div>' : ''}`;
}

/* ── logs ───────────────────────────────────────────────── */

function appendLogs(lines) {
  const box = $('#log');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (const line of lines) {
    const node = document.createElement('div');
    node.className = `log-line ${line.level}`;
    const time = new Date(line.t).toLocaleTimeString('ru-RU', { hour12: false });
    node.innerHTML = `<span class="t">${time}</span><span class="m">${esc(line.message)}</span>`;
    box.append(node);
  }
  while (box.childElementCount > 300) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/* ── polling ────────────────────────────────────────────── */

async function poll() {
  clearTimeout(app.timer);
  try {
    const snap = await request('/api/state');
    render(snap);
    const logs = await request(`/api/logs?since=${app.lastSeq}`);
    if (logs.lines?.length) {
      app.lastSeq = logs.lines[logs.lines.length - 1].seq;
      appendLogs(logs.lines);
    }
  } catch (err) {
    const banner = $('#banner');
    banner.textContent = `Нет связи с локальным сервером: ${err.message}`;
    banner.className = 'banner error';
  }
  const running = app.snap?.phase === 'running' || app.snap?.phase === 'stopping';
  app.timer = setTimeout(poll, running ? 1000 : 2500);
}

/* ── settings ───────────────────────────────────────────── */

function fillSettings(config) {
  const form = $('#settingsForm');
  form.token.value = '';
  form.token.placeholder = config.token.present ? `сохранён: ${config.token.masked}` : 'вставь токен';
  form.autoStart.checked = config.engine.autoStart;
  form.autoEnroll.checked = config.engine.autoEnroll;
  form.autoClaim.checked = config.engine.autoClaim;
  form.keepAwake.checked = config.engine.keepAwake;
  form.hbMin.value = config.engine.heartbeatSeconds[0];
  form.hbMax.value = config.engine.heartbeatSeconds[1];
  form.videoMin.value = config.engine.videoTickMs[0];
  form.videoMax.value = config.engine.videoTickMs[1];
  form.overMin.value = config.engine.overshootSeconds[0];
  form.overMax.value = config.engine.overshootSeconds[1];
  form.startMin.value = config.engine.startDelaySeconds[0];
  form.startMax.value = config.engine.startDelaySeconds[1];
  form.closeMin.value = config.engine.closeDelaySeconds[0];
  form.closeMax.value = config.engine.closeDelaySeconds[1];
  form.gapMin.value = config.engine.gapMinutes[0];
  form.gapMax.value = config.engine.gapMinutes[1];
  form.maxQuests.value = config.engine.maxQuestsPerSession;
  const net = config.network || {};
  const netNote = net.active && net.proxy ? ` · прокси ${net.proxy}` : '';
  $('#tokenStatus').textContent = (config.token.present ? `токен ${config.token.masked}` : 'токен не задан') + netNote;
  form.proxy.value = net.configured || '';
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.target;
  const num = (name) => Number(form[name].value);
  const patch = {
    engine: {
      autoStart: form.autoStart.checked,
      autoEnroll: form.autoEnroll.checked,
      autoClaim: form.autoClaim.checked,
      keepAwake: form.keepAwake.checked,
      heartbeatSeconds: [num('hbMin'), num('hbMax')],
      videoTickMs: [num('videoMin'), num('videoMax')],
      overshootSeconds: [num('overMin'), num('overMax')],
      startDelaySeconds: [num('startMin'), num('startMax')],
      closeDelaySeconds: [num('closeMin'), num('closeMax')],
      gapMinutes: [num('gapMin'), num('gapMax')],
      maxQuestsPerSession: num('maxQuests'),
    },
  };
  if (form.token.value.trim()) patch.token = form.token.value.trim();

  const proxy = form.proxy.value.trim();
  const proxyChanged = proxy !== (app.snap?.config?.network?.configured || '');
  if (proxyChanged) patch.network = { proxy };

  try {
    app.busy = true;
    const result = await request('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    fillSettings(result.config);
    $('#settings').close();
    app.initialized = false;
    await request('/api/refresh', { method: 'POST' }).catch(() => {});
    toast('Настройки сохранены', 'ok');
    if (proxyChanged) toast('Прокси применится после перезапуска программы', 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    app.busy = false;
    poll();
  }
}

/* ── actions ────────────────────────────────────────────── */

async function start() {
  const runnable = (app.snap?.quests || []).filter(eligible);
  let ids = runnable.filter((q) => app.selected.has(q.id)).map((q) => q.id);
  if (!ids.length) {
    ids = runnable.map((q) => q.id);
    ids.forEach((id) => app.selected.add(id));
  }
  if (!ids.length) {
    toast('Нет доступных заданий для запуска', 'error');
    return;
  }
  try {
    app.busy = true;
    await request('/api/session/start', { method: 'POST', body: JSON.stringify({ questIds: ids }) });
    toast(`Запущено заданий: ${ids.length}`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    app.busy = false;
    poll();
  }
}

async function stop() {
  try {
    app.busy = true;
    await request('/api/session/stop', { method: 'POST' });
    toast('Останавливаю…');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    app.busy = false;
    poll();
  }
}

async function refreshQuests() {
  try {
    app.busy = true;
    await request('/api/refresh', { method: 'POST' });
    toast('Список заданий обновлён', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    app.busy = false;
    app.initialized = false;
    poll();
  }
}

/* ── wiring ─────────────────────────────────────────────── */

$('#btnStart').addEventListener('click', start);
$('#btnStop').addEventListener('click', stop);
$('#btnRefresh').addEventListener('click', refreshQuests);

$('#btnSettings').addEventListener('click', () => {
  if (app.snap?.config) fillSettings(app.snap.config);
  $('#settings').showModal();
});

$('#btnClearLog').addEventListener('click', () => {
  $('#log').innerHTML = '';
});

$$('[data-close]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const dialog = document.getElementById(btn.dataset.close);
    dialog?.close();
  }),
);

$('#settingsForm').addEventListener('submit', saveSettings);

$('#quests').addEventListener('change', (event) => {
  const id = event.target.dataset?.pick;
  if (!id) return;
  if (event.target.checked) app.selected.add(id);
  else app.selected.delete(id);
  if (app.snap) renderStats(app.snap);
});

$('#checkAll').addEventListener('change', (event) => {
  const runnable = (app.snap?.quests || []).filter(eligible);
  if (event.target.checked) runnable.forEach((q) => app.selected.add(q.id));
  else runnable.forEach((q) => app.selected.delete(q.id));
  app.signature = '';
  if (app.snap) {
    renderQuests(app.snap);
    renderStats(app.snap);
  }
});

$('#btnSelftest').addEventListener('click', async () => {
  const status = $('#tokenStatus');
  const token = $('#settingsForm').token.value.trim();
  status.textContent = 'проверяю…';
  try {
    const result = await request('/api/selftest', {
      method: 'POST',
      body: JSON.stringify(token ? { token } : {}),
    });
    status.textContent = `ок: ${result.user.globalName}, квестов ${result.quests}`;
    toast(`Токен рабочий. Доступных квестов: ${result.available}`, 'ok');
  } catch (err) {
    status.textContent = err.message;
    toast(err.message, 'error');
  }
});

$('#btnClearToken').addEventListener('click', async () => {
  try {
    await request('/api/config', { method: 'POST', body: JSON.stringify({ clearToken: true }) });
    $('#settingsForm').token.value = '';
    $('#tokenStatus').textContent = 'токен удалён';
    app.initialized = false;
    toast('Токен удалён');
    poll();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#settings').addEventListener('click', (event) => {
  if (event.target.id === 'settings') event.target.close();
});

poll();
