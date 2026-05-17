# Framelink Exporter — Figma Plugin

Companion plugin for [**figma-local-mcp**](https://github.com/MiHarsh/figma-local-mcp) — exports Figma design data + assets (PNG renders, SVG icons, image-fill bytes) as a single `.zip` so AI coding agents can consume your designs without an API key, OAuth dance, or rate limits.

> **Heads up:** this plugin is the *producer*. The `.zip` it generates is meant to be unzipped into your repo and read by the MCP server. You need both pieces installed.

🎨 **Figma Community:** <https://www.figma.com/community/plugin/1626137893880787983/framelink-exporter>
📦 **MCP server:** [`figma-local-mcp`](https://www.npmjs.com/package/figma-local-mcp) on npm
🐙 **Source / issues:** https://github.com/MiHarsh/figma-local-mcp

---

## Quick start

### 1. Install the MCP server

```bash
npm install -g figma-local-mcp     # or use npx in your client config
```

### 2. Add it to your AI client

<details><summary><b>Cursor / Cline / Claude Desktop (MCP config snippet)</b></summary>

```jsonc
{
  "mcpServers": {
    "figma-local": {
      "command": "npx",
      "args": ["-y", "figma-local-mcp", "--stdio"]
    }
  }
}
```

Restart the client. You should see three new tools: `get_figma_data_from_json`, `get_node_image`, `get_node_svg`.
</details>

### 3. Install this plugin in Figma

**Option A: Install from the Figma Community (recommended)** — zero build, auto-updates.

Open the plugin's Community page: <https://www.figma.com/community/plugin/1626137893880787983/framelink-exporter> → click **Open in…** to add it to your Figma. It will appear under **Plugins → Framelink Exporter** in every file.

**Option B: Build & sideload from source** (useful for development)

```bash
cd figma-plugin
npm install
npm run build
```

Then in the Figma desktop app: **Plugins → Development → Import plugin from manifest…** → pick `figma-plugin/manifest.json`.

### 4. Export → unzip → ask your agent

1. Run **Plugins → Development → Framelink Exporter**
2. Select the frames you want to export
3. Click **Export as ZIP** → unzip into your repo (e.g. `./design/`)
4. In your AI client:
   > *"Build a React component matching `./design/myfile.json`"*

The agent calls `get_figma_data_from_json` → reads the manifest → calls `get_node_image` for ground truth → calls `get_node_svg` for icons → generates code with the actual rendered design as a reference.

---

## How it works

The plugin serializes the Figma node tree into the exact JSON shape that the Figma REST API returns (`GetFileNodesResponse` for selected nodes, `GetFileResponse` for full-page exports), with a `framelinkExport` metadata block at the root carrying an asset manifest.

When asset export is enabled (default), the plugin packages the JSON + an `<filename>.assets/` folder of sidecar files into a single `.zip` download.

## Export options

- **Scope**
  - *Export selected nodes* — produces `GetFileNodesResponse` shape
  - *Export current page* — produces `GetFileResponse` shape
- **Assets**
  - *Render selected frames as PNG (@2x)* — top-level frames are rendered for visual grounding
  - *Export icon subtrees as SVG* — vector-only subtrees are rendered as actual SVG markup (no path-data reconstruction needed)
  - *Include image-fill bytes* — raster fills referenced by `imageRef` are saved as PNG bytes
- **Limit traversal depth** — caps how many levels deep the tree serialization goes

## What gets exported

Everything Framelink's extractors consume, plus the new asset references the MCP wires into the simplified output:

- **Layout** — `absoluteBoundingBox`, `constraints`, auto-layout (`layoutMode`, `itemSpacing`, `padding*`, sizing modes)
- **Visuals** — `fills`, `strokes`, `effects`, `opacity`, `cornerRadius`, `blendMode`, `clipsContent`
- **Per-node named-style references** — the `styles` map (`{fill, text, effect, stroke}` → styleId) so the extractor can resolve design-system style names
- **Text** — `characters`, `style` (font, size, weight, alignment, line height), `styleOverrideTable`
- **Components** — `componentProperties`, `componentPropertyDefinitions`, `componentId`, plus cross-scope component metadata for instances whose main component lives outside the export scope
- **Structure** — Full node tree with `id`, `name`, `type`, `visible`, `children`

### Asset manifest (`framelinkExport`)

A top-level `framelinkExport` block carries metadata + the asset manifest:

```jsonc
{
  "framelinkExport": {
    "pluginVersion": "1.3.0",
    "exportedAt": "2026-05-17T...",
    "scope": "selection",
    "depth": null,
    "fileName": "MyDesignFile",
    "pageId": "0:1",
    "pageName": "Page 1",
    "rootNodeIds": ["1:23"],
    "assetsFolder": "design.assets",
    "assets": {
      "1:23": { "image": "design.assets/node_1_23.png", "imageScale": 2 },
      "5:67": { "svg":   "design.assets/icon_5_67.svg" }
    },
    "imageFills": {
      "abc123...": "design.assets/image_abc123.png"
    },
    "errors": [
      {
        "id": "3821:98370",
        "name": "Copilot Drawer",
        "type": "INSTANCE",
        "path": "Page 1 › Frame 12 › Copilot Drawer",
        "message": "componentProperties getter threw: Component set for node has existing errors"
      }
    ],
    "options": { "exportFrameImages": true, "exportSvgs": true, "exportImageFills": true }
  }
}
```

The `errors` array (added in 1.3.0) lists nodes that were replaced by lightweight stubs because a Figma API call threw on them — most commonly broken remote library component sets. The export as a whole still succeeds; only the broken subtree is skipped. The MCP server surfaces these so the agent knows what's missing.

The MCP server reads this block and:
- stamps `imagePath` / `svgPath` / `renderHint` onto matching nodes in the simplified output
- resolves `componentId` → `componentName` + heuristic `semanticRole` (button, textbox, dropdown, …) on every INSTANCE so generated code uses semantic markup
- injects local `assetPath` into image-fill style entries
- emits a top-level `REQUIRED_NEXT_ACTIONS` checklist telling the agent which `get_node_image` / `get_node_svg` calls to make

## Development

```bash
npm run watch   # Rebuild on file changes
```

After editing, reload the plugin in Figma (right-click in the plugin menu → **Run last plugin** or re-open it).

## Release notes

### 1.3.0 — performance & resilience

**Performance**

- **Smart SVG candidate filtering.** Vector-only subtrees are pre-filtered before `exportAsync` using `absoluteRenderBounds` + a complex-vs-simple primitive classifier. Files that previously sent 1200+ candidate nodes to the renderer (mostly invisible / zero-area / single trivial shapes) now send only the ~20 that produce real SVG output. Asset phase is ~50× faster on icon-heavy files.
- **Parallel asset exports.** PNG renders (concurrency 3), SVG renders (6), and image-fill byte fetches (6) now run through a bounded worker pool instead of sequentially.
- **O(n) SVG root detection.** Replaced a quadratic upward-walk with a single bottom-up pass; dropped a redundant `getNodeByIdAsync` round-trip per icon.
- **Yield throttling.** Tree serialization yields to Figma's event loop every 500 nodes instead of after every node (the per-node `setTimeout(0)` was clamped to 4–10 ms each, dominating wall time on large pages).
- **`mainComponentCache`** — `getMainComponentAsync` is called once per unique main component, not once per `INSTANCE`.

**Resilience**

- **Broken component sets no longer kill the export.** Getters like `instance.componentProperties` and `getMainComponentAsync` can throw on instances whose remote library has structural errors. Each is now wrapped individually; the failing instance becomes an error stub with a structured diagnostic, and the rest of the tree exports normally.
- **`framelinkExport.errors`** — a new top-level array listing every skipped node (id, name, type, ancestor path, error message). The MCP server reads this so your agent knows which subtrees are incomplete.
- **Rich broken-instance diagnostics.** When an instance fails, the dev console gets a JSON dump that probes each related getter individually (variantProperties, componentProperties, overrides, main component, component set, property definitions) so the root cause is obvious.

**UX**

- **Instant Export → Cancel button swap.** A double `requestAnimationFrame` defers the sandbox work by one paint frame, guaranteeing the UI updates before the export blocks. Shows "Preparing export…" immediately on click.
- **Skipped-nodes toast.** Success toast surfaces up to 5 example skipped nodes with a pointer to `framelinkExport.errors`.

**Debug**

- Structured logs at every phase boundary with timings.
- Per-asset-type byte totals (PNG / SVG / image fills).
- New filter-ratio log line: `assets/svg: 23 worth exporting (filtered out 1222 of 1245 candidates: invisible / zero-area / single-trivial-primitive) in 18ms`.

### 1.2.0

- Initial public release on the Figma Community.
- JSON export (selection or full page) mirroring the Figma REST API shape.
- Asset export: PNG frame renders, SVG icon subtrees, image-fill bytes.
- Inline ZIP packager with custom filename, progress bar, cancel button.

## Project structure

```
figma-plugin/
├── manifest.json       # Figma plugin manifest
├── package.json
├── tsconfig.json
├── build.mjs           # esbuild build (target: es2017 — Figma sandbox safe)
├── src/
│   ├── code.ts         # Plugin sandbox: node serialization + asset rendering
│   └── ui.html         # Plugin UI: export controls + inline ZIP packager
└── dist/               # Build output (git-ignored)
    ├── code.js
    └── ui.html
```

## License

MIT — same as the parent [figma-local-mcp](https://github.com/MiHarsh/figma-local-mcp) project.
