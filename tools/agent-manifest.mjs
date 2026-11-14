// Writes mini-flow-agent.json: the files mini-flow-agent.mjs downloads, with their SHA-256 hashes.
// Run `node tools/agent-manifest.mjs` after changing any listed file. `--check` fails if it is out of date.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = join(root, 'vendor/p2p-core');

async function scripts(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? (entry.name === 'extras' ? [] : scripts(join(dir, entry.name)))
    : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []));
  return nested.flat();
}

export async function agentManifest() {
  const files = ['mini-flow-live.js', 'mini-flow-secure-room.js', 'mini-flow-agents.js',
    ...(await scripts(vendor)).map(file => relative(root, file))].sort();
  const entries = await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')]));
  return JSON.stringify({ helper: 'mini-flow-agent.mjs', files: Object.fromEntries(entries) }, null, 2) + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = join(root, 'mini-flow-agent.json');
  const next = await agentManifest();
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== next) {
      console.error('mini-flow-agent.json is out of date. Run node tools/agent-manifest.mjs');
      process.exit(1);
    }
  } else {
    await writeFile(target, next);
  }
}
