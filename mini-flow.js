/* Tabler Icons license
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
/* Mini Flow — a dependency-free SVG editor for a small Mermaid subset. */
(function () {
  const shapes = {
    terminal: ['([', '])'],
    step: ['[', ']'],
    decision: ['{', '}']
  };
  const encode = value => value.replace(/["#&<>|\\\r\n]/g, char => char === '\n' ? '<br/>' : '#' + char.charCodeAt(0) + ';');
  const decode = value => value.replace(/<br\s*\/?>/gi, '\n').replace(/#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  function parse(source, definitions = shapes) {
    const metadata = source.split(/\r?\n/).find(line => line.trim().startsWith('%% mini-flow '));
    const lines = source.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('%%'));
    if (!/^(?:flowchart|graph) (?:TD|TB)$/.test(lines.shift() || '')) {
      throw new Error('Start with flowchart TD.');
    }
    const nodes = [], edges = [];
    const ids = new Set();
    for (const line of lines) {
      const edge = line.match(/^([A-Za-z][\w-]*)\s*-->\s*(?:\|([^|]*)\|\s*)?([A-Za-z][\w-]*)$/u);
      if (edge) {
        edges.push({ from: edge[1], to: edge[3], label: decode(edge[2] || '') });
        continue;
      }
      const node = line.match(/^([A-Za-z][\w-]*)\s*(.*)$/);
      const type = node && Object.keys(definitions).sort((a, b) => definitions[b][0].length - definitions[a][0].length).find(key => {
        const [open, close] = definitions[key];
        return node[2].startsWith(open) && node[2].endsWith(close);
      });
      if (!type || ids.has(node[1])) throw new Error('Invalid or repeated node: ' + line);
      const [open, close] = definitions[type];
      const label = node[2].slice(open.length, -close.length).replace(/^"(.*)"$/, '$1');
      ids.add(node[1]);
      nodes.push({ id: node[1], type, label: decode(label), x: 300, y: 65 + nodes.length * 115 });
    }
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error('Declare both arrow endpoints.');
    }
    if (metadata) {
      const extras = JSON.parse(metadata.trim().slice('%% mini-flow '.length));
      for (const [index, bend] of extras.bends ?? []) {
        if (edges[index] && Array.isArray(bend) && bend.length === 2 && bend.every(Number.isFinite)) edges[index].bend = bend;
      }
      for (const note of extras.notes ?? []) {
        if (!/^[A-Za-z][\w-]*$/.test(note.id) || ids.has(note.id) || typeof note.label !== 'string') {
          throw new Error('Invalid note.');
        }
        const target = typeof note.target === 'string' && ids.has(note.target) ||
          Number.isInteger(note.target) && edges[note.target] ? note.target : undefined;
        nodes.push({ id: note.id, type: 'note', label: note.label, x: 300, y: 65 + nodes.length * 115, target });
        ids.add(note.id);
      }
    }
    return { nodes, edges };
  }

  function stringify({ nodes, edges }, definitions = shapes) {
    const notes = nodes.filter(node => node.type === 'note').map(({ id, label, target }) => ({ id, label, target }));
    const bends = edges.flatMap((edge, index) => edge.bend ? [[index, edge.bend]] : []);
    const metadata = notes.length || bends.length ? ['    %% mini-flow ' + JSON.stringify({ notes, bends })] : [];
    return ['flowchart TD', ...nodes.filter(node => node.type !== 'note').map(({ id, type, label }) => {
      const [open, close] = definitions[type];
      return '    ' + id + open + '"' + encode(label) + '"' + close;
    }), ...edges.map(({ from, to, label }) =>
      '    ' + from + ' --> ' + (label ? '|' + encode(label) + '| ' : '') + to
    ), ...metadata].join('\n');
  }

  function mount(host, source = 'flowchart TD', positions = {}, { onChange, features = {}, colors = {}, extraShapes = {}, tools, header, onSend, layout = 'classic', settingsKey, snapToGrid = false } = {}) {
    const enabled = name => features[name] !== false;
    const palette = { canvas: '#f7faff', grid: '#c5d4e4', text: '#203044', surface: '#fff',
      stroke: '#536982', accent: '#3965be', terminal: '#dcf4e9', step: '#e4edff', decision: '#fff0c7', ...colors };
    const definitions = { ...shapes };
    for (const [name, shape] of Object.entries(extraShapes)) {
      const syntax = shape.syntax;
      if (!/^[a-z][\w-]*$/i.test(name) || (name === 'note' || name in definitions) ||
          !Array.isArray(syntax) || syntax.length !== 2 ||
          syntax.some(part => typeof part !== 'string' || !/^[()[\]{}]+$/.test(part)) ||
          Object.values(definitions).some(pair => pair[0] === syntax[0] && pair[1] === syntax[1]) ||
          typeof shape.draw !== 'function') throw new Error('Invalid extra shape: ' + name);
      definitions[name] = syntax;
    }
    const parseSource = source => parse(source, definitions);
    const sourceText = () => stringify(graph, definitions);
    let graph = parseSource(source), selected, origin, drag, pendingShape;
    for (const node of graph.nodes) {
      if (Object.hasOwn(positions, node.id)) [node.x, node.y] = positions[node.id];
    }
    const undoStack = [], redoStack = [];
    const snapshot = () => JSON.stringify(graph, (key, value) =>
      key === 'labelX' || key === 'labelY' ? undefined : value);
    let current = snapshot();
    let serial = 1;
    const connectionGeometry = new WeakMap();
    let reconnect;
    let updateTimer;
    let highlighted = new Set();
    let updateMessage;
    function clearUpdate() {
      clearTimeout(updateTimer);
      highlighted.clear();
      if (get('.status').textContent === updateMessage) status('');
      updateMessage = undefined;
    }
    let pan, editing, zoom = 1, cameraX = 0, cameraY = 0;
    const gridSize = 16;
    const root = document.createElement('div');
    for (const key of ['canvas', 'grid', 'text', 'surface', 'stroke', 'accent']) {
      root.style.setProperty('--mf-' + key, palette[key]);
    }
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {display:block;color:var(--mf-text);font:15px system-ui}
        * {box-sizing:border-box}
        :host(.is-dragging), :host(.is-dragging) * {cursor:grabbing!important}
        [hidden] {display:none!important}
        .frame {position:relative;height:var(--mini-flow-height, 72vh);min-height:360px;isolation:isolate}
        @media (max-width: 550px) { .toolbar button {font-size:13px;padding:5px} .toolbar kbd {font-size:10px} .status {font-size:12px} }
        .toolbar {position:absolute;inset:12px 12px auto;z-index:2;width:fit-content;max-width:calc(100% - 24px);margin:auto;border:1px solid #d9e2ec;border-radius:14px;box-shadow:0 4px 20px #20304418;
display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;background:var(--mf-surface);border-bottom:1px solid #d9e2ec}
        button,input,textarea {font:inherit;color:inherit}
        button,input {background:var(--mf-surface);border:1px solid #bdcbd9;border-radius:8px;padding:8px}
        button {cursor:pointer} button[aria-pressed=true]{background:#e0eaff;border-color:#3965be}
        kbd {margin-inline-start:5px;padding:1px 4px;border:1px solid #bdcbd9;border-radius:4px;font:12px ui-monospace,monospace}
        button:disabled {opacity:.45;cursor:default}
        .frame {border:1px solid #bdcbd9;border-radius:12px;overflow:hidden}
        .scroll {position:absolute;inset:0;overflow:hidden;background:var(--mf-canvas) radial-gradient(var(--mf-grid) 1px,transparent 1px) 0 0/16px 16px}
        .scroll > svg {display:block;width:100%;height:100%;cursor:grab;touch-action:none;user-select:none}
        g[role=button] {cursor:pointer}
        g:focus-visible {outline:2px solid var(--mf-accent)}
        text {fill:var(--mf-text);pointer-events:none}
        .panel {position:absolute;inset:auto 12px 50px auto;width:min(350px,calc(100% - 24px));max-height:65%;overflow:auto;background:var(--mf-surface);border:1px solid #d9e2ec;border-radius:14px;box-shadow:0 4px 24px #20304424;z-index:1}
        .inline {position:absolute;z-index:1;transform:translate(-50%,-50%);min-width:48px;min-height:1.2em;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.2;color:var(--mf-text);outline:none;background:transparent}
        .status {position:absolute;inset:auto 12px 8px;pointer-events:none;border-radius:10px;margin:0;padding:8px 12px;background:var(--mf-surface);border-top:1px solid #d9e2ec;min-height:38px}
        .panel > .repo-link {display:block;margin:0 14px;padding:12px 0;color:var(--mf-stroke);
          font-size:12px;text-decoration:none;border-top:1px solid #e7e2dc;width:fit-content}
        .panel > .repo-link:hover {color:var(--mf-accent);text-decoration:underline}
        .panel > .repo-link:focus-visible {outline:2px solid var(--mf-accent);outline-offset:2px}
        .panel details {padding:14px;background:var(--mf-surface)}
        .panel details + details {border-top:1px solid #d9e2ec}
        .header-actions {position:absolute;z-index:2;inset:auto 12px 54px;display:flex;gap:6px;flex-wrap:wrap;pointer-events:none}
        .header-actions button {pointer-events:auto}
        .export-group {margin-top:14px}
        .export-group + .export-group {border-top:1px solid #d9e2ec;padding-top:12px}
        .connection-actions {position:absolute;z-index:1;white-space:nowrap}
        .connection-actions button {min-height:44px;box-shadow:0 2px 8px #20304420}
        .endpoint-handle {position:absolute;z-index:2;width:44px;height:44px;padding:0;transform:translate(-50%,-50%);
          background:transparent;border:0;cursor:grab;touch-action:none}
        .endpoint-handle::after {content:'';display:block;width:13px;height:13px;margin:auto;
          border:2px solid var(--mf-accent);border-radius:50%;background:var(--mf-surface)}
        .endpoint-handle:active {cursor:grabbing}
        .bend-handle {position:absolute;z-index:1;width:44px;height:44px;padding:0;transform:translate(-50%,-50%);background:transparent;border:0;cursor:grab;touch-action:none}
        .bend-handle::after {content:'';display:block;width:14px;height:14px;margin:auto;border:2px solid var(--mf-accent);border-radius:50%;background:var(--mf-surface)}
        .dock-layout {border:0;border-radius:0;background:var(--mf-canvas);--dock-height:64px;--dock-bottom:calc(12px + env(safe-area-inset-bottom, 0px))}
        .dock-layout .toolbar {inset:auto 8px var(--dock-bottom);max-width:calc(100% - 16px);
          justify-content:center;gap:6px;padding:8px;border:1px solid #ded9d2;border-radius:18px;
          box-shadow:0 3px 14px #332c2212}
        .toolbar button, .connection-actions button, .header-actions button {display:inline-flex;align-items:center;gap:7px}
        .toolbar svg, .connection-actions svg, .header-actions svg {width:18px;height:18px;flex:none}
        .dock-layout .toolbar {gap:8px;padding:10px;background:#fcfaf7;box-shadow:0 4px 12px #332c221c}
        .dock-layout .toolbar button {min-height:44px;padding:8px 12px;border-color:#e7e2dc;border-radius:10px;font-weight:550}
        .dock-layout .toolbar button svg {width:22px;height:22px;stroke-width:1.65}
        .dock-layout .toolbar [data-delete]:disabled {display:none}
        .dock-layout .scroll > svg text {font-weight:650}
        .dock-layout .scroll > svg text[data-edge-label] {font-weight:550}
        .dock-layout .toolbar button:hover:not(:disabled) {background:#f5f1eb}
        .dock-layout .toolbar button[aria-pressed=true] {background:#dcf3ed;border-color:var(--mf-accent)}
        .dock-layout button:focus-visible {outline:2px solid var(--mf-accent);outline-offset:2px}
        .dock-layout kbd {background:#fff;color:#5e6562;border-color:#ded9d2}
        .dock-layout .toolbar label {display:flex;align-items:center;gap:7px;padding:0 9px;min-height:44px;
          border-inline-start:1px solid #e7e2dc;white-space:nowrap;font-size:13px}
        .dock-layout .toolbar label input {order:1;appearance:none;position:relative;width:34px;height:20px;
          border-radius:20px;padding:0;background:#d9d6d1;border:1px solid #aaa59e;cursor:pointer}
        .dock-layout .toolbar label input:checked {background:var(--mf-accent);border-color:var(--mf-accent)}
        .dock-layout .toolbar label input::after {content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;
          background:white;border-radius:50%}
        .dock-layout .toolbar label input:checked::after {left:16px}
        .dock-layout .toolbar label input:focus-visible {outline:2px solid var(--mf-accent);outline-offset:2px}
        .dock-layout .toolbar input {accent-color:var(--mf-accent);width:17px;height:17px;margin:0}
        .dock-layout .scroll {bottom:calc(var(--dock-height) + var(--dock-bottom) + 8px)}
        .dock-layout .status {inset:8px auto auto 12px;min-height:0;max-width:calc(100% - 24px);
          padding:6px 9px;border:0;background:var(--mf-canvas);color:var(--mf-stroke);font-size:12px}
        .dock-layout .panel {inset:0 0 calc(var(--dock-height) + var(--dock-bottom) + 8px) auto;
          max-height:none;border-radius:0;border-width:0 0 1px 1px;box-shadow:none;width:min(350px,100%)}
        .dock-layout .connection-actions button {background:#e4f4ee;border-color:#a7cfc4}
        @media (min-width: 850px) {
          .dock-layout:has(.panel:not([hidden])) .scroll {right:350px}
          .dock-layout:has(.panel:not([hidden])) .status {max-width:calc(100% - 374px)}
        }
        @media (max-width: 550px) {
          .dock-layout .toolbar {gap:4px;padding:5px}
          .dock-layout .toolbar button {padding:6px 8px;gap:4px}
          .dock-layout .toolbar button svg {width:16px;height:16px}
          .dock-layout .toolbar kbd {display:none}
          .dock-layout .status {font-size:11px}
        }
        .panel-actions {display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
        .panel textarea {margin:10px 0 0}
        summary {cursor:pointer}
        textarea {background:var(--mf-surface);color:var(--mf-text);color-scheme:light;border:1px solid #bdcbd9;border-radius:8px;padding:10px;display:block;width:100%;min-height:155px;margin:10px 0;font:14px ui-monospace,monospace}
      </style>
      <section class="frame" aria-label="Flowchart editor">
        <div class="toolbar">
          <button aria-keyshortcuts="1" title="Shortcut: 1" data-shape="terminal"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M6 9a6 6 0 0 1 6 -6a6 6 0 0 1 6 6v6a6 6 0 0 1 -6 6a6 6 0 0 1 -6 -6l0 -6" /></svg><span>Start / End</span> <kbd aria-hidden="true">1</kbd></button>
          <button aria-keyshortcuts="2" title="Shortcut: 2" data-shape="step"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10" /></svg><span>Step</span> <kbd aria-hidden="true">2</kbd></button>
          <button aria-keyshortcuts="3" title="Shortcut: 3" data-shape="decision"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M6 5h12l3 5l-8.5 9.5a.7 .7 0 0 1 -1 0l-8.5 -9.5l3 -5" /><path d="M10 12l-2 -2.2l.6 -1" /></svg><span>Decision</span> <kbd aria-hidden="true">3</kbd></button>
          <button aria-keyshortcuts="4" title="Shortcut: 4" data-link aria-pressed="false"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M5 12l14 0" /><path d="M13 18l6 -6" /><path d="M13 6l6 6" /></svg><span>Connect</span> <kbd aria-hidden="true">4</kbd></button>
          <button aria-keyshortcuts="5" title="Shortcut: 5" data-shape="note"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M13 20l7 -7" /><path d="M13 20v-6a1 1 0 0 1 1 -1h6v-7a2 2 0 0 0 -2 -2h-12a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7" /></svg><span>Note</span> <kbd aria-hidden="true">5</kbd></button>
          <label><input type="checkbox" data-snap> <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M4 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M18 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M4 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M18 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /></svg><span>Snap to grid</span></label>
          <button aria-keyshortcuts="Backspace" title="Shortcut: Backspace" data-delete disabled><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg><span>Delete</span> <kbd aria-hidden="true">⌫</kbd></button>
        </div>
        <div class="header-actions">
          <button data-undo disabled><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M9 14l-4 -4l4 -4" /><path d="M5 10h11a4 4 0 1 1 0 8h-1" /></svg><span>Undo</span></button><button data-redo disabled><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M15 14l4 -4l-4 -4" /><path d="M19 10h-11a4 4 0 1 0 0 8h1" /></svg><span>Redo</span></button>
          <button data-panel aria-expanded="false"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M7 8l-4 4l4 4" /><path d="M17 8l4 4l-4 4" /><path d="M14 4l-4 16" /></svg><span>Code &amp; export</span></button><button data-fit><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M4 8v-2a2 2 0 0 1 2 -2h2" /><path d="M4 16v2a2 2 0 0 0 2 2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M16 20h2a2 2 0 0 0 2 -2v-2" /></svg><span>Fit</span></button>
          <button data-send hidden>Send to chat</button>
        </div>
        <div class="scroll"><svg aria-label="Flowchart canvas"></svg>
          <div class="connection-actions" role="group" aria-label="Connection actions" hidden>
            <button data-bend><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M6 6v6a3 3 0 0 0 3 3h10l-4 -4m0 8l4 -4" /></svg><span>Add bend</span></button><button data-straight hidden>Reset bend</button>
          </div>
          <button class="endpoint-handle" data-endpoint="from" aria-label="Reconnect source" hidden></button>
          <button class="endpoint-handle" data-endpoint="to" aria-label="Reconnect destination" hidden></button>
          <button class="bend-handle" aria-label="Move connection bend" title="Drag or use arrow keys" hidden></button>
        </div>
        <p class="status" role="status"></p>
        <aside class="panel" hidden><details data-source open><summary>Mermaid source</summary>
          <textarea aria-label="Mermaid source" spellcheck="false"></textarea>
          <div class="panel-actions"><button data-import>Apply source</button>
          <button data-export>Refresh source</button></div>
        </details>
        <details data-exports><summary>Export</summary>
          <section class="export-group" data-copy-group><strong>Copy</strong>
            <div class="panel-actions"><button data-copy="mermaid">Mermaid</button><button data-copy="png">PNG</button>
            <button data-copy="svg">SVG markup</button><button data-copy="md">Markdown</button></div>
          </section>
          <section class="export-group" data-download-group><strong>Download</strong>
            <div class="panel-actions"><button data-download="png">PNG</button><button data-download="svg">SVG</button>
            <button data-download="md">Markdown</button></div>
          </section>
          <section class="export-group" data-project><strong>Project</strong>
            <div class="panel-actions"><button data-backup>Download project</button><button data-open>Open project</button>
            <input type="file" accept=".json,application/json" hidden></div>
          </section>
        </details></aside>
      </section>`;
    const get = selector => shadow.querySelector(selector);
    const svg = get('.scroll > svg'), area = get('.panel textarea'), viewport = get('.scroll');
    const panel = get('.panel');
    get('[data-panel]').onclick = event => {
      panel.hidden = !panel.hidden;
      event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
    };
    get('[data-fit]').onclick = fit;
    const frame = get('.frame');
    const toolbar = get('.toolbar');
    const dockLayout = layout === 'dock';
    if (dockLayout) frame.classList.add('dock-layout');
    const observer = new ResizeObserver(() => {
      if (dockLayout) frame.style.setProperty('--dock-height', toolbar.offsetHeight + 'px');
      updateCamera();
    });
    if (dockLayout) observer.observe(toolbar);
    observer.observe(viewport);
    function updateCamera() {
      const width = viewport.clientWidth || 1, height = viewport.clientHeight || 1;
      svg.setAttribute('viewBox', [cameraX, cameraY, width / zoom, height / zoom].join(' '));
      viewport.style.backgroundSize = (16 * zoom) + 'px ' + (16 * zoom) + 'px';
      viewport.style.backgroundPosition = (-cameraX * zoom) + 'px ' + (-cameraY * zoom) + 'px';
      positionEditor();
      positionBendControls();
    }
    function fit() {
      const box = svg.getBBox();
      const width = viewport.clientWidth || 1, height = viewport.clientHeight || 1;
      zoom = Math.max(.05, Math.min(1, width / (box.width + 48), height / (box.height + 110)));
      cameraX = box.x + (box.width - width / zoom) / 2;
      cameraY = box.y + (box.height - height / zoom) / 2 - 22 / zoom;
      updateCamera();
    }
    function world(event) {
      const box = svg.getBoundingClientRect();
      return [cameraX + (event.clientX - box.left) / zoom, cameraY + (event.clientY - box.top) / zoom];
    }
    function changed(record = true) {
      const next = snapshot();
      if (enabled('history') && record && next !== current) {
        undoStack.push(current);
        if (undoStack.length > 100) undoStack.shift();
        redoStack.length = 0;
      }
      current = next;
      undoButton.disabled = !undoStack.length;
      redoButton.disabled = !redoStack.length;
      area.value = sourceText();
      onChange?.(area.value, Object.fromEntries(graph.nodes.map(n => [n.id, [n.x, n.y]])));
    }
    function positionEditor() {
      if (!editing) return;
      const { field, item } = editing;
      field.style.fontSize = (item.type ? 15 : 13) * zoom + 'px';
      field.style.width = item.type ? (radius(item) * 1.55 * zoom) + 'px' : 'max-content';
      field.style.maxWidth = viewport.clientWidth + 'px';
      field.style.left = ((item.x ?? item.labelX) - cameraX) * zoom + 'px';
      field.style.top = ((item.y ?? item.labelY) - cameraY) * zoom + 'px';
    }
    function editLabel(item) {
      if (!enabled('edit') || !item) return;
      if (editing) editing.field.blur();
      const field = document.createElement('div');
      field.contentEditable = 'plaintext-only';
      field.setAttribute('role', 'textbox');
      field.setAttribute('aria-multiline', 'true');
      field.className = 'inline';
      field.setAttribute('aria-label', 'Edit diagram label. Enter to save, Shift+Enter for a new line.');
      const originalLabel = item.label;
      field.textContent = originalLabel;
      editing = { field, item };
      viewport.append(field);
      positionEditor();
      function updateLabel() {
        item.label = (field.childElementCount ? field.innerText : field.textContent).replace(/\r/g, '');
        area.value = sourceText();
        render();
        positionEditor();
      }
      field.addEventListener('input', updateLabel);
      field.addEventListener('blur', () => {
        editing = undefined;
        field.remove();
        changed();
        // Keep the current pointer target alive until its click has completed.
        requestAnimationFrame(() => { if (!drag && !pan) render(); });
      }, { once: true });
      field.addEventListener('keydown', event => {
        if (event.isComposing) return;
        const saveLabel = event.key === 'Enter' && !event.shiftKey;
        if (event.key === 'Enter' && !saveLabel && !event.metaKey && !event.ctrlKey) {
          // Let the browser maintain its trailing line placeholder and caret.
          if (document.execCommand('insertLineBreak')) {
            event.preventDefault();
            updateLabel();
          }
          return;
        }
        if (saveLabel || event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') item.label = originalLabel;
          field.blur();
          root.focus({ preventScroll: true });
        }
      });
      render();
      field.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(field);
      const selection = shadow.getSelection?.() || window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const connect = get('[data-link]'), remove = get('[data-delete]');
    const snap = get('[data-snap]');
    snap.checked = Boolean(snapToGrid);
    if (settingsKey) {
      try {
        const saved = localStorage.getItem(settingsKey + ':snap');
        if (saved === 'true' || saved === 'false') snap.checked = saved === 'true';
      } catch {}
      snap.addEventListener('change', () => {
        try { localStorage.setItem(settingsKey + ':snap', String(snap.checked)); } catch {}
      });
    }
    const undoButton = get('[data-undo]'), redoButton = get('[data-redo]');
    const controls = { connect, delete: remove, history: undoButton, fit: get('[data-fit]'),
      snap: snap.parentElement, source: get('[data-source]'), exports: get('[data-exports]'), project: get('[data-project]') };
    for (const [feature, control] of Object.entries(controls)) control.hidden = !enabled(feature);
    redoButton.hidden = !enabled('history');
    get('[data-panel]').hidden = !enabled('source') && !enabled('exports') && !enabled('project');
    if (!enabled('exports') && enabled('project')) {
      controls.exports.hidden = false;
      for (const row of controls.exports.querySelectorAll('[data-copy-group], [data-download-group]')) row.hidden = true;
    }
    const bendButton = get('[data-bend]'), resetBend = get('[data-straight]');
    const connectionActions = get('.connection-actions'), bendHandle = get('.bend-handle');
    let bending, bendDrag;
    function positionBendControls() {
      positionEndpoints();
      const edge = selected;
      const show = !reconnect && enabled('bend') && edge && !edge.type && !edge.attachment && !editing &&
        !pendingShape && !bending && connect.getAttribute('aria-pressed') === 'false';
      if (!show) {
        connectionActions.hidden = bendHandle.hidden = true;
        return;
      }
      const [x, y] = edge.bend ?? [edge.labelX, edge.labelY];
      const left = (x - cameraX) * zoom, top = (y - cameraY) * zoom;
      if (!bendDrag && (left < 0 || top < 0 || left > viewport.clientWidth || top > viewport.clientHeight)) {
        connectionActions.hidden = bendHandle.hidden = true;
        return;
      }
      bendHandle.hidden = !edge.bend;
      bendHandle.style.left = left + 'px';
      bendHandle.style.top = top + 'px';
      connectionActions.hidden = Boolean(bendDrag);
      if (bendDrag) return;
      bendButton.hidden = Boolean(edge.bend);
      resetBend.hidden = !edge.bend;
      const right = left + 28;
      const maxLeft = viewport.clientWidth - connectionActions.offsetWidth - 8;
      const maxTop = viewport.clientHeight - connectionActions.offsetHeight - 8;
      connectionActions.style.left = Math.max(8, right <= maxLeft ? right : left - connectionActions.offsetWidth - 28) + 'px';
      connectionActions.style.top = Math.max(8, Math.min(maxTop, top + 18)) + 'px';
    }
    const endpointHandles = [...shadow.querySelectorAll('[data-endpoint]')];
    function positionEndpoints() {
      const item = reconnect?.item ?? selected;
      const show = enabled('reconnect') && enabled('connect') && item && !item.type &&
        !editing && !pendingShape && !bending && !bendDrag &&
        connect.getAttribute('aria-pressed') === 'false';
      for (const handle of endpointHandles) {
        const side = handle.dataset.endpoint;
        const point = reconnect?.side === side ? reconnect.pointer : connectionGeometry.get(item)?.[side];
        handle.hidden = !show || !point || Boolean(item?.attachment && side === 'from');
        if (handle.hidden) continue;
        const x = (point[0] - cameraX) * zoom, y = (point[1] - cameraY) * zoom;
        handle.style.left = x + 'px';
        handle.style.top = y + 'px';
      }
    }
    function findReconnectTarget(pointer) {
      const [x, y] = pointer;
      const nodes = graph.nodes.filter(node => node.type !== 'note').reverse();
      const node = nodes.find(node => {
        const dx = Math.abs(x - node.x), dy = Math.abs(y - node.y);
        const padding = 10 / zoom;
        return node.type === 'decision'
          ? dx / (radius(node) + padding) + dy / (height(node) + padding) <= 1
          : dx <= radius(node) + padding && dy <= height(node) + padding;
      });
      if (node || !reconnect.item.attachment) return node;
      for (const edge of graph.edges) {
        const path = connectionGeometry.get(edge)?.hitPath;
        if (path?.isPointInStroke(new DOMPoint(x, y))) return edge;
      }
    }
    function finishReconnect(commit) {
      if (!reconnect) return;
      const { item, side, candidate } = reconnect;
      const handle = endpointHandles.find(handle => handle.dataset.endpoint === side);
      const pointerId = reconnect.id;
      reconnect = undefined;
      root.classList.remove('is-dragging');
      if (commit && candidate) {
        if (item.attachment) item.attachment.target = candidate.type ? candidate.id : graph.edges.indexOf(candidate);
        else item[side] = candidate.id;
        changed();
        status('Connection updated.');
      } else {
        status('Reconnection canceled.');
      }
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      render();
      root.focus({ preventScroll: true });
    }
    for (const handle of endpointHandles) {
      handle.onpointerdown = event => {
        if (event.button !== 0 || !selected || selected.type || reconnect) return;
        event.preventDefault();
        root.classList.add('is-dragging');
        reconnect = { id: event.pointerId, item: selected, side: handle.dataset.endpoint,
          pointer: world(event), candidate: undefined };
        handle.setPointerCapture(event.pointerId);
        status('Drag onto a block to reconnect. Drop elsewhere to cancel.');
        render();
      };
      handle.onpointermove = event => {
        if (reconnect?.id !== event.pointerId) return;
        reconnect.pointer = world(event);
        reconnect.candidate = findReconnectTarget(reconnect.pointer);
        render();
      };
      handle.onpointerup = event => {
        if (reconnect?.id !== event.pointerId) return;
        reconnect.pointer = world(event);
        reconnect.candidate = findReconnectTarget(reconnect.pointer);
        finishReconnect(true);
      };
      handle.onpointercancel = event => {
        if (reconnect?.id === event.pointerId) finishReconnect(false);
      };
      handle.onlostpointercapture = event => {
        if (reconnect?.id === event.pointerId) finishReconnect(false);
      };
    }
    bendHandle.onpointerdown = event => {
      if (event.button !== 0 || !selected?.bend || bendDrag) return;
      bendHandle.focus({ preventScroll: true });
      bendDrag = { id: event.pointerId, edge: selected, start: selected.bend, pointer: world(event) };
      bendHandle.setPointerCapture(event.pointerId);
      bendHandle.style.cursor = 'grabbing';
      root.classList.add('is-dragging');
      positionBendControls();
    };
    bendHandle.onpointermove = event => {
      if (bendDrag?.id !== event.pointerId) return;
      const pointer = world(event);
      bendDrag.edge.bend = bendDrag.start.map((value, i) => coordinate(value + pointer[i] - bendDrag.pointer[i]));
      render();
    };
    bendHandle.onlostpointercapture = event => {
      if (bendDrag?.id !== event.pointerId) return;
      bendDrag = undefined;
      bendHandle.style.cursor = '';
      root.classList.remove('is-dragging');
      changed();
      render();
    };
    bendHandle.onpointercancel = event => {
      if (bendDrag?.id !== event.pointerId) return;
      if (bendDrag.original) bendDrag.edge.bend = bendDrag.original;
      else if (bendDrag.created) delete bendDrag.edge.bend;
      else bendDrag.edge.bend = bendDrag.start;
      bendDrag = undefined;
      bendHandle.style.cursor = '';
      render();
    };
    bendHandle.onkeydown = event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!Object.hasOwn(directions, event.key) || !selected?.bend) return;
      event.preventDefault();
      const direction = directions[event.key];
      selected.bend = selected.bend.map((value, i) => coordinate(value + direction[i] * (snap.checked ? gridSize : 4)));
      changed();
      render();
    };
    bendButton.onclick = () => {
      if (!selected || selected.type) return;
      chooseShape(undefined);
      origin = undefined;
      connect.setAttribute('aria-pressed', 'false');
      bending = selected;
      svg.style.cursor = 'crosshair';
      root.focus({ preventScroll: true });
      positionBendControls();
      status('Click or tap the canvas to place the bend.');
    };
    resetBend.onclick = () => {
      delete selected.bend;
      root.focus({ preventScroll: true });
      chooseShape(undefined);
      select(selected);
      changed();
      render(selected);
    };
    const send = get('[data-send]');
    send.hidden = typeof onSend !== 'function';
    send.disabled = typeof onSend !== 'function';
    send.onclick = async () => {
      try {
        editing?.field.blur();
        const item = selected?.attachment ?? selected;
        const selection = item?.type ? { id: item.id, type: item.type, label: item.label }
          : selected ? { edge: graph.edges.indexOf(selected), from: selected.from, to: selected.to, label: selected.label } : null;
        await onSend({ project: getProject(), selection });
        status('Sent to chat.');
      } catch (error) { status(error.message || 'Could not send to chat.'); }
    };
    const file = get('input[type=file]');
    get('[data-backup]').onclick = () => download(new Blob([JSON.stringify(getProject(), null, 2)],
      { type: 'application/json' }), 'json');
    get('[data-open]').onclick = () => file.click();
    file.onchange = async () => {
      const selectedFile = file.files[0];
      file.value = '';
      if (!selectedFile) return;
      try {
        setProject(JSON.parse(await selectedFile.text()));
        status('Project opened.');
      } catch (error) { status(error.message); }
    };
    const coordinate = value => snap.checked ? Math.round(value / gridSize) * gridSize : value;
    const status = value => { get('.status').textContent = value; };
    const element = (tag, attrs, content) => {
      const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value);
      if (content !== undefined) child.textContent = content;
      return child;
    };
    const radius = node => Math.max(66, ...node.label.split('\n').map(line => line.length * 5 + 25));
    const height = node => (node.type === 'decision' ? 39 : 25) + (node.label.split('\n').length - 1) * 11;
    function labelText(attrs, value) {
      const label = element('text', { 'dominant-baseline': 'central', ...attrs });
      const lines = value.split('\n');
      lines.forEach((line, index) => label.append(element('tspan', {
        x: attrs.x ?? 0, y: (attrs.y ?? 0) + (index - (lines.length - 1) / 2) * 18
      }, line)));
      return label;
    }
    const point = (node, dx, dy) => {
      const w = radius(node), h = height(node);
      const scale = node.type === 'decision'
        ? Math.abs(dx / w) + Math.abs(dy / h)
        : Math.max(Math.abs(dx / w), Math.abs(dy / h));
      return scale ? [node.x + dx / scale, node.y + dy / scale] : [node.x + w, node.y];
    };
    function select(item) {
      selected = item;
      remove.disabled = !item;
    }
    function render(focus) {
      svg.replaceChildren();
      const defs = element('defs', {});
      for (const [id, color] of [['arrow', palette.stroke], ['active', palette.accent]]) {
        const marker = element('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto' });
        marker.append(element('path', { d: 'M0 0 L10 5 L0 10Z', fill: color }));
        defs.append(marker);
      }
      svg.append(defs);
      const byId = new Map(graph.nodes.map(node => [node.id, node]));
      for (const edge of graph.edges) {
        const a = byId.get(edge.from), b = byId.get(edge.to);
        let start, end, d, x, y;
        if (edge.bend) {
          const [bx, by] = edge.bend;
          start = point(a, bx - a.x, by - a.y);
          end = point(b, bx - b.x, by - b.y);
          d = 'M' + start + ' L' + edge.bend + ' L' + end;
          x = bx + 10;
          y = by - 10;
        } else if (b.y <= a.y && Math.abs(a.x - b.x) < 40) {
          const lane = Math.max(a.x + radius(a), b.x + radius(b)) + 52;
          start = [a.x + radius(a), a.y];
          end = [b.x + radius(b), b.y + (a === b ? 16 : 0)];
          if (a === b) {
            start = point(a, 1, -.35);
            end = point(b, 1, .35);
          }
          d = 'M' + start + ' C' + [lane + 32, start[1], lane + 32, end[1], ...end].join(' ');
          x = lane + 14;
          y = (start[1] + end[1]) / 2 - 9;
        } else {
          start = point(a, b.x - a.x, b.y - a.y);
          end = point(b, a.x - b.x, a.y - b.y);
          const dx = b.x - a.x, dy = b.y - a.y;
          const length = Math.hypot(dx, dy);
          const offset = graph.edges.some(other => other.from === edge.to && other.to === edge.from) ? 55 : 0;
          const mx = (start[0] + end[0]) / 2;
          const my = (start[1] + end[1]) / 2;
          const ox = -dy / length * offset, oy = dx / length * offset;
          d = 'M' + start + ' Q' + [mx + ox, my + oy, ...end].join(' ');
          x = mx + (offset ? ox * .7 : 17);
          y = my + oy * .7;
          if (!offset && Math.abs(dy) < 12) { x = mx; y -= 9; }
        }
        edge.labelX = x;
        edge.labelY = y;
        if (reconnect?.item === edge) {
          if (reconnect.side === 'from') start = reconnect.pointer;
          else end = reconnect.pointer;
          d = edge.bend ? 'M' + start + ' L' + edge.bend + ' L' + end : 'M' + start + ' L' + end;
          x = (start[0] + end[0]) / 2;
          y = (start[1] + end[1]) / 2 - 10;
        }
        const active = selected === edge || reconnect?.candidate === edge;
        const group = itemGroup(edge, 'Arrow from ' + a.label + ' to ' + b.label);
        const visibility = editing?.item === edge ? 'hidden' : 'visible';
        const label = labelText({ x, y, 'text-anchor': 'middle', 'font-size': 13, 'data-edge-label': '',
          visibility, stroke: dockLayout ? 'none' : palette.canvas, 'stroke-width': 5,
          'paint-order': 'stroke' }, edge.label);
        group.append(element('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 22 }),
          element('path', { d, fill: 'none', stroke: active ? palette.accent : palette.stroke, 'stroke-width': 2,
            'marker-end': active ? 'url(#active)' : 'url(#arrow)' }),
          label);
        if (highlighted.has(edge)) {
          group.prepend(element('path', { d, fill: 'none', stroke: palette.accent, 'stroke-width': 8,
            opacity: .25, 'pointer-events': 'none', 'data-update-highlight': '' }));
        }
        svg.append(group);
        connectionGeometry.set(edge, { from: start, to: end, hitPath: group.querySelector('path[stroke="transparent"]') });
        if (dockLayout && edge.label.trim()) {
          const box = label.getBBox();
          group.insertBefore(element('rect', {
            x: box.x - 6, y: box.y - 3, width: box.width + 12, height: box.height + 6,
            rx: 6, fill: '#eee9e3', visibility, 'data-edge-badge': ''
          }), label);
        }
        if (focus === edge) group.focus();
      }
      for (const note of graph.nodes.filter(node => node.type === 'note' && node.target !== undefined)) {
        const target = typeof note.target === 'string' ? byId.get(note.target) : graph.edges[note.target];
        if (!target) continue;
        const [x, y] = target.type
          ? point(target, note.x - target.x, note.y - target.y) : [target.labelX, target.labelY];
        const [startX, startY] = point(note, x - note.x, y - note.y);
        const attachment = selected?.attachment === note ? selected : { attachment: note };
        const group = element('g', { role: 'button', tabindex: 0,
          'aria-label': 'Attachment for ' + note.label });
        const destination = reconnect?.item === attachment ? reconnect.pointer : [x, y];
        connectionGeometry.set(attachment, { from: [startX, startY], to: destination });
        const coords = { x1: startX, y1: startY, x2: destination[0], y2: destination[1] };
        group.append(
          element('line', { ...coords, stroke: 'transparent', 'stroke-width': 20,
            'pointer-events': connect.getAttribute('aria-pressed') === 'true' ? 'none' : 'stroke' }),
          element('line', { ...coords, stroke: selected === attachment ? palette.accent : palette.stroke,
            'stroke-width': 2, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round', 'pointer-events': 'none' })
        );
        const activate = () => {
          if (pendingShape || bending || connect.getAttribute('aria-pressed') === 'true') return;
          select(attachment);
          render(attachment);
        };
        group.addEventListener('click', activate);
        group.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activate();
        });
        svg.append(group);
        if (focus === attachment) group.focus({ preventScroll: true });
      }
      for (const node of graph.nodes) {
        const group = itemGroup(node, node.type + ': ' + node.label);
        group.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
        const w = radius(node), h = height(node);
        const paint = {
          fill: palette[node.type] ?? (node.type === 'note' ? '#fff4ae' : palette.step),
          stroke: selected === node || origin === node || reconnect?.candidate === node ? palette.accent : palette.stroke,
          'stroke-width': selected === node || origin === node ? 3 : 1.5
        };
        if (highlighted.has(node)) {
          group.append(element('rect', { x: -w - 6, y: -h - 6, width: w * 2 + 12, height: h * 2 + 12,
            rx: 8, fill: 'none', stroke: palette.accent, 'stroke-width': 3, opacity: .7,
            'pointer-events': 'none', 'data-update-highlight': '' }));
        }
        const custom = Object.hasOwn(extraShapes, node.type) ? extraShapes[node.type] : undefined;
        group.append(custom ? custom.draw({ element, node: { ...node }, width: w * 2, height: h * 2, paint })
          : node.type === 'decision'
          ? element('polygon', { points: '0,' + -h + ' ' + w + ',0 0,' + h + ' ' + -w + ',0', ...paint })
          : element('rect', { x: -w, y: -h, width: 2*w, height: 2*h, rx: node.type === 'terminal' ? h : 4, ...paint }),
          labelText({ 'text-anchor': 'middle', visibility: editing?.item === node ? 'hidden' : 'visible' }, node.label));
        if (connect.getAttribute('aria-pressed') === 'false') {
          group.addEventListener('pointerdown', event => {
            if (event.button !== 0 || pendingShape || bending || !enabled('move')) return;
            event.preventDefault();
            select(node);
            root.classList.add('is-dragging');
            drag = { pointerId: event.pointerId, node, x: node.x, y: node.y, clientX: event.clientX, clientY: event.clientY };
            svg.setPointerCapture(event.pointerId);
            group.focus({ preventScroll: true });
          });
        }
        svg.append(group);
        if (focus === node) group.focus();
      }
      positionBendControls();
    }
    let lastClick;
    function selectLabel(item) {
      const now = performance.now();
      const doubleClick = lastClick?.item === item && now - lastClick.time < 400;
      lastClick = doubleClick ? undefined : { item, time: now };
      render(item);
      if (doubleClick) editLabel(item);
    }
    function itemGroup(item, label) {
      const group = element('g', { role: 'button', tabindex: 0, 'aria-label': label });
      const activate = () => {
        if (pendingShape || bending) return;
        if (connect.getAttribute('aria-pressed') === 'true' && (item.type || origin?.type === 'note')) {
          if (!origin) {
            origin = item;
            status(item.type === 'note' ? 'Choose a block or arrow to attach the note.' : 'Choose the destination shape.');
          } else if (origin.type === 'note' || item.type === 'note') {
            const note = origin.type === 'note' ? origin : item;
            const target = note === origin ? item : origin;
            if (target.type === 'note') return;
            note.target = target.type ? target.id : graph.edges.indexOf(target);
            item = note;
            connect.setAttribute('aria-pressed', 'false');
            origin = undefined;
            changed();
            status('Note attached.');
          } else {
            item = { from: origin.id, to: item.id, label: '' };
            graph.edges.push(item);
            connect.setAttribute('aria-pressed', 'false');
            origin = undefined;
            changed();
            status('Arrow added. Double-click to edit its label.');
          }
        }
        select(item);
        if (origin) render(item);
        else selectLabel(item);
      };
      group.addEventListener('click', activate);
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (connect.getAttribute('aria-pressed') === 'false') editLabel(item);
          else activate();
        }
      });
      return group;
    }
    const touches = new Map();
    const pinched = new Set();
    let pinch;
    function touchGeometry() {
      const [a, b] = touches.values();
      return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2,
        distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) };
    }
    svg.addEventListener('pointerdown', event => {
      if (!bending || event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const edge = bending;
      const original = edge.bend;
      edge.bend = world(event).map(coordinate);
      chooseShape(undefined);
      select(edge);
      render();
      bendHandle.onpointerdown(event);
      bendDrag.original = original;
      bendDrag.created = !original;
      status('Drag to position the bend, then release to save.');
    }, true);
    svg.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' || !enabled('zoom')) return;
      pinched.delete(event.pointerId);
      touches.set(event.pointerId, event);
      if (touches.size < 2) return;
      event.stopPropagation();
      if (drag?.moved) changed();
      drag = pan = undefined;
      root.classList.remove('is-dragging');
      for (const id of touches.keys()) {
        pinched.add(id);
        svg.setPointerCapture(id);
      }
      const geometry = touchGeometry();
      pinch = { ...geometry, anchor: world(geometry), zoom };
      render();
    }, true);
    function endTouch(event) {
      if (!touches.delete(event.pointerId)) return;
      pinch = undefined;
      if (touches.size >= 2) {
        const geometry = touchGeometry();
        pinch = { ...geometry, anchor: world(geometry), zoom };
      }
    }
    svg.addEventListener('pointerup', endTouch);
    svg.addEventListener('pointercancel', endTouch);
    svg.addEventListener('click', event => {
      if (pinched.has(event.pointerId)) event.stopImmediatePropagation();
    }, true);
    svg.addEventListener('wheel', event => {
      if (!enabled('zoom')) return;
      event.preventDefault();
      if (drag || pan || bendDrag || reconnect) return;
      const [x, y] = world(event);
      const oldZoom = zoom;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      zoom = Math.min(5, Math.max(.05, zoom * Math.exp(-delta * .002)));
      cameraX = x - (x - cameraX) * oldZoom / zoom;
      cameraY = y - (y - cameraY) * oldZoom / zoom;
      updateCamera();
    }, { passive: false });
    svg.addEventListener('pointermove', event => {
      if (touches.has(event.pointerId)) touches.set(event.pointerId, event);
      if (pinch && touches.has(event.pointerId)) {
        const geometry = touchGeometry();
        const bounds = svg.getBoundingClientRect();
        zoom = Math.min(5, Math.max(.05, pinch.zoom * geometry.distance / pinch.distance));
        cameraX = pinch.anchor[0] - (geometry.clientX - bounds.left) / zoom;
        cameraY = pinch.anchor[1] - (geometry.clientY - bounds.top) / zoom;
        updateCamera();
        return;
      }
      const gesture = drag || pan;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = (event.clientX - gesture.clientX) / zoom;
      const dy = (event.clientY - gesture.clientY) / zoom;
      if (!gesture.moved && Math.hypot(dx, dy) * zoom < 4) return;
      gesture.moved = true;
      if (drag) {
        drag.node.x = coordinate(drag.x + dx);
        drag.node.y = coordinate(drag.y + dy);
        render();
      } else {
        cameraX = pan.x - dx;
        cameraY = pan.y - dy;
        updateCamera();
      }
    });
    svg.addEventListener('lostpointercapture', event => {
      root.classList.remove('is-dragging');
      if (pinched.has(event.pointerId)) return;
      const completed = drag;
      drag = pan = undefined;
      if (!completed) { render(); return; }
      if (completed.moved) {
        changed();
        render(completed.node);
      } else {
        selectLabel(completed.node);
      }
    });
    for (const [type, shape] of Object.entries(extraShapes)) {
      const button = document.createElement('button');
      button.dataset.shape = type;
      button.textContent = shape.label ?? type;
      connect.before(button);
    }
    const shapeButtons = [...shadow.querySelectorAll('[data-shape]')];
    for (const button of shapeButtons) button.hidden = !enabled('create') || Boolean(tools && !tools.includes(button.dataset.shape)) ||
      (button.dataset.shape === 'note' && !enabled('notes'));
    function chooseShape(button) {
      bending = undefined;
      pendingShape = button;
      for (const candidate of shapeButtons) {
        candidate.setAttribute('aria-pressed', String(candidate === button));
      }
      svg.style.cursor = button ? 'crosshair' : '';
    }
    function addShape(button, x, y) {
      const type = button.dataset.shape;
      let id;
      do { id = 'N' + serial++; } while (graph.nodes.some(node => node.id === id));
      const node = { id, type, label: type === 'terminal' ? 'Start' : type === 'step' ? 'Step' : type === 'decision' ? 'Decision' : type === 'note' ? 'Note' : extraShapes[type].label ?? type, x, y };
      node.x = coordinate(node.x);
      node.y = coordinate(node.y);
      graph.nodes.push(node);
      chooseShape(undefined);
      select(node);
      render(node);
      changed();
      editLabel(node);
      status('Shape added. Type its label or choose another tool.');
    }
    chooseShape(undefined);
    for (const button of shapeButtons) {
      button.onclick = event => {
        if (event.detail === 0) {
          addShape(button, 300, Math.max(65, ...graph.nodes.map(node => node.y + 115)));
          return;
        }
        const next = pendingShape === button ? undefined : button;
        origin = undefined;
        connect.setAttribute('aria-pressed', 'false');
        chooseShape(next);
        status(next ? 'Click an empty spot to place the shape.' : 'Placement canceled.');
        render();
      };
    }
    svg.addEventListener('click', event => {
      if (!pendingShape || event.target !== svg) return;
      addShape(pendingShape, ...world(event));
    });
    root.tabIndex = 0;
    svg.addEventListener('pointerdown', event => {
      if (event.target !== svg || event.button !== 0) return;
      root.focus({ preventScroll: true });
      if (pendingShape || bending || drag || pan) return;
      if (selected && connect.getAttribute('aria-pressed') === 'false') {
        select(undefined);
        render();
      }
      if (!enabled('pan')) return;
      root.classList.add('is-dragging');
      pan = { pointerId: event.pointerId, x: cameraX, y: cameraY, clientX: event.clientX, clientY: event.clientY };
      svg.setPointerCapture(event.pointerId);
    });
    function replay(from, to, message) {
      if (!from.length || drag || pan || bendDrag || reconnect) return;
      clearUpdate();
      to.push(current);
      graph = JSON.parse(from.pop());
      chooseShape(undefined);
      origin = undefined;
      connect.setAttribute('aria-pressed', 'false');
      select(undefined);
      changed(false);
      render();
      root.focus({ preventScroll: true });
      status(message);
    }
    const undo = () => replay(undoStack, redoStack, 'Edit undone.');
    const redo = () => replay(redoStack, undoStack, 'Edit redone.');
    undoButton.onclick = undo;
    redoButton.onclick = redo;
    root.addEventListener('keydown', event => {
      if (!enabled('shortcuts')) return;
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey ||
          event.composedPath().some(target => target.matches?.('input, textarea, select, [contenteditable]'))) return;
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault();
        if (key === 'y' || event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.shiftKey) return;
      const commands = { '1': shapeButtons[0], '2': shapeButtons[1],
        '3': shapeButtons[2], '4': connect, '5': get('[data-shape="note"]'), Backspace: remove };
      const command = commands[event.key];
      if (!Object.hasOwn(commands, event.key)) return;
      event.preventDefault();
      if (command.disabled || command.hidden) return;
      command.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    });
    function cancelTool(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      if (reconnect) finishReconnect(false);
      chooseShape(undefined);
      origin = undefined;
      connect.setAttribute('aria-pressed', 'false');
      status('Tool canceled.');
      render();
      root.focus({ preventScroll: true });
    }
    root.addEventListener('keydown', cancelTool);
    connect.onclick = () => {
      chooseShape(undefined);
      const enabled = connect.getAttribute('aria-pressed') === 'false';
      connect.setAttribute('aria-pressed', String(enabled));
      origin = undefined;
      status(enabled ? 'Choose the source shape.' : 'Connect mode off.');
      render();
    };
    remove.onclick = () => {
      if (!selected) return;
      if (selected.attachment) {
        delete selected.attachment.target;
        select(undefined);
        changed();
        render();
        root.focus({ preventScroll: true });
        status('Note detached.');
        return;
      }
      const oldEdges = graph.edges;
      chooseShape(undefined);
      graph.nodes = graph.nodes.filter(node => node !== selected);
      graph.edges = graph.edges.filter(edge => edge !== selected && edge.from !== selected.id && edge.to !== selected.id);
      for (const note of graph.nodes) {
        if (Number.isInteger(note.target)) {
          const index = graph.edges.indexOf(oldEdges[note.target]);
          note.target = index < 0 ? undefined : index;
        } else if (note.target === selected.id) {
          delete note.target;
        }
      }
      if (origin === selected) origin = undefined;
      select(undefined);
      render();
      changed();
      status('Selection deleted.');
    };
    function setMermaid(value, options = {}) {
      const next = parseSource(value);
      const previous = new Map(graph.nodes.map(node => [node.id, node]));
      let nextY = Math.max(-50, ...graph.nodes.map(node => node.y)) + 115;
      for (const node of next.nodes) {
        const existing = previous.get(node.id);
        if (existing) {
          node.x = existing.x;
          node.y = existing.y;
        } else if (graph.nodes.length) {
          node.y = nextY;
          nextY += 115;
        }
      }
      replaceGraph(next, options);
    }
    function getProject() {
      return { version: 1, source: sourceText(), positions: Object.fromEntries(graph.nodes.map(n => [n.id, [n.x, n.y]])) };
    }
    function setProject(project, options = {}) {
      if (project?.version !== 1 || typeof project.source !== 'string' || !project.positions) {
        throw new Error('Invalid Mini Flow project.');
      }
      const next = parseSource(project.source);
      for (const node of next.nodes) {
        const pair = project.positions[node.id];
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)) {
          throw new Error('Invalid position for ' + node.id);
        }
        [node.x, node.y] = pair;
      }
      replaceGraph(next);
      fit();
    }
    function replaceGraph(next, options = {}) {
      if (reconnect) finishReconnect(false);
      editing?.field.blur();
      clearUpdate();
      const previousNodes = new Map(graph.nodes.map(node => [node.id, node]));
      const previousEdges = new Map();
      for (const edge of graph.edges) {
        const key = JSON.stringify([edge.from, edge.to]);
        if (!previousEdges.has(key)) previousEdges.set(key, []);
        previousEdges.get(key).push(edge);
      }
      let added = 0, updated = 0;
      const moved = new Set();
      for (const node of next.nodes) {
        const previous = previousNodes.get(node.id);
        if (!previous) { highlighted.add(node); added++; }
        else if (['type', 'label', 'x', 'y', 'target'].some(key => previous[key] !== node[key])) {
          highlighted.add(node);
          updated++;
          if (previous.x !== node.x || previous.y !== node.y) moved.add(node.id);
        }
      }
      const nodeIds = new Set(next.nodes.map(node => node.id));
      let removed = graph.nodes.filter(node => !nodeIds.has(node.id)).length;
      for (const edge of next.edges) {
        const previous = previousEdges.get(JSON.stringify([edge.from, edge.to]))?.shift();
        if (!previous) { highlighted.add(edge); added++; }
        else if (previous.label !== edge.label || JSON.stringify(previous.bend) !== JSON.stringify(edge.bend) ||
            moved.has(edge.from) || moved.has(edge.to)) {
          highlighted.add(edge);
          updated++;
        }
      }
      for (const remaining of previousEdges.values()) removed += remaining.length;
      const wasEmpty = !graph.nodes.length;
      graph = next;
      chooseShape(undefined);
      origin = undefined;
      connect.setAttribute('aria-pressed', 'false');
      select(undefined);
      changed();
      render();
      if (wasEmpty && graph.nodes.length) fit();
      root.focus({ preventScroll: true });
      const total = added + updated + removed;
      if (total && options.highlight !== false && enabled('updateFeedback')) {
        const counts = [[added, 'added'], [updated, 'updated'], [removed, 'removed']]
          .filter(([count]) => count).map(([count, label]) => count + ' ' + label).join(', ');
        updateMessage = typeof options.message === 'string' && options.message.trim()
          ? options.message : 'Diagram updated. ' + counts + '.';
        status(updateMessage);
        updateTimer = setTimeout(() => {
          clearUpdate();
          render();
        }, 3000);
      } else {
        highlighted.clear();
        render();
      }
    }
    get('[data-import]').onclick = () => {
      try { setMermaid(area.value, { highlight: false }); status('Mermaid source applied.'); }
      catch (error) { status(error.message); }
    };
    get('[data-export]').onclick = () => {
      area.value = sourceText();
      area.focus();
      area.select();
      status('Mermaid source refreshed and selected.');
    };
    function exportSvg() {
      const copy = svg.cloneNode(true);
      for (const highlight of copy.querySelectorAll('[data-update-highlight]')) highlight.remove();
      const box = svg.getBBox();
      const width = Math.ceil(box.width + 48), height = Math.ceil(box.height + 48);
      copy.setAttribute('width', width);
      copy.setAttribute('height', height);
      copy.setAttribute('viewBox', [box.x - 24, box.y - 24, width, height].join(' '));
      copy.setAttribute('font-family', 'system-ui, sans-serif');
      copy.setAttribute('font-size', '15');
      if (dockLayout) copy.setAttribute('font-weight', '650');
      copy.setAttribute('fill', palette.text);
      for (const label of copy.querySelectorAll('text, [data-edge-badge]')) label.removeAttribute('visibility');
      for (const group of copy.querySelectorAll('[role="button"]')) {
        group.removeAttribute('tabindex');
        group.removeAttribute('role');
      }
      for (const shape of Array.from(copy.querySelectorAll('[stroke]')).filter(shape => shape.getAttribute('stroke') === palette.accent)) {
        shape.setAttribute('stroke', palette.stroke);
        shape.setAttribute('stroke-width', shape.localName === 'line' || shape.hasAttribute('marker-end') ? '2' : '1.5');
        if (shape.hasAttribute('marker-end')) shape.setAttribute('marker-end', 'url(#arrow)');
      }
      copy.prepend(element('rect', { width: '100%', height: '100%', fill: palette.canvas }));
      return new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml;charset=utf-8' });
    }
    function download(blob, extension) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'flowchart.' + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function exportPng() {
      const url = URL.createObjectURL(exportSvg());
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!png) throw new Error('Could not encode PNG.');
        return png;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    function exportMarkdown() {
      const source = sourceText();
      const runs = source.match(/`+/g) || [];
      const fence = '`'.repeat(Math.max(2, ...runs.map(run => run.length)) + 1);
      return fence + 'mermaid\n' + source + '\n' + fence + '\n';
    }
    for (const button of shadow.querySelectorAll('[data-download]')) {
      button.onclick = async () => {
        const format = button.dataset.download;
        try {
          const blob = format === 'png' ? await exportPng() : format === 'svg' ? exportSvg()
            : new Blob([exportMarkdown()], { type: 'text/markdown;charset=utf-8' });
          download(blob, format);
          status('Download requested.');
        } catch (error) {
          status('Export failed: ' + error.message);
        }
      };
    }
    for (const button of shadow.querySelectorAll('[data-copy]')) {
      button.onclick = async () => {
        const format = button.dataset.copy;
        try {
          if (format === 'png') {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportPng() })]);
          } else {
            const value = format === 'mermaid' ? sourceText()
              : format === 'svg' ? await exportSvg().text() : exportMarkdown();
            try {
              await navigator.clipboard.writeText(value);
            } catch {
              const field = document.createElement('textarea');
              field.value = value;
              field.style.cssText = 'position:fixed;left:-9999px';
              shadow.append(field);
              field.select();
              try {
                if (!document.execCommand('copy')) throw new Error('Clipboard unavailable.');
              } finally {
                field.remove();
                button.focus();
              }
            }
          }
          status('Copied to clipboard.');
        } catch {
          status(format === 'png' ? 'PNG clipboard unavailable. Use Download PNG.' : 'Could not copy to clipboard.');
        }
      };
    }
    const headerActions = get('.header-actions');
    if (header) {
      header.append(headerActions);
      headerActions.addEventListener('keydown', cancelTool);
    }
    host.append(root);
    if (dockLayout) frame.style.setProperty('--dock-height', toolbar.offsetHeight + 'px');
    area.value = sourceText();
    status('Scroll to zoom · Drag empty space to pan · Double-click a shape or arrow to edit its label');
    render();
    fit();
    return { getMermaid: sourceText, setMermaid, getProject, setProject, undo, redo, fit, exportSvg, exportPng, exportMarkdown, destroy: () => { clearTimeout(updateTimer); observer.disconnect(); headerActions.remove(); root.remove(); } };
  }

  globalThis.MiniFlow = { mount, parse, stringify };
})();
