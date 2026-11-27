// GET /api/status?run=ID            while the scrape runs, poll every 5 s
// GET /api/status?run=ID&page=N     after the scrape, read one dataset page per call
//
// One page per call keeps each request far below the 10 ms CPU limit.
//   pg:<runId>:<page>   the slim posts of one page
//   top:<runId>         the top 10 per account, written when the last page is read
// A repeat call reuses what is saved: a stored page is not read from Apify or written again,
// and a stored top list is returned as it is. The last page is never stored (top replaces it).
// KV can take a few seconds to show a new key, and it caches "not found" for up to 60 s.
// So the last page reads any earlier page that KV does not show yet from Apify again (free, no write).

import { getRun, readPage, POSTS_PER_ACCOUNT, PAGE_SIZE } from '../../lib/apify.js';
import { rankPosts, BATCH_SIZE } from '../../lib/rank.js';
import { accountsView } from '../../lib/view.js';
import { json, jsonErrors, isRunId, savePut, methodNotAllowed } from '../../lib/http.js';

const CAPTION_CHARS = 500; // enough for the title and the analysis
// More missing pages than this would cost too much CPU in one request: the browser waits and asks again.
const MAX_REFILL_PAGES = 4;

// Keep only what rank.js and the later steps need.
function slimPage(result) {
  return {
    posts: result.posts.map((p) => ({ ...p, caption: p.caption.slice(0, CAPTION_CHARS) })),
    accountErrors: result.accountErrors,
    done: result.done,
    total: result.total,
    costUsd: result.costUsd,
  };
}

export const onRequestGet = jsonErrors(async ({ request, env }) => {
  const params = new URL(request.url).searchParams;
  const runId = params.get('run');
  if (!isRunId(runId)) return json({ error: 'Unknown run.' }, 404);

  // Only runs that start.js created exist here. A made-up id stops before any provider call.
  const run = await env.KV.get(`run:${runId}`, 'json');
  if (!run) return json({ error: 'Unknown run.' }, 404);

  // The page index comes from the browser, so check it against the most pages this run can have.
  const maxPage = Math.ceil((run.usernames.length * POSTS_PER_ACCOUNT) / PAGE_SIZE);
  let page = 0;
  if (params.has('page')) {
    page = Number(params.get('page'));
    if (!Number.isInteger(page) || page < 0 || page > maxPage) return json({ error: 'Bad page.' }, 400);
  }

  let current;
  try {
    // Without a page index, the scrape may still run: ask Apify first.
    if (!params.has('page')) {
      const state = await getRun(runId, env);
      if (state.state === 'running') return json({ stage: 'scraping' });
      if (state.state === 'failed') return json({ stage: 'failed', error: state.reason });
    }
    const key = `pg:${runId}:${page}`;
    current = await env.KV.get(key, 'json');
    if (!current) {
      current = slimPage(await readPage(runId, env, page));
      // The last page is not stored: the top list replaces it, and a replay reads it from Apify for free.
      if (!current.done) await savePut(env.KV, key, JSON.stringify(current));
    }
  } catch (err) {
    // A passing provider error: the page asks again (up to 3 times) before it gives up.
    return json({ error: err.message }, 502);
  }

  const pagesTotal = current.total ? Math.ceil(current.total / PAGE_SIZE) : null;
  if (!current.done) return json({ stage: 'reading', nextPage: page + 1, pagesRead: page + 1, pagesTotal });

  // Last page. A finished ranking is reused, so the post numbers never change.
  const saved = await env.KV.get(`top:${runId}`, 'json');
  if (saved) return json(rankedView(saved, run));

  // Collect the earlier pages with one bulk read. This page is already in memory.
  const keys = Array.from({ length: page }, (_, i) => `pg:${runId}:${i}`);
  const stored = keys.length ? await env.KV.get(keys, 'json') : new Map();
  const missing = keys.filter((k) => !stored.get(k));
  if (missing.length > MAX_REFILL_PAGES) {
    return json({ stage: 'reading', nextPage: page, pagesRead: page + 1, pagesTotal, retry: true });
  }
  const pages = [];
  try {
    for (let i = 0; i < page; i++) pages.push(stored.get(keys[i]) || slimPage(await readPage(runId, env, i)));
  } catch (err) {
    return json({ error: err.message }, 502);
  }
  pages.push(current);

  const posts = [];
  const accountErrors = {};
  for (const p of pages) {
    posts.push(...p.posts);
    Object.assign(accountErrors, p.accountErrors);
  }
  // The 90-day window ends at the run's start time, so a repeat gives the same list.
  const accounts = rankPosts(posts, run.usernames, { now: Date.parse(run.createdAt), accountErrors, fetchLimit: POSTS_PER_ACCOUNT });

  // Number the posts in one list, so a batch index points to a fixed set of posts.
  accounts.flatMap((a) => a.posts).forEach((post, i) => { post.index = i; });
  const postCount = accounts.reduce((n, a) => n + a.posts.length, 0);
  const top = {
    accounts,
    postCount,
    batchCount: Math.ceil(postCount / BATCH_SIZE),
    batchSize: BATCH_SIZE, // stored, so a run keeps its batch size across a deploy
    scrapeCostUsd: current.costUsd ?? null,
    rankedAt: new Date().toISOString(), // analyze.js uses it to time the "final" fallback
  };
  await savePut(env.KV, `top:${runId}`, JSON.stringify(top));
  return json(rankedView(top, run));
});

// The browser gets the page shape. Media URLs stay on the server.
function rankedView(top, run) {
  return {
    stage: 'ranked',
    postCount: top.postCount,
    batchCount: top.batchCount,
    batchSize: top.batchSize ?? 3, // 3: runs ranked before batchSize was stored
    client: run.client,
    cached: false,
    scrapeCostUsd: top.scrapeCostUsd,
    accounts: accountsView(top.accounts, run.client),
  };
}

// Any other method gets 405 in JSON.
export const onRequest = methodNotAllowed('GET');
