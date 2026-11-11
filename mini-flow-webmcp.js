const idSchema = { type: 'string', pattern: '^[A-Za-z][\\w-]*$' };
const labelSchema = { type: 'string' };
const positionSchema = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const nodeTypes = ['terminal', 'step', 'decision', 'note'];

function operation(op, properties, optional = []) {
  return {
    type: 'object',
    properties: { op: { const: op }, ...properties },
    required: ['op', ...Object.keys(properties).filter(key => !optional.includes(key))],
    additionalProperties: false
  };
}

export const editSchema = {
  type: 'object',
  properties: {
    revision: { type: 'string' },
    message: { type: 'string' },
    edits: {
      type: 'array', minItems: 1, maxItems: 100,
      items: { oneOf: [
        operation('rename_node', { id: idSchema, label: labelSchema }),
        operation('move_node', { id: idSchema, position: positionSchema }),
        operation('add_node', { id: idSchema, type: { enum: nodeTypes }, label: labelSchema, position: positionSchema }),
        operation('add_arrow', { from: idSchema, to: idSchema, label: labelSchema }, ['label'])
      ] }
    }
  },
  required: ['revision', 'edits', 'message'],
  additionalProperties: false
};

function applyEdits(project, edits, library) {
  const graph = library.parse(project.source);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const positions = { ...project.positions };
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') throw new Error('Invalid edit.');
    const node = nodes.get(edit.id);
    switch (edit.op) {
      case 'rename_node':
        if (!node || typeof edit.label !== 'string') throw new Error('Rename requires an existing node and a label.');
        node.label = edit.label;
        break;
      case 'move_node':
        if (!node) throw new Error('Move requires an existing node.');
        setPosition(edit);
        break;
      case 'add_node': {
        if (typeof edit.id !== 'string' || !/^[A-Za-z][\w-]*$/.test(edit.id) || node ||
            !nodeTypes.includes(edit.type) || typeof edit.label !== 'string') {
          throw new Error('Add node requires a new ID, supported type, and label.');
        }
        setPosition(edit);
        const added = { id: edit.id, type: edit.type, label: edit.label };
        graph.nodes.push(added);
        nodes.set(added.id, added);
        break;
      }
      case 'add_arrow':
        if (!nodes.get(edit.from) || !nodes.get(edit.to) || nodes.get(edit.from).type === 'note' ||
            nodes.get(edit.to).type === 'note' || (edit.label !== undefined && typeof edit.label !== 'string')) {
          throw new Error('Add arrow requires two existing blocks and an optional label.');
        }
        graph.edges.push({ from: edit.from, to: edit.to, label: edit.label ?? '' });
        break;
      default:
        throw new Error('Unsupported edit operation.');
    }
  }
  return { ...project, source: library.stringify(graph), positions };

  function setPosition({ id, position }) {
    if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) {
      throw new Error('A position must contain two finite coordinates.');
    }
    positions[id] = [...position];
  }
}

export async function registerMiniFlowTools(editor, library = globalThis.MiniFlow, context = document.modelContext, options = {}) {
  if (typeof context?.registerTool !== 'function') return;
  const tabId = options.tabId ?? globalThis.crypto.randomUUID();
  let revision = 0;
  let previousProject;
  function readBoard() {
    const project = editor.getProject();
    const snapshot = JSON.stringify(project);
    if (previousProject !== snapshot) {
      previousProject = snapshot;
      revision++;
    }
    return { tabId, revision: tabId + ':' + revision, project };
  }

  await context.registerTool({
    name: 'get_board',
    description: 'Read the Mini Flow diagram in this tab. Returns its tab ID, revision, and project, including node positions and Mermaid metadata for notes and bends. Read before applying edits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => readBoard()
  });

  await context.registerTool({
    name: 'apply_board_edit',
    description: 'Edit the Mini Flow diagram in this tab. Use the revision from get_board on this same tab. Applies the full batch as one Undo step and highlights changes. A revision conflict leaves the board untouched.',
    inputSchema: editSchema,
    execute: async ({ revision, edits, message } = {}) => {
      const board = readBoard();
      if (revision !== board.revision) {
        return { ok: false, reason: 'revision_conflict', message: 'Read the current board again before editing.' };
      }
      if (!Array.isArray(edits) || !edits.length || edits.length > 100 || typeof message !== 'string' || !message.trim()) {
        return { ok: false, reason: 'invalid_edit', message: 'Supply 1–100 edits and a short message.' };
      }
      let project;
      try {
        project = applyEdits(board.project, edits, library);
      } catch (error) {
        return { ok: false, reason: 'invalid_edit', message: error.message };
      }
      editor.setProject(project, { message });
      return { ok: true, ...readBoard() };
    }
  });
}
