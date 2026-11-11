const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/');
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
  const snap = page.getByRole('checkbox', { name: 'Snap to grid' });
  await snap.check();
  await page.reload();
  await expect(snap).toBeChecked();
  await snap.uncheck();
  await page.reload();
  await expect(snap).not.toBeChecked();
});

test('review and apply an edit link as one undo step', async ({ page }) => {
  const base = await page.evaluate(() => miniFlowEditor.getProject());
  const project = { ...base, source: base.source.replace('Prompt In', 'Read prompt') };
  const hash = '#apply=' + encodeURIComponent(JSON.stringify({ version: 1, base, project, message: 'Renamed the first step.' }));
  await page.goto('http://127.0.0.1:8765/' + hash);
  await expect(page.getByRole('dialog')).toBeVisible();
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
