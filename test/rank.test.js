import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankPosts, countOrNull } from '../lib/rank.js';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

function post(account, n, fields = {}) {
  return { account, shortCode: `${account}${n}`, timestamp: daysAgo(n), views: null, likes: null, comments: null, ...fields };
}

test('-1 and null are missing counts', () => {
  assert.equal(countOrNull(-1), null);
  assert.equal(countOrNull(null), null);
  assert.equal(countOrNull(undefined), null);
  assert.equal(countOrNull(0), 0);
  assert.equal(countOrNull(42), 42);
});

test('keeps the top 10 by views within 90 days, drops old and pinned old posts', () => {
  const posts = [];
  for (let i = 1; i <= 15; i++) posts.push(post('a', i, { views: i * 100, likes: 1 }));
  posts.push(post('a', 120, { views: 999999, pinned: true })); // old pinned post
  posts.push(post('a', 91, { views: 888888 })); // just outside the window
  const [a] = rankPosts(posts, ['a'], { now: NOW });
  assert.equal(a.posts.length, 10);
  assert.deepEqual(a.posts.map((p) => p.views), [1500, 1400, 1300, 1200, 1100, 1000, 900, 800, 700, 600]);
  assert.deepEqual(a.posts.map((p) => p.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(a.posts.every((p) => p.rankedBy === 'views'));
  assert.deepEqual(a.notes, []);
  assert.equal(a.status, 'ok');
  assert.equal(a.rankedBy, 'views');
});

test('falls back to likes when views are missing (null or -1)', () => {
  const posts = [post('a', 1, { views: -1, likes: 50 }), post('a', 2, { likes: 300 }), post('a', 3, { views: null, likes: 10 })];
  const [a] = rankPosts(posts, ['a'], { now: NOW });
  assert.deepEqual(a.posts.map((p) => p.likes), [300, 50, 10]);
  assert.ok(a.posts.every((p) => p.rankedBy === 'likes'));
  assert.ok(a.notes.some((n) => /ranked by likes/.test(n)));
  assert.ok(a.notes.some((n) => /Only 3 posts/.test(n)));
  assert.equal(a.rankedBy, 'likes');
  assert.equal(a.status, 'short');
});

test('mixed account: posts with views first, then the rest by likes', () => {
  const posts = [post('a', 1, { likes: 5000 }), post('a', 2, { views: 10, likes: 1 }), post('a', 3, { views: 20, likes: 1 })];
  const [a] = rankPosts(posts, ['a'], { now: NOW });
  assert.deepEqual(a.posts.map((p) => p.shortCode), ['a3', 'a2', 'a1']);
  assert.equal(a.posts[2].rankedBy, 'likes');
  assert.ok(a.notes.some((n) => /1 posts have no view count/.test(n)));
  assert.equal(a.rankedBy, 'views');
});

test('hidden likes (-1) sort last among posts without views', () => {
  const posts = [post('a', 1, { likes: -1 }), post('a', 2, { likes: 3 })];
  const [a] = rankPosts(posts, ['a'], { now: NOW });
  assert.deepEqual(a.posts.map((p) => p.shortCode), ['a2', 'a1']);
  assert.equal(a.posts[1].likes, null);
});

test('groups by account, keeps the requested order, ignores other accounts and duplicates', () => {
  const posts = [post('b', 1, { views: 5 }), post('a', 1, { views: 7 }), post('a', 1, { views: 7 }), post('zzz', 1, { views: 1e9 })];
  const result = rankPosts(posts, ['a', 'b'], { now: NOW });
  assert.deepEqual(result.map((r) => r.account), ['a', 'b']);
  assert.equal(result[0].posts.length, 1);
});

test('notes for a missing account and for an account with no recent posts', () => {
  const posts = [post('old', 200, { views: 5 })];
  const [missing, priv, old] = rankPosts(posts, ['ghost', 'locked', 'old'], { now: NOW, accountErrors: { ghost: 'not_found', locked: 'Profile is private' } });
  assert.equal(missing.status, 'missing');
  assert.match(missing.notes[0], /not found/);
  assert.equal(priv.status, 'private');
  assert.match(priv.notes[0], /private/);
  assert.equal(old.posts.length, 0);
  assert.equal(old.status, 'short');
  assert.match(old.notes[0], /No posts in the last 90 days/);
});

test('ignores posts with a bad or future timestamp', () => {
  const posts = [post('a', 1, { views: 1, timestamp: 'not a date' }), post('a', 1, { views: 1, shortCode: 'f', timestamp: daysAgo(-2) })];
  const [a] = rankPosts(posts, ['a'], { now: NOW });
  assert.equal(a.posts.length, 0);
});

test('an account that hits the fetch limit gets a note, also when old posts fill the limit', () => {
  const posts = [post('a', 1, { views: 1 }), post('a', 2, { views: 2 }), post('a', 200, { views: 3 })];
  const [a] = rankPosts(posts, ['a'], { now: NOW, fetchLimit: 3 });
  assert.ok(a.notes.includes('Only the newest 3 posts of the window were checked.'));
  const [b] = rankPosts(posts, ['a'], { now: NOW, fetchLimit: 4 });
  assert.ok(!b.notes.some((n) => /newest/.test(n)));
});

test('an error that is neither private nor not found is neutral: "could not be read"', () => {
  const [a] = rankPosts([], ['x'], { now: NOW, accountErrors: { x: 'rate_limited: try later' } });
  assert.equal(a.status, 'unavailable');
  assert.match(a.notes[0], /could not be read/);
});

test('a full top 10 by views notes the posts without a view count that were left out', () => {
  const posts = [];
  for (let i = 1; i <= 12; i++) posts.push(post('a', i, { views: 1000 - i, likes: 1 }));
  posts.push(post('a', 20, { views: null, likes: 50000 }), post('a', 21, { views: -1, likes: 40000 }));
  const [a] = rankPosts(posts, ['a'], { now: NOW });
  assert.equal(a.posts.length, 10);
  assert.ok(a.posts.every((p) => p.rankedBy === 'views'));
  assert.ok(a.notes.some((n) => /^2 posts without a view count .* are not in the top 10/.test(n)));
});
