import { spawn } from 'node:child_process';
import { loadConfig, tokenInfo } from './config.js';
import { ensureEnvProxy } from './proxy.js';
import { Logger } from './logger.js';
import { Engine } from './engine.js';
import { KeepAwake } from './keepawake.js';
import { createServer, publicConfig } from './server.js';
import { formatDuration } from './timing.js';
import { describeQuest } from './quests.js';

const logger = new Logger();
const cfg = loadConfig();

// Если в системе есть прокси, а Node о нём не знает — перезапускаемся с NODE_USE_ENV_PROXY=1.
// Без этого fetch игнорирует HTTP(S)_PROXY и падает с "fetch failed" на сетях с обязательным прокси.
ensureEnvProxy({ cfg, logger });

function buildEngine() {
  const keepawake = new KeepAwake({ logger, enabled: cfg.engine.keepAwake });
  const engine = new Engine({ cfg, logger, keepawake });
  return engine;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function listen(server, port, attempts = 6) {
  return new Promise((resolve, reject) => {
    let current = port;
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts-- > 0) {
          current += 1;
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(current, '127.0.0.1', () => resolve(current));
    };
    tryListen();
  });
}

async function alreadyRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.version && Array.isArray(data.quests));
  } catch {
    return false;
  }
}

async function run() {
  const wanted = Number(cfg.web.port) || 4780;
  if (await alreadyRunning(wanted)) {
    const url = `http://127.0.0.1:${wanted}`;
    console.log('');
    console.log('  Quest Runner уже запущен:');
    console.log(`  ${url}`);
    console.log('');
    if (cfg.web.openBrowser) openBrowser(url);
    return;
  }

  const engine = buildEngine();
  const server = createServer({ cfg, engine, logger });
  const port = await listen(server, Number(cfg.web.port) || 4780);
  const url = `http://127.0.0.1:${port}`;

  console.log('');
  console.log('  Discord Quest Runner');
  console.log(`  ${url}`);
  console.log('');

  if (cfg.web.openBrowser) openBrowser(url);

  const info = tokenInfo(cfg);
  if (!info.present) {
    logger.warn('Токен Discord не задан — открой дашборд и вставь его в настройках.');
  } else {
    try {
      await engine.connect();
      await engine.refresh();
      if (cfg.engine.autoStart) {
        logger.info('Автостарт включён — запускаю квесты');
        await engine.start({ auto: true });
      } else {
        logger.info('Готово. Нажми «Старт» в дашборде.');
      }
    } catch (err) {
      logger.error(`Discord недоступен: ${err.hint || err.message}`);
    }
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    logger.info('Выключаюсь…');
    await engine.stop();
    server.close();
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => logger.error(`Необработанная ошибка: ${err?.message || err}`));
}

async function list() {
  const engine = buildEngine();
  try {
    await engine.connect();
    await engine.refresh();
  } catch (err) {
    logger.error(err.hint || err.message);
    process.exitCode = 1;
    return;
  }
  console.log('');
  const quests = engine.quests;
  if (!quests.length) {
    console.log('  Квестов нет.');
    return;
  }
  for (const [index, quest] of quests.entries()) {
    const target = quest.target ? formatDuration(quest.target) : '—';
    const expiry = quest.expiresAt ? new Date(quest.expiresAt).toLocaleString('ru-RU') : '—';
    console.log(
      `  ${String(index + 1).padStart(2)}. ${quest.name.slice(0, 42).padEnd(42)} ` +
        `${quest.typeLabel.padEnd(15)} ${target.padEnd(9)} ${describeQuest(quest).padEnd(26)} до ${expiry}`,
    );
  }
  console.log('');
}

async function selftest() {
  const info = tokenInfo(cfg);
  console.log('');
  console.log(`  токен: ${info.present ? info.masked + ` (${info.source})` : 'НЕ ЗАДАН'}`);
  console.log(`  api: ${cfg.discord.apiBase || `discord.com/api/v${cfg.discord.apiVersion}`}`);
  if (!info.present) {
    console.log('  добавь токен в config.json → discord.token\n');
    process.exitCode = 1;
    return;
  }
  const engine = buildEngine();
  try {
    const me = await engine.connect();
    console.log(`  вход: ${me.globalName} (${me.id})`);
    await engine.refresh();
    const active = engine.quests.filter((q) => q.active && !q.completed && !q.claimed);
    const runnable = active.filter((q) => q.supported);
    console.log(`  квестов: ${engine.quests.length}, активных: ${active.length}, выполнимых: ${runnable.length}`);
    for (const quest of runnable) {
      console.log(`   • ${quest.name} — ${quest.typeLabel} ${formatDuration(quest.target)}`);
    }
    console.log('\n  всё ок, можно запускать: npm start\n');
  } catch (err) {
    console.log(`  ошибка: ${err.hint || err.message}\n`);
    process.exitCode = 1;
  }
}

const command = (process.argv[2] || 'run').toLowerCase();
const commands = { run, list, selftest };
if (!commands[command]) {
  console.log('Использование: node src/index.js [run|list|selftest]');
  process.exit(1);
}
commands[command]().catch((err) => {
  logger.error(err.message);
  process.exitCode = 1;
});
