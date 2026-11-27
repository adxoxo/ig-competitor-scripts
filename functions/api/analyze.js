// POST /api/analyze  { runId, final? }
// Reads the top posts and the transcripts from KV (never from the browser), makes one Claude call,
// and returns the full page object.
//   an:<runId>         this run's result, saved every time: a repeat call pays for nothing
//   result:<accounts>  the 24 h cache for the same account set, saved only for a good result

import { cacheKey } from '../../lib/guard.js';
import { analyze } from '../../lib/llm.js';
import { accountsView, isVideo } from '../../lib/view.js';
import { json, jsonErrors, isRunId, savePut, methodNotAllowed } from '../../lib/http.js';

// The browser may send final: true when transcripts stay invisible. The server accepts it only
// this long after the ranking, so nobody can trigger the paid call early.
export const FINAL_AFTER_MS = 90_000;

export const onRequestPost = jsonErrors(async ({ request, env }) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send the run id as JSON.' }, 400);
  }
  const runId = body?.runId;
  if (!isRunId(runId)) return json({ error: 'Unknown run.' }, 404);

  const run = await env.KV.get(`run:${runId}`, 'json');
  if (!run) return json({ error: 'Unknown run.' }, 404);

  // This run was analysed before: return the saved result.
  const done = await env.KV.get(`an:${runId}`, 'json');
  if (done) return json(done);

  // KV can take a few seconds to show a new key. A 409 with retry tells the browser to ask again.
  const top = await env.KV.get(`top:${runId}`, 'json');
  if (!top) return json({ error: 'The ranked posts are not visible yet.', retry: true }, 409);

  // All transcript batches in one bulk read.
  const transcripts = new Map();
  let complete = true;
  if (top.batchCount > 0) {
    const keys = Array.from({ length: top.batchCount }, (_, i) => `tx:${runId}:${i}`);
    for (const batch of (await env.KV.get(keys, 'json')).values()) {
      if (!batch) { complete = false; continue; }
      for (const p of batch.posts) transcripts.set(p.index, { mark: p.mark, transcript: p.transcript });
    }
  }
  // A missing batch is usually a new key that KV does not show yet: ask the browser to wait.
  // After FINAL_AFTER_MS the browser may say final: true; the posts of that batch then count as "failed".
  const finalAllowed = body.final === true && Date.now() - Date.parse(top.rankedAt) > FINAL_AFTER_MS;
  if (!complete && !finalAllowed) return json({ error: 'Some transcripts are not visible yet.', retry: true }, 409);

  let analysis;
  try {
    analysis = await analyze(env, run.client, top.accounts, transcripts);
  } catch (err) {
    return json({ error: err.message, noPosts: Boolean(err.noPosts) }, err.noPosts ? 422 : 502);
  }

  const accounts = accountsView(top.accounts, run.client, transcripts, 'failed');
  const result = {
    client: run.client,
    cached: false,
    accounts,
    ...analysis,
    scrapeCostUsd: top.scrapeCostUsd ?? null,
    createdAt: new Date().toISOString(),
  };
  // The analysis is paid for: return it even when a write fails.
  await savePut(env.KV, `an:${runId}`, JSON.stringify(result));

  // The 24 h cache serves other visitors, so it takes only a good result: all batches present,
  // and at most half of the videos without a transcript (an outage must not stay for a day).
  const videos = top.accounts.flatMap((a) => a.posts).filter(isVideo);
  const failed = videos.filter((p) => !transcripts.has(p.index) || transcripts.get(p.index).mark === 'failed').length;
  if (complete && failed * 2 <= videos.length) {
    await savePut(env.KV, cacheKey(run.usernames, run.client), JSON.stringify(result));
  }
  return json(result);
});

// Any other method gets 405 in JSON.
export const onRequest = methodNotAllowed('POST');
