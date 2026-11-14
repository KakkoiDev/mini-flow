// Browser regressions for editing, notes, bends, layout, history, source, exports, links, projects and comments.
const { test, expect } = require('@playwright/test');

const site = 'http://127.0.0.1:8765/';

test.beforeEach(async ({ page }) => {
  await page.goto(site);
});

const mermaid = page => page.evaluate(() => miniFlowEditor.getMermaid());
const project = page => page.evaluate(() => miniFlowEditor.getProject());
const status = page => page.locator('#editor p.status');
const canvas = page => page.locator('svg[aria-label="Flowchart canvas"]');

async function setBoard(page, source, positions) {
  await page.evaluate(([source, positions]) => miniFlowEditor.setProject({ version: 1, source, positions }), [source, positions]);
}

// A point on the canvas, as fractions of its size.
async function canvasPoint(page, fx, fy) {
  const box = await canvas(page).boundingBox();
  return [box.x + box.width * fx, box.y + box.height * fy];
}

// The middle of an arrow's drawn line. WebKit measures SVG groups differently, so use the path itself.
async function arrowPoint(page, name) {
  return page.getByRole('button', { name, exact: true }).evaluate(group => {
    const line = group.querySelector('path').getBoundingClientRect();
    return [line.x + line.width / 2, line.y + line.height / 2];
  });
}

async function focusCanvas(page) {
  await page.evaluate(() => document.querySelector('#editor > div').focus());
}

async function typeLabel(page, text) {
  const label = page.getByRole('textbox', { name: /Edit diagram label/ });
  await expect(label).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
  await label.press('Enter');
  await expect(label).toHaveCount(0);
}

const pair = 'flowchart TD\n    A["Alpha"]\n    B["Beta"]\n    A --> B';
const pairPositions = { A: [200, 80], B: [200, 300] };

