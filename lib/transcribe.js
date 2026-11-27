// Speech to text for one post: fetch the post's audio file from the Instagram CDN, send it to OpenAI.
// Always the audio file (audioUrl): the video files are 4 to 20 MB, and some have no audio track at all.

import { isVideo } from './view.js';

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const STT_MODEL = 'gpt-transcribe';
export const MAX_SECONDS = 180; // longer videos are skipped to cap the cost
// A 3-minute audio file is about 3 MB. Worst case for a batch of 3: 3 x 8 MB of chunks plus a
// Blob copy of each, about 48 MB, well under the 128 MB memory limit. (OpenAI's own limit is 25 MB.)
export const MAX_BYTES = 8 * 1024 * 1024;
const MIN_WORDS = 3; // fewer words is music or a sound, not speech
const CDN_TIMEOUT_MS = 20_000;
const OPENAI_TIMEOUT_MS = 60_000;

// Only Instagram's media hosts. The URL comes from the scraper, so check it before the server fetches it.
export function isMediaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname.endsWith('.cdninstagram.com') || u.hostname.endsWith('.fbcdn.net'));
  } catch {
    return false;
  }
}

// Returns { index, mark, transcript } and never throws. Without a usable transcript, the caption
// stands in, so the analysis still has the post's words.
export async function transcribePost(post, env) {
  const caption = post.caption || '';
  const result = (mark, transcript = caption) => ({ index: post.index, mark, transcript });

  if (!post.audioUrl) {
    // A photo or carousel without audio has nothing to transcribe. A video without audio is a failure.
    return result(isVideo(post) ? 'failed' : 'novideo');
  }
  // Checked before any download. A missing duration is allowed: the size limit still applies.
  if (post.duration > MAX_SECONDS) return result('long');
  if (!isMediaUrl(post.audioUrl)) return result('failed');

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = (await speechToText(post.audioUrl, env)).trim();
      if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return result('nospeech');
      return result('speech', text);
    } catch (err) {
      console.error(`transcript of post ${post.index}, attempt ${attempt}: ${err.message}`);
    }
  }
  return result('failed');
}

async function speechToText(audioUrl, env) {
  if (!env.OPENAI_API_KEY) throw new Error('The speech-to-text key is not set on the server.');
  // redirect: 'manual' so the checked host is the host we actually read from: a redirect (3xx) is
  // not "ok" and counts as an error. (Workers do not support redirect: 'error'.)
  const audio = await fetch(audioUrl, { redirect: 'manual', signal: AbortSignal.timeout(CDN_TIMEOUT_MS) });
  if (!audio.ok) throw new Error(`CDN returned HTTP ${audio.status}`);
  const file = await readCapped(audio);

  const form = new FormData();
  form.append('model', STT_MODEL);
  form.append('file', file, 'audio.m4a');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI returned HTTP ${res.status}: ${data.error?.message || 'no message'}`);
  return data.text || '';
}

// Read the audio body, but stop at MAX_BYTES. A reel's audio file is about 0.5 MB.
async function readCapped(res) {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('audio file over 8 MB');
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('audio file over 8 MB');
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: 'audio/mp4' });
}
