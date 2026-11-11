# Mini Flow agent API

Discover the API from the page's `link[rel="describedby"][type="application/json"]`
or `meta[name="mini-flow-api"]`. Fetch `mini-flow-api.json` relative to the page.
The manifest describes the project schema, methods, and their effects.

The loaded demo exposes its current editor as `window.miniFlowEditor`.
It is available after the page scripts have executed. The same instance drives
the visible canvas, local persistence, share URL, and undo history.

## Read before making changes

```js
const editor = window.miniFlowEditor;
const project = editor.getProject();
const graph = window.MiniFlow.parse(project.source);
```

The project is a JSON-serializable copy with `version: 1`, a Mermaid `source`
string, and `positions` mapping every node ID to finite `[x, y]` coordinates.
Built-in node types are terminal, step, decision, and note. Arrows have
`from`, `to`, and `label`, plus an optional `bend: [x, y]`.
Notes have an optional `target`, either a node ID or a zero-based arrow index.

Use `MiniFlow.parse` and `MiniFlow.stringify` to preserve Mini Flow metadata.
Notes and bends are encoded in a `%% mini-flow` comment in Mermaid source.
Keep existing IDs, positions, notes, and connections when making a targeted edit.
If arrows are removed or reordered, remap note target indices to the intended
arrows. To inspect SDK-configured custom shapes, use the host's delimiter registry.

## Apply an update

For example, rename a known node after reading the latest board.

```js
const editor = window.miniFlowEditor;
const project = editor.getProject();
const graph = MiniFlow.parse(project.source);
const node = graph.nodes.find(node => node.id === 'N3');
if (!node) throw new Error('Node N3 is absent from this board.');
node.label = 'Read database';
project.source = MiniFlow.stringify(graph);
editor.setProject(project, { message: 'Renamed the database step.' });
```

Use one `setProject` call for one coherent update. It creates one undo step,
runs the host's save callback, updates the share URL, and briefly highlights
added or changed elements. Validate the result by calling `getProject()`
again. Avoid applying a stale board if the user edited it in the meantime.

Alternatively, `setMermaid(source, options)` preserves existing positions for
matching IDs and places new nodes below the board. Pass `highlight: false`
to disable feedback for an individual update. Call `fit()` when the user
needs to see newly added content, and `undo()` or `redo()` for history.

## Other integrations

The library is available as `window.MiniFlow`. Each embedding application owns
its mounted instance and must expose that instance or its own bridge if agents
need access. The public demo explicitly exposes `window.miniFlowEditor`.

This discovery layer requires browser tooling that permits page JavaScript
execution. It advertises capabilities and does not register WebMCP tools.
The host's optional `onSend({ project, selection })` callback can connect a
Send to chat button to its chat system. The public demo has no chat backend.

## Apply edit links

An agent that can read the board from a share link can propose a change with an
Apply edit link. Decode the JSON after `#flow=` in the original link and add
`version: 1` to turn it into the base project. Build a second project with the
requested changes. Both projects need a position for every node.

```js
const original = new URL(boardUrl);
const base = { ...JSON.parse(decodeURIComponent(original.hash.slice('#flow='.length))), version: 1 };
const project = structuredClone(base);
const graph = MiniFlow.parse(project.source);
const step = graph.nodes.find(node => node.id === 'N3');
if (!step) throw new Error('Node N3 is absent from this board.');
step.label = 'Read database';
project.source = MiniFlow.stringify(graph);
original.hash = 'apply=' + encodeURIComponent(JSON.stringify({
  version: 1, base, project, message: 'Renamed the database step.'
}));
const applyLink = original.href;
```

Send the link to the user. Opening it in a new tab loads the base board and
opens a review dialog. In an existing Mini Flow tab, paste the link into the
address bar to review the proposal against the current board. The user can
inspect the Mermaid source before applying. Apply highlights the changes and
creates one Undo step. Mini Flow checks the base again on Apply and blocks
the edit if the board in that tab has changed. A new tab works on the shared
copy encoded in the link.
