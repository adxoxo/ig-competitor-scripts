// start.js and status.js with a fake KV and a stubbed fetch. No network calls.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as start } from '../functions/api/start.js';
import { onRequestGet as status } from '../functions/api/status.js';
import { mapItem } from '../lib/apify.js';
import { cacheKey } from '../lib/guard.js';
import { BATCH_SIZE } from '../lib/rank.js';
import { fakeKv } from './fake-kv.js';
import { calls, stubFetch, restoreFetch, RUN, recent } from './helpers.js';

let env;
beforeEach(() => {
  env = { KV: fakeKv(), APIFY_TOKEN: 'test-token' };
});
afterEach(restoreFetch);

const startRequest = (body, ip = '203.0.113.7') => ({
  request: new Request('https://x.test/api/start', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip } }),
  env,
});
const statusRequest = (query) => ({ request: new Request(`https://x.test/api/status?${query}`), env });
const form = { usernames: ['Alpha', 'beta', 'gamma', 'delta'], client: 'alpha' };
// Apify's list of today's runs (the global cap). n runs started today, plus one from yesterday.
const runList = (n) => ({ match: '/runs?desc=1', body: { data: { items: [
  ...Array.from({ length: n }, () => ({ startedAt: new Date().toISOString() })),
  { startedAt: new Date(Date.now() - 86400000 * 2).toISOString() },
] } } });
const startOk = { match: '/runs?maxTotalChargeUsd', body: { data: { id: RUN } } };
const seedRun = (usernames, client = usernames[0]) =>
  env.KV.put(`run:${RUN}`, JSON.stringify({ runId: RUN, usernames, client, createdAt: new Date().toISOString() }));

// ---- mapping ----

test('mapItem: views fallback order, -1 counts, collab posts count for the input account', () => {
  const { post } = mapItem({
    inputUrl: 'https://www.instagram.com/alpha/', ownerUsername: 'someone_else', shortCode: 'X1', type: 'Video',
    timestamp: '2026-11-20T00:00:00.000Z', videoPlayCount: null, igPlayCount: -1, videoViewCount: 77,
    likesCount: -1, commentsCount: 3, videoUrl: 'https://cdn/v.mp4', videoDuration: 31.5, isPinned: true,
  });
  assert.equal(post.account, 'alpha');
  assert.equal(post.views, 77);
  assert.equal(post.likes, -1); // rank.js treats -1 as missing
  assert.equal(post.type, 'video');
  assert.equal(post.url, 'https://www.instagram.com/p/X1/');
  assert.equal(post.duration, 31.5);
  assert.equal(post.pinned, true);
  // Live shape of an error item: username and url, no inputUrl.
  assert.deepEqual(mapItem({ url: 'https://www.instagram.com/Ghost/', username: 'Ghost', error: 'not_found', errorDescription: 'Profile does not exist' }),
    { account: 'ghost', error: 'not_found: Profile does not exist' });
  assert.equal(mapItem({ url: 'https://www.instagram.com/ghost2/', error: 'not_found' }).account, 'ghost2');
});

// ---- start ----

