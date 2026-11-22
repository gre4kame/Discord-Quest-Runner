import http from 'node:http';

/** Мини-имитация Discord API для тестов движка. Считает каждый heartbeat за 1 секунду прогресса. */
export async function createMockDiscord({ quests, secondsPerBeat = 1 }) {
  const state = {
    quests: JSON.parse(JSON.stringify(quests)),
    enrolls: [],
    heartbeats: [],
    terminals: 0,
    videos: [],
    claims: [],
  };

  const find = (id) => state.quests.find((q) => q.id === id);
  const taskOf = (quest) => {
    const tasks = quest.config?.task_config_v2?.tasks || quest.config?.task_config?.tasks || {};
    const type = Object.keys(tasks)[0];
    return { type, task: tasks[type] };
  };
  const ensureStatus = (quest) => {
    if (!quest.user_status) quest.user_status = { enrolled_at: new Date().toISOString(), progress: {} };
    if (!quest.user_status.progress) quest.user_status.progress = {};
    return quest.user_status;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const json = () => {
        try {
          return JSON.parse(body || '{}');
        } catch {
          return {};
        }
      };
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === '/users/@me') return send(200, { id: '1', username: 'tester', global_name: 'Tester' });
      if (url.pathname === '/quests/@me') return send(200, { quests: state.quests });

      if (parts[0] === 'quests' && parts[2] === 'enroll') {
        const quest = find(parts[1]);
        if (!quest) return send(404, { message: 'Unknown Quest' });
        ensureStatus(quest);
        state.enrolls.push(parts[1]);
        return send(200, quest.user_status);
      }

      if (parts[0] === 'quests' && parts[2] === 'heartbeat') {
        const quest = find(parts[1]);
        if (!quest || !quest.user_status) return send(404, { message: 'Unknown Quest' });
        const payload = json();
        const { type, task } = taskOf(quest);
        const status = ensureStatus(quest);
        const entry = (status.progress[type] ||= { event_name: type, value: 0, completed_at: null });

        if (payload.terminal) {
          state.terminals++;
          state.heartbeats.push({ id: parts[1], terminal: true, application_id: payload.application_id });
          return send(200, { user_status: status });
        }

        state.heartbeats.push({ id: parts[1], terminal: false, application_id: payload.application_id });
        entry.value += secondsPerBeat;
        if (entry.value >= task.target) {
          entry.completed_at = new Date().toISOString();
          entry.value = task.target;
          status.completed_at = new Date().toISOString();
        }
        return send(200, { user_status: status });
      }

      if (parts[0] === 'quests' && parts[2] === 'video-progress') {
        const quest = find(parts[1]);
        if (!quest || !quest.user_status) return send(404, { message: 'Unknown Quest' });
        const payload = json();
        const { type, task } = taskOf(quest);
        const status = ensureStatus(quest);
        const entry = (status.progress[type] ||= { event_name: type, value: 0, completed_at: null });
        entry.value = Math.max(entry.value, Number(payload.timestamp) || 0);
        state.videos.push({ id: parts[1], timestamp: payload.timestamp });
        if (entry.value >= task.target) {
          entry.completed_at = new Date().toISOString();
          status.completed_at = new Date().toISOString();
        }
        return send(200, { user_status: status });
      }

      if (parts[0] === 'quests' && parts[2] === 'claim-reward') {
        const quest = find(parts[1]);
        if (!quest) return send(404, { message: 'Unknown Quest' });
        ensureStatus(quest).claimed_at = new Date().toISOString();
        state.claims.push(parts[1]);
        return send(200, { claimed_at: quest.user_status.claimed_at, entitlements: [], errors: [] });
      }

      send(404, { message: 'Not found', path: url.pathname });
    });
  });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
