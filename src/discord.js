import crypto from 'node:crypto';

/** Клиент недокументированного, но стабильного API квестов Discord.
 *  Это ровно те запросы, которые шлёт десктопный клиент: /quests/@me, enroll, heartbeat, video-progress. */

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'discord/1.0.9215 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';

const CLIENT_VERSION = '1.0.9215';
const CHROME_VERSION = '37.6.0';

function superProperties() {
  const payload = {
    os: 'Windows',
    browser: 'Discord Client',
    release_channel: 'stable',
    client_version: CLIENT_VERSION,
    os_version: '10.0.19045',
    os_arch: 'x64',
    app_arch: 'x64',
    system_locale: 'en-US',
    has_client_mods: false,
    client_launch_id: crypto.randomUUID(),
    browser_user_agent: DESKTOP_UA,
    browser_version: CHROME_VERSION,
    os_sdk_version: '19045',
    client_build_number: 471091,
    native_build_number: 72186,
    client_event_source: null,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export class DiscordError extends Error {
  constructor(message, { status = 0, code = null, body = null, path = '', kind = null } = {}) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.path = path;
    this.kind = kind;
  }

  /** 401/403 от Discord — самый важный сигнал: доступ к квестам закрыли либо токен умер. */
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }

  get hint() {
    if (this.kind === 'network') {
      return 'Нет связи с Discord. Проверь интернет и прокси/VPN: системный прокси подхватывается автоматически, ' +
        'либо укажи адрес в config.json → network.proxy и перезапусти приложение.';
    }
    if (this.status === 401) return 'Токен не принят: истёк, сброшен или принадлежит боту.';
    if (this.status === 403) return 'Discord отклонил запрос: доступ к квестам ограничен для аккаунта.';
    if (this.status === 404) return 'Квест не найден или уже неактивен.';
    if (this.status === 429) return 'Слишком много запросов, Discord просит подождать.';
    if (this.status >= 500) return 'Сбой на стороне Discord, попробуем ещё раз.';
    return this.message;
  }
}

export class QuestApi {
  constructor({ token, apiVersion = 10, apiBase = null, logger = null, timeoutMs = 25000, fetchImpl = fetch }) {
    this.token = String(token || '').trim();
    this.base = apiBase || `https://discord.com/api/v${apiVersion}`;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.headers = {
      Authorization: this.token,
      'Content-Type': 'application/json',
      'User-Agent': DESKTOP_UA,
      'X-Super-Properties': superProperties(),
      'X-Discord-Locale': 'en-US',
      'X-Discord-Timezone': 'Europe/Moscow',
      Origin: 'https://discord.com',
      Referer: 'https://discord.com/channels/@me',
    };
    this.requestCount = 0;
  }

  async request(method, path, { body, signal, attempts = 4 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw new DiscordError('Запрос отменён', { path });
      let response;
      try {
        response = await this.fetch(`${this.base}${path}`, {
          method,
          headers: this.headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = new DiscordError(`Сеть: ${err.message}`, { path, kind: 'network' });
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }

      this.requestCount++;
      const text = await response.text().catch(() => '');
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text.slice(0, 400) };
        }
      }

      if (response.ok) return data;

      if (response.status === 429) {
        const wait = Math.ceil((Number(data.retry_after) || 5) * 1000) + 250 + Math.floor(Math.random() * 900);
        this.logger?.warn(`Rate limit ${path}, ждём ${(wait / 1000).toFixed(1)}с`);
        await new Promise((r) => setTimeout(r, wait));
        lastError = new DiscordError('Rate limited', { status: 429, path, body: data });
        continue;
      }

      if (response.status >= 500 && attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        lastError = new DiscordError(`HTTP ${response.status}`, { status: response.status, path, body: data });
        continue;
      }

      throw new DiscordError(data.message || `HTTP ${response.status}`, {
        status: response.status,
        code: data.code ?? null,
        body: data,
        path,
      });
    }
    throw lastError || new DiscordError('Запрос не удался', { path });
  }

  me() {
    return this.request('GET', '/users/@me');
  }

  quests() {
    return this.request('GET', '/quests/@me');
  }

  enroll(questId, quest = {}) {
    const body = { location: 11, is_targeted: false, metadata_raw: null };
    for (const key of ['traffic_metadata_raw', 'traffic_metadata_sealed']) {
      if (quest[key] != null) body[key] = quest[key];
    }
    return this.request('POST', `/quests/${questId}/enroll`, { body });
  }

  /** Тело как у клиента: application_id + terminal. executable_path/fingerprint не шлём:
   *  подделывать отпечаток бинарника нельзя (проверяется нативно), а пустое значение — нормальное состояние. */
  heartbeat(questId, { applicationId, terminal = false, streamKey = null, signal } = {}) {
    const body = { application_id: applicationId, terminal: Boolean(terminal) };
    if (streamKey) body.stream_key = streamKey;
    return this.request('POST', `/quests/${questId}/heartbeat`, { body, signal });
  }

  videoProgress(questId, timestamp, { signal } = {}) {
    return this.request('POST', `/quests/${questId}/video-progress`, {
      body: { timestamp: Math.round(timestamp) },
      signal,
    });
  }

  claim(questId, { platform = 0, location = 11 } = {}) {
    return this.request('POST', `/quests/${questId}/claim-reward`, { body: { location, platform } });
  }
}