test('start: bad input is rejected before any provider call', async () => {
  stubFetch([]);
  const res = await start(startRequest({ usernames: ['a', 'b'], client: 'a' }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('start: counts today\'s runs on Apify, starts a run with the cost cap and timeout, saves the run record', async () => {
  stubFetch([runList(3), startOk]);
  const res = await start(startRequest(form));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runId: RUN });

  const list = new URL(calls[0].url);
  assert.equal(list.pathname, '/v2/acts/apify~instagram-scraper/runs');
  assert.equal(list.searchParams.get('desc'), '1');
  assert.match(list.searchParams.get('startedAfter'), /T00:00:00.000Z$/);
  const url = new URL(calls[1].url);
  assert.equal(url.searchParams.get('maxTotalChargeUsd'), '0.96'); // 4 x 80 x $0.0027 + $0.10
  assert.equal(url.searchParams.get('timeout'), '600');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer test-token');
  assert.ok(calls[1].init.signal, 'Apify calls have a timeout');
  const input = JSON.parse(calls[1].init.body);
  assert.equal(input.resultsType, 'posts');
  assert.equal(input.directUrls[0], 'https://www.instagram.com/alpha/');
  assert.equal(input.onlyPostsNewerThan, '90 days');
  assert.equal(input.resultsLimit, 80);

  const run = await env.KV.get(`run:${RUN}`, 'json');
  assert.deepEqual(run.usernames, ['alpha', 'beta', 'gamma', 'delta']);
  assert.equal(run.client, 'alpha');
  assert.ok(Date.parse(run.createdAt) <= Date.now(), 'the 90-day window is fixed at the start');
});

test('start: a cached result returns at once in the page shape, with no provider call', async () => {
  stubFetch([]);
  await env.KV.put(cacheKey(['alpha', 'beta', 'gamma', 'delta'], 'alpha'), JSON.stringify({ client: 'alpha', cached: false, scripts: [] }));
  const res = await start(startRequest({ usernames: ['delta', 'gamma', 'beta', 'alpha'], client: 'alpha' }));
  assert.deepEqual(await res.json(), { client: 'alpha', cached: true, scripts: [] });
  assert.equal(calls.length, 0);
});

test('start: the 11th run from one IP gets 429 and no provider call', async () => {
  stubFetch([runList(0), startOk]);
  for (let i = 0; i < 10; i++) assert.equal((await start(startRequest(form))).status, 200);
  const before = calls.length;
  const res = await start(startRequest(form));
  assert.equal(res.status, 429);
  assert.equal(calls.length, before);
});

test('start: the global cap comes from Apify: 15 runs today -> 429, no paid start; yesterday does not count', async () => {
  stubFetch([runList(15), startOk]);
  const res = await start(startRequest(form));
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /daily limit/);
  assert.ok(!calls.some((c) => c.url.includes('maxTotalChargeUsd')));
  stubFetch([runList(14), startOk]);
  assert.equal((await start(startRequest(form))).status, 200);
});

test('start: if Apify cannot list today\'s runs, no run starts', async () => {
  stubFetch([{ match: '/runs?desc=1', status: 500, body: {} }, startOk]);
  const res = await start(startRequest(form));
  assert.equal(res.status, 502);
  assert.ok(!calls.some((c) => c.url.includes('maxTotalChargeUsd')));
});

test('start: the visitor slot is counted before the paid call, so a refused run still uses it', async () => {
  stubFetch([runList(0), { match: '/runs?maxTotalChargeUsd', status: 402, body: {} }]);
  const res = await start(startRequest(form));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /credit is used up/);
  assert.equal([...env.KV.store.keys()].filter((k) => k.startsWith('ip:')).length, 1);
});

test('start: a failed counter write stops before the paid call, with JSON 503', async () => {
  env.KV = fakeKv({ failPut: (k) => k.startsWith('ip:') });
  stubFetch([runList(0), startOk]);
  const res = await start(startRequest(form));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /busy/);
  assert.ok(!calls.some((c) => c.url.includes('maxTotalChargeUsd')));
});

test('start: an unexpected error is answered in JSON, not an HTML page', async () => {
  env.KV = { get: async () => { throw new Error('boom'); }, put: async () => {} };
  const res = await start(startRequest(form));
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.match((await res.json()).error, /Unexpected server error/);
});

// ---- status ----

const succeeded = { match: `/actor-runs/${RUN}`, body: { data: { status: 'SUCCEEDED', defaultDatasetId: 'DS1', usageTotalUsd: 0.04 } } };
// 120 items in the dataset: 2 full pages of 50 and one of 20. Odd items are videos with views.
function datasetItems() {
  const items = Array.from({ length: 119 }, (_, i) => ({
    inputUrl: 'https://www.instagram.com/alpha/', shortCode: `P${i}`, type: i % 2 ? 'Video' : 'Image', timestamp: recent(),
    videoPlayCount: i % 2 ? i * 10 : null, likesCount: i, caption: 'Line one\nmore ' + 'x'.repeat(900),
    videoUrl: i % 2 ? 'https://cdn/secret.mp4' : null, audioUrl: i % 2 ? 'https://scontent.cdninstagram.com/a.m4a' : null,
  }));
  items.push({ url: 'https://www.instagram.com/ghost/', username: 'ghost', error: 'not_found', errorDescription: 'Profile does not exist' });
  return items;
}
const datasetPages = () => [0, 50, 100].map((o) => ({ body: datasetItems().slice(o, o + 50), headers: { 'x-apify-pagination-total': '120' } }));

