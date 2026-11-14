#!/usr/bin/env node
// mini-flow-agent: lets an AI agent with a shell work on a Mini Flow board.
//
// It connects to the board's open host tab through the live session's encrypted relay. No other
// server is involved. It downloads Mini Flow's own connection code from the board's site, checks
// each file against the site's manifest, and keeps its login token in ~/.local/state/mini-flow-agent/.
//
// Usage: node mini-flow-agent.mjs "INVITE LINK" NAME COMMAND
//   check                 confirm this machine can reach the board
//   join                  join the board under NAME
//   listen [--timeout S]  wait until someone asks you, print the request, then exit
//   reply ID [TEXT]       answer a request (or --file answer.txt, or text on stdin)
//   progress ID [TEXT]    post an update and keep the request open
//   failed ID [TEXT]      give up on a request with a reason
//   done ID               close a request without an answer
//   board                 print the current board
//   run [--worker-timeout S] -- COMMAND [ARGS]
//                         keep listening and answer each request with COMMAND: it gets the request
//                         on stdin and its output is sent as the answer. Use it for agents that cannot
//                         wait between turns, for example: run -- ollama run qwen3 --hidethinking
// Exit codes: 0 done (or a request arrived), 1 error, 3 the board owner stopped you.
// Needs Node.js 22 or newer.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT_STOPPED = 3;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

class Stopped extends Error {}
class Fatal extends Error {}

function usage(message) {
  if (message) console.error('ERROR: ' + message);
  console.error('Usage: node mini-flow-agent.mjs "INVITE LINK" NAME check|join|listen|reply|progress|failed|done|board|run -- COMMAND');
  process.exit(1);
}

function parseArgs(argv) {
  const [link, name, command, ...rest] = argv;
  if (!link || !name || !command) usage();
  const options = { positional: [], worker: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') {
      options.worker = rest.slice(i + 1);
      break;
    }
    if (rest[i] === '--file') options.file = rest[++i];
    else if (rest[i] === '--timeout') options.timeout = Number(rest[++i]);
    else if (rest[i] === '--worker-timeout') options.workerTimeout = Number(rest[++i]);
    else options.positional.push(rest[i]);
  }
  return { link, name: name.trim(), command, options };
}

function readLink(link) {
  let url;
  try { url = new URL(link); } catch { throw new Fatal('Use the invite link from the board owner (https://…#live=…).'); }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && loopback.has(url.hostname));
  if (!secure || url.username || url.password || !url.hash.startsWith('#live=')) {
    throw new Fatal('Use the invite link from the board owner (https://…#live=…).');
  }
  return { url, site: new URL('.', url.origin + url.pathname).href };
}

// Downloads Mini Flow's connection modules once, keeping the site's folder layout.
async function loadModules(site) {
  const root = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mini-flow-agent', sha256(site).slice(0, 16));
  const manifestResponse = await fetch(new URL('mini-flow-agent.json', site), { cache: 'no-store', redirect: 'error' })
    .catch(() => { throw new Fatal(`Cannot reach ${new URL(site).host}. Check this machine's internet connection.`); });
  if (!manifestResponse.ok) throw new Fatal(`${new URL(site).host} does not offer the Mini Flow agent helper (HTTP ${manifestResponse.status}).`);
  const manifest = await manifestResponse.json();
  if (!manifest || typeof manifest.files !== 'object') throw new Fatal('The board site sent an invalid helper manifest.');
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!/^[a-z0-9][\w./-]*\.js$/i.test(file) || file.includes('..') || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Fatal('The board site sent an invalid helper manifest.');
    }
    const target = join(root, file);
    const cached = await readFile(target).catch(() => null);
    if (cached && sha256(cached) === expected) continue;
    const response = await fetch(new URL(file, site), { cache: 'no-store', redirect: 'error' });
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok || sha256(body) !== expected) throw new Fatal(`Could not download ${file} from the board site. Try again.`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target + '.tmp', body);
    await rename(target + '.tmp', target);
  }
  const load = file => import(pathToFileURL(join(root, file)).href);
  const [live, agents] = await Promise.all([load('mini-flow-live.js'), load('mini-flow-agents.js')]);
  return { live, agents };
}

