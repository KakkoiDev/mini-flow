// Live sessions and AI agents, end to end in one browser. Pages in the same browser reach each
// other through p2p-core's same-browser channel, so these tests need no network relay.
const { test, expect } = require('@playwright/test');

const base = 'http://127.0.0.1:8765/';
const board = {
  version: 1,
  source: 'flowchart TD\n    A["Start"]\n    B{"Valid?"}\n    A --> B\n    %% mini-flow ' +
    JSON.stringify({ notes: [{ id: 'N1', label: 'Add a retry when invalid', target: 'B' }], bends: [] }),
  positions: { A: [100, 60], B: [100, 180], N1: [340, 180] }
};
const mermaid = page => page.evaluate(() => miniFlowEditor.getMermaid());
const counter = page => page.locator('.live-guest-counter');

const ready = page => page.waitForFunction(() => typeof window.miniFlowEditor?.getMermaid === 'function');

async function startHost(page) {
  await page.goto(base);
  await ready(page);
  await page.evaluate(project => miniFlowEditor.setProject(project), board);
  await page.getByRole('button', { name: 'Live session', exact: true }).click();
  await page.getByRole('button', { name: 'Start live session' }).click();
  await expect(page.getByRole('button', { name: 'End session' })).toBeVisible();
  const invite = await page.locator('#live-invite').inputValue();
  await page.getByRole('button', { name: 'Close' }).click();
  return invite;
}

async function joinGuest(context, invite) {
  const guest = await context.newPage();
  await guest.goto(invite);
  await ready(guest);
  await expect.poll(() => mermaid(guest), { timeout: 20000 }).toContain('Add a retry when invalid');
  return guest;
}

// An AI agent running in a page: the same protocol the mini-flow-agent.mjs helper speaks.
async function connectAgent(context, invite, name) {
  const page = await context.newPage();
  await page.goto(base + 'favicon.svg');
  const joined = await page.evaluate(async ({ invite, name }) => {
    const live = await import('/mini-flow-live.js');
    const link = new URL(invite);
    const client = await live.connectAsAgent(live.readLiveInvite(link.hash), {
      transports: { relays: false, pair: false, tabs: true, server: false } });
    const result = await client.call('join', { name });
    window.agent = { client, token: result.token,
      call: (op, body = {}, waitMs) => client.call(op, { ...body, token: result.token }, waitMs) };
    return result;
  }, { invite, name });
  expect(joined.ok).toBe(true);
  return {
    page,
    wait: (timeoutMs = 15000) => page.evaluate(ms => window.agent.call('wait', { timeoutMs: ms }, ms + 5000), timeoutMs),
    act: (requestId, action, text) => page.evaluate(body => window.agent.call('action', body), { requestId, action, text }),
    close: () => page.evaluate(() => window.agent.client.close())
  };
}

