# Real end-to-end run

`real-run.mjs` drives the page against the real providers (Apify, OpenAI, Claude). It uses no stubs.
Each new run costs money: about $0.98 for the scrape (measured on the 5-account finance set) and about $0.10 to $0.30 for transcripts and analysis.
The second run of the same set must come from the cache and cost nothing.

The repository gets no new dependency. The script runs in the Playwright Docker image, which has the browsers.

## Account sets

`accounts.json` holds the sets:

- `finance`: the local run. One small client and 4 large competitors in personal finance.
- `business`: a second niche, for the check on the live link only.
- `negative`: the finance set with one account that does not exist. Run it only on request, because it costs a full scrape.

## Run

1. Start the app (local) or use the live link. Local: `wrangler pages dev --port 8799` in the repository.
2. Run the test. `OUT_DIR` must be a folder that Docker can mount (not under `/tmp`).

```sh
OUT=/path/to/output/ig-competitor-e2e
docker run --rm --network host --ipc=host \
  -v "$PWD/e2e":/e2e:ro -v "$OUT":/out \
  -e BASE_URL=http://127.0.0.1:8799/ -e SET=finance -e OUT_DIR=/out \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  bash -c "cd /tmp && npm i -s playwright@1.63.0 >/dev/null 2>&1 && cp /e2e/* /tmp/ && node /tmp/real-run.mjs"
```

For the live link, set `BASE_URL=https://<project>.pages.dev/` and `SET=business`.
For the negative case, add `-e SET=negative -e EXPECT_MISSING=no.such.account.e2e`.
`SKIP_CACHE=1` skips the cache re-run.

To test only the replays against a run that already finished (no scrape, no new cost), set
`REPLAY_RUN_ID=<runId from report.json>` and `REPLAY_BATCH_COUNT=<its batch count>`. The result goes to `report-replay.json`.

3. Convert the video so it plays anywhere:

```sh
ffmpeg -y -i "$OUT/video/real-run-finance.webm" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT/real-run-finance.mp4"
```

## Output

- `01-form.png`, `02-progress.png`, `03-results.png`, `04-results-cache.png`
- `video/real-run-<set>.webm`: the browser recording at 1280 x 800
- `report.json`: each check with its result, the stage timings, the transcript marks, and the API call counts
- `result.json`: the analysis result the page showed

## Checks

- The run ends on the results view within 10 minutes.
- Each account has a block. Exactly one block is marked as the client.
- Each account shows up to 10 posts (10 when its status is `ok`) in descending order of views, or likes when the block says so.
- Each date is in the last 90 days. Each link is an `instagram.com` post URL.
- At least half of the video posts have a real transcript. The report counts each mark.
- "Shared" and "differs" have points with evidence. There are exactly 3 scripts with a hook, a body, and a call to action.
- The copy button puts the script on the clipboard.
- A repeat of `/api/transcribe` for a finished batch and of `/api/analyze` for the finished run returns the saved answer in under 2 seconds, with the same marks and the same 3 scripts.
- The same set again returns from the cache in under 3 seconds, shows the cache badge, and calls neither `/api/transcribe` nor `/api/analyze`.