function stateFile(link, name) {
  const dir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'mini-flow-agent');
  return { dir, file: join(dir, sha256(link + '\n' + name)) };
}

async function loadState(link, name) {
  try { return JSON.parse(await readFile(stateFile(link, name).file, 'utf8')); } catch { return {}; }
}

async function saveState(link, name, state) {
  const { dir, file } = stateFile(link, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
  await rename(file + '.tmp', file);
}

async function readText(options) {
  if (options.file && options.positional.length > 1) throw new Fatal('Supply the text or --file, not both.');
  let text;
  if (options.file === '-') text = await readStdin();
  else if (options.file) text = await readFile(options.file, 'utf8');
  else if (options.positional.length > 1) text = options.positional.slice(1).join(' ');
  else text = await readStdin();
  if (!text.trim()) throw new Fatal('The message is empty.');
  return text;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Runs the worker command for one request: the request text on stdin, the answer on stdout.
function runWorker(command, input, requestId, timeoutMs, cleanOutput) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    let child;
    try {
      child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MINI_FLOW_REQUEST_ID: requestId } });
    } catch (error) {
      finish({ action: 'failed', text: `Could not start ${command[0]}: ${error.message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ action: 'failed', text: `${command[0]} did not answer within ${Math.round(timeoutMs / 1000)} seconds.` });
    }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 200000) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 20000) stderr += chunk; });
    child.on('error', error => finish({ action: 'failed', text: `Could not start ${command[0]}: ${error.message}` }));
    child.on('close', code => {
      const answer = cleanOutput(stdout);
      if (code !== 0) {
        const detail = cleanOutput(stderr).split('\n').filter(Boolean).at(-1) ?? '';
        finish({ action: 'failed', text: `${command[0]} exited with status ${code}. ${detail}`.trim() });
      } else if (!answer) finish({ action: 'failed', text: `${command[0]} returned an empty answer.` });
      else finish({ action: 'reply', text: answer.slice(0, 12000) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function main() {
  const { link, name, command, options } = parseArgs(process.argv.slice(2));
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Fatal('Install Node.js 22 or newer to use this helper.');
  const { url, site } = readLink(link);
  const { live, agents } = await loadModules(site);
  if (!agents.validAgentName(name)) throw new Fatal('Choose a NAME of 1 to 40 characters without @ or line breaks.');
  const invite = live.readLiveInvite(url.hash);
  if (!invite) throw new Fatal('This invite link is incomplete. Copy it again from the board owner.');
  const cmd = words => `node mini-flow-agent.mjs "${link}" "${name}" ${words}`;
  let state = await loadState(link, name);

  let client;
  async function connect() {
    client?.close();
    client = await live.connectAsAgent(invite, { origin: url.origin });
    return client;
  }
  async function call(op, body = {}, waitMs) {
    const result = await client.call(op, { ...body, token: state.token }, waitMs);
    if (result?.reason === 'stopped') throw new Stopped(result.message);
    if (result?.reason === 'session_ended') throw new Fatal('The board owner ended the live session. Stop listening and tell your user.');
    return result;
  }
  async function join() {
    const result = await client.call('join', { name, token: state.token });
    if (!result.ok) throw new Fatal(result.message);
    state = { token: result.token };
    await saveState(link, name, state);
    return result;
  }
  // Runs an authenticated call, joining again if the board no longer knows this agent.
  async function authed(op, body, waitMs) {
    if (!state.token) await join();
    let result = await call(op, body, waitMs);
    if (result?.reason === 'not_joined') {
      await join();
      result = await call(op, body, waitMs);
    }
    if (result && !result.ok) throw new Fatal(result.message);
    return result;
  }

  try {
    await connect();
    if (command === 'check') {
      const result = await client.call('board', { token: state.token });
      console.log(`OK: this machine can reach the board${client.hostVerified ? ' and verified its owner' : ''}.`);
      if (result?.reason === 'not_joined' || !state.token) console.log('Next: ' + cmd('join'));
      else console.log('Next: ' + cmd('listen'));
      return 0;
    }
    if (command === 'join') {
      const result = await join();
      console.log(`Joined the board as ${result.name}. You can now receive requests.`);
      if (result.reclaimed) console.log(`Note: an earlier agent used the name ${result.name}. You took it over, with its ${result.open} open requests.`);
      console.log('Next: ' + cmd('listen'));
      return 0;
    }
    if (command === 'board') {
      const { board } = await authed('board');
      console.log('```mermaid\n' + board.source + '\n```');
      console.log('Block positions (x,y): ' + Object.entries(board.positions).map(([key, [x, y]]) => `${key}=${Math.round(x)},${Math.round(y)}`).join(' '));
      return 0;
    }
    if (command === 'listen') {
      const deadline = options.timeout > 0 ? Date.now() + options.timeout * 1000 : Infinity;
      let delay = 2000;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          console.log('No request yet. Run listen again to keep listening: ' + cmd('listen'));
          return 0;
        }
        try {
          const waitMs = Math.min(45000, remaining);
          const result = await authed('wait', { timeoutMs: waitMs }, waitMs + 15000);
          delay = 2000;
          if (!result.requests.length) continue;
          console.log(`${result.requests.length} open request${result.requests.length === 1 ? '' : 's'} for ${name}.\n`);
          for (const request of result.requests) console.log(agents.formatAgentRequest(request) + '\n');
          console.log('Next: do the work, write your answer to a file, then send it with');
          console.log('  ' + cmd(`reply ${result.requests[0].id} --file answer.txt`));
          console.log('Use progress for an update that keeps the request open, or failed with a reason if you cannot do it.');
          console.log('Then run listen again.');
          return 0;
        } catch (error) {
          if (error instanceof Stopped || error instanceof Fatal) throw error;
          console.error(`Connection problem (${error.message}). Retrying in ${delay / 1000}s.`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 30000);
          await connect().catch(reason => console.error(reason.message));
        }
      }
    }
    if (command === 'run') {
      if (!options.worker.length) throw new Fatal('Supply the command after run --, for example: run -- ollama run qwen3 --hidethinking');
      const timeoutMs = (options.workerTimeout > 0 ? options.workerTimeout : 600) * 1000;
      if (!state.token) await join();
      console.log(`Listening as ${name}. Each request goes to: ${options.worker.join(' ')}`);
      let delay = 2000;
      while (true) {
        let result;
        try {
          result = await authed('wait', { timeoutMs: 45000 }, 60000);
          delay = 2000;
        } catch (error) {
          if (error instanceof Stopped || error instanceof Fatal) throw error;
          console.error(`Connection problem (${error.message}). Retrying in ${delay / 1000}s.`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 30000);
          await connect().catch(reason => console.error(reason.message));
          continue;
        }
        for (const request of result.requests) {
          console.log(`Request ${request.id} from ${request.requester}: running ${options.worker[0]}…`);
          const outcome = await runWorker(options.worker, agents.formatAgentRequest(request), request.id, timeoutMs, agents.cleanWorkerOutput);
          const operationId = sha256([outcome.action, request.id, outcome.text].join('\n')).slice(0, 32);
          try {
            await authed('action', { requestId: request.id, action: outcome.action, text: outcome.text, operationId });
            console.log(outcome.action === 'reply' ? 'Answered.' : 'Reported a failure: ' + outcome.text);
          } catch (error) {
            if (error instanceof Stopped) throw error;
            console.error(`Could not send the answer (${error.message}).`);
          }
        }
      }
    }
    if (['reply', 'progress', 'failed', 'done'].includes(command)) {
      const requestId = options.positional[0];
      if (!requestId) throw new Fatal('Supply the request ID.');
      const text = command === 'done' ? '' : await readText(options);
      const operationId = sha256([command, requestId, text].join('\n')).slice(0, 32);
      await authed('action', { requestId, action: command, text, operationId });
      if (command === 'reply' || command === 'done') console.log('Sent; that request is closed. Next: ' + cmd('listen'));
      else if (command === 'failed') console.log('Marked as failed; the board owner can retry it. Next: ' + cmd('listen'));
      else console.log('Progress sent; the request stays open.');
      return 0;
    }
    throw new Fatal(`Unknown command ${command}.`);
  } finally {
    client?.close();
  }
}

main().then(code => process.exit(code), error => {
  if (error instanceof Stopped) {
    console.log('STOPPED: ' + error.message);
    process.exit(EXIT_STOPPED);
  }
  console.error('ERROR: ' + error.message);
  process.exit(1);
});
