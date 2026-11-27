// Competitor Script Finder: the page.
// Flow: POST /api/start -> poll /api/status -> POST /api/transcribe per batch -> POST /api/analyze -> render.
// The browser sends only usernames, the run id, a page index, and a batch index. The server holds the rest.
// Security: captions, transcripts, and LLM text are untrusted. They go into the page only through
// textContent (the el() helper below), never through innerHTML.

const MIN = 4;
const MAX = 11;
const FIRST_POLL_MS = 5000; // wait before the first status call
const SCRAPE_POLL_MS = 2000; // while Apify runs
const PAGE_POLL_MS = 500; // while the server reads the result pages
const BATCHES_IN_FLIGHT = 9; // 9 batches of 2 posts: 18 posts at a time
// Cloudflare KV can take up to 60 s to show a key that was just written. The server then answers
// 409 { retry: true }, and the page asks again every 5 s for up to 75 s.
const RETRY_MS = 5000;
const RETRY_FOR_MS = 75000;
const FINAL_FOR_MS = 45000; // after RETRY_FOR_MS, analyze is asked with final: true for this long
const RUN_DEADLINE_MS = 12 * 60 * 1000; // the posts must be ready within 12 minutes
const STATUS_RETRIES = 3; // passing status errors in a row before the run counts as failed
const PREVIEW_POSTS = 3; // competitor blocks show this many posts until opened
const USERNAME_RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build an element. Strings become text nodes, so they are never parsed as HTML.
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}

const fmt = (n) => (n === null || n === undefined ? 'n/a' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
function fmtAgo(iso) {
  const min = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- form

let rows = ['', '', '', ''];
let clientIdx = 0;
let rowErrors = {};
let busy = false;

function renderForm() {
  const list = $('acct-list');
  list.replaceChildren(...rows.map((value, i) => el('li', { class: `acct-row${i === clientIdx ? ' is-client' : ''}${rowErrors[i] ? ' has-error' : ''}` },
    el('span', { class: 'n', text: String(i + 1) }),
    el('label', { class: 'field' },
      el('span', { text: '@' }),
      el('input', { type: 'text', name: 'username', value, placeholder: 'username', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `Account ${i + 1}`, 'data-i': i })),
    el('label', { class: 'client-pick' },
      el('input', { type: 'radio', name: 'client', value: i, checked: i === clientIdx, 'aria-label': `Client: account ${i + 1}` }), ' Client'),
    el('button', { type: 'button', class: 'remove', 'aria-label': `Remove account ${i + 1}`, 'data-rm': i, disabled: rows.length <= MIN, text: '×' }),
    rowErrors[i] ? el('div', { class: 'row-error', text: rowErrors[i] }) : null,
  )));
  $('acct-count').textContent = `${rows.length} of ${MAX} accounts`;
  $('add-acct').disabled = rows.length >= MAX;
  $('run-btn').disabled = busy;
}

$('acct-list').addEventListener('input', (e) => {
  if (e.target.dataset.i === undefined) return;
  // The field shows a fixed "@", so a typed or pasted "@" is dropped at once.
  if (/^\s*@/.test(e.target.value)) e.target.value = e.target.value.replace(/^\s*@+/, '');
  rows[+e.target.dataset.i] = e.target.value;
});
// On leaving the field, a pasted profile link becomes the handle.
$('acct-list').addEventListener('focusout', (e) => {
  if (e.target.dataset.i === undefined || !e.target.value.trim()) return;
  e.target.value = rows[+e.target.dataset.i] = clean(e.target.value);
});
// Change the client by toggling the class only, so the radio keeps the keyboard focus.
$('acct-list').addEventListener('change', (e) => {
  if (e.target.name !== 'client') return;
  clientIdx = +e.target.value;
  document.querySelectorAll('#acct-list .acct-row').forEach((row, i) => row.classList.toggle('is-client', i === clientIdx));
});
$('acct-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rm]');
  if (!btn) return;
  // Blur first: a focusout on the removed input must not write its value into the row that moves up.
  document.activeElement?.blur();
  const i = +btn.dataset.rm;
  rows.splice(i, 1);
  if (clientIdx >= rows.length) clientIdx = 0;
  else if (i < clientIdx) clientIdx--;
  rowErrors = {};
  renderForm();
  document.querySelector(`input[data-i="${Math.max(0, i - 1)}"]`).focus();
});
$('add-acct').addEventListener('click', () => {
  if (rows.length >= MAX) return;
  rows.push('');
  renderForm();
  document.querySelector(`input[data-i="${rows.length - 1}"]`).focus();
});

