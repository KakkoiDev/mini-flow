import { registerRevisionedBoardTools } from './vendor/ai-core/webmcp.mjs';

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
        operation('delete_node', { id: idSchema }),
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
      case 'delete_node': {
        if (!node) throw new Error('Delete requires an existing node.');
        const oldEdges = graph.edges;
        graph.edges = oldEdges.filter(edge => edge.from !== edit.id && edge.to !== edit.id);
        graph.nodes = graph.nodes.filter(item => item !== node);
        nodes.delete(edit.id);
        delete positions[edit.id];
        for (const note of graph.nodes) {
          if (Number.isInteger(note.target)) {
            const index = graph.edges.indexOf(oldEdges[note.target]);
            note.target = index < 0 ? undefined : index;
          } else if (note.target === edit.id) {
            delete note.target;
          }
        }
        break;
      }
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
  const definitions = [];
  const registry = { registerTool: tool => { definitions.push(tool); } };
  await registerRevisionedBoardTools({
    context: registry, editSchema, tabId: options.tabId, isReady: options.isReady,
    getProject: () => editor.getProject(),
    applyEdits: (project, edits) => applyEdits(project, edits, library),
    commitProject: options.commitProject ?? ((project, message) => {
      editor.setProject(project, { message });
      return { ok: true };
    }),
    readDescription: 'Read the Mini Flow diagram in this tab. Returns its tab ID, revision, and project, including node positions and Mermaid metadata for notes and bends. Read before applying edits.',
    editDescription: 'Edit the Mini Flow diagram in this tab. Use the revision from get_board on this same tab. Applies the full batch as one Undo step and highlights changes. A revision conflict leaves the board untouched.'
  });
  if (options.registerAgent) {
    registry.registerTool({
      name: 'register_live_agent',
      description: 'Identify this connected browser guest as an AI agent. Open the live invite in a browser with WebMCP access, wait for Live · Connected, then call this tool before editing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { idempotentHint: true },
      execute: () => options.registerAgent()
    });
  }
  if (options.waitForAIRequest) {
    registry.registerTool({
      name: 'wait_for_ai_request',
      description: 'Wait for Ask AI and claim the request exclusively. Only the first AI acknowledged by the host gets the task. Pass the last handled sequence as after (start at 0). Use get_board to verify the current target. On a follow-up, use the preceding messages in request.thread as context. Use a 10000 ms wait. On null or live_not_ready, wait again with the same cursor. Stop on session_ended. After reporting each result, immediately wait again with the handled sequence as after. Keep listening until the live session disconnects or the user asks you to stop.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          after: { type: 'integer', minimum: 0, default: 0 },
          timeoutMs: { type: 'integer', minimum: 0, maximum: 15000, default: 10000 }
        }
      },
      execute: ({ after, timeoutMs } = {}) => options.waitForAIRequest(after, timeoutMs)
    });
  }
  if (options.reportAIActivity) {
    registry.registerTool({
      name: 'report_ai_activity',
      description: 'Send a short message to show progress and renew the five-minute idle timeout. Finish with an empty message and optional result. To mark a request failed and show Retry, send an empty message, failed: true, and the reason in result.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['message'],
        properties: { message: { type: 'string', maxLength: 200 }, result: { type: 'string', maxLength: 2000 }, failed: { type: 'boolean' } } },
      execute: ({ message, result, failed } = {}) => options.reportAIActivity(message, result, failed)
    });
  }
  if (options.exposeTools) {
    const methods = Object.fromEntries(definitions.map(({ name, execute }) => [name, execute]));
    options.exposeTools(Object.freeze({
      ...methods,
      help: () => ({ tools: structuredClone(definitions.map(({ name, description, inputSchema }) =>
        ({ name, description, inputSchema }))) })
    }));
  }
  if (typeof context?.registerTool !== 'function') return;
  for (const tool of definitions) await context.registerTool(tool);
}

