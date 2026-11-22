import { EventEmitter } from 'node:events';
import { QuestApi, DiscordError } from './discord.js';
import { normalizeQuest, isExpired, describeQuest } from './quests.js';
import { jitter, rand, randInt, sleep, maybePause, formatDuration } from './timing.js';

const sleepSafe = (ms, signal) => sleep(ms, signal);

function readProgress(status, type) {
  const progress = status?.progress || {};
  const entry = progress[type] || Object.values(progress)[0] || {};
  return { value: Number(entry.value) || 0, completed: Boolean(entry.completed_at) };
}

export class Engine extends EventEmitter {
  constructor({ cfg, logger, apiFactory = null, keepawake = null }) {
    super();
    this.cfg = cfg;
    this.logger = logger;
    this.apiFactory = apiFactory;
    this.keepawake = keepawake;
    this.api = null;
    this.apiToken = null;
    this.user = null;
    this.rawQuests = new Map();
    this.quests = [];
    this.excludedCount = 0;
    this.enrollmentBlockedUntil = null;
    this.warning = null;
    this.phase = 'idle';
    this.session = null;
    this.abortController = null;
    this.lastRefresh = 0;
    this.lastError = null;
  }

  get token() {
    return String(this.cfg.discord.token || '').trim();
  }

  ensureApi() {
    if (!this.token) throw new Error('Не задан токен Discord');
    if (!this.api || this.apiToken !== this.token) {
      this.api =
        this.apiFactory?.(this.token) ||
        new QuestApi({
          token: this.token,
          apiVersion: this.cfg.discord.apiVersion || 10,
          apiBase: this.cfg.discord.apiBase || null,
          logger: this.logger,
        });
      this.apiToken = this.token;
    }
    return this.api;
  }

  async connect() {
    const api = this.ensureApi();
    const me = await api.me();
    this.user = {
      id: me.id,
      username: me.username,
      globalName: me.global_name || me.username,
      avatar: me.avatar
        ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
        : null,
    };
    this.logger.info(`Вход выполнен: ${this.user.globalName} (${this.user.id})`);
    return this.user;
  }

  async refresh() {
    const api = this.ensureApi();
    if (!this.user) await this.connect();
    const data = await api.quests();
    const list = Array.isArray(data.quests) ? data.quests : [];
    const now = Date.now();

    this.rawQuests = new Map(list.map((q) => [q.id, q]));
    this.quests = list.map((q) => normalizeQuest(q, now)).sort((a, b) => {
      if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const ax = a.expiresAt ?? Number.MAX_SAFE_INTEGER;
      const bx = b.expiresAt ?? Number.MAX_SAFE_INTEGER;
      return ax - bx;
    });
    this.excludedCount = Array.isArray(data.excluded_quests) ? data.excluded_quests.length : 0;

    const blocked = data.quest_enrollment_blocked_until ? Date.parse(data.quest_enrollment_blocked_until) : null;
    this.enrollmentBlockedUntil = Number.isFinite(blocked) ? blocked : null;
    if (this.enrollmentBlockedUntil && this.enrollmentBlockedUntil > now) {
      this.logger.warn(
        `Discord временно запретил записываться на квесты до ${new Date(this.enrollmentBlockedUntil).toLocaleString('ru-RU')}`,
      );
    }

    this.lastRefresh = now;
    this.lastError = null;
    this.logger.info(
      `Квестов получено: ${this.quests.length} (активных ${this.quests.filter((q) => q.active && !q.claimed && !q.completed).length})`,
    );
    this.emit('change');
    return this.quests;
  }

  updateQuest(id, patch) {
    const quest = this.quests.find((q) => q.id === id);
    if (!quest) return;
    Object.assign(quest, patch);
    if (patch.enrolled) quest.statusText = describeQuest(quest);
    this.emit('change');
  }

  recordResult(session, quest, status, note = null) {
    session.results.push({
      questId: quest.id,
      name: quest.name,
      type: quest.type,
      typeLabel: quest.typeLabel,
      value: quest.value,
      target: quest.target,
      status,
      note,
      at: Date.now(),
    });
    this.emit('change');
  }