// "@Name", "name", and "https://www.instagram.com/name/?hl=en" all give "name" (same rule as the server).
const clean = (s) => s.trim()
  .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '')
  .replace(/[/?#].*$/, '')
  .replace(/^@/, '')
  .toLowerCase();

// The server checks the same rules. This check only gives a faster, clearer message.
function validate() {
  rowErrors = {};
  const seen = new Set();
  rows.map(clean).forEach((name, i) => {
    if (!name) rowErrors[i] = 'Type a username or remove this row.';
    else if (!USERNAME_RE.test(name)) rowErrors[i] = 'Use letters, numbers, dots and underscores only.';
    else if (seen.has(name)) rowErrors[i] = 'This account is already in the list.';
    seen.add(name);
  });
  const count = Object.keys(rowErrors).length;
  formAlert(count ? `Fix ${count === 1 ? '1 account' : count + ' accounts'} before you run.` : '');
  renderForm();
  return count === 0;
}

function formAlert(text) {
  $('form-alert').hidden = !text;
  $('form-alert').textContent = text;
}

$('run-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  if (validate()) run();
  else document.querySelector(`input[data-i="${Math.min(...Object.keys(rowErrors).map(Number))}"]`)?.focus();
});
// After an analysis failure, "Try again" repeats only the analysis of the same run (no new scrape).
$('retry-btn').addEventListener('click', () => {
  if (busy) return;
  if (lastFailure?.kind === 'analysis' && lastRunId) retryAnalysis(lastRunId);
  else run();
});
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && !busy) { show(go.dataset.go); renderForm(); }
});

// ---------------------------------------------------------------- API

// One API call. Returns { ok, status, data }. A network error counts as status 0.
async function api(path, body) {
  try {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    let data = {};
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'The network connection failed.' } };
  }
}

// Repeat a call while the server says "not visible yet" (409 with retry), for up to RETRY_FOR_MS.
async function untilVisible(call) {
  const deadline = Date.now() + RETRY_FOR_MS;
  for (;;) {
    const res = await call();
    if (!(res.status === 409 && res.data.retry) || Date.now() > deadline) return res;
    await sleep(RETRY_MS);
  }
}

class RunError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// ---------------------------------------------------------------- run

let model = null; // the result object being built: { client, accounts, shared, differs, scripts, ... }
let postRows = new Map(); // post index -> [row elements], so a transcript can update its rows in place
let timer = null;

async function run() {
  busy = true;
  renderForm();
  const usernames = rows.map(clean);
  const client = usernames[clientIdx];
  try {
    const start = await api('/api/start', { usernames, client });
    if (start.status === 400) { show('form'); formAlert(start.data.error); return; }
    if (start.status === 429) throw new RunError('limit', start.data.error);
    if (!start.ok) throw new RunError('scrape', start.data.error);
    if (start.data.cached) { renderResults(start.data); return; }

    const runId = start.data.runId;
    lastRunId = runId;
    startProgress();
    const ranked = await waitForPosts(runId);
    model = ranked;
    renderAccountsInto('progress-accounts');
    $('progress-posts').hidden = false;
    stage('stage-posts', 'done', `${ranked.accounts.length} accounts, ${ranked.postCount} posts in ${fmtDuration(Date.now() - startedAt)}`);
    if (ranked.postCount === 0) { renderResults({ ...ranked, shared: [], differs: [], scripts: [] }); return; }

    await transcribeAll(runId, ranked.batchCount, ranked.batchSize, ranked.postCount);

    await analyse(runId);
  } catch (err) {
    showFailure(err);
  } finally {
    busy = false;
    clearInterval(timer);
    renderForm();
  }
}

let lastRunId = null;
let lastFailure = null;

// Ask for the analysis. While transcripts are not visible yet (409 retry), ask again every 5 s.
// After 75 s, send final: true, so the server goes on and counts missing transcripts as "failed".
async function analyse(runId) {
  stage('stage-llm', 'active', 'Comparing the accounts and writing the scripts');
  const since = Date.now();
  let res;
  for (;;) {
    const final = Date.now() - since > RETRY_FOR_MS;
    res = await api('/api/analyze', final ? { runId, final: true } : { runId });
    if (!(res.status === 409 && res.data.retry) || Date.now() - since > RETRY_FOR_MS + FINAL_FOR_MS) break;
    await sleep(RETRY_MS);
  }
  if (!res.ok) throw new RunError('analysis', res.data.error);
  renderResults(res.data);
}

