// POST /api/start  { usernames: [...], client: "name" }
// Checks the input, returns a cached result if one exists, checks the caps, and starts a scrape.
// The order matters: every check that costs nothing runs before the scraper is called.

import { validateInput, cacheKey, checkIpCap, countIpRun, hashIp, today, MAX_RUNS_PER_DAY } from '../../lib/guard.js';
import { startRun, runsStartedToday } from '../../lib/apify.js';
import { json, jsonErrors, savePut, methodNotAllowed } from '../../lib/http.js';

export const onRequestPost = jsonErrors(async ({ request, env }) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send the form data as JSON.' }, 400);
  }

  // 1. Input check (no cost).
  const input = validateInput(body);
  if (!input.ok) return json({ error: input.error }, 400);
  const { usernames, client } = input;

  // 2. Cache: the same accounts and client return the saved result (no cost).
  const cached = await env.KV.get(cacheKey(usernames, client), 'json');
  if (cached) return json({ ...cached, cached: true });

  // 3. Daily caps (no cost). The visitor's cap is in KV (approximate).
  const date = today();
  const ipHash = await hashIp(request.headers.get('CF-Connecting-IP') || 'unknown', date);
  const ipCap = await checkIpCap(env.KV, ipHash, date);
  if (!ipCap.ok) return json({ error: ipCap.error }, 429);

  // The global cap counts today's runs on Apify itself, which is consistent. If Apify cannot
  // answer, no run starts (the safe side for spend).
  let started;
  try {
    started = await runsStartedToday(env, MAX_RUNS_PER_DAY + 5);
  } catch (err) {
    return json({ error: err.message }, 502);
  }
  if (started >= MAX_RUNS_PER_DAY) {
    return json({ error: 'The daily limit of new runs is reached. Try again tomorrow.' }, 429);
  }

  // Count the visitor's run before the paid call. If the write fails, stop here at no cost.
  try {
    await countIpRun(env.KV, ipHash, date);
  } catch (err) {
    console.error('KV write failed for ip:', err?.message);
    return json({ error: 'The tool is busy. Try again in a few seconds.' }, 503);
  }

  // 4. Start the scrape. This is the first step that costs money.
  let runId;
  try {
    runId = await startRun(usernames, env);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  // Save what the run is for. Later calls read the accounts from here, never from the browser.
  // createdAt also fixes the 90-day window for this run.
  const run = { runId, usernames, client, createdAt: new Date().toISOString() };
  if (!(await savePut(env.KV, `run:${runId}`, JSON.stringify(run)))) {
    // Without this record the run cannot go on. The scrape is paid; say so plainly.
    return json({ error: 'The run started but could not be saved. Try again in a minute.' }, 503);
  }
  return json({ runId });
});

// Any other method gets 405 in JSON.
export const onRequest = methodNotAllowed('POST');
