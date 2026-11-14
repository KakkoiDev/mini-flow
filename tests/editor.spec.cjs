const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/');
});

test('opens a live invite in an existing Mini Flow tab', async ({ page }) => {
  const { hash, relay } = await page.evaluate(async () => {
    const { liveInviteHash, newLiveInvite } = await import('./mini-flow-live.js');
    const invite = newLiveInvite('wss://relay.example.org');
    return { hash: liveInviteHash(invite), relay: invite.relay };
  });
  await page.evaluate(hash => { location.hash = hash; }, hash);
  await page.waitForFunction(() => location.hash.startsWith('#live=') && document.querySelector('#agent-room-options')?.hidden);
  await page.getByRole('button', { name: /Live session/ }).click();
  await page.getByText('Custom WebSocket relay', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Relay URL' })).toHaveValue(relay);
});

test('remembers the agent edit review setting and explains a bad agent-room link', async ({ page }) => {
  const openLive = () => page.getByRole('button', { name: 'Live session', exact: true }).click();
  await openLive();
  await page.getByText('AI agents', { exact: true }).click();
  const review = page.getByRole('switch', { name: 'Review agent edits before they apply' });
  await expect(review).toBeChecked();
  await review.press('Space');
  await expect(review).not.toBeChecked();
  await page.getByRole('textbox', { name: 'agent-room chat link' }).fill('http://agents.example/chat');
  await page.locator('#agent-room-connect').click();
  await expect(page.locator('#agent-room-status')).toHaveText(/Enter an agent-room chat link/);
  await page.reload();
  await openLive();
  await page.getByText('AI agents', { exact: true }).click();
  await expect(review).not.toBeChecked();
});

// A minimal agent-room served through Playwright routes (see agent-room's PROTOCOL.md).
async function mockAgentRoom(page) {
  const room = { messages: [], posted: [], agents: [{ username: 'Claude', role: 'agent', listening: true, connection: 'waiting' }] };
  const reply = (route, status, body) => route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*' },
    contentType: typeof body === 'string' ? 'text/plain' : 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
  await page.route('https://agents.example/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/chat') return reply(route, 200, { client: '' });
    if (path === '/api/chat/rooms/general/participants' && request.method() === 'POST') return reply(route, 201, { token: 'person', username: 'Mini Flow' });
    if (path === '/api/chat/rooms/general/participants') return reply(route, 200, [{ username: 'Mini Flow', role: 'person' }, ...room.agents]);
    if (path === '/api/chat/rooms/general/invite') return reply(route, 200, 'You are invited to join "General". Download the helper.');
    if (path === '/api/chat/rooms/general') return reply(route, 200, { revision: room.messages.length, messages: room.messages, requests: [] });
    if (path === '/api/chat/rooms/general/messages') {
      const body = request.postDataJSON();
      room.posted.push(body.text);
      const assignments = [{ id: 'R' + room.messages.length, agent: 'Claude' }];
      room.messages.push({ author: 'Mini Flow', text: body.text, assignments });
      return reply(route, 200, { assignments, mentions: ['Claude'] });
    }
    if (path === '/api/chat/rooms/general/wait') {
      const after = Number(url.searchParams.get('after'));
      for (let i = 0; i < 20 && room.messages.length <= after; i++) await new Promise(resolve => setTimeout(resolve, 50));
      return reply(route, 200, { revision: room.messages.length, messages: room.messages.slice(after), assignments: [] });
    }
    return reply(route, 404, 'Not found');
  });
  return room;
}

