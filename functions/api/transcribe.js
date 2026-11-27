// POST /api/transcribe  { runId, batch }
// Transcribes one batch of posts (BATCH_SIZE) and stores the result in KV as tx:<runId>:<batch>.
// The audio URLs come from the server's own ranked list, never from the browser.

import { BATCH_SIZE } from '../../lib/rank.js';
import { transcribePost } from '../../lib/transcribe.js';
import { json, jsonErrors, isRunId, savePut } from '../../lib/http.js';

export const onRequestPost = jsonErrors(async ({ request, env }) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send the run id and batch as JSON.' }, 400);
  }
  const runId = body?.runId;
  const batch = body?.batch;
  if (!isRunId(runId)) return json({ error: 'Unknown run.' }, 404);

  // Only a ranked run of ours has batches. Everything here is checked before any paid call.
  const top = await env.KV.get(`top:${runId}`, 'json');
  if (!top) {
    // top:<id> is written seconds before the first batch, and KV can be slow to show a new key.
    // For a real run, ask the browser to try again. A made-up run id gets 404.
    if (await env.KV.get(`run:${runId}`)) return json({ error: 'The ranked posts are not visible yet.', retry: true }, 409);
    return json({ error: 'Unknown run.' }, 404);
  }
  if (!Number.isInteger(batch) || batch < 0 || batch >= top.batchCount) return json({ error: 'Bad batch.' }, 400);

  // A repeat call returns the saved batch and pays for nothing.
  // (This read can make KV cache "not found" for a short time; analyze.js then answers 409 retry.)
  const key = `tx:${runId}:${batch}`;
  const saved = await env.KV.get(key, 'json');
  if (saved) return json(saved);

  const first = batch * BATCH_SIZE;
  const posts = top.accounts.flatMap((a) => a.posts).filter((p) => p.index >= first && p.index < first + BATCH_SIZE);

  // All posts of the batch at once. allSettled: one bad post never fails the others.
  const settled = await Promise.allSettled(posts.map((p) => transcribePost(p, env)));
  const result = {
    posts: settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { index: posts[i].index, mark: 'failed', transcript: posts[i].caption || '' })),
  };

  // The transcripts are paid for: return them even when the write fails.
  await savePut(env.KV, key, JSON.stringify(result));
  return json(result);
});
