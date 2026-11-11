# Mini Flow

Mini Flow is a small flowchart editor with a dependency-free browser SDK.
Build diagrams with start/end blocks, steps, decisions, labeled arrows, and linked
sticky notes. Embed it in another application, customize its tools and colors,
or let an AI agent inspect and update the board through the JavaScript API.

[Try the live editor](https://mini-flow.kakkoi.dev/) · [Agent API guide](./agent-guide.md) · [API manifest](./mini-flow-api.json)

Open index.html in a browser. The demo and library work offline.
To serve locally, run `python3 -m http.server 8765 --bind 127.0.0.1` in this directory and open http://127.0.0.1:8765/.

- Scroll to zoom and drag empty canvas to pan. Use Fit to bring the diagram back into view.
- Double-click a shape or arrow to edit its label. Enter saves and Shift+Enter adds a line break.
- Use Code & export to download or open a project JSON with editable labels and positions.
- Open **Projects** in the header to name, save, and browse boards alongside the canvas. The open project saves automatically and its **Last saved** time updates after each edit. Click a title to rename it as you type, or use **Delete** on its row. Projects are stored in this browser. Download project JSON for a portable backup.
- Scroll or pinch to zoom. Undo and Redo are available in the toolbar.
- The demo saves each edit in browser storage and in the URL fragment. Copy link shares the current diagram and shape positions.
- Pick a terminal, step, or decision, then click the canvas to place it. Drag shapes to arrange them.
- Enable **Snap to grid** under **Arrange** to align placed and dragged shapes to the 16 px grid.
- Click Connect, then choose the source and destination.
- Select any shape or arrow and edit its label. Delete removes the selection
  and any arrows attached to a deleted shape.
- Mermaid source updates as you edit the board. Use Apply source to apply changes typed or pasted into the source panel. Discard edits appears while you have unapplied source changes.
- Use **Auto layout** under **Arrange** to arrange the current diagram in one undoable edit. Dagre follows the arrows, places branches side by side, and resets manual bends. Undo restores positions and bends.
  Mini Flow's copied source includes a layout comment so reimporting restores the canvas positions.
  Mermaid Live ignores that comment and computes its own layout.

Use the download buttons in the side panel’s Export section to save PNG or SVG with the current
canvas layout, or Markdown with a fenced Mermaid block. The embedded editor
also exposes exportSvg() and async exportPng() as Blob exporters, and
exportMarkdown() as a string exporter.

## Embed

Copy mini-flow.js into your project.

```html
<div id="flow"></div>
<script src="./mini-flow.js"></script>
<script>
const editor = MiniFlow.mount(document.querySelector('#flow'), 'flowchart TD');
const source = editor.getMermaid();
editor.setMermaid(source);
</script>
```

Call editor.destroy() to remove the editor. MiniFlow.parse and MiniFlow.stringify
are also available without mounting a canvas. The editor uses SVG and Shadow DOM.

Import supports TD and TB headers, standalone terminal/step/decision declarations,
and one arrow per line with an optional pipe label. Declare every referenced
node. Mermaid export stores labels and connections. Use project JSON or a share link to preserve canvas positions. Applying source preserves positions for matching node IDs and places
new nodes below the existing diagram.

Mermaid syntax and the text-editor workflow come from the Mermaid project and
its MIT-licensed Mermaid Live Editor (https://github.com/mermaid-js/mermaid-live-editor).
The editor SDK uses an independent SVG canvas and has no required runtime dependencies. The demo bundles [Dagre 1.1.5](https://github.com/dagrejs/dagre/tree/v1.1.5), a layout engine supported by Mermaid, for automatic node placement. The editor draws the connections on its SVG canvas.

Copy Mermaid in the source panel, or copy Markdown, SVG markup, or PNG in
Export. PNG clipboard support depends on the browser.

With focus in the editor, use these shortcuts. Label editors and the source
textarea keep their normal text-editing behavior.

| Key | Action |
| --- | --- |
| `1` | Start / End tool |
| `2` | Step tool |
| `3` | Decision tool |
| `4` | Connect tool |
| `5` | Note tool |
| `6` | Laser pointer |
| `Esc` | Cancel the active tool or connection placement |
| `Backspace` | Delete the selected block, arrow, or note attachment |
| `Enter` while editing a label | Save and close the label editor |
| `Shift+Enter` while editing a label | Insert a line break |

Use Ctrl+Z to undo and Ctrl+Y to redo diagram edits. Cmd+Z and Cmd+Shift+Z
also work on Mac. Text fields keep their native undo behavior.

With **Laser** selected, drag to draw a temporary trail that fades on its own.
Guests in a live session see the trail as you draw.


## Configure an embed

```js
const editor = MiniFlow.mount(host, 'flowchart TD', {}, {
  features: { exports: false, shortcuts: false },
  tools: ['step', 'storage'],
  colors: { canvas: '#fbfaf6', step: '#e8efe5', storage: '#e4edff' },
  extraShapes: {
    storage: {
      label: 'Storage',
      syntax: ['[(', ')]'],
      draw({ element, width, height, paint }) {
        return element('rect', {
          x: -width / 2, y: -height / 2, width, height, rx: 12, ...paint
        });
      }
    }
  }
});
```

Feature switches default to enabled. Disable any of create, connect, delete,
edit, move, pan, zoom, fit, snap, history, shortcuts, laser, source, exports, or project.
These switches control the UI. The SDK still exposes explicit methods for
host-driven imports and exports. The tools array lists the shape buttons to
show. Theme keys include canvas, grid, text, surface, stroke, accent, and shape
type names. Extra shapes supply unique Mermaid delimiters and an SVG drawing
callback centered at the origin. Register the same shapes when reopening
projects that use them.

## Agent integration

Use MiniFlow.parse(source) to inspect built-in shapes and MiniFlow.stringify(graph)
to generate source. For custom shapes, pass the registered delimiter map as
the second argument. A mounted editor uses its configured shapes automatically.

Read the board with editor.getProject() and apply a complete board with
editor.setProject(project). The project schema is version 1 with a Mermaid
source string and a positions object mapping node IDs to finite [x, y] pairs.
Use editor.setMermaid(source) to update structure and retain matching positions. Copied Mini Flow source also carries positions in a Mermaid comment. When an import has no saved or matching positions, the demo uses Dagre to place the nodes.

Embeds can pass `{ dagre }` in the options to `MiniFlow.mount` to enable the same behavior. With Dagre configured, `editor.autoLayout()` arranges the current board in a single Undo step and fits it into view.
Call editor.fit(), editor.undo(), or editor.redo() directly. Pass onChange(source,
positions) when mounting to subscribe to committed edits. These methods require
no pointer or keyboard simulation.

## Notes, connector bends, and chat

Choose **Note**, click the canvas, and type. To attach a note, choose **Connect**,
click the note, then click a block or arrow. Connecting again moves the attachment.
Deleting the target leaves the note on the canvas. To route an arrow manually,
select it and choose **Add bend** beside the arrow, then click or tap the canvas.
Drag the handle to move the bend, or focus it and use the arrow keys. **Reset bend**
restores the default path. Project files and share links retain notes, attachments, and bends
in a Mini Flow Mermaid comment. Other Mermaid renderers ignore that comment.

Embeds can pass a `header` element to receive the editor action buttons, and
turn off note creation or bend controls with `features: { notes: false, bend: false }`.
Pass `onSend: async ({ project, selection }) => { … }` to show **Send to chat**.
The host handles delivery. A selection is either a node summary with its ID,
an arrow summary with its index and endpoints, or null. Use `setProject()` to
apply an incoming board as one undoable change.

## Feedback for SDK updates

Both `setProject(project, options)` and `setMermaid(source, options)` accept
`{ message: 'Added a fallback after Data here?' }`. Added or changed blocks
and arrows are highlighted for three seconds. Without a message, the editor
reports counts of additions, updates, and removals. Each call is one diagram
undo step. Feedback is transient and excluded from project data and exported
images. Pass `{ highlight: false }` per call or configure
`features: { updateFeedback: false }` to disable it.

## Reconnect a connection

Select an arrow and drag either endpoint onto a block. The target is highlighted
during the drag. Dropping elsewhere or pressing Escape cancels. Select a dotted
note attachment and drag its destination onto a block or arrow to reattach it.
Each reconnection is one undo step. Embeds can disable handles with
`features: { reconnect: false }`.

## Remember snap preferences

Pass `settingsKey: 'my-editor-preferences'` to persist the snap toggle in local
storage across reloads. Use distinct keys for independent embeds. Optional
`snapToGrid: true` sets the initial value when no saved preference exists.
The demo uses `mini-flow-preferences`.

## API discovery for visiting agents

The demo exposes its current mounted instance as `window.miniFlowEditor`.
The page advertises [mini-flow-api.json](./mini-flow-api.json) through a
`rel="describedby"` link and `meta[name="mini-flow-api"]`. The manifest lists
method signatures, update effects, and the project schema.

Read the [agent guide](./agent-guide.md) for examples of reading a board,
preserving notes and positions, and applying an update as one undo step.
The agent's browser tooling must permit page JavaScript execution.

```js
const editor = window.miniFlowEditor;
const project = editor.getProject();
// Modify project.source and project.positions for the requested edit.
editor.setProject(project, { message: 'Added the requested fallback.' });
```

Embeds expose their own mounted instance or bridge. The manifest describes the
public demo's instance, and the optional `onSend` callback connects host-owned
chat delivery.

Agents can also send an **Apply edit** link containing a base board, proposed
board, and summary. Mini Flow reviews the proposal before applying it as one
Undo step. See [Apply edit links](./agent-guide.md#apply-edit-links).

WebMCP-capable browsers can use `get_board` and `apply_board_edit` on the open
board. See the [Site tools guide](./agent-guide.md#webmcp-site-tools).


## Live session with an agent

Open the board you want to edit, then choose **Live session → Start live session**
and share the same **Copy invite** link with your collaborators. Keep the
host tab open. Up to eight guests can join, including humans and agents.
The regular **Copy link** still shares a snapshot.

Guests can edit directly on the canvas and see the other participants' cursors
and selected blocks. The canvas corner shows the number of connected human and
AI guests, excluding the host. Agents call `register_live_agent` after joining
through a WebMCP-capable browser, then use `get_board` and `apply_board_edit`.
The host owns Undo and Redo, and accepted edits
and Undo or Redo sync to everyone. If edits conflict, the guest sees the current
board and can retry.

When an AI guest is connected, select a sticky note and click **Ask AI** on
its corner. The note shows when it is waiting, which AI guest claimed it,
and the result. You can ask again once the request finishes.
Only the first AI guest to claim the request gets it from
`wait_for_ai_request`. That call runs during an active agent turn.

Participants see draft text, drag movement, and tool icons as they edit.
Live guests get a separate note color, and notes return to yellow when the
session ends. AI guests can report progress with `report_ai_activity` and
publish small batches as they finish them. Every accepted batch is visible
immediately.

## GitHub Gist backups

Open a saved project and expand **GitHub Gist backup** in Projects. Paste a
Gist URL or ID and a GitHub token with Gists write permission, then choose
**Connect project**. While the tab is open, Mini Flow checks for changes every
five minutes. **Back up now** saves a changed snapshot immediately. Each
snapshot has its own file, so edits from different machines can be opened
independently. The token is kept in memory until reload. **Disconnect** stops
new backups from this project.

On another machine, paste the Gist link and choose **Find backups**. Select a
snapshot to open it as a working copy. Use **Save as Project** to give it a local
name, then connect that project to the same Gist to continue backing up.
Anyone with the Gist link can read its backups.

When the host ends the session or a guest leaves, the guest can continue
editing their own copy. Mini Flow switches the guest's URL to a snapshot and
enables local Undo and Redo. During a connection interruption, guests can use
**Leave session** to keep editing a copy while the host is away.

Live sessions load the pinned p2p-core browser module and use its online
transport. Sessions require both tabs to stay connected and end when the host
closes or reloads the page. GitHub Pages continues to host the editor.


Run the live-session regression with `node --test tests/live-session.test.mjs`.
Serve the repo and open `tests/auto-layout.html` to run the browser regression
for bend reset, note attachments, Undo, and Redo.
