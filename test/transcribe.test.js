// transcribe.js with a fake KV and a stubbed fetch for the CDN and OpenAI. No network calls.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as transcribe } from '../functions/api/transcribe.js';
import { isMediaUrl, MAX_BYTES } from '../lib/transcribe.js';
import { BATCH_SIZE } from '../lib/rank.js';
import { fakeKv } from './fake-kv.js';
import { calls, restoreFetch, RUN, audio } from './helpers.js';

let env;
beforeEach(() => { env = { KV: fakeKv(), OPENAI_API_KEY: 'test-oai-key' }; });
afterEach(restoreFetch);

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

// CDN answers per audio URL; OpenAI answers in turn from openai.replies.
function stub({ cdn = {}, openai = { replies: [] } } = {}) {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    if (url.includes('cdninstagram.com') || url.includes('fbcdn.net')) {
      assert.equal(init.redirect, 'manual', 'redirects are not followed on the media fetch');
      const r = cdn[url] ?? { status: 200 };
      if (r.throw) throw new Error('timeout');
      // r.body may be a function, so each attempt gets a fresh stream.
      const body = typeof r.body === 'function' ? r.body() : r.body;
      return new Response(r.status === 200 ? (body ?? new Uint8Array([1, 2, 3])) : 'denied', { status: r.status, headers: r.headers || {} });
    }
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      assert.equal(init.body.get('model'), 'gpt-transcribe');
      assert.equal(init.body.get('file').name, 'audio.m4a');
      assert.equal(init.headers.Authorization, 'Bearer test-oai-key');
      const next = openai.replies.shift();
      return new Response(JSON.stringify(next.body), { status: next.status || 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
}

// One account with the given posts, numbered from 0. batchCount follows BATCH_SIZE.
async function seed(posts) {
  const numbered = posts.map((p, i) => ({ index: i, rank: i + 1, caption: `Caption ${i}`, type: 'video', duration: 30, ...p }));
  await env.KV.put(`run:${RUN}`, JSON.stringify({ usernames: ['a'], client: 'a' }));
  await env.KV.put(`top:${RUN}`, JSON.stringify({ batchCount: Math.ceil(numbered.length / BATCH_SIZE), accounts: [{ account: 'a', posts: numbered }] }));
}
const req = (body) => ({ request: new Request('https://x.test/api/transcribe', { method: 'POST', body: JSON.stringify(body) }), env });
async function allBatches(n) {
  const posts = [];
  for (let batch = 0; batch < Math.ceil(n / BATCH_SIZE); batch++) {
    const res = await transcribe(req({ runId: RUN, batch }));
    assert.equal(res.status, 200);
    posts.push(...(await res.json()).posts);
  }
  return posts;
}

test('isMediaUrl allows only https Instagram media hosts', () => {
  assert.ok(isMediaUrl('https://scontent-waw2-1.cdninstagram.com/v/x.mp4'));
  assert.ok(isMediaUrl('https://scontent.fltn4-1.fna.fbcdn.net/o1/v/x.mp4'));
  for (const bad of ['http://scontent.cdninstagram.com/x', 'https://evil.test/x', 'https://cdninstagram.com.evil.test/x', 'https://evilcdninstagram.com/x', 'not a url', null]) {
    assert.equal(isMediaUrl(bad), false, String(bad));
  }
});

test('unknown run, bad batch, and bad JSON stop before any provider call', async () => {
  stub();
  assert.equal((await transcribe(req({ runId: 'MADEUP123456', batch: 0 }))).status, 404);
  assert.equal((await transcribe(req({ runId: '../x', batch: 0 }))).status, 404);
  await seed([{ audioUrl: audio(0) }]);
  for (const batch of [-1, 1, 0.5, '0', null]) assert.equal((await transcribe(req({ runId: RUN, batch }))).status, 400, String(batch));
  const bad = { request: new Request('https://x.test/api/transcribe', { method: 'POST', body: 'not json' }), env };
  assert.equal((await transcribe(bad)).status, 400);
  assert.equal(calls.length, 0);
});

test('each mark: speech, nospeech, novideo, long, failed (no audio, bad host, CDN error twice)', async () => {
  await seed([
    { audioUrl: audio('speech') }, // 0 speech, 3 words is enough
    { audioUrl: audio('quiet') }, // 1 two words -> nospeech
    { type: 'image', audioUrl: null, hasVideo: false }, // 2 photo -> novideo
    { type: 'video', audioUrl: null, hasVideo: true }, // 3 video without audio -> failed
    { audioUrl: audio('long'), duration: 600 }, // 4 over 3 minutes -> long, no download
    { audioUrl: audio('blocked') }, // 5 CDN 403 twice -> failed
    { audioUrl: 'https://evil.test/a.m4a' }, // 6 not an Instagram host -> failed, no fetch
    { audioUrl: audio('noduration'), duration: null }, // 7 unknown duration is allowed
    { audioUrl: audio('moved') }, // 8 a redirect is refused, twice -> failed
  ]);
  stub({
    cdn: { [audio('blocked')]: { status: 403 }, [audio('moved')]: { status: 302 } },
    openai: { replies: [{ body: { text: 'one two three' } }, { body: { text: 'la la' } }, { body: { text: words(5) } }] },
  });
  const posts = await allBatches(9);
  assert.deepEqual(posts.map((p) => p.mark), ['speech', 'nospeech', 'novideo', 'failed', 'long', 'failed', 'failed', 'speech', 'failed']);
  assert.equal(posts[0].transcript, 'one two three');
  assert.equal(posts[1].transcript, 'Caption 1', 'nospeech uses the caption');
  assert.equal(posts[4].transcript, 'Caption 4', 'long uses the caption');
  assert.ok(!calls.some((c) => c.url.includes('/long') || c.url.includes('evil')), 'no download for skipped posts');
  assert.equal(calls.filter((c) => c.url === audio('blocked')).length, 2);
  assert.equal(calls.filter((c) => c.url === audio('moved')).length, 2, 'a redirect is not followed, then retried once');
});

test('an audio file over 8 MB is not sent to OpenAI (by header, and while reading a stream)', async () => {
  assert.equal(MAX_BYTES, 8 * 1024 * 1024);
  await seed([{ audioUrl: audio('big') }, { audioUrl: audio('stream') }]);
  const chunk = new Uint8Array(1024 * 1024);
  let cancelled = 0;
  // A fresh 9 MB stream for each attempt, with no content-length header.
  const stream = () => new ReadableStream({
    pull(c) { c.enqueue(chunk); },
    cancel() { cancelled++; },
  });
  stub({ cdn: {
    [audio('big')]: { status: 200, headers: { 'content-length': String(MAX_BYTES + 1) } },
    [audio('stream')]: { status: 200, body: stream },
  } });
  const posts = await allBatches(2);
  assert.deepEqual(posts.map((p) => p.mark), ['failed', 'failed']);
  assert.equal(cancelled, 2, 'both attempts stop reading at the cap');
  assert.ok(!calls.some((c) => c.url.includes('openai')));
});

test('a failed KV write still returns the paid transcripts', async () => {
  env.KV = fakeKv({ failPut: (k) => k.startsWith('tx:') });
  await seed([{ audioUrl: audio('a') }]);
  stub({ openai: { replies: [{ body: { text: words(9) } }] } });
  const res = await transcribe(req({ runId: RUN, batch: 0 }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).posts[0].mark, 'speech');
});

test('an OpenAI error is retried once, then succeeds', async () => {
  await seed([{ audioUrl: audio('a') }]);
  stub({ openai: { replies: [{ status: 400, body: { error: { message: 'Audio file might be corrupted' } } }, { body: { text: words(12) } }] } });
  const { posts } = await (await transcribe(req({ runId: RUN, batch: 0 }))).json();
  assert.equal(posts[0].mark, 'speech');
  assert.equal(calls.filter((c) => c.url.includes('openai')).length, 2);
});

test('a CDN timeout twice marks the post failed and keeps the other posts of the batch', async () => {
  await seed([{ audioUrl: audio('hang') }, { audioUrl: audio('ok') }]);
  stub({ cdn: { [audio('hang')]: { throw: true } }, openai: { replies: [{ body: { text: words(10) } }] } });
  const posts = await allBatches(2);
  assert.deepEqual(posts.map((p) => p.mark), ['failed', 'speech']);
  assert.equal(posts[0].transcript, 'Caption 0');
});

test('replay: a second call returns the saved batch and makes zero provider calls', async () => {
  await seed([{ audioUrl: audio('a') }]);
  stub({ openai: { replies: [{ body: { text: words(9) } }] } });
  const first = await (await transcribe(req({ runId: RUN, batch: 0 }))).json();
  const writes = env.KV.writes;
  stub();
  const again = await (await transcribe(req({ runId: RUN, batch: 0 }))).json();
  assert.deepEqual(again, first);
  assert.equal(calls.length, 0);
  assert.equal(env.KV.writes, writes);
});

test('batch membership follows BATCH_SIZE, and the audio URL comes from KV, not the browser', async () => {
  const n = BATCH_SIZE * 2 + 1;
  await seed(Array.from({ length: n }, (_, i) => ({ audioUrl: audio(i) })));
  stub({ openai: { replies: [{ body: { text: words(9) } }] } });
  const { posts } = await (await transcribe(req({ runId: RUN, batch: 2, audioUrl: 'https://evil.test/x' }))).json();
  assert.deepEqual(posts.map((p) => p.index), [BATCH_SIZE * 2]);
  assert.equal(calls[0].url, audio(BATCH_SIZE * 2));
  assert.ok(!calls.some((c) => c.url.includes('evil')));
});

test('delayed KV: a top list that is not visible yet gives 409 retry, then works once visible', async () => {
  env.KV = fakeKv({ delayed: true });
  await env.KV.put(`run:${RUN}`, JSON.stringify({ usernames: ['a'], client: 'a' }));
  env.KV.settle(); // the run record is old enough to be visible
  await env.KV.put(`top:${RUN}`, JSON.stringify({ batchCount: 1, accounts: [{ account: 'a', posts: [{ index: 0, rank: 1, caption: 'c', type: 'video', duration: 9, audioUrl: audio('d') }] }] }));
  stub({ openai: { replies: [{ body: { text: words(5) } }] } });
  const early = await transcribe(req({ runId: RUN, batch: 0 }));
  assert.equal(early.status, 409);
  assert.equal((await early.json()).retry, true);
  assert.equal(calls.length, 0);
  env.KV.settle();
  env.KV.expire();
  const later = await transcribe(req({ runId: RUN, batch: 0 }));
  assert.equal(later.status, 200);
});