async function retryAnalysis(runId) {
  busy = true;
  renderForm();
  show('progress');
  try {
    await analyse(runId);
  } catch (err) {
    showFailure(err);
  } finally {
    busy = false;
    renderForm();
  }
}

let startedAt = 0;
function startProgress() {
  startedAt = Date.now();
  postRows = new Map();
  $('progress-posts').hidden = true;
  stage('stage-posts', 'active', 'Reading Instagram, about 1 to 4 min');
  stage('stage-tx', 'wait', 'Starts after the posts');
  stage('stage-llm', 'wait', 'Starts after the transcripts, about 1 min');
  bar(null);
  const tick = () => { $('elapsed').textContent = `Started ${fmtDuration(Date.now() - startedAt)} ago`; };
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
  show('progress');
}

function stage(id, state, meta) {
  const node = $(id);
  node.dataset.state = state;
  node.querySelector('.dot').textContent = state === 'done' ? '✓' : state === 'active' ? '' : node.id === 'stage-posts' ? '1' : node.id === 'stage-tx' ? '2' : '3';
  node.querySelector('.meta').textContent = meta;
}

function bar(fraction) {
  const wrap = $('stage-tx').querySelector('.bar');
  wrap.hidden = fraction === null;
  wrap.firstElementChild.style.width = `${Math.round((fraction || 0) * 100)}%`;
}

// Poll while Apify runs, then read the result pages one by one until the top 10s are ready.
async function waitForPosts(runId) {
  let query = `run=${encodeURIComponent(runId)}`;
  const since = Date.now();
  // The scrape takes at least 20 s. Waiting before the first poll also gives KV time to show the new run.
  await sleep(FIRST_POLL_MS);
  let errorsInARow = 0;
  for (;;) {
    if (Date.now() - since > RUN_DEADLINE_MS) throw new RunError('scrape', 'The posts were not ready after 12 minutes.');
    const res = await api(`/api/status?${query}`);
    const s = res.data;
    // "Unknown run" just after the start is usually the new run record that KV does not show yet.
    if (res.status === 404 && Date.now() - since < RETRY_FOR_MS) { await sleep(RETRY_MS); continue; }
    // A network blip or one provider error (status 0 or 5xx): ask the same thing again, up to 3 times.
    if ((res.status === 0 || res.status >= 500) && errorsInARow < STATUS_RETRIES) { errorsInARow++; await sleep(RETRY_MS); continue; }
    errorsInARow = 0;
    if (!res.ok || s.stage === 'failed') throw new RunError('scrape', s.error);
    if (s.stage === 'ranked') return s;
    if (s.retry) {
      // Earlier result pages are not visible in KV yet: ask for the same page again soon.
      await sleep(RETRY_MS);
      query = `run=${encodeURIComponent(runId)}&page=${s.nextPage}`;
    } else if (s.stage === 'scraping') {
      await sleep(SCRAPE_POLL_MS);
    } else {
      stage('stage-posts', 'active', s.pagesTotal ? `Reading the results, page ${s.pagesRead} of ${s.pagesTotal}` : 'Reading the results');
      query = `run=${encodeURIComponent(runId)}&page=${s.nextPage}`;
      await sleep(PAGE_POLL_MS);
    }
  }
}

// Transcribe the batches, a few at a time. A batch that fails twice marks its posts "failed";
// the analysis then uses their captions.
async function transcribeAll(runId, batchCount, batchSize, postCount) {
  let done = 0;
  const update = () => {
    stage('stage-tx', done === postCount ? 'done' : 'active', `${done} of ${postCount}`);
    bar(postCount ? done / postCount : 1);
  };
  update();
  let next = 0;
  async function worker() {
    while (next < batchCount) {
      const batch = next++;
      const call = () => api('/api/transcribe', { runId, batch });
      let res = await untilVisible(call);
      if (!res.ok && res.status !== 409) res = await untilVisible(call); // one retry for other errors
      const posts = res.ok && Array.isArray(res.data.posts) ? res.data.posts : null;
      const indexes = batchIndexes(batch, batchSize, postCount);
      for (const index of indexes) {
        const tx = posts?.find((p) => p.index === index);
        updatePost(index, tx ? { mark: tx.mark, transcript: tx.transcript } : { mark: markOf(index) === 'novideo' ? 'novideo' : 'failed' });
      }
      done += indexes.length;
      update();
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCHES_IN_FLIGHT, batchCount) }, worker));
}

