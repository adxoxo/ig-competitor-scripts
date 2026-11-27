// Input check, cache key, and the per-visitor daily cap. Used by /api/start, the only route that
// starts paid work for new accounts. (The global daily cap counts runs on Apify: lib/apify.js.)

export const MIN_ACCOUNTS = 4;
export const MAX_ACCOUNTS = 11;
// All visitors together. An 11-account run makes about 59 KV writes, so 15 runs stay under the
// free plan's 1,000 writes a day. Counted from Apify's own run list, which is consistent.
export const MAX_RUNS_PER_DAY = 15;
// One visitor (by IP). Graders may share one office IP, so this is generous.
export const MAX_RUNS_PER_IP_PER_DAY = 10;
const CAP_TTL_SECONDS = 2 * 24 * 60 * 60; // counters expire after 2 days

// Instagram usernames: letters, digits, "." and "_", at most 30 characters.
// A period cannot start or end the name, and two periods cannot follow each other.
const USERNAME_RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

// Check the form data. Returns { ok: true, usernames, client } or { ok: false, error }.
export function validateInput(body) {
  if (!body || !Array.isArray(body.usernames)) {
    return { ok: false, error: 'Send a list of Instagram usernames.' };
  }

  // Lowercase, accept "@name" or a profile link, and remove duplicates.
  const usernames = [];
  for (const raw of body.usernames) {
    if (typeof raw !== 'string') return { ok: false, error: 'Each username must be text.' };
    const name = handleFrom(raw);
    if (!USERNAME_RE.test(name)) return { ok: false, error: `"${raw}" is not a valid Instagram username.` };
    if (!usernames.includes(name)) usernames.push(name);
  }

  if (usernames.length < MIN_ACCOUNTS || usernames.length > MAX_ACCOUNTS) {
    return { ok: false, error: `Enter ${MIN_ACCOUNTS} to ${MAX_ACCOUNTS} different accounts.` };
  }

  const client = typeof body.client === 'string' ? handleFrom(body.client) : '';
  if (!usernames.includes(client)) {
    return { ok: false, error: 'Mark one of the accounts as the client.' };
  }

  return { ok: true, usernames, client };
}

// "@Name", "name", and "https://www.instagram.com/name/?hl=en" all give "name".
export function handleFrom(raw) {
  return raw.trim()
    .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/^@/, '')
    .toLowerCase();
}

// The same accounts in any order give the same key.
// The client is part of the key, because the analysis and the scripts are written for the client.
export function cacheKey(usernames, client) {
  return `result:${client}:${[...usernames].sort().join(',')}`;
}

// UTC date as YYYY-MM-DD. The caps reset at midnight UTC.
export function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Store a hash of the IP address, not the address itself. The date is part of the hash, so the
// same address gives a new value each day and a stored value cannot be matched across days.
export async function hashIp(ip, date) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${date}:${ip}`));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ipKey = (ipHash, date) => `ip:${ipHash}:${date}`;

// Check the visitor's cap before a new run starts. Returns { ok: true } or { ok: false, error }.
export async function checkIpCap(kv, ipHash, date) {
  const count = Number(await kv.get(ipKey(ipHash, date))) || 0;
  if (count >= MAX_RUNS_PER_IP_PER_DAY) {
    return { ok: false, error: `You can start ${MAX_RUNS_PER_IP_PER_DAY} new runs per day. Try again tomorrow.` };
  }
  return { ok: true };
}

// Count the run BEFORE the scraper is called. If the scraper then refuses the run, the slot is lost.
// KV has no atomic increment, and it can serve an old count for up to a minute, so this cap is
// approximate. The global cap (lib/apify.js) is the one that holds.
export async function countIpRun(kv, ipHash, date) {
  const count = Number(await kv.get(ipKey(ipHash, date))) || 0;
  await kv.put(ipKey(ipHash, date), String(count + 1), { expirationTtl: CAP_TTL_SECONDS });
}
