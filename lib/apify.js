// Scrape provider: Apify instagram-scraper.
//   startRun(usernames, env)     -> runId
//   getRun(runId, env)           -> { state: 'running' | 'done' | 'failed', reason, costUsd, datasetId }
//   readPage(runId, env, page)   -> { posts: [normalised post], accountErrors: { username: reason }, done, total, costUsd }
// readPage reads one small page per call, so one request never parses the whole dataset (10 ms CPU limit).
// Only mapItem() knows the Apify field names.

const API = 'https://api.apify.com/v2';
const ACTOR_ID = 'apify~instagram-scraper';
const TIMEOUT_MS = 20_000; // one Apify API call; the scrape itself runs on Apify, not in this request

// Posts per account. 80 covers 90 days for most accounts. rank.js notes an account that hits it.
export const POSTS_PER_ACCOUNT = 80;
// Price per result. The run cap is a ceiling: a lower real price is fine.
const PRICE_PER_POST_USD = 0.0027;
const COST_MARGIN_USD = 0.1;
const RUN_TIMEOUT_SECONDS = 600;
// Items per dataset page. A full item is about 27 KB, so always ask only for the fields we read.
export const PAGE_SIZE = 50;

const FIELDS = [
  'inputUrl', 'ownerUsername', 'shortCode', 'url', 'type', 'productType', 'timestamp',
  'videoPlayCount', 'igPlayCount', 'videoViewCount', 'likesCount', 'commentsCount',
  'caption', 'videoUrl', 'audioUrl', 'videoDuration', 'isPinned',
  'error', 'errorDescription', 'username',
].join(',');

// Ask Apify for the posts of the last 90 days of all accounts in one run. Returns the run id at once.
export async function startRun(usernames, env) {
  const input = {
    directUrls: usernames.map((u) => `https://www.instagram.com/${u}/`),
    resultsType: 'posts',
    resultsLimit: POSTS_PER_ACCOUNT,
    onlyPostsNewerThan: '90 days',
    addParentData: false,
  };
  // The cost cap stops the run on Apify's side if it returns more than we expect.
  const maxCharge = (usernames.length * POSTS_PER_ACCOUNT * PRICE_PER_POST_USD + COST_MARGIN_USD).toFixed(2);
  // timeout: Apify stops a stuck run after this many seconds (the page gives up after 12 minutes).
  const res = await call(env, `/acts/${ACTOR_ID}/runs?maxTotalChargeUsd=${maxCharge}&timeout=${RUN_TIMEOUT_SECONDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await res.json()).data.id;
}

// How many runs of the actor this account started today (UTC). Apify's list is consistent,
// unlike a KV counter, so this is the global daily cap. One call, newest first.
export async function runsStartedToday(env, limit, now = Date.now()) {
  const midnight = new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const res = await call(env, `/acts/${ACTOR_ID}/runs?desc=1&limit=${limit}&startedAfter=${midnight}`);
  const items = (await res.json()).data?.items || [];
  // Filter here too, so the count is right even if the list ignores startedAfter.
  return items.filter((r) => r.startedAt >= midnight).length;
}

// Check the run state. The browser calls status every few seconds, so this does not wait.
export async function getRun(runId, env) {
  const { data } = await (await call(env, `/actor-runs/${encodeURIComponent(runId)}`)).json();
  const costUsd = data.usageTotalUsd ?? null; // the real charge so far
  if (data.status === 'SUCCEEDED') return { state: 'done', costUsd, datasetId: data.defaultDatasetId };
  if (data.status === 'READY' || data.status === 'RUNNING') return { state: 'running', costUsd };
  // FAILED, ABORTING, ABORTED, TIMING-OUT, TIMED-OUT
  return { state: 'failed', costUsd, reason: `The scraper run ended with status ${data.status}.` };
}

// Read one page of the run's dataset and convert each item with mapItem.
export async function readPage(runId, env, page) {
  const run = await getRun(runId, env);
  if (run.state !== 'done') throw new Error('The scraper run is not finished.');
  const offset = page * PAGE_SIZE;
  const query = `format=json&clean=1&offset=${offset}&limit=${PAGE_SIZE}&fields=${FIELDS}`;
  const res = await call(env, `/datasets/${run.datasetId}/items?${query}`);
  const items = await res.json();
  // Apify sends the item count of the whole dataset in a header. It drives the progress bar.
  const total = Number(res.headers.get('x-apify-pagination-total')) || null;

  const posts = [];
  const accountErrors = {};
  for (const item of items) {
    const result = mapItem(item);
    if (result.error) accountErrors[result.account] = result.error;
    else posts.push(result.post);
  }
  // The total header decides the last page. clean=1 may skip empty items, so a short page
  // is not proof of the end. Without the header, a short page is the end.
  const done = total !== null ? offset + PAGE_SIZE >= total : items.length < PAGE_SIZE;
  return { posts, accountErrors, done, total, costUsd: run.costUsd };
}

// The only place that knows Apify field names. Returns { post } or { account, error }.
export function mapItem(item) {
  if (item.error) {
    // Error items (missing or private accounts) carry username and url, not inputUrl.
    const account = (item.username || accountFrom(item.url || item.inputUrl)).toLowerCase();
    return { account, error: [item.error, item.errorDescription].filter(Boolean).join(': ') };
  }
  const account = accountFrom(item.inputUrl, item.ownerUsername);
  return {
    post: {
      account,
      shortCode: item.shortCode,
      url: item.url || `https://www.instagram.com/p/${item.shortCode}/`,
      type: String(item.type || '').toLowerCase(), // 'video', 'image', or 'sidecar'
      timestamp: item.timestamp, // ISO string
      // videoPlayCount is the current field. The others are older names for the same count.
      views: firstCount(item.videoPlayCount, item.igPlayCount, item.videoViewCount),
      likes: item.likesCount ?? null,
      comments: item.commentsCount ?? null,
      caption: item.caption || '',
      // The video file is never downloaded (the audio file is), so keep only whether there is one.
      hasVideo: Boolean(item.videoUrl),
      audioUrl: item.audioUrl || null,
      duration: item.videoDuration ?? null,
      pinned: Boolean(item.isPinned),
    },
  };
}

// Prefer the account we asked for (inputUrl), so a collab post still counts for that account.
function accountFrom(inputUrl, fallbackName) {
  const match = /instagram\.com\/([^/?#]+)/i.exec(inputUrl || '');
  return (match ? match[1] : fallbackName || '').toLowerCase();
}

function firstCount(...values) {
  for (const v of values) {
    if (typeof v === 'number' && v >= 0) return v;
  }
  return null;
}

// One Apify API call with a timeout. Turns the common HTTP errors into a message that names the cause.
async function call(env, path, init = {}) {
  if (!env.APIFY_TOKEN) throw new Error('The scraper token is not set on the server.');
  let res;
  try {
    res = await fetch(API + path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${env.APIFY_TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error('The scraper did not answer in time.');
  }
  if (res.ok) return res;
  if (res.status === 401) throw new Error('The scraper rejected the token.');
  if (res.status === 402 || res.status === 403) throw new Error('The scraper credit is used up or the plan limit is reached.');
  if (res.status === 404) throw new Error('The scraper run was not found.');
  if (res.status === 429) throw new Error('The scraper is busy. Try again in a minute.');
  throw new Error(`The scraper returned HTTP ${res.status}.`);
}
