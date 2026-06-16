# Chart Artifacts MCP

Render Vega-Lite chart artifacts for Cynosure conversations.

## Tools

- `render_chart`: render a full Vega-Lite spec to SVG or PNG.
- `quick_chart`: build common bar, line, area, scatter, and pie charts from tabular data.

`render_chart` defaults to SVG because it stays sharp in the app. `quick_chart` defaults to high-resolution PNG for broad model-vision compatibility. PNG output is rendered from SVG with a configurable scale.

## Local Cynosure Setup

Build the server:

```bash
pnpm --filter @cynosure-mcp/chart-artifacts build
```

Add it in Cynosure MCP settings:

```text
Command: node
Args: /absolute/path/to/apps/chart-artifacts-mcp/dist/index.js
```

Optional environment:

```text
CHART_ARTIFACTS_OUTPUT_DIR=/path/to/chart-artifacts
```