test('status: a made-up run id or a bad page stops before any provider call', async () => {
  stubFetch([]);
  assert.equal((await status(statusRequest('run=MADEUP123456'))).status, 404);
  assert.equal((await status(statusRequest('run=../../etc'))).status, 404);
  await seedRun(['alpha', 'ghost']);
  for (const bad of ['-1', '1.5', 'abc', '99']) assert.equal((await status(statusRequest(`run=${RUN}&page=${bad}`))).status, 400, bad);
  assert.equal(calls.length, 0);
});

test('status: scraping, then one page per call, then the top 10 chosen from the full list of 119 posts', async () => {
  await seedRun(['alpha', 'ghost']);
  const writesBefore = env.KV.writes;

  stubFetch([{ match: `/actor-runs/${RUN}`, body: { data: { status: 'RUNNING' } } }]);
  assert.deepEqual(await (await status(statusRequest(`run=${RUN}`))).json(), { stage: 'scraping' });

  stubFetch([{ match: '/datasets/DS1/items', replies: datasetPages() }, succeeded]);
  let res = await (await status(statusRequest(`run=${RUN}`))).json(); // first call after SUCCEEDED reads page 0
  assert.deepEqual(res, { stage: 'reading', nextPage: 1, pagesRead: 1, pagesTotal: 3 });
  res = await (await status(statusRequest(`run=${RUN}&page=1`))).json();
  assert.equal(res.nextPage, 2);
  res = await (await status(statusRequest(`run=${RUN}&page=2`))).json();

  assert.equal(res.stage, 'ranked');
  assert.equal(res.scrapeCostUsd, 0.04);
  assert.equal(res.postCount, 10);
  assert.equal(res.batchCount, Math.ceil(10 / BATCH_SIZE));
  assert.equal(res.batchSize, BATCH_SIZE);
  const [alpha, ghost] = res.accounts;
  // The expected top 10 from the whole source list: the 10 videos with the most views.
  const expected = datasetItems().filter((i) => i.videoPlayCount).sort((a, b) => b.videoPlayCount - a.videoPlayCount).slice(0, 10).map((i) => i.videoPlayCount);
  assert.deepEqual(alpha.posts.map((p) => p.views), expected);
  assert.equal(alpha.isClient, true);
  assert.equal(alpha.posts[0].title, 'Line one');
  assert.equal(alpha.posts[0].mark, 'wait');
  assert.match(alpha.note, /Only the newest 80 posts/);
  assert.match(alpha.note, /posts without a view count .* are not in the top 10/);
  assert.equal(ghost.status, 'missing');
  assert.ok(!JSON.stringify(res).includes('secret.mp4') && !JSON.stringify(res).includes('cdninstagram'), 'media URLs stay on the server');

  const page0 = await env.KV.get(`pg:${RUN}:0`, 'json');
  assert.ok(page0.posts.every((p) => p.caption.length <= 500));
  const top = await env.KV.get(`top:${RUN}`, 'json');
  assert.equal(top.accounts[0].posts[0].hasVideo, true);
  assert.equal(top.accounts[0].posts[0].audioUrl, 'https://scontent.cdninstagram.com/a.m4a');
  assert.ok(!JSON.stringify(top).includes('secret.mp4'), 'the video URL is not stored');
  assert.ok(top.rankedAt);
  assert.equal(await env.KV.get(`pg:${RUN}:2`), null, 'the last page is not stored');
  assert.equal(env.KV.writes - writesBefore, 3, '2 page keys and the top list');
});

test('status replay: stored pages and the stored top list are reused, with no write', async () => {
  await seedRun(['alpha', 'ghost']);
  stubFetch([{ match: '/datasets/DS1/items', replies: datasetPages() }, succeeded]);
  for (const q of ['', '&page=1', '&page=2']) await status(statusRequest(`run=${RUN}${q}`));
  const first = await env.KV.get(`top:${RUN}`, 'json');
  const writes = env.KV.writes;

  stubFetch([]);
  for (const q of ['&page=0', '&page=1']) await status(statusRequest(`run=${RUN}${q}`));
  assert.equal(calls.length, 0, 'no Apify call for a stored page');
  // The last page is not stored, so its replay reads it from Apify again (free) and returns the stored top list.
  stubFetch([{ match: '/datasets/DS1/items', replies: [datasetPages()[2], datasetPages()[2]] }, succeeded]);
  for (let i = 0; i < 2; i++) assert.equal((await (await status(statusRequest(`run=${RUN}&page=2`))).json()).stage, 'ranked');
  assert.equal(env.KV.writes, writes, 'no KV write on a replay');
  assert.deepEqual(await env.KV.get(`top:${RUN}`, 'json'), first, 'the ranking and its post numbers stay the same');
});

