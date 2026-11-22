import { execFileSync, spawnSync } from 'node:child_process';

/** Поддержка системного прокси.
 *
 *  Node не читает HTTP(S)_PROXY сам по себе: переменные учитываются только если
 *  NODE_USE_ENV_PROXY=1 выставлен ДО старта процесса. Поэтому здесь мы находим
 *  прокси (config.json → переменные окружения → настройки Windows) и, если он
 *  есть, перезапускаем себя с нужными переменными. Иначе fetch ходит напрямую
 *  и на сетях с обязательным прокси падает с "fetch failed". */

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];
const DEFAULT_NO_PROXY = '127.0.0.1,localhost,::1';
const REENTRY_FLAG = 'QUEST_RUNNER_PROXY_REEXEC';

const empty = (v) => String(v || '').trim() === '';

/** Приводит "127.0.0.1:10809" или "http://host:port/" к нормальному URL. */
export function normalizeProxyUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
  value = value.replace(/^["']|["']$/g, '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Windows хранит прокси как "host:port" либо "http=host:port;https=host:port". */
export function parseProxyServer(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!value.includes('=')) return normalizeProxyUrl(value);
  const parts = value
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const pick =
    parts.find((p) => /^https=/i.test(p)) ||
    parts.find((p) => /^http=/i.test(p)) ||
    parts.find((p) => !p.includes('='));
  if (!pick) return null;
  return normalizeProxyUrl(pick.includes('=') ? pick.slice(pick.indexOf('=') + 1) : pick);
}

export function proxyFromEnv(env = process.env) {
  for (const key of PROXY_ENV_KEYS) {
    const url = normalizeProxyUrl(env[key]);
    if (url) return { url, source: 'env', key };
  }
  return null;
}

function readRegistryValue(name) {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name],
      { encoding: 'latin1', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, 'i'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Прокси из настроек Windows (Internet Options / WinHTTP). */
export function proxyFromRegistry({ platform = process.platform, readValue = readRegistryValue } = {}) {
  if (platform !== 'win32') return null;
  const enabled = readValue('ProxyEnable');
  if (!enabled) return null;
  const isOn = /^0x1$/i.test(enabled) || enabled === '1';
  if (!isOn) return null;
  const url = parseProxyServer(readValue('ProxyServer'));
  if (!url) return null;
  const override = readValue('ProxyOverride');
  const noProxy = [DEFAULT_NO_PROXY];
  if (override) {
    const list = override
      .split(';')
      .map((item) => item.trim())
      .filter((item) => item && !/<local>/i.test(item))
      .map((item) => item.replace(/^\*\.?/, '.'));
    if (list.length) noProxy.push(...list);
  }
  return { url, source: 'windows', key: 'ProxyServer', noProxy: noProxy.join(',') };
}

/** Итоговый выбор прокси: явная настройка важнее переменных, переменные важнее Windows. */
export function detectProxy({ cfg = null, env = process.env, platform = process.platform, readValue } = {}) {
  if (String(env.QUEST_RUNNER_NO_PROXY || '') === '1') return null;
  const configured = normalizeProxyUrl(cfg?.network?.proxy);
  if (configured) return { url: configured, source: 'config', key: 'network.proxy' };
  return proxyFromEnv(env) || proxyFromRegistry({ platform, readValue });
}

export function mergeNoProxy(env = process.env, extra = '') {
  const current = NO_PROXY_ENV_KEYS.map((k) => env[k]).find((v) => !empty(v)) || '';
  const parts = new Set(
    `${current},${extra}`
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  for (const item of DEFAULT_NO_PROXY.split(',')) parts.add(item);
  return [...parts].join(',');
}

export function maskProxy(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return String(url);
  }
}

export function networkInfo() {
  const fromEnv = proxyFromEnv();
  return {
    active: String(process.env.NODE_USE_ENV_PROXY || '') === '1',
    proxy: maskProxy(fromEnv?.url),
    noProxy: mergeNoProxy(),
  };
}

/**
 * Выставляет переменные и, если Node их ещё не видит, перезапускает процесс.
 * Возвращает описание найденного прокси (или null). При перезапуске не возвращает
 * управление: родительский процесс завершается вместе с дочерним.
 */
export function ensureEnvProxy({ cfg = null, logger = null, args = process.argv.slice(1), execPath = process.execPath } = {}) {
  const found = detectProxy({ cfg });
  if (!found) {
    if (logger && String(process.env.NODE_USE_ENV_PROXY || '') !== '1') {
      logger.info('Прокси не найден — подключаюсь к Discord напрямую.');
    }
    return null;
  }

  const envProxyOn = !empty(process.env.NODE_USE_ENV_PROXY);
  if (envProxyOn) return found; // NODE_USE_ENV_PROXY уже выставлен — прокси работает

  if (process.env[REENTRY_FLAG] === '1') {
    logger?.warn('Прокси найден, но перезапуск не удался — пробую напрямую.');
    return found;
  }

  const childEnv = {
    ...process.env,
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: found.url,
    HTTP_PROXY: found.url,
    NO_PROXY: mergeNoProxy(process.env, found.noProxy || ''),
    [REENTRY_FLAG]: '1',
  };

  logger?.info(`Прокси ${maskProxy(found.url)} (${found.source}) — перезапускаюсь с его поддержкой…`);

  // Родитель ждёт дочерний процесс: Ctrl+C должен обработать именно он, иначе консоль
  // закроется раньше, чем раннер успеет аккуратно остановить сессию.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});

  const result = spawnSync(execPath, args, {
    env: childEnv,
    stdio: 'inherit',
    windowsHide: false,
  });

  if (result.error) logger?.error(`Не удалось перезапуститься с прокси: ${result.error.message}`);
  process.exit(result.error ? 1 : result.status ?? 1);
}
