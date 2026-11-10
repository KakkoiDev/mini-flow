# Mini Flow

Open index.html in a browser. The demo and library work offline.
To serve locally, run `python3 -m http.server 8765 --bind 127.0.0.1` in this directory and open http://127.0.0.1:8765/.

- Scroll to zoom and drag empty canvas to pan. Use Fit to bring the diagram back into view.
- Click a shape or arrow to edit its label in place. Enter adds a line break. Click away to save.
- Use Code & export to open or hide the side panel.
- The demo saves each edit in browser storage and in the URL fragment. Copy link shares the current diagram and shape positions.
- Pick a terminal, step, or decision, then click the canvas to place it. Drag shapes to arrange them.
- Enable Snap to grid to align placed and dragged shapes to the 16 px grid.
- Click Connect, then choose the source and destination.
- Select any shape or arrow and edit its label. Delete removes the selection
  and any arrows attached to a deleted shape.
- In Mermaid source, use Refresh source to export and Apply source to import.
  Paste the exported text into https://mermaid.live/ for Mermaid's own layout.

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
node. Mermaid export stores labels and connections. Canvas positions are session
state. Applying source preserves positions for matching node IDs and places
new nodes below the existing diagram.

Mermaid syntax and the text-editor workflow come from the Mermaid project and
its MIT-licensed Mermaid Live Editor (https://github.com/mermaid-js/mermaid-live-editor).
Mini Flow uses an independent SVG canvas and has no runtime dependencies.

Copy Mermaid in the source panel, or copy Markdown, SVG markup, or PNG in
Export. PNG clipboard support depends on the browser.

With focus in the editor, use 1 for Start / End, 2 for Step, 3 for Decision,
4 for Connect, and Backspace to delete the selection.
