import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockDiscord } from '../test/mock-discord.js';

/** Локальное демо без токена: поднимает фальшивый Discord API и настоящий дашборд.
 *  Нужно, чтобы посмотреть интерфейс и прогнать сессию целиком. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QUEST_RUNNER_PORT || 4781);

function quest(id, game, publisher, task, target, extra = {}) {
  return {
    id,
    config: {
      config_version: 2,
      starts_at: '2026-11-01T00:00:00+00:00',
      expires_at: '2026-11-30T21:00:00+00:00',
      application: { id: `app-${id}`, name: game },
      assets: {},
      messages: { quest_name: game, game_title: game, game_publisher: publisher },
      task_config_v2: {
        join_operator: 'or',
        tasks: {
          [task]: { type: task, target, applications: [{ id: `app-${id}` }] },
        },
      },
      rewards_config: { assignment_method: 1, rewards: [{ type: 4, orb_quantity: 700 }], platforms: [0] },
    },
    user_status: extra.enrolled
      ? { enrolled_at: new Date(Date.now() - 600_000).toISOString(), progress: {} }
      : null,
    ...extra.raw,
  };
}

const quests = [
  quest('770001', 'Basketball Zero', 'Roblox', 'PLAY_ON_DESKTOP', 900),
  quest('770002', 'Beat the Kobayashi Maru', 'Magic: The Gathering', 'WATCH_VIDEO', 120),
  quest('770003', 'Asphalt Legends', 'Gameloft', 'PLAY_ON_DESKTOP', 900, { enrolled: true }),
  quest('770004', 'MapleStory Classic World', 'Nexon America', 'PLAY_ON_DESKTOP', 900),
  quest('770005', 'Delta Force', 'Team Jade', 'PLAY_ON_DESKTOP', 900),
  (() => {
    const expired = quest('770006', 'ANNO 117', 'Ubisoft', 'WATCH_VIDEO', 120);
    expired.config.expires_at = '2026-11-10T00:00:00+00:00';
    return expired;
  })(),
  quest('770007', 'Where Winds Meet', 'Netease', 'STREAM_ON_DESKTOP', 1800),
];

const mock = await createMockDiscord({ quests, secondsPerBeat: 900 });
const child = spawn(process.execPath, ['src/index.js', 'run'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    DISCORD_TOKEN: 'demo-token',
    QUEST_RUNNER_API_BASE: mock.url,
    QUEST_RUNNER_PORT: String(PORT),
  },
});

console.log(`\n  Демо-режим (фальшивый Discord API): http://127.0.0.1:${PORT}\n`);

const shutdown = async (code = 0) => {
  child.kill();
  await mock.close().catch(() => {});
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
child.on('exit', (code) => shutdown(code ?? 0));
