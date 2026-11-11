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
