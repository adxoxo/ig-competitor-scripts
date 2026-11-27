// Any other path under /api/ gets 404 in JSON, not the page.
import { json } from '../../lib/http.js';

export const onRequest = async () => json({ error: 'Unknown API route.' }, 404);