  async start({ questIds = null, auto = false } = {}) {
    if (this.session && !this.session.finishedAt) throw new Error('Сессия уже запущена');
    if (!this.token) throw new Error('Сначала вставь токен Discord в настройках');

    const cfg = this.cfg.engine;
    await this.refresh();

    let candidates = this.quests.filter(
      (q) => q.active && !q.claimed && !q.completed && q.supported && q.runnableTasks.length > 0,
    );
    if (Array.isArray(questIds) && questIds.length) {
      const wanted = new Set(questIds);
      candidates = candidates.filter((q) => wanted.has(q.id));
    }
    candidates = candidates.slice(0, Math.max(1, Number(cfg.maxQuestsPerSession) || 8));

    if (!candidates.length) {
      throw new Error('Нет квестов, которые можно выполнить (нет активных, поддерживаемых или уже всё сделано)');
    }

    this.abortController = new AbortController();
    this.session = {
      startedAt: Date.now(),
      finishedAt: null,
      auto,
      queue: candidates.map((q) => ({ id: q.id, name: q.name })),
      currentId: null,
      currentSince: null,
      results: [],
      nextAt: null,
      stopRequested: false,
      completed: 0,
      failed: 0,
    };
    this.phase = 'running';
    this.warning = null;

    this.logger.info(
      `Сессия: ${candidates.length} квест(ов) — ${candidates.map((q) => q.name).join(', ')}`,
    );
    this.keepawake?.start();
    this.runLoop(candidates, this.session).catch((err) => {
      this.logger.error(`Сессия упала: ${err.message}`);
      this.lastError = err.message;
    });
    this.emit('change');
    return this.sessionSnapshot();
  }

  async stop() {
    if (!this.session || this.session.finishedAt) return false;
    this.session.stopRequested = true;
    this.phase = 'stopping';
    this.abortController?.abort();
    this.logger.warn('Останавливаю сессию…');
    this.emit('change');
    return true;
  }

  async runLoop(candidates, session) {
    const signal = this.abortController.signal;
    const cfg = this.cfg.engine;
    try {
      for (let index = 0; index < candidates.length; index++) {
        if (signal.aborted) break;
        const snapshot = candidates[index];
        const quest = this.quests.find((q) => q.id === snapshot.id);
        if (!quest) continue;

        if (isExpired(quest)) {
          this.logger.warn(`Пропуск «${quest.name}»: квест истёк`);
          this.recordResult(session, quest, 'skipped', 'истёк');
          continue;
        }
        if (quest.claimed || quest.completed) {
          this.recordResult(session, quest, 'skipped', 'уже выполнен');
          continue;
        }

        if (!quest.enrolled) {
          if (!cfg.autoEnroll) {
            this.recordResult(session, quest, 'failed', 'квест не принят, а автопринятие выключено');
            continue;
          }
          try {
            const raw = this.rawQuests.get(quest.id) || {};
            await this.ensureApi().enroll(quest.id, raw);
            this.logger.info(`Принял задание: ${quest.name}`);
            this.updateQuest(quest.id, { enrolled: true, enrolledAt: Date.now() });
            await sleepSafe(rand(1.5, 5) * 1000, signal);
          } catch (err) {
            const reason = err instanceof DiscordError ? `${err.status} ${err.hint}` : err.message;
            this.logger.error(`Не смог принять «${quest.name}»: ${reason}`);
            this.recordResult(session, quest, 'failed', `принятие: ${reason}`);
            if (err instanceof DiscordError && err.isAuth) throw err;
            continue;
          }
        }

        session.currentId = quest.id;
        session.currentSince = Date.now();
        session.nextAt = null;
        this.emit('change');
        this.logger.info(`Выполняю «${quest.name}» — ${quest.typeLabel}, ${formatDuration(quest.target)}`);

        try {
          await this.runQuest(quest, session, signal);
          const fresh = this.quests.find((q) => q.id === quest.id) || quest;
          if (fresh.completed || fresh.claimed) {
            session.completed++;
            this.logger.info(`Квест выполнен: ${quest.name}`);
            this.recordResult(session, fresh, 'completed');
            if (cfg.autoClaim) await this.tryClaim(fresh);
          } else if (signal.aborted) {
            this.recordResult(session, fresh, 'stopped', 'остановлено вручную');
          } else {
            session.failed++;
            this.recordResult(session, fresh, 'incomplete', 'прогресс не дошёл до цели');
          }
        } catch (err) {
          if (signal.aborted) {
            this.recordResult(session, quest, 'stopped', 'остановлено вручную');
          } else {
            const reason = err instanceof DiscordError ? `${err.status} ${err.hint}` : err.message;
            session.failed++;
            this.logger.error(`Ошибка на «${quest.name}»: ${reason}`);
            this.recordResult(session, quest, 'failed', reason);
            if (err instanceof DiscordError && err.isAuth) throw err;
          }
        }

        if (index < candidates.length - 1 && !signal.aborted) {
          const gap = rand(cfg.gapMinutes[0], cfg.gapMinutes[1]) * 60_000;
          session.nextAt = Date.now() + gap;
          this.logger.info(`Пауза ${(gap / 60000).toFixed(1)} мин перед следующим квестом`);
          this.emit('change');
          await sleepSafe(gap, signal);
        }
      }
    } catch (err) {
      if (err instanceof DiscordError && err.isAuth) {
        this.warning =
          `Discord отклонил запрос (${err.status}). Похоже, автоматизация квестов для аккаунта заблокирована ` +
          'либо токен больше не работает. Проверь «Нарушения аккаунта» в настройках Discord.';
        this.logger.error(this.warning);
      } else if (!signal.aborted) {
        this.lastError = err.message;
        this.logger.error(`Сессия прервана: ${err.message}`);
      }
    } finally {
      const stopped = signal.aborted;
      if (session) {
        session.finishedAt = Date.now();
        session.currentId = null;
        session.nextAt = null;
        session.stopRequested = stopped;
      }
      this.phase = 'idle';
      this.keepawake?.stop();
      this.logger.info(
        `Сессия завершена: выполнено ${session?.completed || 0}, ошибок ${session?.failed || 0}` +
          (stopped ? ' (остановлено)' : ''),
      );
      this.emit('change');
    }
  }