test('Ask AI sends the note and board to an agent-room agent and reviews its edit', async ({ page }) => {
  const room = await mockAgentRoom(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.copiedInvite = value; } } });
    const source = 'flowchart TD\n    A["Start"]\n    %% mini-flow ' + JSON.stringify({ notes: [{ id: 'N1', label: 'Add a check step', target: 'A' }] });
    miniFlowEditor.setProject({ version: 1, source, positions: { A: [100, 80], N1: [320, 80] } });
  });
  await page.getByRole('button', { name: 'Live session', exact: true }).click();
  await page.getByText('AI agents', { exact: true }).click();
  await page.getByRole('textbox', { name: 'agent-room chat link' }).fill('https://agents.example/chat?room=general');
  await page.locator('#agent-room-connect').click();
  await expect(page.locator('#agent-room-status')).toHaveText('1 agent is in the room.');
  await expect(page.getByRole('combobox', { name: 'Ask AI sends to' })).toHaveValue('Claude');
  await page.getByRole('button', { name: 'Copy agent invite' }).click();
  await expect(page.getByRole('button', { name: 'Agent invite copied' })).toBeVisible();
  expect(await page.evaluate(() => window.copiedInvite)).toContain('mini-flow-edit block');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'note: Add a check step' }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect.poll(() => room.posted.length).toBe(1);
  expect(room.posted[0]).toMatch(/^@Claude Add a check step\n/);
  expect(room.posted[0]).toContain('A["Start"]');
  expect(room.posted[0]).toContain('attached to block A');
  room.messages.push({ author: 'Claude', kind: 'assignment-state', assignment_id: 'R0', assignment_status: 'Working', text: '' });
  room.messages.push({ author: 'Claude', kind: 'agent', assignment_id: 'R0', assignment_status: 'Replied',
    text: 'Added the check.\n```mini-flow-edit\n{"message":"Add a check","edits":[{"op":"add_node","id":"C1","type":"step","label":"Check","position":[100,190]},{"op":"add_arrow","from":"A","to":"C1"}]}\n```' });
  const dialog = page.getByRole('dialog', { name: 'Apply diagram edit?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Claude: Add a check');
  await dialog.getByRole('button', { name: 'Apply edit' }).click();
  await expect.poll(() => page.evaluate(() => miniFlowEditor.getMermaid())).toContain('A --> C1');
  await page.getByRole('button', { name: /Open note conversation/ }).click();
  await expect(page.getByRole('list', { name: 'Comments' })).toContainText('Added the check.');
  await expect(page.getByRole('list', { name: 'Comments' })).toContainText('Applied Claude’s edit: Add a check');
});

test('replacing a project through the page API clears old threads on reused note IDs', async ({ page }) => {
  await page.evaluate(() => {
    const source = 'flowchart TD\n    %% mini-flow ' + JSON.stringify({ notes: [{ id: 'N1', label: 'Old note' }] });
    miniFlowEditor.setProject({ version: 1, source, positions: { N1: [100, 100] },
      threads: [['N1', [{ role: 'user', author: 'Host', text: 'Old thread' }]]] });
  });
  await expect(page.getByRole('button', { name: /Open note conversation: 1 comment/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /Open note conversation: 1 comment/ })).toBeVisible();
  await page.evaluate(() => {
    const source = 'flowchart TD\n    %% mini-flow ' + JSON.stringify({ notes: [{ id: 'N1', label: 'New note' }] });
    miniFlowEditor.setProject({ version: 1, source, positions: { N1: [100, 100] } });
  });
  await expect(page.getByRole('button', { name: 'note: New note' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open note conversation/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'note: New note' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open note conversation/ })).toHaveCount(0);
});

test('collapses the custom relay in the live dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Live session', exact: true }).click();
  const relay = page.getByRole('textbox', { name: 'Relay URL' });
  await expect(relay).toBeHidden();
  await page.getByText('Custom WebSocket relay', { exact: true }).click();
  await expect(relay).toBeVisible();
  await page.getByText('Custom WebSocket relay', { exact: true }).click();
  await expect(relay).toBeHidden();
});

test('wraps long Japanese notes and unbroken words without changing saved text', async ({ page }) => {
  const label = '日本語には単語の間に空白がありません。'.repeat(4) + '\n' + 'a'.repeat(80);
  const result = await page.evaluate(label => {
    const source = 'flowchart TD\n    %% mini-flow ' + JSON.stringify({ notes: [{ id: 'N1', label }] });
    miniFlowEditor.setProject({ version: 1, source, positions: { N1: [0, 0] } });
    const root = document.querySelector('#editor > div').shadowRoot;
    const shape = root.querySelector('[data-note-fill="N1"]');
    const lines = [...shape.parentNode.querySelectorAll('text > tspan')];
    return {
      lineCount: lines.length,
      widestLine: Math.max(...lines.map(line => line.getComputedTextLength())),
      width: Number(shape.getAttribute('width')),
      savedLabel: MiniFlow.parse(miniFlowEditor.getProject().source).nodes[0].label
    };
  }, label);
  expect(result.lineCount).toBeGreaterThan(3);
  expect(result.widestLine).toBeLessThan(result.width);
  expect(result.savedLabel).toBe(label);
});

