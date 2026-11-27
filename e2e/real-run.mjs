// Real end-to-end run: no stubs. It drives the page against real providers, so each new run costs money.
// Run it in the Playwright Docker image (see e2e/README.md).
//
// Env:
//   BASE_URL   the page to test, for example http://127.0.0.1:8799/ or https://<project>.pages.dev/
//   SET        an account set from e2e/accounts.json (default: finance)
//   OUT_DIR    where the video, screenshots, and report go (default: ./e2e-out)
//   SKIP_CACHE 1 = skip the cache re-run
//   EXPECT_MISSING  a username that must end with a "not found" note (used by the negative set)
//   REPLAY_RUN_ID   only replay /api/transcribe and /api/analyze for a finished run (free); REPLAY_BATCH_COUNT = its batch count
//
// Exit code: 0 when every check passes, 1 otherwise.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8799/';
const SET = process.env.SET || 'finance';
const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'e2e-out');
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const CACHE_LIMIT_MS = 3000;
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const POST_URL = /^https:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?(\?.*)?$/;

const sets = JSON.parse(await readFile(path.join(HERE, 'accounts.json'), 'utf8'));
const set = sets[SET];
if (!set) throw new Error(`Unknown SET "${SET}". Use one of: ${Object.keys(sets).filter((k) => !k.startsWith('_')).join(', ')}`);
const usernames = set.accounts;
const clientIdx = usernames.indexOf(set.client);
if (clientIdx < 0) throw new Error('The client must be one of the accounts.');

