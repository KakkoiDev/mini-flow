// Test only: serve https://mini-flow.kakkoi.dev/* from the working copy so the helper downloads unreleased files.
import { readFile } from 'node:fs/promises';
const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://mini-flow.kakkoi.dev') return real(input, init);
  try { return new Response(await readFile(root + decodeURIComponent(url.pathname))); }
  catch { return new Response('Not found', { status: 404 }); }
};
