// In-memory stand-in for a Cloudflare KV binding. Counts writes and records reads.
// get() with an array of keys returns a Map, like the KV bulk read.
//
// delayed: true models how KV really behaves:
//   - a new write is not visible until settle() (KV can take a few seconds),
//   - a read that finds nothing is cached, so the key stays "not found" until expire() (up to 60 s in KV).
// failPut: (key) => true makes put() throw for that key, like KV's 429 or a used-up write quota.
export function fakeKv({ delayed = false, failPut = () => false } = {}) {
  const store = new Map();
  const visible = new Set();
  const negative = new Set();
  const read = (key, type) => {
    if (delayed && (!visible.has(key) || negative.has(key))) {
      negative.add(key);
      return null;
    }
    const value = store.has(key) ? store.get(key) : null;
    return value !== null && type === 'json' ? JSON.parse(value) : value;
  };
  return {
    store,
    writes: 0,
    reads: [],
    async get(key, type) {
      this.reads.push(...(Array.isArray(key) ? key : [key]));
      if (Array.isArray(key)) return new Map(key.map((k) => [k, read(k, type)]));
      return read(key, type);
    },
    async put(key, value) {
      if (failPut(key)) throw new Error('KV PUT failed: 429 Too Many Requests');
      this.writes++;
      store.set(key, value);
      if (!delayed) visible.add(key);
    },
    settle() { for (const k of store.keys()) visible.add(k); },
    expire() { negative.clear(); },
  };
}