await mkdir(path.join(OUT, 'video'), { recursive: true });

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`);
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: path.join(OUT, 'video'), size: { width: 1280, height: 800 } },
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE_URL).origin });
const page = await context.newPage();

// Network log: every /api call, and the JSON bodies the checks need.
const calls = [];
const bodies = { ranked: null, analyze: null, starts: [] };
page.on('request', (req) => {
  const u = new URL(req.url());
  if (u.pathname.startsWith('/api/')) calls.push({ at: Date.now(), path: u.pathname, method: req.method() });
});
page.on('response', async (res) => {
  const u = new URL(res.url());
  if (!u.pathname.startsWith('/api/')) return;
  let data = null;
  try { data = await res.json(); } catch { return; }
  if (u.pathname === '/api/start') bodies.starts.push({ status: res.status(), data });
  if (u.pathname === '/api/status' && data?.stage === 'ranked') bodies.ranked = data;
  if (u.pathname === '/api/analyze') bodies.analyze = { status: res.status(), data };
});
page.on('pageerror', (err) => log('page error:', err.message));

const shot = (name, full = true) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
const visibleView = () => page.evaluate(() => document.querySelector('.view:not([hidden])')?.dataset.view);

async function fillForm() {
  await page.goto(BASE_URL);
  for (let i = 4; i < usernames.length; i++) await page.click('#add-acct');
  for (let i = 0; i < usernames.length; i++) await page.fill(`input[data-i="${i}"]`, usernames[i]);
  await page.check(`input[name="client"][value="${clientIdx}"]`);
}

// POST to the API from the page (same origin), timed.
async function postTimed(apiPath, body) {
  return page.evaluate(async ({ apiPath, body }) => {
    const t = performance.now();
    const res = await fetch(apiPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, ms: Math.round(performance.now() - t), data };
  }, { apiPath, body });
}

const REPLAY_LIMIT_MS = 2000;
let report_runId = null;

// A repeat of a finished paid step returns its saved answer: no provider call, so it is fast.
// first: the analyze result of the first run, when the caller has it.
async function replayChecks(runId, batchCount, first) {
  const batch = Math.max(0, batchCount - 1); // the last batch: it finished last, so it is the strictest case
  const tx = await postTimed('/api/transcribe', { runId, batch });
  const txPosts = Array.isArray(tx.data?.posts) ? tx.data.posts : [];
  const firstMarks = new Map((first?.accounts || []).flatMap((a) => a.posts).map((p) => [p.index, p.mark]));
  const sameMarks = !first || txPosts.every((p) => firstMarks.get(p.index) === p.mark);
  check(`replay /api/transcribe batch ${batch} returns the saved batch in under ${REPLAY_LIMIT_MS} ms`,
    tx.status === 200 && txPosts.length > 0 && sameMarks && tx.ms < REPLAY_LIMIT_MS,
    `HTTP ${tx.status}, ${tx.ms} ms, ${txPosts.length} posts, marks ${txPosts.map((p) => p.mark).join('/')}${sameMarks ? '' : ' (differ from the first run)'}`);

  const an = await postTimed('/api/analyze', { runId });
  const sameScripts = !first || JSON.stringify(an.data?.scripts) === JSON.stringify(first.scripts);
  check(`replay /api/analyze returns the saved result in under ${REPLAY_LIMIT_MS} ms`,
    an.status === 200 && Array.isArray(an.data?.scripts) && an.data.scripts.length === 3 && sameScripts && an.ms < REPLAY_LIMIT_MS,
    `HTTP ${an.status}, ${an.ms} ms, cached=${an.data?.cached}, scripts ${sameScripts ? 'identical' : 'DIFFERENT'} to the first run`);
}

// REPLAY_RUN_ID: only the two replays against a run that already finished. No scrape, no new cost.
if (process.env.REPLAY_RUN_ID) {
  await page.goto(BASE_URL);
  await replayChecks(process.env.REPLAY_RUN_ID, Number(process.env.REPLAY_BATCH_COUNT || 1), null);
  await writeFile(path.join(OUT, 'report-replay.json'), JSON.stringify({ runId: process.env.REPLAY_RUN_ID, baseUrl: BASE_URL, checks }, null, 2));
  await context.close();
  await browser.close();
  process.exit(checks.some((c) => !c.pass) ? 1 : 0);
}

// ------------------------------------------------------------------ first run (real, paid)
log(`Set "${SET}": ${usernames.join(', ')}; client @${set.client}; ${BASE_URL}`);
await fillForm();
await shot('01-form', false);

const t0 = Date.now();
await page.click('#run-btn');

// Watch the three stages until the results or an error view shows.
const stageDone = {};
let progressShot = false;
let finalView = null;
while (Date.now() - t0 < RUN_TIMEOUT_MS) {
  const view = await visibleView();
  if (view === 'results' || view?.startsWith('error')) { finalView = view; break; }
  if (view === 'form' && Date.now() - t0 > 5000) { finalView = 'form'; break; } // the server refused the input
  const states = await page.evaluate(() => Object.fromEntries(['stage-posts', 'stage-tx', 'stage-llm'].map((id) => [id, document.getElementById(id)?.dataset.state || ''])));
  for (const [id, state] of Object.entries(states)) {
    if (state === 'done' && !stageDone[id]) { stageDone[id] = Date.now() - t0; log(`${id} done after ${Math.round(stageDone[id] / 1000)} s`); }
  }
  if (!progressShot && states['stage-tx'] === 'active') {
    const meta = await page.textContent('#stage-tx .meta');
    if (/^[1-9]\d* of /.test(meta || '')) { await shot('02-progress', false); progressShot = true; }
  }
  await page.waitForTimeout(500);
}
const totalMs = Date.now() - t0;
log(`first run ended in view "${finalView}" after ${Math.round(totalMs / 1000)} s`);

const timings = {
  postsMs: stageDone['stage-posts'] ?? null,
  transcriptsMs: stageDone['stage-tx'] != null && stageDone['stage-posts'] != null ? stageDone['stage-tx'] - stageDone['stage-posts'] : null,
  analysisMs: stageDone['stage-tx'] != null ? totalMs - stageDone['stage-tx'] : null,
  totalMs,
};

check('run finishes with the results view within 10 min', finalView === 'results',
  finalView === 'results' ? `${Math.round(totalMs / 1000)} s` : `view=${finalView}; ${(await page.textContent('.view:not([hidden]) .detail').catch(() => '')) || ''}`);

let marks = {};
if (finalView === 'results') {
  await shot('03-results');
  const result = bodies.analyze?.data;
  check('analyze returned a result (HTTP 200)', bodies.analyze?.status === 200, `status=${bodies.analyze?.status}`);

  // ---- account blocks
  const blocks = await page.$$eval('#result-accounts .acct', (els) => els.map((e) => ({
    name: e.querySelector('h3')?.textContent || '',
    isClient: e.classList.contains('is-client'),
    badge: Boolean(e.querySelector('.badge.client')),
    note: e.querySelector('.note')?.textContent || '',
    rows: e.querySelectorAll('details.post').length,
    links: [...e.querySelectorAll('details.post .act a')].map((a) => a.href),
  })));
  const names = blocks.map((b) => b.name.replace(/^@/, ''));
  check('every account has a block', usernames.every((u) => names.includes(u)), `blocks: ${names.join(', ')}`);
  const clientBlocks = blocks.filter((b) => b.isClient);
  check('exactly one block is marked as the client, with the badge', clientBlocks.length === 1 && clientBlocks[0].badge && clientBlocks[0].name === '@' + set.client,
    clientBlocks.map((b) => b.name).join(', '));

  // ---- posts per account, from the analyze JSON (the same data the page renders)
  const now = Date.now();
  for (const acc of result?.accounts || []) {
    const block = blocks.find((b) => b.name === '@' + acc.username);
    const posts = acc.posts;
    const label = `@${acc.username} (${acc.status}, ranked by ${acc.rankedBy})`;
    if (acc.status === 'private' || acc.status === 'missing') {
      check(`${label}: shows a note and no posts`, posts.length === 0 && Boolean(block?.note), block?.note || 'no note');
      continue;
    }
    check(`${label}: up to 10 posts, 10 when status is ok`, posts.length <= 10 && (acc.status !== 'ok' || posts.length === 10) && block?.rows === posts.length,
      `json=${posts.length}, rows on page=${block?.rows}`);
    // Order: by views; posts without views come last, by likes. Or by likes only.
    let ordered = true;
    for (let i = 1; i < posts.length; i++) {
      const a = posts[i - 1], b = posts[i];
      if (acc.rankedBy === 'likes') { if ((a.likes ?? -1) < (b.likes ?? -1)) ordered = false; }
      else if (a.views != null && b.views != null) { if (a.views < b.views) ordered = false; }
      else if (a.views == null && b.views != null) ordered = false;
      else if (a.views == null && b.views == null && (a.likes ?? -1) < (b.likes ?? -1)) ordered = false;
    }
    const col = acc.rankedBy === 'likes' ? posts.map((p) => p.likes) : posts.map((p) => p.views);
    check(`${label}: sorted in descending order`, ordered, col.join(' > '));
    const badDates = posts.filter((p) => { const t = Date.parse(p.date); return !(t >= now - WINDOW_MS && t <= now + 3600000); });
    check(`${label}: every date is within the last 90 days`, badDates.length === 0,
      badDates.length ? badDates.map((p) => p.date).join(', ') : `${posts.at(-1)?.date?.slice(0, 10) ?? '-'} .. ${posts[0]?.date?.slice(0, 10) ?? '-'}`);
    const badUrls = [...posts.map((p) => p.url), ...(block?.links || [])].filter((u) => !POST_URL.test(u || ''));
    check(`${label}: every link is an instagram.com post URL`, badUrls.length === 0, badUrls.slice(0, 3).join(', ') || `${posts.length} links`);
  }

  // ---- transcript marks
  const allPosts = (result?.accounts || []).flatMap((a) => a.posts);
  marks = allPosts.reduce((m, p) => ({ ...m, [p.mark]: (m[p.mark] || 0) + 1 }), {});
  const videoPosts = allPosts.filter((p) => p.mark !== 'novideo');
  const realSpeech = allPosts.filter((p) => p.mark === 'speech' && (p.transcript || '').trim().split(/\s+/).length >= 8);
  check('most video posts carry a real transcript', videoPosts.length > 0 && realSpeech.length / videoPosts.length >= 0.5,
    `marks ${JSON.stringify(marks)}; real speech ${realSpeech.length} of ${videoPosts.length} video posts`);

  // ---- insights and scripts, from the page
  const insight = async (id) => page.$$eval(`#${id} li`, (els) => els.map((li) => ({ t: li.querySelector('b')?.textContent?.trim() || '', ev: li.querySelector('.ev')?.textContent?.trim() || '', text: li.textContent.trim() })));
  const shared = await insight('shared');
  const differs = await insight('differs');
  check('"shared" has points with a title and evidence', shared.length >= 2 && shared.every((p) => p.t && p.ev), `${shared.length} points; first ev: ${shared[0]?.ev || '-'}`);
  check('"differs" has points with a title and evidence', differs.length >= 2 && differs.every((p) => p.t && p.ev), `${differs.length} points; first ev: ${differs[0]?.ev || '-'}`);
  const scripts = await page.$$eval('#scripts .script', (els) => els.map((e) => ({
    title: e.querySelector('.head .label')?.textContent?.trim() || '',
    hook: e.querySelector('.hook')?.textContent?.trim() || '',
    body: e.querySelector('.body')?.textContent?.trim() || '',
    cta: e.querySelector('.cta')?.textContent?.trim() || '',
  })));
  check('exactly 3 scripts, each with a hook, a body, and a call to action', scripts.length === 3 && scripts.every((s) => s.hook && s.body && s.cta),
    scripts.map((s) => `${s.title} (${s.body.split(/\s+/).length} words)`).join('; '));

  // ---- copy button
  await page.click('#scripts .script:first-child .copy');
  // The handler awaits the clipboard write before it changes the label, so wait for the label.
  await page.waitForFunction(() => document.querySelector('#scripts .script:first-child .copy')?.textContent === 'Copied', null, { timeout: 3000 }).catch(() => {});
  const label = await page.textContent('#scripts .script:first-child .copy');
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard error: ${e.message}`);
  check('the copy button copies the script', label === 'Copied' && clip.includes(scripts[0]?.hook || '###') && clip.includes('CALL TO ACTION'),
    `button="${label}", clipboard starts "${clip.slice(0, 60).replace(/\n/g, ' / ')}"`);

  // ---- replays: a finished batch and a finished run must return the saved answer, fast and free
  const runId = bodies.starts.find((x) => x.data?.runId)?.data.runId;
  report_runId = runId || null;
  if (runId) await replayChecks(runId, bodies.ranked?.batchCount ?? 1, result);

  // ---- expected "not found" account (negative set)
  if (process.env.EXPECT_MISSING) {
    const miss = blocks.find((b) => b.name === '@' + process.env.EXPECT_MISSING);
    check(`@${process.env.EXPECT_MISSING} shows a "not found" or "private" note`, Boolean(miss) && /not found|private|no posts/i.test(miss.note), miss?.note || 'no block');
  }

  // ------------------------------------------------------------------ cache re-run (free)
  if (process.env.SKIP_CACHE !== '1') {
    await page.click('[data-go="form"]');
    await page.waitForSelector('[data-view="form"]:not([hidden])');
    await page.waitForTimeout(800); // so the video shows the form again
    const before = calls.length;
    const t1 = Date.now();
    await page.click('#run-btn');
    await page.waitForSelector('[data-view="results"]:not([hidden])', { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#cache-badge:not([hidden])', { timeout: 5000 }).catch(() => {});
    const cacheMs = Date.now() - t1;
    timings.cacheMs = cacheMs;
    const newCalls = calls.slice(before).map((c) => c.path);
    const badge = await page.$eval('#cache-badge', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
    const lastStart = bodies.starts.at(-1);
    check('the same set returns from the cache in under 3 s with the badge', cacheMs < CACHE_LIMIT_MS && Boolean(badge) && lastStart?.data?.cached === true,
      `${cacheMs} ms; badge "${badge}"; start.cached=${lastStart?.data?.cached}`);
    check('the cache run makes no /api/transcribe or /api/analyze call', !newCalls.some((p) => p === '/api/transcribe' || p === '/api/analyze'),
      `calls: ${newCalls.join(', ') || 'none'}`);
    await page.waitForTimeout(1500);
    await shot('04-results-cache', false);
  }

  await writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}

// ------------------------------------------------------------------ report
const transcribeCalls = calls.filter((c) => c.path === '/api/transcribe').length;
const statusCalls = calls.filter((c) => c.path === '/api/status').length;
const report = {
  set: SET, baseUrl: BASE_URL, usernames, client: set.client, runId: report_runId, finishedAt: new Date().toISOString(),
  timings, marks, calls: { status: statusCalls, transcribe: transcribeCalls, analyze: calls.filter((c) => c.path === '/api/analyze').length, start: calls.filter((c) => c.path === '/api/start').length },
  scrapeCostUsd: bodies.ranked?.scrapeCostUsd ?? null,
  checks,
};
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

const videoPath = await page.video()?.path();
await context.close(); // writes the video
await browser.close();
if (videoPath) {
  const target = path.join(OUT, 'video', `real-run-${SET}.webm`);
  await rename(videoPath, target).catch(() => {});
  log(`video: ${target}`);
}
const failed = checks.filter((c) => !c.pass).length;
log(`${checks.length - failed} of ${checks.length} checks passed. Timings (s): posts ${Math.round((timings.postsMs ?? 0) / 1000)}, transcripts ${Math.round((timings.transcriptsMs ?? 0) / 1000)}, analysis ${Math.round((timings.analysisMs ?? 0) / 1000)}, total ${Math.round(totalMs / 1000)}${timings.cacheMs != null ? `, cache ${timings.cacheMs} ms` : ''}`);
process.exit(failed ? 1 : 0);