test('shows retry beside timed-out AI work in the activity list', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.body.appendChild(document.createElement('div'));
    const label = 'Retry this note';
    const source = 'flowchart TD\n    %% mini-flow ' + JSON.stringify({ notes: [{ id: 'N1', label }] });
    const editor = MiniFlow.mount(host, source, {}, {
      onRetryAIRequest: id => { host.dataset.retried = id; }
    });
    editor.setAIRequests({ N1: { phase: 'interrupted', label: 'AI request timed out' } });
  });
  await expect(page.getByText('AI request timed out · Retry this note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry AI request for Retry this note' }).click();
  await expect(page.locator('[data-retried="N1"]')).toHaveCount(1);
});

test('select, edit, delete, and restore a shape', async ({ page }) => {
  const node = page.getByRole('button', { name: 'terminal: Prompt In' });
  await node.click();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeEnabled();
  await node.press('Backspace');
  await expect(node).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(node).toBeVisible();
  await node.dblclick();
  const label = page.getByRole('textbox', { name: /Edit diagram label/ });
  // ArrowRight collapses the selection to the end on every platform; End does not move the caret in WebKit on macOS.
  await label.press('ArrowRight');
  await label.press('Shift+Enter');
  await page.keyboard.insertText('Next line');
  await label.press('Enter');
  await expect(label).toHaveCount(0);
  await expect(page.locator('svg tspan').filter({ hasText: /^Next line$/ })).toBeVisible();
});

test('configure an embed and round-trip a custom shape project', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = document.body.appendChild(document.createElement('div'));
    const editor = MiniFlow.mount(host, 'flowchart TD', {}, {
      features: { connect: false, edit: false, history: false },
      colors: { storage: '#ffeecc' },
      extraShapes: {
        storage: {
          syntax: ['[(', ')]'],
          draw: ({ element, paint }) => element('ellipse', { rx: 60, ry: 25, ...paint })
        }
      }
    });
    editor.setProject({ version: 1, source: 'flowchart TD\nA[("Disk")]', positions: { A: [-50, 80] } });
    const root = host.firstChild.shadowRoot;
    return {
      project: editor.getProject(),
      color: root.querySelector('ellipse').getAttribute('fill'),
      connectHidden: root.querySelector('[data-link]').hidden
    };
  });
  expect(result).toEqual({
    project: { version: 1, source: 'flowchart TD\n    A[("Disk")]', positions: { A: [-50, 80] } },
    color: '#ffeecc',
    connectHidden: true
  });
});

test('pinch changes the canvas zoom', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Touch injection uses Chromium CDP.');
  const svg = page.locator('svg[aria-label="Flowchart canvas"]');
  const before = await svg.getAttribute('viewBox');
  const box = await svg.boundingBox();
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  const touches = delta => [{ x: x - delta, y, id: 1 }, { x: x + delta, y, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(30) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(100) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(svg).not.toHaveAttribute('viewBox', before);
});

test('SDK feedback identifies changes and applies one undo step', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = document.body.appendChild(document.createElement('div'));
    host.id = 'sdk-feedback';
    const editor = MiniFlow.mount(host, 'flowchart TD\nA[Before]', { A: [100, 100] });
    const before = editor.getProject();
    editor.setProject({ version: 1, source: 'flowchart TD\nA[After]\nB[Fallback]\nA --> B',
      positions: { A: [100, 100], B: [300, 100] } }, { message: 'Added a fallback.' });
    const root = host.firstChild.shadowRoot;
    const summary = root.querySelector('[role=status]').textContent;
    const highlighted = root.querySelectorAll('[data-update-highlight]').length;
    window.feedbackEditor = editor;
    editor.undo();
    const restored = JSON.stringify(editor.getProject()) === JSON.stringify(before);
    editor.redo();
    editor.setMermaid('flowchart TD\nA[Latest]\nB[Fallback]\nA --> B', { message: 'Latest update.' });
    return { summary, highlighted, restored };
  });
  expect(result.summary).toBe('Added a fallback.');
  expect(result.highlighted).toBe(3);
  expect(result.restored).toBe(true);
  await expect(page.locator('#sdk-feedback [data-update-highlight]')).toHaveCount(0, { timeout: 5000 });
});

