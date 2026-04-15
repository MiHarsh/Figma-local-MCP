# figma-local-mcp

## [0.3.0](https://github.com/MiHarsh/Figma-local-MCP/compare/v0.2.0...v0.3.0) (2026-04-15)


### Features

* add figma-plugin zip to GitHub Releases ([67a6c17](https://github.com/MiHarsh/Figma-local-MCP/commit/67a6c1752f0cf9fa95f0831cd95d706eaf1163e2))

## [0.2.0](https://github.com/MiHarsh/Figma-local-MCP/compare/v0.1.0...v0.2.0) (2026-04-15)


### ⚠ BREAKING CHANGES

* switch to stateless HTTP transport ([#304](https://github.com/MiHarsh/Figma-local-MCP/issues/304))
* getServerConfig() no longer takes an isStdioMode parameter. It now detects stdio mode internally and returns it as part of ServerConfig.

### Features

* add --image-dir config for image download path control ([#297](https://github.com/MiHarsh/Figma-local-MCP/issues/297)) ([0417766](https://github.com/MiHarsh/Figma-local-MCP/commit/0417766eb5fc1e0b76e55da497961f9aee2f62f7))
* add anonymous PostHog telemetry ([#342](https://github.com/MiHarsh/Figma-local-MCP/issues/342)) ([6c0666a](https://github.com/MiHarsh/Figma-local-MCP/commit/6c0666a7c96e62b39f730a96d24eacb8f3a35cf6))
* add component property support (BOOLEAN & TEXT) ([#340](https://github.com/MiHarsh/Figma-local-MCP/issues/340)) ([b0f9efc](https://github.com/MiHarsh/Figma-local-MCP/commit/b0f9efcc0680012eac4a760ec6826a7605b38fb6))
* add Figma plugin for offline export and get_figma_data_from_json MCP tool ([7cf0033](https://github.com/MiHarsh/Figma-local-MCP/commit/7cf003365c442bdc3358d319dff8a37a87cc8b07))
* add progress notifications and async tree walker ([#305](https://github.com/MiHarsh/Figma-local-MCP/issues/305)) ([b5724ad](https://github.com/MiHarsh/Figma-local-MCP/commit/b5724ade8234e73fe94467c6bfad5e020552f0e2))
* add proxy support for managed networks ([#338](https://github.com/MiHarsh/Figma-local-MCP/issues/338)) ([32d5779](https://github.com/MiHarsh/Figma-local-MCP/commit/32d57790317e57a35dfc8df0de4c6ac830268b31))
* add support for using as a CLI via `fetch` subcommand to retrieve design data directly ([#331](https://github.com/MiHarsh/Figma-local-MCP/issues/331)) ([dd237c8](https://github.com/MiHarsh/Figma-local-MCP/commit/dd237c8e87565cee42d706b8f374fc4bc411066b))
* Extracting global variables ([bb52df2](https://github.com/MiHarsh/Figma-local-MCP/commit/bb52df2835a7d34b588ab553e8807ff4c1a3d356))
* Extracting global variables ([03143b8](https://github.com/MiHarsh/Figma-local-MCP/commit/03143b834385176b474bed22660120dd36a86970))
* Include component and component set names to help LLMs find pre-existing components in code ([#122](https://github.com/MiHarsh/Figma-local-MCP/issues/122)) ([60c663e](https://github.com/MiHarsh/Figma-local-MCP/commit/60c663e6a83886b03eb2cde7c60433439e2cedd0))
* replace yargs with cleye for CLI flag parsing ([#285](https://github.com/MiHarsh/Figma-local-MCP/issues/285)) ([0092ee7](https://github.com/MiHarsh/Figma-local-MCP/commit/0092ee789fce01b9ef1dab5e8f32c52e71107dbb))
* **security:** add input validation to download images tool ([#207](https://github.com/MiHarsh/Figma-local-MCP/issues/207)) ([651974e](https://github.com/MiHarsh/Figma-local-MCP/commit/651974e6f31a3b60b863dab12e69029c710dd1c0))
* **security:** add path sanitization to prevent directory traversal ([#206](https://github.com/MiHarsh/Figma-local-MCP/issues/206)) ([5a18eef](https://github.com/MiHarsh/Figma-local-MCP/commit/5a18eef889b0449894e835f71b15786e4e36dd10))
* support gifRef for downloading animated GIF embeds ([#286](https://github.com/MiHarsh/Figma-local-MCP/issues/286)) ([f1ec913](https://github.com/MiHarsh/Figma-local-MCP/commit/f1ec9133c31a351b55651126c20ea2f842c0a9ee))


### Bug Fixes

* add actionable 403 error message with troubleshooting link ([9230bd0](https://github.com/MiHarsh/Figma-local-MCP/commit/9230bd02a63085d88ca5d3687275f2cba9557309))
* Cannot find module '~/transformers/layout' ([7432d6c](https://github.com/MiHarsh/Figma-local-MCP/commit/7432d6ca28796327aec9f4fdd4b2948b95b49a08))
* Cannot find module '~/transformers/layout' ([82a52f7](https://github.com/MiHarsh/Figma-local-MCP/commit/82a52f7e4b349268995633f229e03ee034cce8b5))
* disambiguate named styles with duplicate names ([#319](https://github.com/MiHarsh/Figma-local-MCP/issues/319)) ([a077ace](https://github.com/MiHarsh/Figma-local-MCP/commit/a077ace9809bf6b14c4e4a9906065fb3cea2d24f))
* enhance fetchWithRetry to handle error statuses in response body ([803a479](https://github.com/MiHarsh/Figma-local-MCP/commit/803a479c2a3f0e8b8636f498728b5aaca2e30580))
* Fix bug where MCP cannot be invoked by cursor 0.45.11 ([dbea364](https://github.com/MiHarsh/Figma-local-MCP/commit/dbea36451cbf68f6d1dd814fed01743a1fdd27f4))
* handle drive root paths in image directory security check ([#301](https://github.com/MiHarsh/Figma-local-MCP/issues/301)) ([9f32616](https://github.com/MiHarsh/Figma-local-MCP/commit/9f32616caa29b1dbdd5c5a9dcfafa3dd717070a3))
* include BOOLEAN_OPERATION in SVG container collapse ([354679e](https://github.com/MiHarsh/Figma-local-MCP/commit/354679eab17389c551a435ca7c5224a250446301))
* include BOOLEAN_OPERATION in SVG container collapse ([19c50b3](https://github.com/MiHarsh/Figma-local-MCP/commit/19c50b3ad3ecf12ce4b4bedc0aefff718b3b89f9))
* **layout:** suppress computed gap values when using SPACE_BETWEEN ([#341](https://github.com/MiHarsh/Figma-local-MCP/issues/341)) ([309c60e](https://github.com/MiHarsh/Figma-local-MCP/commit/309c60e6d59eb2fb8fdc0acc85dd81b1644b1f12)), closes [#169](https://github.com/MiHarsh/Figma-local-MCP/issues/169)
* Make sure LLM provides a filename extension when calling download_figma_images ([00bad7d](https://github.com/MiHarsh/Figma-local-MCP/commit/00bad7dae48a6d0cc55d78560cc691a39271f151))
* README.zh-tw typo ([#236](https://github.com/MiHarsh/Figma-local-MCP/issues/236)) ([c65c25c](https://github.com/MiHarsh/Figma-local-MCP/commit/c65c25c16f19c7f05c05f976b26cc5fbd2bcb19a))
* Remove empty keys from simplified design output ([#106](https://github.com/MiHarsh/Figma-local-MCP/issues/106)) ([4237a53](https://github.com/MiHarsh/Figma-local-MCP/commit/4237a5363f696dcf7abe046940180b6861bdcf22))
* remove inline release-type so release-please reads config file ([a03cd68](https://github.com/MiHarsh/Figma-local-MCP/commit/a03cd68826da1c1596273a223a612eb919832397))
* replace jimp with selective @jimp/* imports to fix ESM crash ([#333](https://github.com/MiHarsh/Figma-local-MCP/issues/333)) ([dd47ebf](https://github.com/MiHarsh/Figma-local-MCP/commit/dd47ebf82520c6147b913415db99c3b4caaa40b2)), closes [#329](https://github.com/MiHarsh/Figma-local-MCP/issues/329)
* replace sharp dependency with js-native jimp for image manipulation ([#289](https://github.com/MiHarsh/Figma-local-MCP/issues/289)) ([62b9f94](https://github.com/MiHarsh/Figma-local-MCP/commit/62b9f94b1607dd08daeaa90e8ace0a896fe6eb50))
* Replaced the NODE_ENV setting with cross-env to improve cross-platform compatibility. ([#19](https://github.com/MiHarsh/Figma-local-MCP/issues/19)) ([a0eeed5](https://github.com/MiHarsh/Figma-local-MCP/commit/a0eeed588002915df1489346880372a5896b3fdb))
* skip jimp processing for SVGs and prevent image-fill collapse ([#298](https://github.com/MiHarsh/Figma-local-MCP/issues/298)) ([a4a4b13](https://github.com/MiHarsh/Figma-local-MCP/commit/a4a4b13ec7cae5d603022b1c8719cc717749195b))
* throw actionable error for missing nodes, add error_category to telemetry ([#344](https://github.com/MiHarsh/Figma-local-MCP/issues/344)) ([334ae2b](https://github.com/MiHarsh/Figma-local-MCP/commit/334ae2bbecbd3583922098787877448337acf6cb))
* update Node ID regex to support additional formats in download i… ([#227](https://github.com/MiHarsh/Figma-local-MCP/issues/227)) ([68fbc87](https://github.com/MiHarsh/Figma-local-MCP/commit/68fbc87645d25c57252d4d9bec5f43ee4238b09f))
* upgrade MCP SDK to 1.27.1 and modernize tool registration ([#282](https://github.com/MiHarsh/Figma-local-MCP/issues/282)) ([4153e5f](https://github.com/MiHarsh/Figma-local-MCP/commit/4153e5f857aa708ee9ee10156e553c1289f03cf7))
* use Node 24 in release workflow for npm OIDC support ([11ba7c6](https://github.com/MiHarsh/Figma-local-MCP/commit/11ba7c6a2e22910c483592ba7cdc1966fcdc9166))


### Performance Improvements

* fix O(n²) bottlenecks in simplification and YAML serialization ([#307](https://github.com/MiHarsh/Figma-local-MCP/issues/307)) ([29cff0c](https://github.com/MiHarsh/Figma-local-MCP/commit/29cff0cbd6d2fd0459900e9c3cbc49f64e47075d))


### Code Refactoring

* switch to stateless HTTP transport ([#304](https://github.com/MiHarsh/Figma-local-MCP/issues/304)) ([9dfb1cb](https://github.com/MiHarsh/Figma-local-MCP/commit/9dfb1cb65a081655d7dca5f076ab76f5d7e9edc0))

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
