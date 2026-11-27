// Small helpers for JSON responses and KV records.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// The fallback for every other method on a route: 405 in JSON, with the allowed method.
export function methodNotAllowed(allow) {
  return async () => json({ error: `Use ${allow} for this route.` }, 405, { Allow: allow });
}

export const RUN_TTL_SECONDS = 24 * 60 * 60; // runs, transcripts, and results live for 1 day

// Run ids come from the scraper. Check the shape before a KV or provider lookup.
export function isRunId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{8,40}$/.test(value);
}

// Every route answers in JSON, also on an unexpected error, so the page can show a cause.
export function jsonErrors(handler) {
  return async (context) => {
    try {
      return await handler(context);
    } catch (err) {
      console.error('Unexpected error:', err?.message);
      return json({ error: 'Unexpected server error. Try again in a moment.' }, 500);
    }
  };
}

// A KV write after a paid call must not lose the paid result. A failed write (for example
// "429: one write per second per key", or the daily write quota) is logged, and the request goes on.
export async function savePut(kv, key, value) {
  try {
    await kv.put(key, value, { expirationTtl: RUN_TTL_SECONDS });
    return true;
  } catch (err) {
    console.error(`KV write failed for ${key.split(':')[0]}: ${err?.message}`);
    return false;
  }
}