test('reconnect an endpoint and undo it', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.body.appendChild(document.createElement('div'));
    host.id = 'sdk-reconnect';
    window.reconnectEditor = MiniFlow.mount(host, 'flowchart TD\nA[Source]\nB[First]\nC[Second]\nA --> B',
      { A: [100, 150], B: [350, 150], C: [600, 150] });
    host.scrollIntoView();
  });
  const host = page.locator('#sdk-reconnect');
  // WebKit measures SVG groups differently (a horizontal arrow has no height), so click the middle of the drawn line.
  const arrowPoint = await host.getByRole('button', { name: 'Arrow from Source to First', exact: true }).evaluate(group => {
    const line = group.querySelector('path').getBoundingClientRect();
    return [line.x + line.width / 2, line.y + line.height / 2];
  });
  await page.mouse.click(...arrowPoint);
  const handle = host.getByRole('button', { name: 'Reconnect destination', exact: true });
  const box = await handle.boundingBox();
  const target = await host.getByRole('button', { name: 'step: Second', exact: true }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  expect(await page.evaluate(() => reconnectEditor.getMermaid())).toContain('A --> B');
  await page.mouse.up();
  expect(await page.evaluate(() => reconnectEditor.getMermaid())).toContain('A --> C');
  await page.evaluate(() => reconnectEditor.undo());
  expect(await page.evaluate(() => reconnectEditor.getMermaid())).toContain('A --> B');
});

test('snap preference survives reloads in both directions', async ({ page }) => {
  const arrange = page.getByText('Arrange', { exact: true });
  const snap = page.getByRole('checkbox', { name: 'Snap to grid' });
  await arrange.click();
  await snap.check();
  await page.reload();
  await arrange.click();
  await expect(snap).toBeChecked();
  await snap.uncheck();
  await page.reload();
  await arrange.click();
  await expect(snap).not.toBeChecked();
});

test('drag autosaves the open project and its title saves as you type', async ({ page }) => {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const saveAs = page.getByRole('button', { name: '+ Save as Project', exact: true });
  await saveAs.click();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Test diagram');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Test diagram' });
  const time = row.locator('time');
  await expect(time).toBeVisible();
  await saveAs.click();
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('');
  const initialTime = await time.getAttribute('datetime');
  const node = page.getByRole('button', { name: 'terminal: Prompt In', exact: true });
  const box = await node.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 65, y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(time).not.toHaveAttribute('datetime', initialTime);
  const moved = await page.evaluate(() => miniFlowEditor.getProject());

  await row.getByRole('button', { name: 'Rename Test diagram', exact: true }).click();
  const title = row.getByRole('textbox', { name: 'Project title' });
  await title.fill('Renamed diagram');
  const open = page.getByRole('button', { name: 'Open Renamed diagram', exact: true });
  await expect(open).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Project title' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('');
  const restored = await page.context().newPage();
  await restored.goto('http://127.0.0.1:8765/');
  expect(await restored.evaluate(() => miniFlowEditor.getProject())).toEqual(moved);
  await restored.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(restored.getByRole('button', { name: 'Rename Renamed diagram', exact: true }))
    .toHaveAttribute('aria-current', 'true');
});