test('creates blocks with the dock and the number keys, and Esc cancels a tool', async ({ page }) => {
  await setBoard(page, 'flowchart TD', {});
  await page.getByRole('button', { name: 'Start / End' }).click();
  await expect(page.getByRole('button', { name: 'Start / End' })).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(...await canvasPoint(page, 0.3, 0.3));
  await typeLabel(page, 'Begin');

  await focusCanvas(page);
  await page.keyboard.press('2');
  await expect(page.getByRole('button', { name: 'Step', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(...await canvasPoint(page, 0.3, 0.5));
  await typeLabel(page, 'Work');

  await focusCanvas(page);
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: 'Decision', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Decision', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(status(page)).toHaveText('Tool canceled.');
  const before = await mermaid(page);
  await page.mouse.click(...await canvasPoint(page, 0.6, 0.4));
  expect(await mermaid(page)).toBe(before);

  await focusCanvas(page);
  await page.keyboard.press('3');
  await page.mouse.click(...await canvasPoint(page, 0.6, 0.4));
  await typeLabel(page, 'Done?');
  const source = await mermaid(page);
  expect(source).toMatch(/\(\["Begin"\]\)/);
  expect(source).toMatch(/\["Work"\]/);
  expect(source).toMatch(/\{"Done\?"\}/);
  expect(Object.keys((await project(page)).positions)).toHaveLength(3);
});

test('connects blocks, labels an arrow, and deletes arrows and blocks', async ({ page }) => {
  await setBoard(page, 'flowchart TD\n    A["Alpha"]\n    B["Beta"]', pairPositions);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'step: Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'step: Beta', exact: true }).click();
  await expect.poll(() => mermaid(page)).toContain('A --> B');
  await expect(status(page)).toHaveText('Arrow added. Double-click to edit its label.');
  await page.keyboard.press('Escape');

  await page.mouse.dblclick(...await arrowPoint(page, 'Arrow from Alpha to Beta'));
  await typeLabel(page, 'next');
  await expect.poll(() => mermaid(page)).toContain('A --> |next| B');

  // Press keys on the selected element: a mouse click does not move focus into the SVG in WebKit.
  await page.mouse.click(...await arrowPoint(page, 'Arrow from Alpha to Beta'));
  await page.getByRole('button', { name: 'Arrow from Alpha to Beta', exact: true }).press('Backspace');
  await expect.poll(() => mermaid(page)).not.toContain('-->');
  await expect(page.getByRole('button', { name: 'step: Beta', exact: true })).toBeVisible();

  await focusCanvas(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mermaid(page)).toContain('A --> |next| B');
  await page.getByRole('button', { name: 'step: Beta', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const after = await mermaid(page);
  expect(after).not.toContain('Beta');
  expect(after).not.toContain('-->');
  expect(after).toContain('A["Alpha"]');
});

test('notes attach to blocks and arrows, outlive their target, and survive a reload', async ({ page }) => {
  await setBoard(page, pair, pairPositions);
  await focusCanvas(page);
  await page.keyboard.press('5');
  await page.mouse.click(...await canvasPoint(page, 0.7, 0.3));
  await typeLabel(page, 'Check this');
  const notes = async () => (await page.evaluate(() => MiniFlow.parse(miniFlowEditor.getMermaid()).nodes))
    .filter(node => node.type === 'note');
  expect((await notes()).map(note => note.label)).toEqual(['Check this']);

  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await connect.click();
  await page.getByRole('button', { name: 'note: Check this', exact: true }).click();
  await page.getByRole('button', { name: 'step: Alpha', exact: true }).click();
  await expect(status(page)).toHaveText('Note attached.');
  expect((await notes())[0].target).toBe('A');

  await page.keyboard.press('Escape');
  await connect.click();
  await page.getByRole('button', { name: 'note: Check this', exact: true }).click();
  await page.mouse.click(...await arrowPoint(page, 'Arrow from Alpha to Beta'));
  await expect.poll(async () => (await notes())[0].target).toBe(0);
  await page.keyboard.press('Escape');
  expect(await mermaid(page)).toMatch(/%% mini-flow .*"target":0/);

  await page.reload();
  expect(await mermaid(page)).toMatch(/%% mini-flow .*"label":"Check this","target":0/);
  await page.mouse.click(...await arrowPoint(page, 'Arrow from Alpha to Beta'));
  await page.getByRole('button', { name: 'Arrow from Alpha to Beta', exact: true }).press('Backspace');
  await expect.poll(() => mermaid(page)).not.toContain('-->');
  const kept = await notes();
  expect(kept.map(note => [note.label, note.target])).toEqual([['Check this', undefined]]);
});

test('adds, moves and resets an arrow bend, one undo step each', async ({ page }) => {
  await setBoard(page, pair, pairPositions);
  const bend = async () => (await page.evaluate(() => MiniFlow.parse(miniFlowEditor.getMermaid()).edges[0].bend)) ?? null;
  await page.mouse.click(...await arrowPoint(page, 'Arrow from Alpha to Beta'));
  await page.getByRole('button', { name: 'Add bend', exact: true }).click();
  await expect(status(page)).toHaveText('Click or tap the canvas to place the bend.');
  await page.mouse.click(...await canvasPoint(page, 0.75, 0.45));
  await expect.poll(bend).not.toBeNull();
  const placed = await bend();

  const handle = page.getByRole('button', { name: 'Move connection bend', exact: true });
  await handle.focus();
  await handle.press('ArrowRight');
  await expect.poll(bend).not.toEqual(placed);
  const moved = await bend();
  expect(moved[0]).toBeGreaterThan(placed[0]);
  expect(moved[1]).toBe(placed[1]);

  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(bend).not.toEqual(moved);
  const dragged = await bend();

  await page.getByRole('button', { name: 'Reset bend', exact: true }).click();
  await expect.poll(bend).toBeNull();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await bend()).toEqual(dragged);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await bend()).toEqual(moved);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await bend()).toEqual(placed);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await bend()).toBeNull();
});

test('auto layout moves blocks, resets bends, keeps notes, and undoes in one step', async ({ page }) => {
  const source = 'flowchart TD\n    A(["Start"])\n    B["Step"]\n    C(["End"])\n    A --> B\n    B --> C\n    %% mini-flow '
    + JSON.stringify({ notes: [{ id: 'N1', label: 'Keep this attachment', target: 1 }], bends: [[0, [500, 300]], [1, [-80, 400]]] });
  await setBoard(page, source, { A: [0, 0], B: [30, 100], C: [60, 200], N1: [-80, 100] });
  const before = await project(page);
  await page.getByText('Arrange', { exact: true }).click();
  await page.getByRole('button', { name: 'Auto layout', exact: true }).click();
  const after = await project(page);
  const graph = await page.evaluate(source => MiniFlow.parse(source), after.source);
  expect(graph.edges.every(edge => !edge.bend)).toBe(true);
  expect(graph.nodes.find(node => node.id === 'N1').target).toBe(1);
  expect(after.positions).not.toEqual(before.positions);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await project(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await project(page)).toEqual(after);
});

test('keyboard undo and redo, while text fields keep their own undo', async ({ page }) => {
  await setBoard(page, pair, pairPositions);
  const before = await mermaid(page);
  await page.getByRole('button', { name: 'step: Beta', exact: true }).click();
  await page.getByRole('button', { name: 'step: Beta', exact: true }).press('Backspace');
  const deleted = await mermaid(page);
  expect(deleted).not.toContain('Beta');
  await focusCanvas(page);
  await page.keyboard.press('Control+z');
  expect(await mermaid(page)).toBe(before);
  await page.keyboard.press('Control+y');
  expect(await mermaid(page)).toBe(deleted);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Meta+Shift+z');
  expect(await mermaid(page)).toBe(deleted);
  await page.keyboard.press('Meta+z');
  expect(await mermaid(page)).toBe(before);

  await page.getByRole('button', { name: 'Code & export' }).click();
  const area = page.getByRole('textbox', { name: 'Mermaid source' });
  await area.click();
  await area.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n    C["Draft"]');
  await area.press('ControlOrMeta+z');
  expect(await mermaid(page)).toBe(before);
  await expect(area).not.toHaveValue(/Draft/);
});

test('applies, rejects and discards Mermaid source edits', async ({ page }) => {
  await setBoard(page, pair, pairPositions);
  await page.getByRole('button', { name: 'Code & export' }).click();
  const area = page.getByRole('textbox', { name: 'Mermaid source' });
  const apply = page.getByRole('button', { name: 'Apply source', exact: true });
  const discard = page.getByRole('button', { name: 'Discard edits', exact: true });
  await expect(discard).toBeHidden();
  const original = await area.inputValue();

  await area.fill('flowchart TD\n    A["Alpha renamed"]\n    B["Beta"]\n    Z["Zeta"]\n    A --> B\n    B --> Z');
  await expect(discard).toBeVisible();
  await apply.click();
  await expect(status(page)).toHaveText('Mermaid source applied.');
  const applied = await project(page);
  expect(applied.source).toContain('A["Alpha renamed"]');
  expect(applied.source).toContain('B --> Z');
  expect(applied.positions.A).toEqual(pairPositions.A);
  expect(applied.positions.B).toEqual(pairPositions.B);
  expect(applied.positions.Z).toBeDefined();
  await expect(discard).toBeHidden();

  await area.fill('this is not a flowchart');
  await apply.click();
  await expect(status(page)).toHaveText('Start with flowchart TD.');
  expect(await project(page)).toEqual(applied);
  await discard.click();
  await expect(status(page)).toHaveText('Source edits discarded.');
  await expect(area).toHaveValue(/Alpha renamed/);
  expect(original).toContain('A["Alpha"]');
});

test('exports SVG, PNG and Markdown, downloads them, and copies text formats', async ({ page }) => {
  await setBoard(page, pair, pairPositions);
  const api = await page.evaluate(async () => {
    const svg = await miniFlowEditor.exportSvg().text();
    const png = await miniFlowEditor.exportPng();
    return { svg, pngType: png.type, pngSize: png.size, markdown: miniFlowEditor.exportMarkdown() };
  });
  expect(api.svg).toMatch(/^<svg[\s\S]*<\/svg>$/);
  expect(api.svg).toContain('Alpha');
  expect(api.svg).toContain('Beta');
  expect(api.pngType).toBe('image/png');
  expect(api.pngSize).toBeGreaterThan(1000);
  expect(api.markdown).toMatch(/^```mermaid\nflowchart TD\n[\s\S]*A --> B\n[\s\S]*```\n$/);

  await page.evaluate(() => {
    window.copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.copied.push(value); } } });
  });
  await page.getByRole('button', { name: 'Code & export' }).click();
  await page.getByText('Export', { exact: true }).click();
  for (const [name, file] of [['PNG', 'flowchart.png'], ['SVG', 'flowchart.svg'], ['Markdown', 'flowchart.md']]) {
    const group = page.locator('[data-download-group]');
    const download = page.waitForEvent('download');
    await group.getByRole('button', { name, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(file);
  }
  const copy = page.locator('[data-copy-group]');
  await copy.getByRole('button', { name: 'Markdown', exact: true }).click();
  await copy.getByRole('button', { name: 'SVG markup', exact: true }).click();
  await copy.getByRole('button', { name: 'Mermaid', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.copied.length)).toBe(3);
  const [markdown, svg, source] = await page.evaluate(() => window.copied);
  expect(markdown).toBe(api.markdown);
  expect(svg).toContain('<svg');
  expect(source).toContain('%% mini-flow-layout ');
  await expect(status(page)).toHaveText('Copied to clipboard.');
});

