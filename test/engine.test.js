import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { createMockDiscord } from './mock-discord.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function baseQuest(id) {
  return {
    id,
    config: {
      config_version: 2,
      starts_at: '2020-01-01T00:00:00+00:00',
      expires_at: '2099-01-01T00:00:00+00:00',
      application: { id: 'app1', name: 'Basketball Zero' },
      assets: { hero: 'hero.jpg' },
      messages: { quest_name: `Quest ${id}`, game_title: 'Basketball Zero' },
      task_config_v2: {
        join_operator: 'or',
        tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 3, applications: [{ id: 'app1' }] } },
      },
    },
    user_status: null,
  };
}

function makeCfg(apiBase, overrides = {}) {
  return {
    discord: { token: 'test-token', apiVersion: 10, apiBase },
    engine: {
      autoStart: false,
      autoEnroll: true,
      autoClaim: false,
      startDelaySeconds: [0, 0],
      heartbeatSeconds: [0.01, 0.02],
      videoTickMs: [10, 20],
      overshootSeconds: [0, 0],
      closeDelaySeconds: [0, 0],
      gapMinutes: [0, 0],
      pauseChance: 0,
      maxQuestsPerSession: 5,
      keepAwake: false,
      ...overrides,
    },
  };
}

async function waitFor(predicate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('Не дождались условия за ' + timeout + 'мс');
}

test('PLAY_ON_DESKTOP: принимает квест, шлёт heartbeat и закрывает сессию terminal-ом', async () => {
  const mock = await createMockDiscord({ quests: [baseQuest('1001')] });
  const cfg = makeCfg(mock.url);
  const engine = new Engine({ cfg, logger: silent });

  try {
    await engine.start();
    await waitFor(() => engine.session?.finishedAt);

    assert.deepEqual(mock.state.enrolls, ['1001']);
    assert.ok(mock.state.heartbeats.length >= 3, 'мало heartbeat-ов');
    assert.equal(mock.state.heartbeats.at(-1).terminal, true);
    assert.equal(mock.state.heartbeats[0].application_id, 'app1');
    assert.equal(engine.quests[0].completed, true);
    assert.equal(engine.session.completed, 1);
    assert.equal(engine.session.results.at(-1).status, 'completed');
    assert.equal(engine.phase, 'idle');
  } finally {
    await mock.close();
  }
});

test('WATCH_VIDEO: досматривает видео и отмечает выполнение', async () => {
  const quest = baseQuest('2002');
  quest.config.task_config_v2.tasks = {
    WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 30, applications: [{ id: 'app1' }] },
  };
  quest.user_status = { enrolled_at: new Date().toISOString(), progress: {} };

  const mock = await createMockDiscord({ quests: [quest] });
  const engine = new Engine({ cfg: makeCfg(mock.url), logger: silent });

  try {
    await engine.start();
    await waitFor(() => engine.session?.finishedAt);

    assert.ok(mock.state.videos.length >= 2, 'видео-прогресс не отправлялся');
    assert.ok(mock.state.videos.at(-1).timestamp >= 30);
    assert.equal(engine.quests[0].completed, true);
    assert.equal(mock.state.enrolls.length, 0, 'уже принятый квест не должен переприниматься');
  } finally {
    await mock.close();
  }
});

test('автонаграда: claim-reward вызывается только когда включён', async () => {
  const mock = await createMockDiscord({ quests: [baseQuest('3003')] });
  const engine = new Engine({ cfg: makeCfg(mock.url, { autoClaim: true }), logger: silent });

  try {
    await engine.start();
    await waitFor(() => engine.session?.finishedAt);
    assert.deepEqual(mock.state.claims, ['3003']);
    assert.equal(engine.quests[0].claimed, true);
  } finally {
    await mock.close();
  }
});

test('без autoEnroll квест пропускается с понятной причиной', async () => {
  const mock = await createMockDiscord({ quests: [baseQuest('4004')] });
  const engine = new Engine({ cfg: makeCfg(mock.url, { autoEnroll: false }), logger: silent });

  try {
    await engine.start();
    await waitFor(() => engine.session?.finishedAt);
    assert.equal(mock.state.enrolls.length, 0);
    assert.equal(engine.session.results[0].status, 'failed');
    assert.match(engine.session.results[0].note, /автопринятие/);
  } finally {
    await mock.close();
  }
});

test('стоп посреди квеста отправляет terminal и фиксирует остановку', async () => {
  const quest = baseQuest('5005');
  quest.config.task_config_v2.tasks.PLAY_ON_DESKTOP.target = 9999;
  const mock = await createMockDiscord({ quests: [quest] });
  const engine = new Engine({ cfg: makeCfg(mock.url), logger: silent });

  try {
    await engine.start();
    await waitFor(() => mock.state.heartbeats.length >= 1);
    await engine.stop();
    await waitFor(() => engine.session?.finishedAt);

    assert.equal(mock.state.terminals, 1);
    assert.equal(engine.phase, 'idle');
    assert.equal(engine.session.results.at(-1).status, 'stopped');
  } finally {
    await mock.close();
  }
});

test('квест без активных заданий не даёт стартовать', async () => {
  const quest = baseQuest('6006');
  quest.config.expires_at = '2021-01-01T00:00:00+00:00';
  const mock = await createMockDiscord({ quests: [quest] });
  const engine = new Engine({ cfg: makeCfg(mock.url), logger: silent });

  try {
    await assert.rejects(() => engine.start(), /Нет квестов/);
    assert.equal(engine.session, null);
  } finally {
    await mock.close();
  }
});