// Same numbering as the server: batch b holds the posts b*size to b*size+size-1.
function batchIndexes(batch, size, postCount) {
  const out = [];
  for (let i = batch * size; i < Math.min(postCount, (batch + 1) * size); i++) out.push(i);
  return out;
}

function markOf(index) {
  for (const account of model.accounts) {
    const post = account.posts.find((p) => p.index === index);
    if (post) return post.mark;
  }
  return null;
}

function updatePost(index, change) {
  for (const account of model.accounts) {
    const post = account.posts.find((p) => p.index === index);
    if (!post) continue;
    Object.assign(post, change);
    for (const row of postRows.get(index) || []) {
      const fresh = postRow(post, account.rankedBy);
      fresh.open = row.open;
      fresh.hidden = row.hidden;
      row.replaceWith(fresh);
      track(index, row, fresh);
    }
  }
}

function track(index, oldRow, newRow) {
  const list = postRows.get(index) || [];
  const at = list.indexOf(oldRow);
  if (at >= 0) list[at] = newRow; else list.push(newRow);
  postRows.set(index, list);
}

function showFailure(err) {
  lastFailure = err;
  const cause = err.message || 'Unknown error.';
  if (err.kind === 'limit') {
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const min = Math.round((midnight - now.getTime()) / 60000);
    $('limit-text').textContent = `This tool allows a set number of new runs each day. The limit resets at midnight UTC, in ${Math.floor(min / 60)} h ${min % 60} min.`;
    $('limit-cause').textContent = `Cause: ${cause}`;
    show('error-limit');
    return;
  }
  const analysis = err.kind === 'analysis';
  $('fail-title').textContent = analysis ? 'We could not finish the analysis' : 'We could not get the posts';
  $('fail-text').textContent = analysis
    ? 'The posts and transcripts are ready, but the language model did not return a usable answer.'
    : 'The post provider stopped the run before it finished. This is usually a short outage on its side, not a problem with your accounts.';
  $('fail-cause').textContent = `Cause: ${cause}`;
  show('error-scrape');
}

// ---------------------------------------------------------------- render

const MARK_LABEL = { speech: '', nospeech: 'no speech', novideo: 'no video', long: 'over 3 min, not transcribed', failed: 'transcript failed', wait: 'transcript pending' };
const NO_POSTS = ['private', 'missing', 'unavailable'];

// Only open links to Instagram. A URL from the data could hold "javascript:" otherwise.
const safeUrl = (url) => (/^https:\/\/(www\.)?instagram\.com\//.test(url || '') ? url : null);

function postRow(p, rankedBy) {
  const viewsFirst = rankedBy === 'views';
  const label = MARK_LABEL[p.mark] || '';
  const url = safeUrl(p.url);
  let body = p.transcript || '(no caption)';
  if (p.mark === 'wait') body = 'The transcript is on its way.';
  else if (p.mark === 'failed') body = `The transcript failed. The analysis uses the caption${p.transcript ? ': ' + p.transcript : '.'}`;
  const bodyLabel = p.mark === 'speech' || p.mark === 'wait' ? 'Transcript' : 'Caption';

  return el('details', { class: 'post' },
    el('summary', {},
      el('span', { class: 'rank', text: String(p.rank) }),
      el('span', { class: 'cap' },
        el('span', { class: 't', text: p.title }),
        el('span', { class: 'sub' }, label ? el('span', { class: `mark ${p.mark}`, text: label }) : null)),
      el('span', { class: 'num', text: fmt(viewsFirst ? p.views : p.likes) }),
      el('span', { class: 'num dim', text: fmt(viewsFirst ? p.likes : p.views) }),
      el('span', { class: 'num dim', text: fmtDate(p.date) }),
      el('span', { class: 'act' },
        url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation(), text: 'Open' }) : el('span', { class: 'no-link', text: '-' }),
        el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })),
      el('span', { class: 'nums' },
        el('span', { text: `${fmt(p.views)} views` }),
        el('span', { text: `${fmt(p.likes)} likes` }),
        el('span', { text: fmtDate(p.date) }))),
    el('div', { class: 'transcript' },
      el('span', { class: 'label', text: bodyLabel }),
      el('p', { text: body })));
}