test('Copy link and a reload both restore the board', async ({ page, context }) => {
  await setBoard(page, pair, pairPositions);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.copiedLink = value; } } });
  });
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.locator('#save-status')).toHaveText('Link copied.');
  const link = await page.evaluate(() => window.copiedLink);
  expect(link).toMatch(/#flow=/);
  const expected = await project(page);

  const opened = await context.newPage();
  await opened.goto('about:blank');
  await opened.evaluate(() => localStorage.clear()).catch(() => {});
  await opened.goto(link);
  expect(await project(opened)).toEqual(expected);
  await opened.close();

  await page.reload();
  expect(await project(page)).toEqual(expected);
});

test('saves, opens and deletes projects, and autosaves the open one', async ({ page }) => {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const saveAs = page.getByRole('button', { name: '+ Save as Project', exact: true });
  const name = page.getByRole('textbox', { name: 'Project name', exact: true });
  const save = page.getByRole('button', { name: 'Save project', exact: true });
  await saveAs.click();
  await name.fill('First board');
  await save.click();
  await expect(page.getByRole('button', { name: 'Open First board', exact: true })).toBeVisible();
  const first = await project(page);

  // Start blank closes the open project, so loading the next board does not autosave into First board.
  await page.getByRole('button', { name: 'Start blank' }).click();
  await setBoard(page, pair, pairPositions);
  await saveAs.click();
  await name.fill('Second board');
  await save.click();
  await expect(page.getByRole('button', { name: 'Rename Second board', exact: true })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'step: Beta', exact: true }).click();
  await page.getByRole('button', { name: 'step: Beta', exact: true }).press('Backspace');
  await expect.poll(() => mermaid(page)).not.toContain('Beta');
  const edited = await project(page);

  await page.getByRole('button', { name: 'Open First board', exact: true }).click();
  await expect.poll(() => project(page)).toEqual(first);
  await page.getByRole('button', { name: 'Open Second board', exact: true }).click();
  await expect.poll(() => project(page)).toEqual(edited);

  await page.getByRole('button', { name: 'Delete First board', exact: true }).click();
  await expect(page.getByText('Delete “First board”?')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open First board', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete First board', exact: true }).click();
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open First board', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rename Second board', exact: true })).toBeVisible();
});

