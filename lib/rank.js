// Pick the top 10 posts of each account. Pure function: no network, no KV.
// The scraper returns posts in no fixed order, so the sort and the 90-day filter happen here.

export const WINDOW_DAYS = 90;
export const TOP_N = 10;
// Transcripts are made in batches of this many posts: one call and one KV write per batch.
// CPU: the free plan allows 10 ms per request. In production, batches of 3 used 13 to 45 ms
// (median 23 ms), about 7.7 ms per post, with the audio read in a JavaScript loop. That loop is now
// a native read, which cuts the cost per post; 2 posts per batch give the extra margin.
export const BATCH_SIZE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const ERROR_NOTES = {
  private: 'This account is private. It is left out of the analysis.',
  missing: 'This account was not found. It is left out of the analysis.',
  unavailable: 'This account could not be read. It is left out of the analysis.',
};

// Instagram uses -1 for a hidden count. Treat it like a missing value.
export function countOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Higher views first. Posts without a view count (photos, hidden counts) go after
// the posts with views and sort by likes among themselves. Comments break ties.
function compare(a, b) {
  const byViews = (b.views ?? -1) - (a.views ?? -1);
  if (byViews !== 0) return byViews;
  const byLikes = (b.likes ?? -1) - (a.likes ?? -1);
  if (byLikes !== 0) return byLikes;
  return (b.comments ?? -1) - (a.comments ?? -1);
}

// posts: normalised posts from the scrape provider.
// usernames: the accounts the user asked for.
// accountErrors: { username: reason } from the provider, for missing or private accounts.
// fetchLimit: posts per account asked from the scraper. An account that hits it may have more posts.
// now: the run's start time. The 90-day window is fixed at the start, so a repeat gives the same list.
// Returns one entry per requested account, in the order the user typed them:
//   { account, status: 'ok' | 'short' | 'private' | 'missing' | 'unavailable', rankedBy: 'views' | 'likes', posts, notes }
export function rankPosts(posts, usernames, { now = Date.now(), accountErrors = {}, fetchLimit = Infinity } = {}) {
  const since = now - WINDOW_DAYS * DAY_MS;
  const byAccount = new Map(usernames.map((u) => [u, new Map()]));
  const returned = new Map(usernames.map((u) => [u, new Set()])); // all posts the scraper gave, any date

  for (const post of posts) {
    const group = byAccount.get(post.account);
    if (!group) continue; // not an account we asked for
    returned.get(post.account).add(post.shortCode);
    const time = Date.parse(post.timestamp);
    // Check the date here too: pinned posts come back even when they are old.
    if (!(time >= since && time <= now)) continue;
    // The same post can appear twice in a dataset. Keep one copy per shortCode.
    group.set(post.shortCode, { ...post, views: countOrNull(post.views), likes: countOrNull(post.likes), comments: countOrNull(post.comments) });
  }

  return usernames.map((account) => {
    const inWindow = [...byAccount.get(account).values()];
    const top = inWindow.sort(compare).slice(0, TOP_N).map((post, i) => ({
      ...post,
      rank: i + 1,
      rankedBy: post.views !== null ? 'views' : 'likes',
    }));

    const error = accountErrors[account];
    if (error && top.length === 0) {
      // "not found" only for the provider's explicit answer. Any other error is neutral.
      const status = /private/i.test(error) ? 'private' : /not_found|does not exist/i.test(error) ? 'missing' : 'unavailable';
      return { account, status, rankedBy: 'views', posts: [], notes: [ERROR_NOTES[status]] };
    }

    const notes = [];
    if (top.length === 0) {
      notes.push(`No posts in the last ${WINDOW_DAYS} days. The account may be private or new.`);
    } else if (top.length < TOP_N) {
      notes.push(`Only ${top.length} posts in the last ${WINDOW_DAYS} days.`);
    }
    if (returned.get(account).size >= fetchLimit) {
      notes.push(`Only the newest ${fetchLimit} posts of the window were checked.`);
    }
    const byLikes = top.filter((p) => p.rankedBy === 'likes').length;
    const allByLikes = byLikes > 0 && byLikes === top.length;
    if (allByLikes) {
      notes.push('Instagram shows no view counts for these posts, so they are ranked by likes.');
    } else if (byLikes > 0) {
      notes.push(`${byLikes} posts have no view count (for example photos). They are ranked by likes, after the posts with views.`);
    }
    // Posts with views rank first, so in a full top 10 a photo with many likes can be left out. Say so.
    const leftOut = inWindow.filter((p) => p.views === null).length - byLikes;
    if (!allByLikes && top.length === TOP_N && leftOut > 0) {
      notes.push(`${leftOut} posts without a view count (for example photos) are not in the top 10, because posts with views rank first.`);
    }

    return {
      account,
      status: top.length < TOP_N ? 'short' : 'ok',
      rankedBy: allByLikes ? 'likes' : 'views',
      posts: top,
      notes,
    };
  });
}
