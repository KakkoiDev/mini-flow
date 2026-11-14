const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { readFile, writeFile } = require('node:fs/promises');
const { spawn, execFileSync } = require('node:child_process');
// Opt-in end-to-end test over the real public relay; not part of CI because it needs the network.
// Run: npx playwright test -c tests/agent-relay/playwright.config.cjs
// The page and the helper use the production origin, served from this working copy, so the relay accepts them.
const { mkdtempSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const root = path.join(__dirname, '../..');
const work = mkdtempSync(path.join(tmpdir(), 'mini-flow-agent-'));
copyFileSync(path.join(root, 'mini-flow-agent.mjs'), path.join(work, 'mini-flow-agent.mjs'));
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html' };
const env = { ...process.env, XDG_STATE_HOME: work + '/state', XDG_CACHE_HOME: work + '/cache' };
const helper = (...args) => execFileSync('node', ['--import', path.join(__dirname, 'fetch-shim.mjs'), work + '/mini-flow-agent.mjs', ...args], { env, encoding: 'utf8', timeout: 60000 });

test('an AI agent joins over the relay, answers Ask AI, and edits the board', async ({ page }) => {
  test.setTimeout(150000);
  await page.route('https://mini-flow.kakkoi.dev/**', async route => {
    let file = new URL(route.request().url()).pathname;
    if (file.endsWith('/')) file += 'index.html';
    try { await route.fulfill({ body: await readFile(path.join(root, file)), contentType: types[path.extname(file)] ?? 'application/octet-stream' }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
  await page.goto('https://mini-flow.kakkoi.dev/');
  await page.evaluate(() => {
    const source = 'flowchart TD\n    A["Start"]\n    B{"Valid?"}\n    A --> B\n    %% mini-flow ' + JSON.stringify({ notes: [{ id: 'N1', label: 'Add a retry when invalid', target: 'B' }] });
    miniFlowEditor.setProject({ version: 1, source, positions: { A: [100, 60], B: [100, 180], N1: [340, 180] } });
  });
  await page.getByRole('button', { name: 'Live session', exact: true }).click();
  await page.getByRole('button', { name: 'Start live session' }).click();
  await expect(page.locator('#live-network-status')).toContainText('WebSocket relay: ready', { timeout: 30000 });
  const invite = await page.locator('#live-invite').inputValue();
  await page.getByText('AI agents', { exact: true }).click();

  console.log(helper(invite, 'Claude', 'check').trim());
  console.log(helper(invite, 'Claude', 'join').trim());
  await expect(page.locator('#ai-agents-status')).toHaveText('1 agent has joined.');
  await expect(page.getByRole('combobox', { name: 'Ask AI sends to' })).toHaveValue('Claude');
  await page.getByRole('button', { name: 'Close' }).click();

  const listen = spawn('node', ['--import', path.join(__dirname, 'fetch-shim.mjs'), work + '/mini-flow-agent.mjs', invite, 'Claude', 'listen', '--timeout', '90'], { env });
  let output = '';
  listen.stdout.on('data', chunk => { output += chunk; });
  listen.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => listen.on('exit', resolve));
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'note: Add a retry when invalid' }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  expect(await exited).toBe(0);
  console.log(output.split('\n').slice(0, 12).join('\n'));
  const requestId = output.match(/Request ID: (\w+)/)[1];
  expect(output).toContain('B{"Valid?"}');
  expect(output).toContain('attached to block B');

  await writeFile(work + '/answer.txt', 'Added a retry loop for invalid input.\n\n```mini-flow-edit\n'
    + JSON.stringify({ message: 'Add retry loop', edits: [
      { op: 'add_node', id: 'R1', type: 'step', label: 'Ask again', position: [340, 300] },
      { op: 'add_arrow', from: 'B', to: 'R1', label: 'no' }, { op: 'add_arrow', from: 'R1', to: 'B' }] })
    + '\n```\n');
  console.log(helper(invite, 'Claude', 'reply', requestId, '--file', work + '/answer.txt').trim());
  const dialog = page.getByRole('dialog', { name: 'Apply diagram edit?' });
  await expect(dialog).toBeVisible({ timeout: 20000 });
  await expect(dialog).toContainText('Claude: Add retry loop');
  await dialog.getByRole('button', { name: 'Apply edit' }).click();
  await expect.poll(() => page.evaluate(() => miniFlowEditor.getMermaid())).toContain('B --> |no| R1');
  await page.getByRole('button', { name: /Open note conversation/ }).click();
  await expect(page.getByRole('list', { name: 'Comments' })).toContainText('Added a retry loop for invalid input.');
  await expect(page.getByRole('list', { name: 'Comments' })).toContainText('Applied Claude’s edit: Add retry loop');

  // Stop: the agent's next listen exits with code 3.
  await page.getByRole('button', { name: 'Live session, active' }).click();
  await page.getByRole('button', { name: 'Stop agent' }).click();
  let stopped;
  try { helper(invite, 'Claude', 'listen', '--timeout', '5'); } catch (error) { stopped = error; }
  expect(stopped.status).toBe(3);
  expect(stopped.stdout).toContain('STOPPED');
});
