import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ maxLines = 600, file = path.join(ROOT, 'data', 'runner.log') } = {}) {
    this.maxLines = maxLines;
    this.lines = [];
    this.seq = 0;
    this.listeners = new Set();
    this.file = file;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      this.file = null;
    }
  }

  write(level, message, meta) {
    const entry = { seq: ++this.seq, t: Date.now(), level, message: String(message), meta: meta ?? null };
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);

    const prefix = { debug: 'dbg', info: 'inf', warn: 'wrn', error: 'err' }[level] || 'inf';
    const time = new Date(entry.t).toLocaleTimeString('ru-RU', { hour12: false });
    const metaText = meta ? ' ' + JSON.stringify(meta) : '';
    console.log(`${time} ${prefix} ${entry.message}${metaText}`);

    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${new Date(entry.t).toISOString()} ${level} ${entry.message}${metaText}\n`);
      } catch {
        /* лог в файл не критичен */
      }
    }
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* подписчик не должен ломать логгер */
      }
    }
    return entry;
  }

  debug(message, meta) {
    return this.write('debug', message, meta);
  }
  info(message, meta) {
    return this.write('info', message, meta);
  }
  warn(message, meta) {
    return this.write('warn', message, meta);
  }
  error(message, meta) {
    return this.write('error', message, meta);
  }

  tail(sinceSeq = 0, limit = 200) {
    const filtered = sinceSeq > 0 ? this.lines.filter((l) => l.seq > sinceSeq) : this.lines;
    return filtered.slice(-limit);
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export { LEVELS };