test('a saved project backs up to a Gist and opens on another tab', async ({ page }) => {
  const id = '1234567890abcdef1234567890abcdef';
  const files = { 'README.md': { content: 'Keep this file' } };
  await page.context().route('https://api.github.com/gists/' + id, async route => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      expect(request.headers().authorization).toBe('Bearer test-token');
      const patch = request.postDataJSON().files;
      for (const name of Object.keys(patch)) expect(files[name]).toBeUndefined();
      Object.assign(files, patch);
    }
    await route.fulfill({ json: { files }, headers: { 'access-control-allow-origin': '*' } });
  });
  const original = await page.evaluate(() => miniFlowEditor.getProject());
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: '+ Save as Project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Gist example');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.', { exact: true }).waitFor();
  await page.getByText('GitHub Gist backup', { exact: true }).click();
  await page.getByLabel('Gist URL or ID').fill(id);
  await page.getByLabel('GitHub token for backups').fill('test-token');
  await expect(page.getByRole('checkbox', { name: /Back up automatically/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Connect project', exact: true }).click();
  const rowBackup = page.getByRole('button', { name: 'Back up to Gist Gist example', exact: true });
  await expect(rowBackup).toBeVisible();
  expect(Object.keys(files)).toHaveLength(1);
  await expect(page.getByRole('link', { name: 'Open Gist', exact: true })).toHaveAttribute('href', 'https://gist.github.com/' + id);
  await rowBackup.click();
  await expect(page.locator('[data-gist-status]')).toHaveText('Gist backup saved.');
  const backupTime = page.locator('[data-gist-backup-time]');
  await expect(backupTime).toHaveAttribute('datetime', /Z$/);
  const savedAt = await backupTime.getAttribute('datetime');
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByText('GitHub Gist backup', { exact: true }).click();
  await expect(page.getByLabel('GitHub token for backups')).toHaveValue('test-token');
  await expect(page.getByLabel('GitHub token for backups')).toHaveAttribute('type', 'password');
  await expect(backupTime).toHaveAttribute('datetime', savedAt);
  await expect(page.getByRole('checkbox', { name: /Back up automatically/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Back up now', exact: true }).click();
  await expect(page.getByText('Gist backup is up to date.', { exact: true })).toBeVisible();
  await expect(backupTime).toHaveAttribute('datetime', savedAt);
  expect(Object.keys(files)).toHaveLength(2);
  expect(files['README.md'].content).toBe('Keep this file');

  const restored = await page.context().newPage();
  await restored.goto('http://127.0.0.1:8765/#flow=' + encodeURIComponent(JSON.stringify({ source: 'flowchart TD', positions: {} })));
  await restored.getByRole('button', { name: 'Projects', exact: true }).click();
  await restored.getByText('GitHub Gist backup', { exact: true }).click();
  await restored.getByLabel('Gist URL or ID').fill(id);
  await restored.getByRole('button', { name: 'Find backups', exact: true }).click();
  await restored.getByRole('button', { name: 'Open snapshot', exact: true }).click();
  await expect(restored.getByText('Opened “Gist example” as a working copy.', { exact: true })).toBeVisible();
  expect(await restored.evaluate(() => miniFlowEditor.getProject())).toEqual(original);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByLabel('GitHub token for backups')).toHaveValue('');
  await expect(backupTime).toBeHidden();
  expect(await page.evaluate(id => sessionStorage.getItem('mini-flow-gist-token:' + id), id)).toBeNull();
});

test('review and apply an edit link as one undo step', async ({ page }) => {
  const base = await page.evaluate(() => miniFlowEditor.getProject());
  const project = { ...base, source: base.source.replace('Prompt In', 'Read prompt') };
  const hash = '#apply=' + encodeURIComponent(JSON.stringify({ version: 1, base, project, message: 'Renamed the first step.' }));
  await page.goto('http://127.0.0.1:8765/' + hash);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#proposal-diff .diff-remove')).toContainText('Prompt In');
  await expect(page.locator('#proposal-diff .diff-add')).toContainText('Read prompt');
  expect(await page.evaluate(() => miniFlowEditor.getMermaid())).toContain('Prompt In');
  await page.getByRole('button', { name: 'Apply edit' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'terminal: Read prompt' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'terminal: Prompt In' })).toBeVisible();

  await page.evaluate(() => miniFlowEditor.setMermaid(miniFlowEditor.getMermaid().replace('Prompt In', 'Newer edit')));
  await page.evaluate(hash => { location.hash = hash; }, hash);
  await expect(page.getByRole('button', { name: 'Apply edit' })).toBeDisabled();
  expect(await page.evaluate(() => miniFlowEditor.getMermaid())).toContain('Newer edit');
});

test('Mermaid source restores the exact layout on a blank board', async ({ page }) => {
  const before = await page.evaluate(() => miniFlowEditor.getProject());
  await page.getByRole('button', { name: 'Code & export' }).click();
  const source = page.getByRole('textbox', { name: 'Mermaid source' });
  const copied = await source.inputValue();
  await page.getByRole('button', { name: 'Start blank' }).click();
  await source.fill(copied);
  await page.getByRole('button', { name: 'Apply source' }).click();
  expect(await page.evaluate(() => miniFlowEditor.getProject())).toEqual(before);
});

const stepFill = page => page.evaluate(() => {
  const root = document.querySelector('#editor > div').shadowRoot;
  return [...root.querySelectorAll('svg rect')].find(rect => rect.getAttribute('rx') === '4')?.getAttribute('fill');
});

test('follows the system theme and always exports the light palette', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => stepFill(page)).toBe('#ffffff');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => stepFill(page)).toBe('#232b29');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(21, 26, 25)');
  const exported = await page.evaluate(() => miniFlowEditor.exportSvg().text());
  expect(exported).toContain('fill="#ffffff"');
  expect(exported).toContain('fill="#faf8f5"');
  expect(exported).not.toContain('#232b29');
  expect(await stepFill(page)).toBe('#232b29');
});

