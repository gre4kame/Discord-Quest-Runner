import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, saveConfig, tokenInfo, cleanToken } from './config.js';
import { QuestApi } from './discord.js';
import { networkInfo, normalizeProxyUrl } from './proxy.js';
import { normalizeQuest } from './quests.js';

const PUBLIC_DIR = path.join(ROOT, 'src', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const NUM = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const pair = (value, fallback, min, max) => {
  if (!Array.isArray(value) || value.length < 2) return [...fallback];
  const a = NUM(value[0], fallback[0], min, max);
  const b = NUM(value[1], fallback[1], min, max);
  return a <= b ? [a, b] : [b, a];
};

export function publicConfig(cfg) {
  return {
    token: tokenInfo(cfg),
    engine: {
      autoStart: Boolean(cfg.engine.autoStart),
      autoEnroll: Boolean(cfg.engine.autoEnroll),
      autoClaim: Boolean(cfg.engine.autoClaim),
      startDelaySeconds: cfg.engine.startDelaySeconds,
      heartbeatSeconds: cfg.engine.heartbeatSeconds,
      videoTickMs: cfg.engine.videoTickMs,
      overshootSeconds: cfg.engine.overshootSeconds,
      closeDelaySeconds: cfg.engine.closeDelaySeconds,
      gapMinutes: cfg.engine.gapMinutes,
      maxQuestsPerSession: cfg.engine.maxQuestsPerSession,
      keepAwake: Boolean(cfg.engine.keepAwake),
    },
    web: { port: cfg.web.port, openBrowser: Boolean(cfg.web.openBrowser) },
    network: { ...networkInfo(), configured: cfg.network?.proxy || '' },
  };
}

export function applyConfigPatch(cfg, patch = {}) {
  if (typeof patch.token === 'string') {
    const token = cleanToken(patch.token);
    if (token) cfg.discord.token = token;
  }
  if (patch.clearToken) cfg.discord.token = '';

  if (patch.network && typeof patch.network.proxy === 'string') {
    const raw = patch.network.proxy.trim();
    const normalized = normalizeProxyUrl(raw);
    if (raw && !normalized) {
      const err = new Error('Прокси должен быть вида http://host:port');
      err.status = 400;
      throw err;
    }
    cfg.network.proxy = normalized || '';
  }

  const e = patch.engine || {};
  if (e.autoStart !== undefined) cfg.engine.autoStart = Boolean(e.autoStart);
  if (e.autoEnroll !== undefined) cfg.engine.autoEnroll = Boolean(e.autoEnroll);
  if (e.autoClaim !== undefined) cfg.engine.autoClaim = Boolean(e.autoClaim);
  if (e.keepAwake !== undefined) cfg.engine.keepAwake = Boolean(e.keepAwake);
  if (e.startDelaySeconds) cfg.engine.startDelaySeconds = pair(e.startDelaySeconds, cfg.engine.startDelaySeconds, 0, 600);
  if (e.heartbeatSeconds) cfg.engine.heartbeatSeconds = pair(e.heartbeatSeconds, cfg.engine.heartbeatSeconds, 10, 180);
  if (e.videoTickMs) cfg.engine.videoTickMs = pair(e.videoTickMs, cfg.engine.videoTickMs, 3000, 30000);
  if (e.overshootSeconds) cfg.engine.overshootSeconds = pair(e.overshootSeconds, cfg.engine.overshootSeconds, 0, 900);
  if (e.closeDelaySeconds) cfg.engine.closeDelaySeconds = pair(e.closeDelaySeconds, cfg.engine.closeDelaySeconds, 0, 600);
  if (e.gapMinutes) cfg.engine.gapMinutes = pair(e.gapMinutes, cfg.engine.gapMinutes, 0, 180);
  if (e.maxQuestsPerSession !== undefined) {
    cfg.engine.maxQuestsPerSession = NUM(e.maxQuestsPerSession, cfg.engine.maxQuestsPerSession, 1, 20);
  }
  saveConfig(cfg);
  return cfg;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, data) => {
    if (err) {
      if (rel === 'index.html') return sendJson(res, 500, { error: 'index.html не найден' });
      return sendJson(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-store' : 'public, max-age=60',
    });
    res.end(data);
  });
}

export function createServer({ cfg, engine, logger }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      if (pathname === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, {
          ...engine.snapshot(),
          config: publicConfig(cfg),
          version: '2.0.0',
        });
      }

      if (pathname === '/api/logs' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since')) || 0;
        return sendJson(res, 200, { lines: logger.tail(since, 200) });
      }

      if (pathname === '/api/refresh' && req.method === 'POST') {
        await engine.refresh();
        return sendJson(res, 200, { ok: true, quests: engine.quests.length });
      }

      if (pathname === '/api/selftest' && req.method === 'POST') {
        const body = await readBody(req);
        const provided = body.token ? cleanToken(body.token) : '';
        if (provided && provided !== cfg.discord.token) {
          const api = new QuestApi({
            token: provided,
            apiVersion: cfg.discord.apiVersion || 10,
            apiBase: cfg.discord.apiBase || null,
            logger,
          });
          const me = await api.me();
          const data = await api.quests();
          const quests = (data.quests || []).map((q) => normalizeQuest(q));
          return sendJson(res, 200, {
            ok: true,
            user: { id: me.id, globalName: me.global_name || me.username },
            quests: quests.length,
            available: quests.filter((q) => q.active && !q.completed && !q.claimed && q.supported).length,
            notSaved: true,
          });
        }
        await engine.connect();
        await engine.refresh();
        return sendJson(res, 200, {
          ok: true,
          user: engine.user,
          quests: engine.quests.length,
          available: engine.quests.filter((q) => q.active && !q.completed && !q.claimed && q.supported).length,
        });
      }

      if (pathname === '/api/session/start' && req.method === 'POST') {
        const body = await readBody(req);
        const session = await engine.start({ questIds: body.questIds || null, auto: Boolean(body.auto) });
        return sendJson(res, 200, { ok: true, session });
      }

      if (pathname === '/api/session/stop' && req.method === 'POST') {
        const stopped = await engine.stop();
        return sendJson(res, 200, { ok: true, stopped });
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        if (engine.session && !engine.session.finishedAt) {
          return sendJson(res, 409, { error: 'Останови сессию, чтобы менять настройки' });
        }
        const body = await readBody(req);
        const previousToken = cfg.discord.token;
        applyConfigPatch(cfg, body);
        if (cfg.discord.token !== previousToken) {
          engine.api = null;
          engine.user = null;
          engine.warning = null;
          engine.quests = [];
          engine.lastRefresh = 0;
        }
        logger.info('Настройки сохранены');
        return sendJson(res, 200, { ok: true, config: publicConfig(cfg) });
      }

      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

      return serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status && err.status < 500 ? 400 : 500;
      const message = err.hint || err.message || 'Ошибка';
      logger.error(`API ${pathname}: ${message}`);
      return sendJson(res, status, { error: message, status: err.status || null });
    }
  });

  return server;
}
