/* Mini Flow — a dependency-free SVG editor for a small Mermaid subset. */
(function () {
  const shapes = {
    terminal: ['([', '])'],
    step: ['[', ']'],
    decision: ['{', '}']
  };
  const encode = value => value.replace(/["#&<>|\\\r\n]/g, char => char === '\n' ? '<br/>' : '#' + char.charCodeAt(0) + ';');
  const decode = value => value.replace(/<br\s*\/?>/gi, '\n').replace(/#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  function parse(source) {
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
      const type = node && Object.keys(shapes).find(key => {
        const [open, close] = shapes[key];
        return node[2].startsWith(open) && node[2].endsWith(close);
      });
      if (!type || ids.has(node[1])) throw new Error('Invalid or repeated node: ' + line);
      const [open, close] = shapes[type];
      const label = node[2].slice(open.length, -close.length).replace(/^"(.*)"$/, '$1');
      ids.add(node[1]);
      nodes.push({ id: node[1], type, label: decode(label), x: 300, y: 65 + nodes.length * 115 });
    }
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error('Declare both arrow endpoints.');
    }
    return { nodes, edges };
  }

  function stringify({ nodes, edges }) {
    return ['flowchart TD', ...nodes.map(({ id, type, label }) => {
      const [open, close] = shapes[type];
      return '    ' + id + open + '"' + encode(label) + '"' + close;
    }), ...edges.map(({ from, to, label }) =>
      '    ' + from + ' --> ' + (label ? '|' + encode(label) + '| ' : '') + to
    )].join('\n');
  }

  function mount(host, source = 'flowchart TD', positions = {}, { onChange } = {}) {
    let graph = parse(source), selected, origin, drag, pendingShape;
    for (const node of graph.nodes) {
      if (Object.hasOwn(positions, node.id)) [node.x, node.y] = positions[node.id];
    }
    const undoStack = [], redoStack = [];
    const snapshot = () => JSON.stringify(graph, (key, value) =>
      key === 'labelX' || key === 'labelY' ? undefined : value);
    let current = snapshot();
    let serial = 1;
    let pan, editing, zoom = 1, cameraX = 0, cameraY = 0;
    const gridSize = 16;
    const root = document.createElement('div');
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {display:block;color:#203044;font:15px system-ui}
        * {box-sizing:border-box}
        .frame {position:relative;height:var(--mini-flow-height, 72vh);min-height:360px;isolation:isolate}
        @media (max-width: 550px) { .toolbar button {font-size:13px;padding:5px} .toolbar kbd {font-size:10px} .status {font-size:12px} }
        .toolbar {position:absolute;inset:12px 12px auto;z-index:2;width:fit-content;max-width:calc(100% - 24px);margin:auto;border:1px solid #d9e2ec;border-radius:14px;box-shadow:0 4px 20px #20304418;
display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;background:#fff;border-bottom:1px solid #d9e2ec}
        button,input,textarea {font:inherit;color:inherit}
        button,input {background:white;border:1px solid #bdcbd9;border-radius:8px;padding:8px}
        button {cursor:pointer} button[aria-pressed=true]{background:#e0eaff;border-color:#3965be}
        kbd {margin-inline-start:5px;padding:1px 4px;border:1px solid #bdcbd9;border-radius:4px;font:12px ui-monospace,monospace}
        button:disabled {opacity:.45;cursor:default}
        .frame {border:1px solid #bdcbd9;border-radius:12px;overflow:hidden}
        .scroll {position:absolute;inset:0;overflow:hidden;background:#f7faff radial-gradient(#c5d4e4 1px,transparent 1px) 0 0/16px 16px}
        svg {display:block;width:100%;height:100%;cursor:grab;touch-action:none;user-select:none}
        g[role=button] {cursor:pointer}
        g:focus-visible {outline:2px solid #3965be}
        text {fill:#203044;pointer-events:none}
        .panel {position:absolute;inset:auto 12px 50px auto;width:min(350px,calc(100% - 24px));max-height:65%;overflow:auto;background:white;border:1px solid #d9e2ec;border-radius:14px;box-shadow:0 4px 24px #20304424;z-index:1}
        .inline {position:absolute;z-index:1;transform:translate(-50%,-50%);min-width:48px;min-height:1.2em;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.2;color:#203044;outline:none;background:transparent}
        .status {position:absolute;inset:auto 12px 8px;pointer-events:none;border-radius:10px;margin:0;padding:8px 12px;background:#fff;border-top:1px solid #d9e2ec;min-height:38px}
        .panel details {padding:14px;background:#fff}
        .panel details + details {border-top:1px solid #d9e2ec}
        .panel-actions {display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
        .panel textarea {margin:10px 0 0}
        summary {cursor:pointer}
        textarea {background:#fff;color:#203044;color-scheme:light;border:1px solid #bdcbd9;border-radius:8px;padding:10px;display:block;width:100%;min-height:155px;margin:10px 0;font:14px ui-monospace,monospace}
      </style>
      <section class="frame" aria-label="Flowchart editor">
        <div class="toolbar">
          <button aria-keyshortcuts="1" title="Shortcut: 1" data-shape="terminal">Start / End <kbd aria-hidden="true">1</kbd></button>
          <button aria-keyshortcuts="2" title="Shortcut: 2" data-shape="step">Step <kbd aria-hidden="true">2</kbd></button>
          <button aria-keyshortcuts="3" title="Shortcut: 3" data-shape="decision">Decision <kbd aria-hidden="true">3</kbd></button>
          <button aria-keyshortcuts="4" title="Shortcut: 4" data-link aria-pressed="false">Connect <kbd aria-hidden="true">4</kbd></button>
          <label><input type="checkbox" data-snap> Snap to grid</label>
          <button aria-keyshortcuts="Backspace" title="Shortcut: Backspace" data-delete disabled>Delete <kbd aria-hidden="true">⌫</kbd></button>
          <button data-panel aria-expanded="false">Code &amp; export</button><button data-fit>Fit</button>
        </div>
        <div class="scroll"><svg aria-label="Flowchart canvas"></svg></div>
        <p class="status" role="status"></p>
        <aside class="panel" hidden><details open><summary>Mermaid source</summary>
          <textarea aria-label="Mermaid source" spellcheck="false"></textarea>
          <div class="panel-actions"><button data-import>Apply source</button>
          <button data-export>Refresh source</button>
          <button data-copy="mermaid">Copy Mermaid</button></div>
        </details>
        <details><summary>Export</summary>
          <div class="panel-actions"><button data-download="png">Download PNG</button>
          <button data-download="svg">Download SVG</button>
          <button data-download="md">Download Markdown</button></div>
          <div class="panel-actions"><button data-copy="png">Copy PNG</button>
          <button data-copy="svg">Copy SVG markup</button>
          <button data-copy="md">Copy Markdown</button></div>
        </details></aside>
      </section>`;
    const get = selector => shadow.querySelector(selector);
    const svg = get('svg'), area = get('.panel textarea'), viewport = get('.scroll');
    const panel = get('.panel');
    get('[data-panel]').onclick = event => {
      panel.hidden = !panel.hidden;
      event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
    };
    get('[data-fit]').onclick = fit;
    const observer = new ResizeObserver(updateCamera);
    observer.observe(viewport);
    function updateCamera() {
      const width = viewport.clientWidth || 1, height = viewport.clientHeight || 1;
      svg.setAttribute('viewBox', [cameraX, cameraY, width / zoom, height / zoom].join(' '));
      viewport.style.backgroundSize = (16 * zoom) + 'px ' + (16 * zoom) + 'px';
      viewport.style.backgroundPosition = (-cameraX * zoom) + 'px ' + (-cameraY * zoom) + 'px';
      positionEditor();
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
      if (record && next !== current) {
        undoStack.push(current);
        redoStack.length = 0;
      }
      current = next;
      area.value = stringify(graph);
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
      if (editing) editing.field.blur();
      const field = document.createElement('div');
      field.contentEditable = 'plaintext-only';
      field.setAttribute('role', 'textbox');
      field.setAttribute('aria-multiline', 'true');
      field.className = 'inline';
      field.setAttribute('aria-label', 'Edit diagram label');
      const originalLabel = item.label;
      field.textContent = originalLabel;
      editing = { field, item };
      viewport.append(field);
      positionEditor();
      function updateLabel() {
        item.label = (field.childElementCount ? field.innerText : field.textContent).replace(/\r/g, '');
        area.value = stringify(graph);
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
        if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
          // Let the browser maintain its trailing line placeholder and caret.
          if (document.execCommand('insertLineBreak')) {
            event.preventDefault();
            updateLabel();
          }
          return;
        }
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
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
      return [node.x + dx / scale, node.y + dy / scale];
    };
    function select(item) {
      selected = item;
      remove.disabled = !item;
    }
    function render(focus) {
      svg.replaceChildren();
      const defs = element('defs', {});
      for (const [id, color] of [['arrow', '#536982'], ['active', '#3965be']]) {
        const marker = element('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto' });
        marker.append(element('path', { d: 'M0 0 L10 5 L0 10Z', fill: color }));
        defs.append(marker);
      }
      svg.append(defs);
      const byId = new Map(graph.nodes.map(node => [node.id, node]));
      for (const edge of graph.edges) {
        const a = byId.get(edge.from), b = byId.get(edge.to);
        let start, end, d, x, y;
        if (b.y <= a.y && Math.abs(a.x - b.x) < 40) {
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
        const active = selected === edge;
        const group = itemGroup(edge, 'Arrow from ' + a.label + ' to ' + b.label);
        group.append(element('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 22 }),
          element('path', { d, fill: 'none', stroke: active ? '#3965be' : '#536982', 'stroke-width': 2,
            'marker-end': active ? 'url(#active)' : 'url(#arrow)' }),
          labelText({ x, y, 'text-anchor': 'middle', 'font-size': 13, visibility: editing?.item === edge ? 'hidden' : 'visible', stroke: '#f7faff', 'stroke-width': 5, 'paint-order': 'stroke' }, edge.label));
        svg.append(group);
        if (focus === edge) group.focus();
      }
      for (const node of graph.nodes) {
        const group = itemGroup(node, node.type + ': ' + node.label);
        group.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
        const w = radius(node), h = height(node);
        const paint = {
          fill: node.type === 'decision' ? '#fff0c7' : node.type === 'terminal' ? '#dcf4e9' : '#e4edff',
          stroke: selected === node || origin === node ? '#3965be' : '#536982',
          'stroke-width': selected === node || origin === node ? 3 : 1.5
        };
        group.append(node.type === 'decision'
          ? element('polygon', { points: '0,' + -h + ' ' + w + ',0 0,' + h + ' ' + -w + ',0', ...paint })
          : element('rect', { x: -w, y: -h, width: 2*w, height: 2*h, rx: node.type === 'terminal' ? h : 4, ...paint }),
          labelText({ 'text-anchor': 'middle', visibility: editing?.item === node ? 'hidden' : 'visible' }, node.label));
        if (connect.getAttribute('aria-pressed') === 'false') {
          group.addEventListener('pointerdown', event => {
            if (event.button !== 0 || pendingShape) return;
            event.preventDefault();
            select(node);
            drag = { pointerId: event.pointerId, node, x: node.x, y: node.y, clientX: event.clientX, clientY: event.clientY };
            svg.setPointerCapture(event.pointerId);
            group.focus({ preventScroll: true });
          });
        }
        svg.append(group);
        if (focus === node) group.focus();
      }
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
        if (pendingShape) return;
        if (item.type && connect.getAttribute('aria-pressed') === 'true') {
          if (!origin) {
            origin = item;
            status('Choose the destination shape.');
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
    svg.addEventListener('wheel', event => {
      event.preventDefault();
      if (drag || pan) return;
      const [x, y] = world(event);
      const oldZoom = zoom;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      zoom = Math.min(5, Math.max(.05, zoom * Math.exp(-delta * .002)));
      cameraX = x - (x - cameraX) * oldZoom / zoom;
      cameraY = y - (y - cameraY) * oldZoom / zoom;
      updateCamera();
    }, { passive: false });
    svg.addEventListener('pointermove', event => {
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
    svg.addEventListener('lostpointercapture', () => {
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
    const shapeButtons = [...shadow.querySelectorAll('[data-shape]')];
    function chooseShape(button) {
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
      const node = { id, type, label: type === 'terminal' ? 'Start' : type === 'step' ? 'Step' : 'Decision', x, y };
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
      if (pendingShape || drag || pan) return;
      pan = { pointerId: event.pointerId, x: cameraX, y: cameraY, clientX: event.clientX, clientY: event.clientY };
      svg.setPointerCapture(event.pointerId);
    });
    function replay(from, to, message) {
      if (!from.length || drag || pan) return;
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
    root.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey ||
          event.composedPath().some(target => target.matches?.('input, textarea, select, [contenteditable]'))) return;
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault();
        if (key === 'y' || event.shiftKey) replay(redoStack, undoStack, 'Edit redone.');
        else replay(undoStack, redoStack, 'Edit undone.');
        return;
      }
      if (event.shiftKey) return;
      const commands = { '1': shapeButtons[0], '2': shapeButtons[1],
        '3': shapeButtons[2], '4': connect, Backspace: remove };
      const command = commands[event.key];
      if (!Object.hasOwn(commands, event.key)) return;
      event.preventDefault();
      if (command.disabled) return;
      command.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    });
    shadow.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      chooseShape(undefined);
      origin = undefined;
      connect.setAttribute('aria-pressed', 'false');
      status('Tool canceled.');
      render();
    });
    connect.onclick = () => {
      chooseShape(undefined);
      const enabled = connect.getAttribute('aria-pressed') === 'false';
      connect.setAttribute('aria-pressed', String(enabled));
      origin = undefined;
      status(enabled ? 'Choose the source shape.' : 'Connect mode off.');
      render();
    };
    remove.onclick = () => {
      graph.nodes = graph.nodes.filter(node => node !== selected);
      graph.edges = graph.edges.filter(edge => edge !== selected && edge.from !== selected.id && edge.to !== selected.id);
      if (origin === selected) origin = undefined;
      select(undefined);
      render();
      changed();
      status('Selection deleted.');
    };
    function setMermaid(value) {
      const next = parse(value);
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
    }
    get('[data-import]').onclick = () => {
      try { setMermaid(area.value); status('Mermaid source applied.'); }
      catch (error) { status(error.message); }
    };
    get('[data-export]').onclick = () => {
      area.value = stringify(graph);
      area.focus();
      area.select();
      status('Mermaid source refreshed and selected.');
    };
    function exportSvg() {
      const copy = svg.cloneNode(true);
      const box = svg.getBBox();
      const width = Math.ceil(box.width + 48), height = Math.ceil(box.height + 48);
      copy.setAttribute('width', width);
      copy.setAttribute('height', height);
      copy.setAttribute('viewBox', [box.x - 24, box.y - 24, width, height].join(' '));
      copy.setAttribute('font-family', 'system-ui, sans-serif');
      copy.setAttribute('font-size', '15');
      copy.setAttribute('fill', '#203044');
      for (const group of copy.querySelectorAll('[role="button"]')) {
        group.removeAttribute('tabindex');
        group.removeAttribute('role');
      }
      for (const shape of copy.querySelectorAll('[stroke="#3965be"]')) {
        shape.setAttribute('stroke', '#536982');
        shape.setAttribute('stroke-width', shape.hasAttribute('marker-end') ? '2' : '1.5');
        if (shape.hasAttribute('marker-end')) shape.setAttribute('marker-end', 'url(#arrow)');
      }
      copy.prepend(element('rect', { width: '100%', height: '100%', fill: '#f7faff' }));
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
      const source = stringify(graph);
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
            const value = format === 'mermaid' ? stringify(graph)
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
    host.append(root);
    area.value = stringify(graph);
    status('Scroll to zoom · Drag empty space to pan · Double-click a shape or arrow to edit its label');
    render();
    fit();
    return { getMermaid: () => stringify(graph), setMermaid, exportSvg, exportPng, exportMarkdown, destroy: () => { observer.disconnect(); root.remove(); } };
  }

  globalThis.MiniFlow = { mount, parse, stringify };
})();
