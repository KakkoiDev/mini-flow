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
show. Extra shapes supply unique Mermaid delimiters and an SVG drawing
callback centered at the origin. Register the same shapes when reopening
projects that use them.

### Colors and themes

The editor follows the system light or dark setting. Pass `theme: 'light'` or
`theme: 'dark'` to fix one. Color keys are canvas, grid, text, surface, stroke,
accent, terminal, step, decision, note, border, hover, muted, onAccent,
accentInk, accentSoft, focus, good, warn, danger, highlight, laser, edgeLabel,
`guests` (an array of up to four guest note fills), and extra shape type names.
A color you pass applies in both themes.

The editor also reads the `--mf-*` custom properties from the page, such as
`--mf-accent`, `--mf-ink` for text, and `--mf-guest-1`. Link [tokens.css](./tokens.css)
to theme your page and the editor from one set of light and dark values, as the
demo does. When the page defines these properties, its own theme rules decide
light or dark. Exported PNG and SVG files always use the light colors.

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
board, and summary. Switch between the current and proposed canvases, or expand
the Mermaid diff, before applying the change as one Undo step. See [Apply edit links](./agent-guide.md#apply-edit-links).

WebMCP-capable browsers can use `get_board` and `apply_board_edit` on the open
board. See the [Site tools guide](./agent-guide.md#webmcp-site-tools).


## Live session

Open the board you want to edit, then choose **Live session → Start live session**
and share the same **Copy invite** link with your collaborators. Keep the
host tab open. Up to eight people can join.
Guests can also copy the invite from the **Live session** dialog.
The regular **Copy link** shares a snapshot.

To use your own relay, enter its HTTPS or WSS URL in **Live session → Custom WebSocket relay** before starting. Use a relay that implements the [p2p-core WebSocket protocol](https://github.com/KakkoiDev/p2p-core), such as the [Cloudflare Worker example](https://github.com/KakkoiDev/p2p-core-cloudflare). The invite carries the relay address. Custom sessions use that relay for remote traffic and disable public WebRTC signaling. Board messages are encrypted with the invite's room key.
New invites also carry the host's key fingerprint, and guests only accept a board signed by that host.
Invites from older versions still work without this check. Leave the field blank for the default connection.

Guests can edit directly on the canvas and see the other participants' cursors
and selected blocks. The canvas corner shows the number of connected guests,
excluding the host. The host owns Undo and Redo, and accepted edits
and Undo or Redo sync to everyone. If edits conflict, the guest sees the current
board and can retry.

Select a sticky note and click **Comment** below it. After someone replies,
the reply count in that spot opens the same conversation. Use a reply's **⋯**
menu to edit or delete it. Guests can manage their own replies during the live
session. The host can manage any reply, including after its author leaves.
Replies keep the original author label and show when the host edited them.
Conversations survive reload in the same tab and are included in saved projects
and Gist snapshots. The board link shares the diagram alone. Mini Flow keeps the
full comment history, and undoing a note deletion restores its comments.
A conversation keeps up to 200 messages, and each guest can post up to 20 comments a minute.

Participants see draft text, drag movement, and tool icons as they edit.
Live guests get a separate note color, and notes return to yellow when the
session ends.

## AI agents

AI agents with a shell, such as Claude Code, Codex, a local model, or your own script, join a
live session from their terminal. Nothing else needs to be hosted: agents reach your open board
tab through the live session's encrypted relay, the same one guests use.

1. Choose **Live session → Start live session**, then open **AI agents** and choose
   **Copy agent invite**.
2. Paste the invite into each agent. The agent downloads `mini-flow-agent.mjs` from this site,
   checks that it can reach the board, joins under a name, and listens. It needs Node.js 22 or newer.
3. Select a sticky note and choose **Ask AI**. The request goes to the agent chosen under
   **Ask AI sends to**, with the note, its latest 12 messages, and the board. Type a follow-up in
   the note conversation before choosing **Ask AI** to send it as the request.

Agents answer with `node mini-flow-agent.mjs … reply REQUEST_ID --file answer.txt`. Their answer
appears in the note conversation. To change the board, an agent adds a `mini-flow-edit` block with
edit operations. Mini Flow shows the change for you to apply or decline; turn off
**Review agent edits before they apply** to apply edits at once. The note shows whether the request
is waiting, which agent is working on it, and the result. Agent progress messages and failures
appear in the conversation. Use **Retry** on a failed request, or cancel a request from the
bottom-left activity list. **Stop agent** tells an agent to stop listening; its helper exits.

Agents that only run when their user sends them a message, such as pi or a chat app, cannot
wait for requests. Run the helper with a command that answers each request instead. It passes the
request on standard input and sends the command's output as the answer, for example with a local model:

```sh
node mini-flow-agent.mjs "INVITE" qwen run -- ollama run qwen3.8:27b-mlx --hidethinking
```

The canvas corner shows connected guests and AI agents; hover it to see which agents are listening.
**Ask AI** goes to the agent chosen under **Ask AI sends to**, otherwise to the first agent that is
listening. Agents choose their own names, so a local model may call itself Claude.

Keep the host tab open while agents work. Guests can use **Ask AI** too: the host's tab hands the
request to the agent, and everyone sees the status and the answer. A host reload in the same tab
keeps the agents and their open requests. Agents connect through the WebSocket relay, so a custom
relay must allow the board's address. Anyone with the agent invite can edit the board, so keep it private.

The helper downloads Mini Flow's own connection code from the board's site and checks each file
against `mini-flow-agent.json`. After changing a listed file, run `node tools/agent-manifest.mjs`.
`tests/agent-relay/agent-relay.e2e.cjs` runs an agent against the real relay; it is not part of CI.

## GitHub Gist backups

Open a saved project and expand **GitHub Gist backup** in Projects.

1. [Create a secret Gist](https://gist.github.com/). Add a starter file, choose
   **Create secret gist**, then paste its URL or ID into Mini Flow.
2. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new?name=Mini+Flow+Gist+backups&gists=write)
   from the account that owns the Gist. Grant **Account permissions → Gists →
   Read and write**. No repository permissions are needed.
3. Paste the token into Mini Flow and choose **Connect project**.

Use a dedicated Gist for each project. A connected project shows **Back up to
Gist**, **Open Gist**, and the last backup time in the project list. Each backup
saves a snapshot of that project and keeps the latest 100 in the Gist. Older
snapshots stay available in the Gist's revision history. New connections start with manual backups.
You can enable automatic checks every five minutes while the project is open.
Existing connections retain their previous automatic backup setting.

The token stays masked and is kept in the current tab's session storage so
you can keep backing up after reload. It is sent to GitHub for Gist API requests.
**Disconnect** stops backups from this project and clears the saved token.

On another machine, paste the Gist link and choose **Find backups**. Select a
snapshot to open it as a working copy. Use **Save as Project** to give it a local
name, then connect that project to the same Gist to continue backing up.
Anyone with the Gist link can read its backups. For joint editing, share a
live-session link. The host can back up the shared board with their own token.

When the host ends the session or a guest leaves, the guest can continue
editing their own copy. Mini Flow switches the guest's URL to a snapshot and
enables local Undo and Redo. During a connection interruption, guests can use
**Leave session** to keep editing a copy while the host is away.

Live sessions use p2p-core. A host reload in the same tab restores the board,
comments, invite, AI agents, and their open requests. Open guest tabs and agents reconnect.
**End session** clears recovery and closes the room explicitly.

To keep one saved project current across devices, connect it to the same Gist
on each device and enable **Sync this open project across devices**. Mini Flow
checks for updates every 20 seconds while the project is visible. Sync pauses
during live sessions and while the editor is busy. If the copies diverge, Mini
Flow pauses and lets you choose **Keep this board** or **Use latest cloud copy**.
Gist access and visibility are the same for sync and backups.


### Tests

CI runs every regression on each push and pull request:

```sh
node --test tests/live-session.test.mjs tests/parse.test.mjs tests/agents.test.mjs
npx playwright test
```

The Playwright suites run in Chromium and WebKit against `node tools/serve.mjs`:
`tests/editor.spec.cjs` covers the SDK, themes, phone layout, projects, Gist backups and edit links;
`tests/editing.spec.cjs` covers creating and connecting blocks, notes, bends, Auto layout,
keyboard history, the Mermaid source panel, exports, share links, projects, comments, the laser
and diagnostics; `tests/live.spec.cjs` runs real live sessions and AI agents between pages of one
browser. `tests/agent-relay/agent-relay.e2e.cjs` checks an agent over the public relay and is
run by hand.

### Diagnose a live connection

Open [Mini Flow with connection diagnostics enabled](https://mini-flow.kakkoi.dev/?debug=1),
start a live session, and send the invite from that session. The invite
enables diagnostics for the guest as well. After connecting or waiting
for the board, open **Live session → Connection diagnostics → Copy
diagnostics** on both devices. The console also logs a report at the
12-second wait, on connection, and when the session ends. Run
`JSON.stringify(miniFlowLiveDebug(), null, 2)` in the console for a fresh
snapshot.

The reports include browser and relay information, WebRTC negotiation, and
whether Mini Flow received the board. `browser.webRTCProbe` records whether
the peer connection API exists and can create a local data channel. The
reports omit invite credentials, board content, and raw ICE addresses.

### Optional WebSocket fallback for Safari

Safari builds or settings that leave WebRTC unavailable can join through an
optional WebSocket relay. Mini Flow can still be served by GitHub Pages.

1. Deploy the [Cloudflare relay using the deployment repository](https://github.com/KakkoiDev/p2p-core-cloudflare)
   on your Cloudflare account and add your Mini Flow site's HTTPS origin to
   `ALLOWED_ORIGINS`.
2. In `mini-flow-live.js`, set `liveRelayUrl` to the relay's `wss://` origin
   and redeploy Mini Flow. Every participant uses this same setting.
3. Start a new live session and open its invite in Safari. Check
   **Live session** for the WebSocket relay status and test an edit in each
   direction.

The hosted Mini Flow app uses the Cloudflare relay at
`wss://p2p-core-cloudflare.kakkoidev.workers.dev`. For your own deployment,
set `liveRelayUrl` to your relay URL or leave it empty to disable the fallback.
Mini Flow encrypts and authenticates application payloads in the browser with
AES-GCM. The key is derived from the private invite with HKDF. The relay sees
routing metadata. Anyone with the invite can join the room. Reload both sides
to use the encrypted protocol. You can reuse the relay for other p2p-core apps
by adding their origins to its allowlist.