test('comments on a note, then edits and deletes the comment', async ({ page }) => {
  const source = 'flowchart TD\n    A["Alpha"]\n    %% mini-flow ' + JSON.stringify({ notes: [{ id: 'N1', label: 'Discuss this', target: 'A' }] });
  await setBoard(page, source, { A: [200, 100], N1: [450, 100] });
  await page.getByRole('button', { name: 'note: Discuss this', exact: true }).click();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Comment', exact: true });
  await input.fill('First thought');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  const comments = page.getByRole('list', { name: 'Comments' });
  await expect(comments).toContainText('First thought');
  await expect(input).toHaveValue('');

  await page.getByLabel('Comment actions for You').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('textbox', { name: 'Edit comment' });
  await edit.fill('Second thought');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(comments).toContainText('Second thought');
  await expect(comments).toContainText('Edited');

  await page.getByRole('button', { name: 'Close note conversation' }).click();
  await expect(page.getByRole('button', { name: /Open note conversation: .*1 comment/ })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Open note conversation: .*1 comment/ }).click();
  await expect(comments).toContainText('Second thought');
  await page.getByLabel('Comment actions for You').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.getByRole('button', { name: 'Delete comment', exact: true }).click();
  await expect(comments).not.toContainText('Second thought');
});

test('the laser draws a fading trail without changing the board', async ({ page }) => {
  await setBoard(page, pair, pairPositions);
  const before = await project(page);
  await focusCanvas(page);
  await page.keyboard.press('6');
  await expect(page.getByRole('button', { name: 'Laser' })).toHaveAttribute('aria-pressed', 'true');
  const [x, y] = await canvasPoint(page, 0.6, 0.5);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++) await page.mouse.move(x + step * 15, y + step * 8);
  const marks = page.locator('.laser-mark');
  await expect.poll(() => marks.count()).toBeGreaterThan(0);
  await page.mouse.up();
  await expect(marks).toHaveCount(0, { timeout: 5000 });
  expect(await project(page)).toEqual(before);
  await page.keyboard.press('6');
  await expect(page.getByRole('button', { name: 'Laser' })).toHaveAttribute('aria-pressed', 'false');
});

test('connection diagnostics copy a report without the invite secret', async ({ page }) => {
  await page.goto(site + '?debug=1');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.copiedReport = value; } } });
  });
  await page.getByRole('button', { name: 'Live session', exact: true }).click();
  await page.getByRole('button', { name: 'Start live session' }).click();
  await expect(page.locator('#live-invite')).toHaveValue(/#live=/);
  const invite = await page.locator('#live-invite').inputValue();
  await expect(page.getByText('Connection diagnostics', { exact: true })).toBeVisible();
  await page.getByText('Connection diagnostics', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy diagnostics', exact: true }).click();
  await expect(page.locator('#live-debug-status')).toHaveText('Diagnostics copied.');
  const report = await page.evaluate(() => window.copiedReport);
  expect(() => JSON.parse(report)).not.toThrow();
  const [, room, password] = invite.match(/#live=([a-f0-9]+)\.([a-f0-9]+)/);
  expect(report).not.toContain(password);
  expect(report).not.toContain(room);
  await page.getByRole('button', { name: 'End session' }).click();
});
