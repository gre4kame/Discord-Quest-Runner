import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProxyUrl,
  parseProxyServer,
  proxyFromEnv,
  proxyFromRegistry,
  detectProxy,
  mergeNoProxy,
  maskProxy,
} from '../src/proxy.js';

test('normalizeProxyUrl добавляет схему и убирает слэш', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:10809'), 'http://127.0.0.1:10809');
  assert.equal(normalizeProxyUrl('http://127.0.0.1:10809/'), 'http://127.0.0.1:10809');
  assert.equal(normalizeProxyUrl('  "https://user:pass@10.0.0.1:8443" '), 'https://user:pass@10.0.0.1:8443');
  assert.equal(normalizeProxyUrl(''), null);
  assert.equal(normalizeProxyUrl('ftp://10.0.0.1:21'), null);
  assert.equal(normalizeProxyUrl('socks5://10.0.0.1:1080'), null);
  assert.equal(normalizeProxyUrl('http://'), null);
});

test('parseProxyServer понимает формат настроек Windows', () => {
  assert.equal(parseProxyServer('10.0.0.5:3128'), 'http://10.0.0.5:3128');
  assert.equal(
    parseProxyServer('http=10.0.0.5:3128;https=secure.example:8443'),
    'http://secure.example:8443',
  );
  assert.equal(parseProxyServer('socks=10.0.0.6:1080'), null);
  assert.equal(parseProxyServer(''), null);
});

test('proxyFromEnv берёт HTTPS_PROXY раньше HTTP_PROXY и ALL_PROXY', () => {
  const env = {
    HTTPS_PROXY: 'http://127.0.0.1:10809',
    HTTP_PROXY: 'http://127.0.0.1:9999',
    ALL_PROXY: 'http://127.0.0.1:7777',
  };
  assert.deepEqual(proxyFromEnv(env), { url: 'http://127.0.0.1:10809', source: 'env', key: 'HTTPS_PROXY' });
  assert.equal(proxyFromEnv({ http_proxy: '10.0.0.1:3128' })?.url, 'http://10.0.0.1:3128');
  assert.equal(proxyFromEnv({ HTTPS_PROXY: '   ' }), null);
});

test('proxyFromRegistry учитывает ProxyEnable и ProxyServer', () => {
  const values = { ProxyEnable: '0x1', ProxyServer: '10.1.2.3:8080', ProxyOverride: '<local>;*.corp.local' };
  const readValue = (name) => values[name] ?? null;
  const found = proxyFromRegistry({ platform: 'win32', readValue });
  assert.equal(found?.url, 'http://10.1.2.3:8080');
  assert.equal(found?.source, 'windows');
  assert.match(found?.noProxy || '', /corp\.local/);
  assert.doesNotMatch(found?.noProxy || '', /<local>/);

  values.ProxyEnable = '0x0';
  assert.equal(proxyFromRegistry({ platform: 'win32', readValue }), null);
  assert.equal(proxyFromRegistry({ platform: 'linux', readValue }), null);
});

test('detectProxy: config важнее env, env важнее реестра, NO_PROXY=1 отключает всё', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:10809' };
  const readValue = () => '0x1';

  assert.equal(detectProxy({ cfg: { network: { proxy: '10.9.9.9:1234' } }, env, platform: 'win32', readValue })?.source, 'config');
  assert.equal(detectProxy({ env, platform: 'win32', readValue })?.source, 'env');
  assert.equal(detectProxy({ env: {}, platform: 'win32', readValue })?.source, 'windows');
  assert.equal(detectProxy({ env: {}, platform: 'win32', readValue: () => null }), null);
  assert.equal(detectProxy({ env: { ...env, QUEST_RUNNER_NO_PROXY: '1' }, platform: 'win32' }), null);
});

test('mergeNoProxy добавляет локальные адреса без дублей', () => {
  const merged = mergeNoProxy({ NO_PROXY: 'localhost,.corp' }, '10.0.0.0/8');
  const parts = merged.split(',');
  assert.ok(parts.includes('127.0.0.1'));
  assert.ok(parts.includes('::1'));
  assert.ok(parts.includes('.corp'));
  assert.ok(parts.includes('10.0.0.0/8'));
  assert.equal(new Set(parts).size, parts.length);
});

test('maskProxy прячет логин и пароль', () => {
  assert.equal(maskProxy('http://user:secret@10.0.0.1:8080'), 'http://***:***@10.0.0.1:8080');
  assert.equal(maskProxy('http://127.0.0.1:10809'), 'http://127.0.0.1:10809');
  assert.equal(maskProxy(''), '');
});
