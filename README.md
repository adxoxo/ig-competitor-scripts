# Competitor Script Finder

A small web tool for short-form video teams.
You enter 4 to 11 public Instagram accounts in one niche and mark one account as the client.
The tool finds the top 10 posts of each account from the last 90 days and transcribes the videos.
It then compares the competitors with the client and writes 3 new video scripts for the client.

I built it as a trial task for a developer role.

## How a run works

1. **Start.** The page sends the usernames to `/api/start`. The server checks the input, the 24 h cache, and the daily caps. It counts the run, then starts one Apify run for all the accounts.
2. **Posts.** The page asks `/api/status` every 2 s (first call after 5 s) until the scrape is done. It then asks for the result one page of 50 posts per call. After the last page, the server keeps the posts of the 90 days before the run started and picks the top 10 per account.
3. **Tables.** The page shows the top-10 tables at once, with "transcript pending" marks.
4. **Transcripts.** The page sends `/api/transcribe` one batch number at a time, 9 batches at the same time. A batch is 2 posts. The server downloads the audio file of each post and sends it to OpenAI speech to text. If no account has any post, the page stops here and says so.
5. **Analysis.** The page calls `/api/analyze`. The server makes one Claude call and gets JSON back: what the competitors' top posts share, how the client differs, and 3 scripts. The page shows the result.

```
browser ──► /api/start ──► Apify (one run, all accounts)
        ──► /api/status (poll, then one page per call) ──► rank top 10 ──► KV
        ──► /api/transcribe {batch} ──► Instagram CDN audio ──► OpenAI ──► KV
        ──► /api/analyze ──► Claude (JSON) ──► KV ──► page
```

## Ranking

- Posts with a view count come first, sorted by views. Posts without a view count (photos, hidden counts) come after them, sorted by likes.
- An account where no post has a view count is ranked by likes.
- The page notes each case: fewer than 10 posts, the newest 80 posts only, posts ranked by likes, and posts without a view count that are not in a full top 10.

## Design choices

- **The browser runs the steps.** The Cloudflare free plan gives each request 10 ms of CPU and 50 outbound calls. One long server job does not fit. Each step is a short request, and the page calls the next one.
- **The browser is not trusted.** It sends only usernames, a run id, a page number, and a batch number. The server reads the accounts, the audio URLs, and the transcripts from its own storage. A made-up run id gets an error before any paid call.
- **A repeat call costs nothing, once the saved output is visible.** Each step saves its output in Cloudflare KV and returns it on a repeat call: a stored page is not read or written again, a stored batch is not transcribed again, and a run is analysed once (`an:<run>`). KV usually shows a new key at once, but it can take up to a minute; a repeat inside that window pays again.
- **One page per call.** The status call reads 50 posts at a time with only the fields it needs. The page count comes from Apify's total, not from the size of a page. The last page is not stored: the top list replaces it. On the last page, the server collects the earlier pages from KV.
- **KV is slow to show new keys.** A new key can take a few seconds to appear, and KV remembers a "not found" answer for up to 60 s. So:
  - the last status call reads any earlier page that KV does not show yet from Apify again (up to 4 pages; for more, the page waits and asks again);
  - transcribe and analyze answer `409 {retry: true}` when the ranking or a batch is not visible yet, and the page asks again every 5 s for up to 75 s;
  - after that, the page asks analyze with `final: true`. The server accepts it only 90 s after the ranking. The posts of a missing batch then count as "transcript failed".
- **Cache.** A good result is kept for 24 hours under the client plus the sorted account list. The same set comes back at once and costs nothing. A result is not cached when a batch is missing or when more than half of the videos have no transcript. The same set started again while the first run is still going, or within about a minute of its result, starts a second paid run.
- **Caps.** 12 new runs per day in total, counted from Apify's own list of today's runs, which is consistent. 10 per visitor, counted in KV by a daily hash of the IP address; KV can serve an old count for up to a minute, so this cap is approximate. Each run is counted before Apify is called. Each Apify run has a cost cap and a 10-minute timeout. Every provider call has a timeout.
- **KV writes.** An 11-account run makes about 77 writes: 2 at the start, 17 pages, 1 top list, 55 batches, and 2 for the analysis. 12 runs make about 924, under the free plan's 1,000 a day. A failed write after a paid call is logged, and the paid result is still returned.
- **Audio, not video.** The tool downloads the audio-only file of a post (about 0.5 MB), only from Instagram's media hosts, with no redirects and at most 8 MB. The video file is never downloaded or stored. Videos over 3 minutes are not transcribed.
- **The model reads data, not instructions.** Captions and transcripts go to Claude in one delimited JSON block, with the rule that text inside is content to analyse. Code, not the model, handles the empty cases: no posts at all stops the run with a clear message, a client without posts gets a fixed "nothing to compare" point, and competitors without posts get a fixed "no competitor posts" point.
- **Errors.** Every route answers in JSON, also on an unexpected error, a wrong method (405 with an `Allow` header), or an unknown `/api/` path (404). The page asks a failed status call again up to 3 times before it shows an error.
- **Plain code.** No framework, no build step, no dependencies. Plain JavaScript on Cloudflare Pages Functions.

## Files

```
public/              index.html, app.js, style.css (the page)
functions/api/       start.js, status.js, transcribe.js, analyze.js (the API)
lib/guard.js         input check, cache key, daily caps
lib/apify.js         Apify scraper: start, state, read one page; field mapping in mapItem()
lib/rank.js          90-day filter and top-10 ranking (pure function); BATCH_SIZE
lib/transcribe.js    audio download and OpenAI speech to text for one post
lib/llm.js           the Claude prompt, JSON schema, shape check, and retry
lib/view.js          the result shape the page renders
test/                node tests, no network
e2e/                 a real end-to-end run against the real providers (costs money)
```

## Run it locally

You need Node 20 or later and Wrangler.

```
cp .dev.vars.example .dev.vars   # then fill in the keys
npm test                         # node --test, no network calls
npx wrangler pages dev           # http://localhost:8788
```

Secrets, by name only:

- `APIFY_TOKEN`: Instagram post data
- `OPENAI_API_KEY`: speech to text (`gpt-transcribe`)
- `ANTHROPIC_API_KEY`: analysis and scripts (`claude-sonnet-5-5`)

On Cloudflare, set them as Pages secrets. Bind one KV namespace as `KV` (see `wrangler.toml`).
Never put a key in a file that Git tracks. `.dev.vars` is in `.gitignore`.

## Cost per run

- Apify: $0.0027 per post. The tool asks for up to 80 posts per account from the last 90 days.
- OpenAI: $0.0045 per minute of audio, about $0.003 per video.
- Claude: about $0.02 to $0.06 per run.

Measured: 5 accounts cost $0.98 for the scrape. A set of 11 accounts costs up to about $2.50 for the scrape. A cached set costs nothing.
The form also accepts `@name` and a pasted profile link.

## Known limits

- Only the newest 80 posts of each account are checked. The page says so when an account hits the limit.
- Videos inside a carousel are not transcribed. The caption is used.
- A video without a separate audio file is not transcribed. The caption is used.
- Videos over 3 minutes are not transcribed. The caption is used.
- A reload does not resume a run. If you close or reload the tab during a run, start it again.
- Speech to text can contain errors.
- Private and missing accounts are left out of the analysis, with a note.
