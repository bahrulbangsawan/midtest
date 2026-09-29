# MidTest desktop app

MidTest is a Tauri 2 desktop agent for AI-assisted application testing. The
React frontend connects to Codex or Claude over ACP, while the Rust backend
registers the Midscene MCP engine for browser and desktop automation.

MidTest is the product name. Midscene remains the underlying visual automation
engine and keeps its existing package names, MCP server name, tool prefixes,
and `MIDSCENE_*` configuration variables.

## Development

From the repository root:

```bash
npm install
npm install --prefix app
npm --prefix app run tauri -- dev
```

Configure the vision model in **Settings → Midscene / Vision Model**. API keys
saved there live in macOS Keychain, while non-secret endpoint/model choices
live in the application `settings.json`. Existing root `.env`
`MIDSCENE_MODEL_*` variables remain supported as a fallback. See
[`../midscene-mcp/README.md`](../midscene-mcp/README.md) for provider details.

## Verification

```bash
npm test --prefix app
npm run typecheck --prefix app
npm run build --prefix app
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
```

The Tauri bundle is named `MidTest`, uses the `com.midtest.desktop` identifier,
and includes the Midscene TypeScript runtime, its locked Node dependencies, and
`build-demo.js`. Node.js >=24 and the selected ACP adapter remain host
prerequisites. `MIDTEST_ROOT` is an optional source/runtime override; packaged
scenario data lives in the application's data directory rather than the app
bundle.
