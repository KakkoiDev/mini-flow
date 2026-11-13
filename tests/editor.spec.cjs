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
  await page.waitForFunction(() => typeof window.miniFlowLiveAI?.register_live_agent === 'function');
  await page.getByRole('button', { name: /Live session/ }).click();
  await page.getByText('Custom WebSocket relay', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Relay URL' })).toHaveValue(relay);
});

test('remembers the host idle timeout selected before starting', async ({ page }) => {
  const openLive = () => page.getByRole('button', { name: 'Live session', exact: true }).click();
  const timeout = page.getByRole('combobox', { name: 'AI idle timeout' });
  await openLive();
  await expect(timeout).toHaveValue('5');
  await timeout.selectOption('15');
  await page.reload();
  await openLive();
  await expect(timeout).toHaveValue('15');
  await page.getByRole('button', { name: 'Start live session' }).click();
  await expect(page.getByRole('button', { name: 'End session' })).toBeVisible();
  await expect(timeout).toHaveValue('15');
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(timeout).toHaveValue('15');
});

test('copies a direct AI guest invite and resets its label after three seconds', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      async writeText(value) { window.copiedAIInvite = value; }
    } });
  });
  await page.clock.install();
  await page.getByRole('button', { name: 'Live session', exact: true }).click();
  await page.getByRole('button', { name: 'Start live session' }).click();
  await page.getByText('AI guests', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy AI invite' }).click();
  await expect(page.getByRole('button', { name: 'AI invite copied' })).toBeVisible();
  const invite = await page.evaluate(() => window.copiedAIInvite);
  expect(invite).toContain('await window.miniFlowLiveAI.register_live_agent({})');
  expect(invite).toContain('{"after":0,"timeoutMs":10000}');
  expect(invite).toContain('session_ended');
  expect(invite).toContain('retry for up to 60 seconds');
  expect(invite).toContain('window.miniFlowLiveAI.help()');
  expect(invite).toContain('"op":"add_arrow"');
  await page.clock.fastForward(3000);
  await expect(page.getByRole('button', { name: 'Copy AI invite' })).toBeVisible();
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

test('collapses the custom relay and toggles AI approval in the live dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Live session', exact: true }).click();
  const relay = page.getByRole('textbox', { name: 'Relay URL' });
  await expect(relay).toBeHidden();
  await page.getByText('Custom WebSocket relay', { exact: true }).click();
  await expect(relay).toBeVisible();
  await page.getByText('Custom WebSocket relay', { exact: true }).click();
  await expect(relay).toBeHidden();

  await page.getByRole('button', { name: 'Start live session' }).click();
  await page.getByText('AI guests', { exact: true }).click();
  const approval = page.getByRole('switch', { name: 'Require approval for AI guest edits' });
  await expect(approval).toBeChecked();
  await approval.press('Space');
  await expect(approval).not.toBeChecked();
  await expect(page.getByText('AI guest edits apply without host approval.')).toBeVisible();
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
  await label.press('End');
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
  await host.getByRole('button', { name: 'Arrow from Source to First', exact: true }).click();
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
