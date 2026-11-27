import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, cacheKey, checkIpCap, countIpRun, hashIp, handleFrom, MAX_RUNS_PER_IP_PER_DAY } from '../lib/guard.js';
import { fakeKv } from './fake-kv.js';

const four = ['alpha', 'beta', 'gamma', 'delta'];

test('accepts 4 accounts, lowercases, strips @, removes duplicates', () => {
  const r = validateInput({ usernames: ['@Alpha', 'beta', 'BETA', 'gamma', 'delta.co'], client: '@ALPHA' });
  assert.deepEqual(r, { ok: true, usernames: ['alpha', 'beta', 'gamma', 'delta.co'], client: 'alpha' });
});

test('rejects fewer than 4 accounts after duplicates are removed', () => {
  const r = validateInput({ usernames: ['a', 'b', 'c', 'C'], client: 'a' });
  assert.equal(r.ok, false);
});

test('rejects more than 11 accounts', () => {
  const names = Array.from({ length: 12 }, (_, i) => `user${i}`);
  assert.equal(validateInput({ usernames: names, client: 'user0' }).ok, false);
});

test('accepts 11 accounts', () => {
  const names = Array.from({ length: 11 }, (_, i) => `user${i}`);
  assert.equal(validateInput({ usernames: names, client: 'user0' }).ok, true);
});

test('rejects invalid usernames', () => {
  for (const bad of ['has space', '.start', 'end.', 'two..dots', 'a'.repeat(31), 'https://example.com/x', 'émoji', '']) {
    const r = validateInput({ usernames: [bad, 'b', 'c', 'd'], client: 'b' });
    assert.equal(r.ok, false, bad);
  }
});

test('rejects a client that is not in the list, and a missing body', () => {
  assert.equal(validateInput({ usernames: four, client: 'other' }).ok, false);
  assert.equal(validateInput({ usernames: four }).ok, false);
  assert.equal(validateInput(null).ok, false);
  assert.equal(validateInput({ usernames: 'alpha' }).ok, false);
  assert.equal(validateInput({ usernames: [1, 2, 3, 4], client: 1 }).ok, false);
});

test('cache key ignores account order but depends on the client', () => {
  assert.equal(cacheKey(['b', 'a', 'c', 'd'], 'a'), cacheKey(['d', 'c', 'b', 'a'], 'a'));
  assert.equal(cacheKey(['b', 'a', 'c', 'd'], 'a'), 'result:a:a,b,c,d');
  assert.notEqual(cacheKey(four, 'alpha'), cacheKey(four, 'beta'));
});

test('a pasted profile link or @name gives the handle', () => {
  assert.equal(handleFrom('https://www.instagram.com/TheDanKoe/?hl=en'), 'thedankoe');
  assert.equal(handleFrom('instagram.com/a.b_c'), 'a.b_c');
  assert.equal(handleFrom('http://instagram.com/x/reels/'), 'x');
  assert.equal(handleFrom('  @Name '), 'name');
  const r = validateInput({ usernames: ['https://www.instagram.com/alpha/', '@beta', 'gamma', 'delta'], client: 'https://instagram.com/alpha' });
  assert.deepEqual(r, { ok: true, usernames: ['alpha', 'beta', 'gamma', 'delta'], client: 'alpha' });
});

test(`per-IP cap stops run ${MAX_RUNS_PER_IP_PER_DAY + 1} of one visitor`, async () => {
  assert.equal(MAX_RUNS_PER_IP_PER_DAY, 10);
  const kv = fakeKv();
  const ip = await hashIp('203.0.113.7', '2026-11-27');
  for (let i = 0; i < MAX_RUNS_PER_IP_PER_DAY; i++) {
    assert.equal((await checkIpCap(kv, ip, '2026-11-27')).ok, true);
    await countIpRun(kv, ip, '2026-11-27');
  }
  assert.equal((await checkIpCap(kv, ip, '2026-11-27')).ok, false);
  // Another visitor is still allowed, and the next day resets the cap.
  assert.equal((await checkIpCap(kv, await hashIp('198.51.100.1', '2026-11-27'), '2026-11-27')).ok, true);
  assert.equal((await checkIpCap(kv, await hashIp('203.0.113.7', '2026-11-28'), '2026-11-28')).ok, true);
});

test('the IP is stored as a daily hash, not as the address', async () => {
  const kv = fakeKv();
  await countIpRun(kv, await hashIp('203.0.113.7', '2026-11-27'), '2026-11-27');
  assert.ok(![...kv.store.keys()].some((k) => k.includes('203.0.113.7')));
  assert.notEqual(await hashIp('203.0.113.7', '2026-11-27'), await hashIp('203.0.113.7', '2026-11-28'));
});