test('an embed can force a theme and still override colors', async ({ page }) => {
  const fills = await page.evaluate(() => {
    const read = theme => {
      const host = document.createElement('div');
      document.body.append(host);
      const editor = MiniFlow.mount(host, 'flowchart TD\n    A["One"]', {}, { theme, colors: { accent: '#123456' } });
      const root = host.firstElementChild;
      const style = getComputedStyle(root);
      const result = { step: style.getPropertyValue('--c-step').trim(), accent: style.getPropertyValue('--c-accent').trim() };
      editor.destroy();
      host.remove();
      return result;
    };
    return { dark: read('dark'), light: read('light') };
  });
  expect(fills.light.accent).toBe('#123456');
  expect(fills.dark.accent).toBe('#123456');
});

test('phone layout fits the header and dock on one row each', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const header = await page.locator('header').boundingBox();
  expect(header.height).toBeLessThanOrEqual(60);
  await expect(page.getByRole('button', { name: 'Start blank' })).toBeHidden();
  const dock = await page.evaluate(() => {
    const toolbar = document.querySelector('#editor > div').shadowRoot.querySelector('.toolbar');
    const buttons = [...toolbar.querySelectorAll('button')].filter(button => button.offsetParent);
    return { height: toolbar.getBoundingClientRect().height,
      sizes: buttons.map(button => [button.offsetWidth, button.offsetHeight]) };
  });
  expect(dock.height).toBeLessThan(70);
  for (const [width, height] of dock.sizes) {
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Snap to grid' })).toBeVisible();
  for (const name of ['Auto layout', 'Fit to screen', 'Copy link', 'Live session', 'Projects', 'Code & export', 'Start blank']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.getByRole('button', { name: 'More actions' }).click();
  await menu.getByRole('menuitem', { name: 'Projects' }).click();
  await expect(menu).toBeHidden();
  const sheet = page.locator('#saved-projects');
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box.width).toBe(375);
  expect(box.y + box.height).toBeCloseTo(812, 0);
  await page.locator('.sheet-scrim').click({ position: { x: 20, y: 20 } });
  await expect(sheet).toBeHidden();
});

test('Start blank shows an undo toast that restores the board', async ({ page }) => {
  const before = await page.evaluate(() => miniFlowEditor.getProject());
  const blank = page.getByRole('button', { name: 'Start blank' });
  await blank.click();
  const toast = page.locator('#toast-region .toast');
  await expect(toast).toContainText('Board cleared. 9 blocks removed.');
  await expect(blank).toHaveAttribute('aria-disabled', 'true');
  await expect(blank).toHaveAttribute('title', 'Board is already empty');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toBeHidden();
  expect(await page.evaluate(() => miniFlowEditor.getProject())).toEqual(before);
  await blank.click();
  await expect(toast).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toast).toBeHidden();
  await page.getByRole('button', { name: 'Undo' }).first().click();
  expect(await page.evaluate(() => miniFlowEditor.getProject())).toEqual(before);
});
