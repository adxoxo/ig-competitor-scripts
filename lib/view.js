// The shape the page renders. status.js and analyze.js both return it, so the page has one renderer.
//
// { client, cached, accounts: [{ username, isClient, status, rankedBy, note,
//     posts: [{ index, rank, title, views, likes, duration, date, url, mark, transcript }] }],
//   shared, differs, scripts }
//
// mark: 'speech' | 'nospeech' | 'novideo' | 'long' | 'failed' | 'wait'
//
// Transcript batches in KV (written by transcribe.js, read by analyze.js):
//   tx:<runId>:<batch> = { posts: [{ index, mark, transcript }] }

// The one test for "is this post a video" (used by the view, transcribe, the prompt, and the cache rule).
export function isVideo(post) {
  return post.type === 'video' || Boolean(post.hasVideo || post.audioUrl);
}

// The first line of the caption is the post's title in the tables.
export function postTitle(caption) {
  const line = String(caption || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!line) return '(no caption)';
  return line.length > 90 ? line.slice(0, 89) + '…' : line;
}

// transcripts: Map of post index -> { mark, transcript }. Without an entry, a video post is 'wait'
// (status.js, before the transcripts) or 'failed' (analyze.js, when the batch never arrived).
export function accountsView(ranked, client, transcripts = new Map(), missingMark = 'wait') {
  return ranked.map((a) => ({
    username: a.account,
    isClient: a.account === client,
    status: a.status,
    rankedBy: a.rankedBy,
    note: a.notes.join(' '),
    posts: a.posts.map((p) => {
      const tx = transcripts.get(p.index);
      const mark = tx ? tx.mark : isVideo(p) ? missingMark : 'novideo';
      return {
        index: p.index,
        rank: p.rank,
        title: postTitle(p.caption),
        views: p.views,
        likes: p.likes,
        duration: p.duration,
        date: p.timestamp,
        url: p.url,
        mark,
        // Without a transcript the analysis uses the caption, so the page shows it too.
        transcript: tx?.transcript || (mark === 'wait' ? '' : p.caption || ''),
      };
    }),
  }));
}
