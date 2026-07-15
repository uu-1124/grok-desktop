# Engineering boundaries

- Correctness, security and Grok CLI compatibility take priority over visual refactors.
- Keep Grok as an external runtime. Never copy, patch, replace or redistribute `grok.exe`.
- ACP is the product API; PTY is a compatibility fallback and must not become the data model.
- Renderer code must not import Node.js or Electron modules.
- Preload exposes only the typed methods in `src/shared/contracts.ts`.
- Never persist credentials, complete prompts, tool results or Grok session files.
- Spawn executables directly with argument arrays. Do not use shell command interpolation.
- Discover models, modes and extensions from ACP responses; do not hard-code current Grok values.
- Preserve permission prompts. Unknown or failed permission decisions default to cancellation.
- Keep changes scoped to the relevant module and add focused tests for protocol/state changes.
