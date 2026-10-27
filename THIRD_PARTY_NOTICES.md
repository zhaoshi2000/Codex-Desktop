# Third-party provenance and notices

This source distribution contains a newly implemented UI, local service and protocol adapter. It does not contain the complete CC Switch repository, the proprietary Codex desktop GUI, or precompiled OpenAI/Electron binaries.

## CC Switch

- Upstream: https://github.com/farion1231/cc-switch
- Examined revision: 51ac86f1c59abfefabadebd05ec5a5415b8ad72c (repository search result at development time).
- Relevant files: src/types.ts; src/components/providers/forms/hooks/useCodexConfigState.ts.
- Integration: independently implemented compatibility with Codex Provider.settingsConfig = {auth, config}, default-model and model-catalog conventions. The Rust/Tauri backend, routing engine and marketplace are not bundled.
- License: MIT, Copyright (c) 2025 Jason Young. Preserved in licenses/CC-SWITCH-MIT.txt.

## OpenAI Codex

- Upstream: https://github.com/openai/codex
- Protocol target: rust-v0.162.1 (Codex 0.162.1).
- Relevant source: codex-rs/app-server-protocol/schema/typescript/v2/{ThreadStartParams,TurnStartParams,SandboxMode,SandboxPolicy}.ts and codex-cli/bin/codex.js.
- Official documentation: https://developers.openai.com/codex/app-server ; https://developers.openai.com/codex/config-reference
- Integration: calls the separately installed official native binary over stdio. The source zip does not include that binary or a copied Codex codebase. Install scripts acquire the official package only when explicitly run.
- License: Apache-2.0. A copy of the license is in licenses/CODEX-APACHE-2.0.txt. When redistributing builds containing the native package, retain its original license, NOTICE and bundled dependency notices as supplied by the package.

## Electron / build tools

- Electron: https://www.electronjs.org/ ; package pinned to 44.7.2.
- electron-builder: https://www.electron.build/ ; package pinned to 26.0.12.
- These dependencies are downloaded only when npm install is run. Their binaries and transitive dependencies are not contained in this source distribution. Preserve their own notices when publishing built installers; the license of this project's source does not replace those notices.

All third-party trademarks belong to their respective owners. AstroGate Codex is an independent client, not an official OpenAI or CC Switch product. Screenshot-inspired model labels are UI presets, not an assertion of model ownership, availability or access.
