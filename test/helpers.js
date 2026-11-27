// Shared test helpers: a fetch stub that answers from a route table, and fixtures.
export const calls = [];
const realFetch = globalThis.fetch;

// routes: [{ match, status, body, headers }] or { match, replies: [...] } to answer in turn.
export function stubFetch(routes) {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => String(url).includes(r.match));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const reply = route.replies ? route.replies.shift() : route;
    return new Response(JSON.stringify(reply.body), { status: reply.status || 200, headers: reply.headers || {} });
  };
}
export function restoreFetch() {
  globalThis.fetch = realFetch;
}

// A Claude Messages API reply that carries JSON text, like structured output does.
export function claudeReply(obj, stop_reason = 'end_turn') {
  return { body: { content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } } };
}

export const goodAnalysis = {
  shared: [{ t: 'Number first', d: 'Hooks open with a figure.', ev: '2 of 2 competitor posts' }],
  differs: [{ t: 'Late hook', d: 'The client greets first.', ev: '1 of 1 client posts' }],
  scripts: [1, 2, 3].map((i) => ({ title: `S${i}`, hook: 'h', body: 'b', cta: 'c', why: 'w' })),
};

export const RUN = 'RUNabc12345';
export const recent = () => new Date(Date.now() - 86400000).toISOString();
export const audio = (name) => `https://scontent-waw2-1.cdninstagram.com/a/${name}.m4a`;
