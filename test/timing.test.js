import test from 'node:test';
import assert from 'node:assert/strict';
import { jitter, rand, randInt, formatDuration, sleep, maybePause } from '../src/timing.js';

test('jitter держится в границах', () => {
  for (let i = 0; i < 500; i++) {
    const value = jitter([10, 40]);
    assert.ok(value >= 10 && value <= 40, `значение ${value} вне диапазона`);
  }
});

test('jitter переваривает перевёрнутый диапазон и нули', () => {
  assert.ok(jitter([40, 10]) >= 10);
  assert.equal(jitter([5, 5]), 5);
  assert.equal(jitter([0, 0]), 0);
});

test('rand и randInt работают в границах', () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(rand(2, 3) >= 2 && rand(2, 3) <= 3);
    const int = randInt(2, 4);
    assert.ok(Number.isInteger(int) && int >= 2 && int <= 4);
  }
});

test('formatDuration печатает часы, минуты и секунды', () => {
  assert.equal(formatDuration(0), '0с');
  assert.equal(formatDuration(45), '45с');
  assert.equal(formatDuration(90), '1м 30с');
  assert.equal(formatDuration(3600), '1ч 00м');
  assert.equal(formatDuration(5430), '1ч 30м');
});

test('sleep прерывается по aborted-сигналу', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 30);
  await sleep(5000, controller.signal);
  assert.ok(Date.now() - started < 1000, 'sleep не прервался');
});

test('maybePause иногда добавляет паузу', () => {
  assert.equal(maybePause(0, [1000, 2000]), 0);
  const sample = Array.from({ length: 200 }, () => maybePause(1, [1000, 2000]));
  assert.ok(sample.every((v) => v >= 1000 && v <= 2000));
});
