export async function registerRevisionedBoardTools({
  context, getProject, applyEdits, commitProject, editSchema, tabId, isReady,
  readDescription = 'Read the board and its current revision.',
  editDescription = 'Apply edits against the revision returned by get_board.'
}) {
  if (typeof context?.registerTool !== 'function') return;
  tabId ??= globalThis.crypto.randomUUID();
  let revision = 0;
  let previousProject;
  function readBoard() {
    const project = getProject();
    const snapshot = JSON.stringify(project);
    if (previousProject !== snapshot) {
      previousProject = snapshot;
      revision++;
    }
    return { tabId, revision: tabId + ':' + revision, project };
  }

  const notReady = { ok: false, reason: 'live_not_ready', message: 'The live board is not ready. Wait for the host and try again.' };
  await context.registerTool({
    name: 'get_board',
    description: readDescription,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => isReady?.() === false ? notReady : readBoard()
  });

  await context.registerTool({
    name: 'apply_board_edit',
    description: editDescription,
    inputSchema: editSchema,
    execute: async ({ revision, edits, message } = {}) => {
      if (isReady?.() === false) return notReady;
      const board = readBoard();
      if (revision !== board.revision) {
        return { ok: false, reason: 'revision_conflict', message: 'Read the current board again before editing.' };
      }
      if (!Array.isArray(edits) || !edits.length || edits.length > 100 || typeof message !== 'string' || !message.trim()) {
        return { ok: false, reason: 'invalid_edit', message: 'Supply 1–100 edits and a short message.' };
      }
      let project;
      try {
        project = applyEdits(board.project, edits);
      } catch (error) {
        return { ok: false, reason: 'invalid_edit', message: error.message };
      }
      const result = await commitProject(project, message);
      if (!result.ok) return result;
      return { ok: true, ...readBoard() };
    }
  });
}

