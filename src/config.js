import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

export const DEFAULTS = {
  discord: { token: '', apiVersion: 10 },
  engine: {
    autoStart: false,
    autoEnroll: true,
    autoClaim: false,
    startDelaySeconds: [4, 25],
    heartbeatSeconds: [24, 40],
    videoTickMs: [7000, 9500],
    overshootSeconds: [20, 180],
    closeDelaySeconds: [15, 90],
    gapMinutes: [2, 7],
    pauseChance: 0.1,
    pauseSeconds: [2.5, 11],
    maxQuestsPerSession: 8,
    keepAwake: true,
  },
  web: { port: 4780, openBrowser: true },
  network: { proxy: '' },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function merge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    out[key] = isObj(value) && isObj(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const example = readJson(EXAMPLE_PATH) || {};
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merge(DEFAULTS, example), null, 2) + '\n');
  }
  const cfg = merge(DEFAULTS, readJson(CONFIG_PATH) || {});
  const envToken = (process.env.DISCORD_TOKEN || '').trim();
  if (envToken) cfg.discord.token = envToken;
  if (process.env.QUEST_RUNNER_API_BASE) cfg.discord.apiBase = process.env.QUEST_RUNNER_API_BASE;
  if (process.env.QUEST_RUNNER_PORT) cfg.web.port = Number(process.env.QUEST_RUNNER_PORT);
  if (process.env.QUEST_RUNNER_NO_OPEN) cfg.web.openBrowser = false;
  if (process.env.QUEST_RUNNER_PROXY) cfg.network.proxy = process.env.QUEST_RUNNER_PROXY;
  cfg.discord.token = cleanToken(cfg.discord.token);
  return cfg;
}

export function saveConfig(cfg) {
  const persisted = merge(DEFAULTS, cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2) + '\n');
}

export function cleanToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^(Bot|Bearer)\s+/i, '')
    .trim();
}

export function maskToken(token) {
  const t = cleanToken(token);
  if (!t) return '';
  if (t.length <= 8) return '•'.repeat(t.length);
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export function tokenInfo(cfg) {
  const token = cleanToken(cfg.discord.token);
  const fromEnv = Boolean((process.env.DISCORD_TOKEN || '').trim());
  return { present: Boolean(token), masked: maskToken(token), source: fromEnv ? 'env' : token ? 'config' : null };
}
