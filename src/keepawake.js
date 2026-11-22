import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

export class KeepAwake {
  constructor({ logger, enabled = true }) {
    this.logger = logger;
    this.enabled = enabled;
    this.proc = null;
    this.script = path.join(ROOT, 'src', 'windows', 'keepawake.ps1');
  }

  start() {
    if (!this.enabled || process.platform !== 'win32' || this.proc) return;
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script],
        { windowsHide: true, stdio: 'ignore' },
      );
      this.proc.on('exit', () => {
        this.proc = null;
      });
      this.logger?.debug('Режим «не спать» включён');
    } catch (err) {
      this.logger?.warn(`Не удалось включить режим «не спать»: ${err.message}`);
    }
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* уже умер */
    }
    this.proc = null;
    this.logger?.debug('Режим «не спать» выключен');
  }
}