function accountBlock(acc) {
  const noPosts = NO_POSTS.includes(acc.status);
  const n = acc.posts.length;
  const block = el('article', { class: `acct${acc.isClient ? ' is-client' : ''}` },
    el('div', { class: 'acct-head' },
      el('h3', { class: 'mono', text: '@' + acc.username }),
      acc.isClient ? el('span', { class: 'badge client', text: 'Client' }) : null,
      el('span', { class: 'sum', text: noPosts ? 'No posts' : `${n} posts, ranked by ${acc.rankedBy}` })),
    acc.note ? el('div', { class: `note ${noPosts ? 'bad' : acc.rankedBy === 'likes' ? 'info' : 'warn'}`, text: acc.note }) : null);
  if (!n) return block;

  const viewsFirst = acc.rankedBy === 'views';
  block.append(el('div', { class: 'posts-head', 'aria-hidden': 'true' },
    el('span', { text: '#' }), el('span', { text: 'Post' }),
    el('span', { class: 'r', text: viewsFirst ? 'Views' : 'Likes' }), el('span', { class: 'r', text: viewsFirst ? 'Likes' : 'Views' }),
    el('span', { class: 'r', text: 'Date' }), el('span', { class: 'r', text: 'Link' })));

  // The client block stays open. A competitor block shows its top 3 with a toggle.
  const folded = !acc.isClient && n > PREVIEW_POSTS;
  const rowsEls = acc.posts.map((p, i) => {
    const row = postRow(p, acc.rankedBy);
    if (folded && i >= PREVIEW_POSTS) row.hidden = true;
    track(p.index, null, row);
    return row;
  });
  block.append(...rowsEls);
  if (folded) {
    const btn = el('button', { type: 'button', class: 'btn ghost small', 'aria-expanded': 'false', text: `Show all ${n}` });
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      // Look the rows up again: a transcript update may have replaced them.
      acc.posts.forEach((p, i) => { if (i >= PREVIEW_POSTS) (postRows.get(p.index) || []).forEach((r) => { if (block.contains(r)) r.hidden = !open; }); });
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? `Show top ${PREVIEW_POSTS}` : `Show all ${n}`;
    });
    block.append(el('div', { class: 'more' }, btn));
  }
  return block;
}

function renderAccountsInto(targetId) {
  $(targetId).replaceChildren(...model.accounts.map(accountBlock));
}

function renderResults(result) {
  model = result;
  postRows = new Map();
  const client = result.client;
  const others = result.accounts.filter((a) => !a.isClient);
  const notFound = others.filter((a) => a.status === 'missing').length;
  const locked = others.filter((a) => a.status === 'private').length;
  const unread = others.filter((a) => a.status === 'unavailable').length;
  const left = [notFound ? `${notFound} not found` : '', locked ? `${locked} private` : '', unread ? `${unread} could not be read` : ''].filter(Boolean).join(', ');
  $('run-who').replaceChildren('Client ', el('b', { class: 'mono', text: '@' + client }),
    ` against ${others.length} competitor${others.length === 1 ? '' : 's'}${left ? ` (${left})` : ''}`);
  $('cache-badge').hidden = !result.cached;
  $('cache-badge').textContent = result.cached && result.createdAt ? `Served from cache, saved ${fmtAgo(result.createdAt)}` : 'Served from cache';
  $('differs-title').textContent = `How @${client} differs`;
  $('scripts-title').textContent = `3 new scripts for @${client}`;

  const point = (x) => el('li', {}, el('b', { text: x.t }), x.d, el('div', { class: 'ev', text: x.ev }));
  $('shared').replaceChildren(...(result.shared || []).map(point));
  $('differs').replaceChildren(...(result.differs || []).map(point));
  $('scripts').replaceChildren(...(result.scripts || []).map(scriptCard));
  const empty = !(result.scripts || []).length;
  $('no-posts').hidden = !empty;
  $('insights').hidden = empty;
  $('scripts-section').hidden = empty;
  renderAccountsInto('result-accounts');
  show('results');
}

function scriptCard(s, i) {
  const copy = el('button', { class: 'btn ghost small copy', type: 'button', text: 'Copy' });
  copy.addEventListener('click', async () => {
    const text = `HOOK\n${s.hook}\n\nBODY\n${s.body}\n\nCALL TO ACTION\n${s.cta}`;
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed'; // the browser blocked the clipboard
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  });
  const part = (label, cls, text) => el('div', { class: 'part' }, el('span', { class: 'label', text: label }), el('p', { class: cls, text }));
  return el('article', { class: 'card script' },
    el('div', { class: 'head' }, el('span', { class: 'label', text: `Script ${i + 1}: ${s.title}` }), copy),
    part('Hook', 'hook', s.hook),
    part('Body', 'body', s.body),
    part('Call to action', 'cta', s.cta),
    el('p', { class: 'why', text: s.why }));
}

renderForm();
