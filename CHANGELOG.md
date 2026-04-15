# figma-local-mcp

## 0.1.0 (2026-04-15)

Initial release — forked from [Framelink MCP for Figma](https://github.com/GLips/Figma-Context-MCP).

### Features

* Consume Figma design data from local JSON files — no API key, no rate limits, no internet required
* Figma desktop plugin for exporting design data as JSON
* `get_figma_data_from_json` MCP tool for processing exported files
* Same extractor pipeline as Framelink MCP — identical simplified output
* Plugin features: custom filename, progress bar, cancel support, file size display

### Patch Changes

- 6e2c8f5: Minor bump, testing fix for hanging CF DOs

## 0.2.2-beta.0

### Patch Changes

- fd10a46: - Update HTTP server creation method to no longer subclass McpServer
  - Change logging behavior on HTTP server
