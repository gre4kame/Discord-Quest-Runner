/** Случайные задержки «как у человека»: не ровный метроном, а разброс с редкими паузами. */

export function rand(min, max) {
  if (max === undefined) [min, max] = [0, min];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
}

export function randInt(min, max) {
  return Math.round(rand(min, max));
}

/** Приблизительно нормальное распределение внутри [min, max], без выбросов за границы. */
export function jitter([min, max], factor = 0.25) {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  if (hi <= lo) return lo;
  const mean = (lo + hi) / 2;
  const sd = ((hi - lo) / 2) * factor;
  let value = mean;
  for (let i = 0; i < 4; i++) value = (value + mean + (Math.random() * 2 - 1) * sd * 2) / 2;
  return Math.min(hi, Math.max(lo, value));
}

/** Раз в N шагов добавляет «человеческую» паузу. */
export function maybePause(probability = 0.12, extraMs = [4000, 15000]) {
  return Math.random() < probability ? rand(extraMs[0], extraMs[1]) : 0;
}

export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    if (signal) {
      if (signal.aborted) return done();
      signal.addEventListener('abort', done, { once: true });
    }
  });
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}ч ${String(m).padStart(2, '0')}м`;
  if (m) return `${m}м ${String(s % 60).padStart(2, '0')}с`;
  return `${s}с`;
}