async function askAI(page) {
  await page.getByRole('button', { name: 'note: Add a retry when invalid' }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
}

async function openConversation(page) {
  await page.getByRole('button', { name: /Open note conversation/ }).click();
  return page.getByRole('list', { name: 'Comments' });
}

test('a guest joins, edits sync both ways, comments reach the host, and the guest keeps a copy at the end', async ({ page, context }) => {
  const invite = await startHost(page);
  expect(invite).toMatch(/#live=[a-f0-9]{32}\.[a-f0-9]{32}&host=/);
  const guest = await joinGuest(context, invite);
  await expect(counter(page)).toHaveText('1 guest');

  await guest.evaluate(() => miniFlowEditor.setMermaid(miniFlowEditor.getMermaid().replace('"Start"', '"Begin"')));
  await expect.poll(() => mermaid(page)).toContain('A["Begin"]');
  await page.evaluate(() => miniFlowEditor.setMermaid(miniFlowEditor.getMermaid().replace('"Valid?"', '"Is it valid?"')));
  await expect.poll(() => mermaid(guest)).toContain('B{"Is it valid?"}');
  // Only the host owns Undo.
  await expect(guest.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);

  await guest.getByRole('button', { name: 'note: Add a retry when invalid' }).click();
  await guest.getByRole('button', { name: 'Comment', exact: true }).click();
  await guest.getByRole('textbox', { name: 'Comment' }).fill('Should B loop back to A?');
  await guest.getByRole('button', { name: 'Post comment' }).click();
  const comments = await openConversation(page);
  await expect(comments).toContainText('Guest 1');
  await expect(comments).toContainText('Should B loop back to A?');

  await page.getByRole('button', { name: /Live session/ }).first().click();
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(guest.locator('#live-notice')).toHaveText('Session ended. You can keep editing this copy.');
  await expect.poll(() => guest.evaluate(() => location.hash)).toMatch(/^#flow=/);
  await guest.evaluate(() => miniFlowEditor.setMermaid(miniFlowEditor.getMermaid().replace('"Begin"', '"Local copy"')));
  await expect(guest.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  expect(await mermaid(page)).toContain('A["Begin"]');
});

test('Ask AI needs a connected agent and says so', async ({ page, context }) => {
  const invite = await startHost(page);
  await page.getByRole('button', { name: 'note: Add a retry when invalid' }).click();
  await expect(page.getByRole('button', { name: 'Ask AI', exact: true })).toBeDisabled();
  const guest = await joinGuest(context, invite);
  await askAI(guest);
  await expect(guest.locator('#live-notice')).toHaveText('No AI agents have joined yet. Copy the agent invite into an agent first.');
});

test('an AI agent joins, answers Ask AI with an edit, and everyone sees it', async ({ page, context }) => {
  const invite = await startHost(page);
  const guest = await joinGuest(context, invite);
  const agent = await connectAgent(context, invite, 'Qwen');
  await expect(counter(page)).toHaveText('1 guest · 1 AI agent');
  await expect(counter(guest)).toHaveText('1 guest · 1 AI agent');
  await expect(counter(page)).toHaveAttribute('title', /AI agent Qwen: listening/);
  await page.getByRole('button', { name: /Live session/ }).first().click();
  await page.getByText('AI agents', { exact: true }).click();
  await expect(page.locator('#ai-agents-status')).toHaveText('1 agent has joined.');
  await expect(page.getByRole('combobox', { name: 'Ask AI sends to' })).toHaveValue('Qwen');
  await page.getByRole('button', { name: 'Close' }).click();

  const waiting = agent.wait();
  await askAI(page);
  const { requests: [request] } = await waiting;
  expect(request.requester).toBe('Host');
  expect(request.prompt).toBe('Add a retry when invalid');
  expect(request.note.target).toEqual({ type: 'node', id: 'B' });
  expect(request.board.source).toContain('B{"Valid?"}');
  expect(request.board.positions.B).toEqual([100, 180]);

  expect((await agent.act(request.id, 'progress', 'Reading the board')).ok).toBe(true);
  const comments = await openConversation(page);
  await expect(comments).toContainText('Reading the board');
  const answer = 'Added a retry loop.\n```mini-flow-edit\n' + JSON.stringify({ message: 'Add retry loop', edits: [
    { op: 'add_node', id: 'R1', type: 'step', label: 'Ask again', position: [340, 300] },
    { op: 'add_arrow', from: 'B', to: 'R1', label: 'no' }] }) + '\n```';
  expect((await agent.act(request.id, 'reply', answer)).ok).toBe(true);
  const dialog = page.getByRole('dialog', { name: 'Apply diagram edit?' });
  await expect(dialog).toContainText('Qwen: Add retry loop');
  await dialog.getByRole('button', { name: 'Apply edit' }).click();
  await expect.poll(() => mermaid(page)).toContain('B --> |no| R1');
  await expect.poll(() => mermaid(guest)).toContain('B --> |no| R1');
  await expect(comments).toContainText('Added a retry loop.');
  await expect(comments).toContainText('Applied Qwen’s edit: Add retry loop');
  await expect(comments).not.toContainText('mini-flow-edit');
  // One Undo removes the whole edit.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => mermaid(page)).not.toContain('R1');
  await agent.close();
});

test('a guest asks AI, the agent fails, the host retries, cancels, and stops the agent', async ({ page, context }) => {
  const invite = await startHost(page);
  const guest = await joinGuest(context, invite);
  const agent = await connectAgent(context, invite, 'Qwen');
  await expect(counter(guest)).toHaveText('1 guest · 1 AI agent');

  let waiting = agent.wait();
  await guest.getByRole('button', { name: 'note: Add a retry when invalid' }).click();
  await guest.getByRole('button', { name: 'Comment', exact: true }).click();
  await guest.getByRole('textbox', { name: 'Comment' }).fill('Can you translate this note to Japanese?');
  await guest.locator('#ai-reply-ask').click();
  let { requests: [request] } = await waiting;
  expect(request.requester).toBe('Guest 1');
  expect(request.prompt).toBe('Can you translate this note to Japanese?');

  expect((await agent.act(request.id, 'failed', 'The model is offline')).ok).toBe(true);
  const comments = await openConversation(page);
  await expect(comments).toContainText('Qwen could not finish: The model is offline');
  await expect(page.getByRole('button', { name: 'Retry AI request for Add a retry when invalid' })).toBeVisible();
  waiting = agent.wait();
  await page.getByRole('button', { name: 'Retry AI request for Add a retry when invalid' }).click();
  ({ requests: [request] } = await waiting);
  expect(request.prompt).toBe('Can you translate this note to Japanese?');
  expect((await agent.act(request.id, 'reply', '再試行を追加してください')).ok).toBe(true);
  await expect(comments).toContainText('再試行を追加してください');
  await expect.poll(async () => (await guest.getByRole('list', { name: 'Comments' }).textContent()) ?? '').toContain('再試行を追加してください');

  // Cancel from the activity list: the agent can no longer answer.
  waiting = agent.wait();
  await page.getByRole('button', { name: 'Close note conversation' }).click();
  await askAI(page);
  ({ requests: [request] } = await waiting);
  await page.getByRole('button', { name: 'Cancel AI request for Add a retry when invalid' }).click();
  expect((await agent.act(request.id, 'reply', 'Too late')).reason).toBe('request_missing');

  // Stop: the agent's next wait says stopped, and the counter drops it.
  const stopped = agent.wait();
  await page.getByRole('button', { name: /Live session/ }).first().click();
  await page.getByText('AI agents', { exact: true }).click();
  await page.getByRole('button', { name: 'Stop agent' }).click();
  expect((await stopped).reason).toBe('stopped');
  await expect(counter(guest)).toHaveText('1 guest');
});
