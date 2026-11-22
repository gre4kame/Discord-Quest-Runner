import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuest, isExpired, describeQuest, estimateSeconds } from '../src/quests.js';

const NOW = Date.parse('2026-11-15T12:00:00+00:00');

export function playQuest(overrides = {}) {
  return {
    id: '1001',
    config: {
      config_version: 2,
      starts_at: '2026-11-01T00:00:00+00:00',
      expires_at: '2026-11-20T00:00:00+00:00',
      application: { id: 'app1', name: 'Basketball Zero' },
      assets: { hero: 'hero.jpg', game_tile: 'tile.jpg' },
      messages: { quest_name: 'Basketball Zero', game_title: 'Basketball Zero', game_publisher: 'Roblox' },
      task_config_v2: {
        join_operator: 'or',
        tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 900, applications: [{ id: 'app1' }] } },
      },
    },
    user_status: null,
    ...overrides,
  };
}

test('нормализует обычный play-квест', () => {
  const quest = normalizeQuest(playQuest(), NOW);
  assert.equal(quest.type, 'PLAY_ON_DESKTOP');
  assert.equal(quest.appId, 'app1');
  assert.equal(quest.target, 900);
  assert.equal(quest.value, 0);
  assert.equal(quest.active, true);
  assert.equal(quest.supported, true);
  assert.equal(quest.enrolled, false);
  assert.equal(quest.typeLabel, 'Играть');
  assert.equal(quest.game, 'Basketball Zero');
  assert.match(quest.image, /quests\/1001\/hero\.jpg$/);
  assert.equal(quest.runnableTasks.length, 1);
});

test('подхватывает прогресс и принятие из user_status', () => {
  const raw = playQuest({
    user_status: {
      enrolled_at: '2026-11-15T11:00:00+00:00',
      completed_at: null,
      claimed_at: null,
      progress: { PLAY_ON_DESKTOP: { value: 300, event_name: 'PLAY_ON_DESKTOP', completed_at: null } },
    },
  });
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.value, 300);
  assert.equal(quest.enrolled, true);
  assert.equal(quest.completed, false);
  assert.equal(describeQuest(quest, NOW), 'принят');
});

test('просроченный квест неактивен', () => {
  const raw = playQuest();
  raw.config.expires_at = '2026-11-10T00:00:00+00:00';
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.active, false);
  assert.equal(isExpired(quest, NOW), true);
  assert.equal(describeQuest(quest, NOW), 'истёк');
});

test('будущий квест ещё не активен', () => {
  const raw = playQuest();
  raw.config.starts_at = '2026-12-01T00:00:00+00:00';
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.active, false);
  assert.equal(describeQuest(quest, NOW), 'ещё не начался');
});

test('видео-квест маппится на video-режим', () => {
  const raw = playQuest();
  raw.config.task_config_v2.tasks = {
    WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 120, applications: [{ id: 'app1' }] },
  };
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.primary.mode, 'video');
  assert.equal(quest.typeLabel, 'Смотреть видео');
  assert.equal(quest.supported, true);
});

test('неподдерживаемый тип объясняет причину', () => {
  const raw = playQuest();
  raw.config.task_config_v2.tasks = {
    STREAM_ON_DESKTOP: { type: 'STREAM_ON_DESKTOP', target: 900, applications: [{ id: 'app1' }] },
  };
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.supported, false);
  assert.match(quest.primary.reason, /стрим/);
  assert.equal(quest.runnableTasks.length, 0);
});

test('без application_id квест не запускается', () => {
  const raw = playQuest();
  raw.config.application = {};
  raw.config.task_config_v2.tasks = { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 900 } };
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.supported, false);
  assert.match(quest.primary.reason, /application_id/);
});

test('join_operator=and даёт несколько задач', () => {
  const raw = playQuest();
  raw.config.task_config_v2.join_operator = 'and';
  raw.config.task_config_v2.tasks = {
    PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 900, applications: [{ id: 'app1' }] },
    WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60, applications: [{ id: 'app1' }] },
  };
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.runnableTasks.length, 2);
});

test('поддерживает старый task_config (v1)', () => {
  const raw = playQuest();
  delete raw.config.task_config_v2;
  raw.config.task_config = {
    tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600, applications: [{ id: 'app1' }] } },
  };
  raw.config.config_version = 1;
  const quest = normalizeQuest(raw, NOW);
  assert.equal(quest.target, 600);
  assert.equal(quest.supported, true);
});

test('оценка времени учитывает паузы', () => {
  const a = normalizeQuest(playQuest(), NOW);
  const b = normalizeQuest(playQuest({ id: '1002' }), NOW);
  const seconds = estimateSeconds([a, b], [2, 4]);
  assert.ok(seconds > 900 * 2);
});
