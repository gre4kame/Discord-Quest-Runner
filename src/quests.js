import { formatDuration } from './timing.js';

export const TYPE_LABELS = {
  PLAY_ON_DESKTOP: 'Играть',
  PLAY_ON_DESKTOP_V2: 'Играть',
  WATCH_VIDEO: 'Смотреть видео',
  WATCH_VIDEO_ON_MOBILE: 'Смотреть видео',
  STREAM_ON_DESKTOP: 'Стримить',
  PLAY_ACTIVITY: 'Активность',
  PLAY_ON_XBOX: 'Xbox',
  PLAY_ON_PLAYSTATION: 'PlayStation',
  ACHIEVEMENT_IN_GAME: 'Достижение в игре',
  ACHIEVEMENT_IN_ACTIVITY: 'Достижение в активности',
};

const HEARTBEAT_TYPES = new Set(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);
const VIDEO_TYPES = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);

const UNSUPPORTED_REASON = {
  STREAM_ON_DESKTOP: 'нужен реальный стрим в голосовом канале',
  PLAY_ACTIVITY: 'нужно сидеть в голосовом канале с запущенной активностью',
  PLAY_ON_XBOX: 'только консоль Xbox',
  PLAY_ON_PLAYSTATION: 'только консоль PlayStation',
  ACHIEVEMENT_IN_GAME: 'достижение выдаёт сама игра',
  ACHIEVEMENT_IN_ACTIVITY: 'достижение выдаёт бэкенд активности',
};

const PRIORITY = [
  'PLAY_ON_DESKTOP',
  'PLAY_ON_DESKTOP_V2',
  'WATCH_VIDEO',
  'WATCH_VIDEO_ON_MOBILE',
  'STREAM_ON_DESKTOP',
  'PLAY_ACTIVITY',
  'PLAY_ON_XBOX',
  'PLAY_ON_PLAYSTATION',
  'ACHIEVEMENT_IN_GAME',
  'ACHIEVEMENT_IN_ACTIVITY',
];

export function taskMode(type) {
  if (HEARTBEAT_TYPES.has(type)) return 'heartbeat';
  if (VIDEO_TYPES.has(type)) return 'video';
  return null;
}

function parseTs(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function cdnQuestAsset(questId, asset) {
  if (!asset) return null;
  return `https://cdn.discordapp.com/quests/${questId}/${asset}`;
}

function pickImage(cfg, id) {
  const assets = cfg.assets || {};
  return (
    cdnQuestAsset(id, assets.hero) ||
    cdnQuestAsset(id, assets.quest_bar_hero) ||
    cdnQuestAsset(id, assets.game_tile) ||
    cdnQuestAsset(id, assets.logotype) ||
    null
  );
}

export function normalizeQuest(raw, now = Date.now()) {
  const cfg = raw.config || {};
  const messages = cfg.messages || {};
  const app = cfg.application || {};
  const taskConfig = cfg.task_config_v2 || cfg.task_config || {};
  const rawTasks = taskConfig.tasks || {};

  const ordered = [...PRIORITY.filter((t) => rawTasks[t]), ...Object.keys(rawTasks).filter((t) => !PRIORITY.includes(t))];

  const userStatus = raw.user_status || {};
  const progressMap = userStatus.progress || {};

  const tasks = ordered.map((type) => {
    const task = rawTasks[type] || {};
    const appId = task.applications?.[0]?.id || app.id || null;
    const progress = progressMap[type] || {};
    return {
      type,
      label: TYPE_LABELS[type] || type,
      mode: taskMode(type),
      target: Number(task.target) || 0,
      value: Number(progress.value) || 0,
      appId,
      supported: Boolean(appId) && Boolean(taskMode(type)),
      reason: taskMode(type) ? (appId ? null : 'Discord не вернул application_id') : UNSUPPORTED_REASON[type] || 'неизвестный тип задания',
    };
  });

  const primary = tasks.find((t) => t.supported) || tasks[0] || null;
  const startsAt = parseTs(cfg.starts_at);
  const expiresAt = parseTs(cfg.expires_at);
  const active = !raw.preview && (!startsAt || startsAt <= now) && (!expiresAt || expiresAt > now);

  return {
    id: raw.id,
    name: messages.quest_name || messages.game_title || app.name || 'Квест',
    game: messages.game_title || app.name || null,
    publisher: messages.game_publisher || null,
    image: pickImage(cfg, raw.id),
    tasks,
    primary,
    type: primary?.type || null,
    typeLabel: primary ? primary.label : '—',
    supported: tasks.some((t) => t.supported),
    target: primary?.target || 0,
    value: primary?.value || 0,
    appId: primary?.appId || null,
    enrolled: Boolean(userStatus.enrolled_at),
    enrolledAt: parseTs(userStatus.enrolled_at),
    completed: Boolean(userStatus.completed_at),
    claimed: Boolean(userStatus.claimed_at),
    startsAt,
    expiresAt,
    active,
    preview: Boolean(raw.preview),
    remainingSeconds: expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null,
    runnableTasks:
      taskConfig.join_operator === 'and' ? tasks.filter((t) => t.supported) : primary?.supported ? [primary] : [],
  };
}

export function isExpired(quest, now = Date.now()) {
  return Boolean(quest.expiresAt && quest.expiresAt <= now);
}

export function progressText(quest) {
  if (!quest.target) return '—';
  const done = Math.min(quest.value, quest.target);
  return `${formatDuration(done)} / ${formatDuration(quest.target)}`;
}

/** За сколько примерно закроется набор квестов: время задания + средние паузы между ними. */
export function estimateSeconds(quests, gapRange = [2, 7]) {
  if (!quests.length) return 0;
  const avgGap = ((gapRange[0] + gapRange[1]) / 2) * 60;
  return quests.reduce((sum, q) => sum + (q.target || 0) + 40, 0) + avgGap * Math.max(0, quests.length - 1);
}

export function describeQuest(quest, now = Date.now()) {
  if (quest.claimed) return 'награда получена';
  if (quest.completed) return 'выполнен, забери награду';
  if (!quest.active) return quest.expiresAt && quest.expiresAt <= now ? 'истёк' : 'ещё не начался';
  if (!quest.supported) return quest.primary?.reason || 'не поддерживается';
  if (quest.enrolled) return 'принят';
  return 'ждёт принятия';
}