  async runQuest(quest, session, signal) {
    const tasks = quest.runnableTasks.length ? quest.runnableTasks : quest.primary ? [quest.primary] : [];
    for (const task of tasks) {
      if (signal.aborted) break;
      if (task.mode === 'video') await this.runVideo(quest, task, signal);
      else if (task.mode === 'heartbeat') await this.runHeartbeat(quest, task, signal);
      else this.logger.warn(`Тип задания «${task.type}» не поддерживается`);
    }
    return quest;
  }

  /** PLAY_ON_DESKTOP: шлём те же heartbeat'ы, что клиент Discord, с рандомным шагом. */
  async runHeartbeat(quest, task, signal) {
    const cfg = this.cfg.engine;
    const api = this.ensureApi();
    const overshoot = randInt(cfg.overshootSeconds[0], cfg.overshootSeconds[1]);
    let value = Number(task.value) || 0;
    let completed = quest.completed;
    let beats = 0;

    this.logger.debug(`Heartbeat для «${quest.name}» (app ${task.appId}), цель ${task.target}с`);

    // «Запуск игры» — не мгновенно после нажатия кнопки.
    await sleepSafe(rand(cfg.startDelaySeconds[0], cfg.startDelaySeconds[1]) * 1000, signal);

    while (!signal.aborted) {
      let response;
      try {
        response = await api.heartbeat(quest.id, { applicationId: task.appId, terminal: false, signal });
      } catch (err) {
        // Стоп во время запроса: выходим из цикла, чтобы всё равно отправить terminal.
        if (signal.aborted) break;
        throw err;
      }
      const status = response.user_status || response;
      const progress = readProgress(status, task.type);
      value = Math.max(value, progress.value);
      completed = Boolean(status.completed_at) || progress.completed;
      this.updateQuest(quest.id, { value, completed, enrolled: true });

      const left = Math.max(0, task.target - value);
      this.logger.info(
        `«${quest.name}»: ${formatDuration(value)} / ${formatDuration(task.target)}` +
          (left ? `, осталось ${formatDuration(left)}` : ', цель достигнута'),
      );

      if (completed) break;
      if (value >= task.target) {
        if (value - task.target >= overshoot) break;
        // Сервер ещё не отметил выполнение — добиваем парой ударов.
      }

      beats++;
      const base = jitter(cfg.heartbeatSeconds) * 1000;
      const pauseChance = Number(cfg.pauseChance ?? 0.1);
      const pauseSeconds = cfg.pauseSeconds || [2.5, 11];
      await sleepSafe(
        base + maybePause(pauseChance, [pauseSeconds[0] * 1000, pauseSeconds[1] * 1000]),
        signal,
      );
    }

    if (completed) {
      const linger = rand(cfg.closeDelaySeconds[0], cfg.closeDelaySeconds[1]) * 1000;
      this.logger.debug(`«${quest.name}»: закрываю игру через ${(linger / 1000).toFixed(0)}с`);
      await sleepSafe(linger, signal);
    }
    try {
      await api.heartbeat(quest.id, { applicationId: task.appId, terminal: true, signal: null });
    } catch (err) {
      if (!signal.aborted) this.logger.warn(`Финальный heartbeat не прошёл: ${err.hint || err.message}`);
    }
  }