test('status: earlier pages that KV does not show yet are read from Apify again, with no KV write', async () => {
  await seedRun(['alpha', 'ghost']);
  const [p0, p1, p2] = datasetPages();
  stubFetch([{ match: '/datasets/DS1/items', replies: [p2, p0, p1] }, succeeded]);
  const writesBefore = env.KV.writes;
  const res = await (await status(statusRequest(`run=${RUN}&page=2`))).json();
  assert.equal(res.stage, 'ranked');
  assert.equal(res.accounts[0].posts.length, 10);
  assert.equal(calls.filter((c) => c.url.includes('/datasets/')).length, 3);
  assert.equal(env.KV.writes - writesBefore, 1, 'only the top list is written');
});

test('status: more than 4 pages not visible -> the browser waits and asks for the same page', async () => {
  await seedRun(Array.from({ length: 11 }, (_, i) => `u${i}`));
  stubFetch([{ match: '/datasets/DS1/items', replies: [{ body: [], headers: { 'x-apify-pagination-total': '300' } }] }, succeeded]);
  const res = await (await status(statusRequest(`run=${RUN}&page=6`))).json();
  assert.deepEqual(res, { stage: 'reading', nextPage: 6, pagesRead: 7, pagesTotal: 6, retry: true });
  assert.equal(calls.filter((c) => c.url.includes('/datasets/')).length, 1, 'no refill reads');
});

test('status: the 90-day window ends at the run start, not at the time of the call', async () => {
  const day = 86400000;
  // The run started 10 days ago. A post 95 days old now was 85 days old then: it is in the window.
  await env.KV.put(`run:${RUN}`, JSON.stringify({ runId: RUN, usernames: ['alpha'], client: 'alpha', createdAt: new Date(Date.now() - 10 * day).toISOString() }));
  const items = [{ inputUrl: 'https://www.instagram.com/alpha/', shortCode: 'OLD', type: 'Video', timestamp: new Date(Date.now() - 95 * day).toISOString(), videoPlayCount: 5 }];
  stubFetch([{ match: '/datasets/DS1/items', replies: [{ body: items }] }, succeeded]);
  const res = await (await status(statusRequest(`run=${RUN}&page=0`))).json();
  assert.equal(res.accounts[0].posts.length, 1);
});

test('status: a short page is not the end when the total header says more items follow', async () => {
  await seedRun(['alpha', 'ghost']);
  const short = { body: datasetItems().slice(0, 30), headers: { 'x-apify-pagination-total': '120' } };
  stubFetch([{ match: '/datasets/DS1/items', replies: [short] }, succeeded]);
  const res = await (await status(statusRequest(`run=${RUN}&page=0`))).json();
  assert.deepEqual(res, { stage: 'reading', nextPage: 1, pagesRead: 1, pagesTotal: 3 });
});

test('status: a failed write of the top list still returns the ranked posts', async () => {
  env.KV = fakeKv({ failPut: (k) => k.startsWith('top:') });
  await seedRun(['alpha', 'ghost']);
  stubFetch([{ match: '/datasets/DS1/items', replies: datasetPages() }, succeeded]);
  for (const q of ['', '&page=1']) await status(statusRequest(`run=${RUN}${q}`));
  const res = await status(statusRequest(`run=${RUN}&page=2`));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stage, 'ranked');
});

test('status: a provider error is a 502 in JSON (the page asks again), not a failed run', async () => {
  await seedRun(['alpha']);
  stubFetch([{ match: '/actor-runs/', status: 503, body: {} }]);
  const res = await status(statusRequest(`run=${RUN}`));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.stage, undefined);
  assert.match(body.error, /HTTP 503/);
});

test('status: a failed scrape names the cause', async () => {
  await seedRun(['alpha']);
  stubFetch([{ match: '/actor-runs/', body: { data: { status: 'TIMED-OUT' } } }]);
  const res = await (await status(statusRequest(`run=${RUN}`))).json();
  assert.equal(res.stage, 'failed');
  assert.match(res.error, /TIMED-OUT/);
});