  /** WATCH_VIDEO: видео-прогресс нельзя обогнать часы — идём в темпе просмотра. */
  async runVideo(quest, task, signal) {
    const cfg = this.cfg.engine;
    const api = this.ensureApi();
    const apiNow = () => Date.now();
    const enrolledAt = quest.enrolledAt || apiNow();
    const target = Number(task.target) || 0;
    let value = Number(task.value) || 0;
    const overshoot = Math.min(5, randInt(0, 3));

    this.logger.debug(`Видео «${quest.name}», цель ${target}с`);

    await sleepSafe(rand(cfg.startDelaySeconds[0], cfg.startDelaySeconds[1]) * 1000, signal);

    while (!signal.aborted && value < target + overshoot) {
      const wallClock = (apiNow() - enrolledAt) / 1000 + 10;
      const step = rand(6.4, 9.4);
      const next = Math.min(target + overshoot, Math.floor(Math.min(value + step, Math.max(value + 1, wallClock))));
      if (next <= value) {
        await sleepSafe(2200, signal);
        continue;
      }

      const response = await api.videoProgress(quest.id, next, { signal });
      const status = response.user_status || response;
      const progress = readProgress(status, task.type);
      value = Math.max(value, Math.min(next, progress.value || next));
      const completed = Boolean(status.completed_at) || progress.completed;
      this.updateQuest(quest.id, { value, completed, enrolled: true });

      this.logger.info(`«${quest.name}»: ${formatDuration(value)} / ${formatDuration(target)} видео`);
      if (completed || value >= target) break;

      await sleepSafe(rand(cfg.videoTickMs[0], cfg.videoTickMs[1]), signal);
    }

    if (!signal.aborted && value < target) {
      try {
        await api.videoProgress(quest.id, target, {});
        this.updateQuest(quest.id, { value: target });
      } catch {
        /* не критично */
      }
    }
  }

  async tryClaim(quest) {
    try {
      await this.ensureApi().claim(quest.id, { platform: 0, location: 11 });
      this.updateQuest(quest.id, { claimed: true });
      this.logger.info(`Награда получена: ${quest.name}`);
    } catch (err) {
      const hint = err instanceof DiscordError ? `${err.status} ${err.hint}` : err.message;
      this.logger.warn(`Автополучение награды не удалось (${hint}). Забери вручную: Настройки → Подарки.`);
    }
  }

  sessionSnapshot() {
    const s = this.session;
    if (!s) return null;
    return {
      ...s,
      running: !s.finishedAt,
      currentName: this.quests.find((q) => q.id === s.currentId)?.name || null,
    };
  }

  snapshot() {
    return {
      phase: this.phase,
      user: this.user,
      quests: this.quests.map((q) => ({
        ...q,
        statusText: q.completed ? 'выполнен' : q.claimed ? 'награда получена' : describeQuest(q),
        progressPct: q.target ? Math.min(100, Math.round((q.value / q.target) * 100)) : 0,
      })),
      excludedCount: this.excludedCount,
      enrollmentBlockedUntil: this.enrollmentBlockedUntil,
      warning: this.warning,
      lastError: this.lastError,
      lastRefresh: this.lastRefresh,
      session: this.sessionSnapshot(),
      tokenPresent: Boolean(this.token),
    };
  }
}
