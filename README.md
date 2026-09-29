# MidTest

<div align="center">
  <img src="logo/midtest-wordmark.png" alt="MidTest" width="480"/>
  <p><strong>AI-powered desktop agent for automated QA testing and interactive product walkthrough generation</strong></p>

  [![Tauri 2](https://img.shields.io/badge/Tauri-2.0-blue.svg)](https://tauri.app/)
  [![React 19](https://img.shields.io/badge/React-19.0-61DAFB.svg)](https://react.dev/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
  [![Rust](https://img.shields.io/badge/Rust-2021-orange.svg)](https://www.rust-lang.org/)
  [![Midscene](https://img.shields.io/badge/Midscene-1.10.8-green.svg)](https://midscenejs.com/)
  [![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-purple.svg)](https://modelcontextprotocol.io/)
  [![License](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)
</div>

---

## Overview

**MidTest** is an AI-driven desktop application built with **Tauri 2** and **React 19** that integrates conversational coding agents (**Codex** or **Claude Code**) with **Midscene**, a visual-language-model (VLM) automation engine.

Through natural language chat, users can direct the agent to explore user journeys across web and desktop interfaces. MidTest produces two primary artifacts:

1. **Replay-ready QA Scenarios (YAML)**: Deterministic, repeatable test scripts that can be executed with automated caching and budget guards.
2. **Interactive Walkthroughs (HTML)**: Self-contained product demo guides and documentation with captured screenshots and step-by-step visual explanations.

### Dual-AI Architecture

MidTest cleanly separates reasoning and UI grounding across two distinct AI layers:

- **ACP Agent (Codex / Claude)**: Runs locally as an Agent Client Protocol (ACP) adapter. It handles high-level reasoning, test planning, user interaction, and tool orchestration.
- **Midscene Vision Model (VLM)**: Dedicated visual model (e.g. Qwen-VL, Gemini, Doubao, UI-TARS) that parses UI screenshots into actionable coordinates and semantic elements. Uses your own VLM API key configured in `.env` or the application Settings.

---

## Architecture

```text
User
 │
 ▼
React 19 + TanStack AI (`app/src`)
 │   ▲
 │   │ Tauri Commands & AG-UI Streaming Events
 ▼   │
Tauri 2 Rust Backend (`app/src-tauri`)
 │
 ├── Stdio JSON-RPC
 ▼
ACP Adapter (Codex ACP / Claude Agent ACP)
 │
 ├── Registers MCP Server via Stdio
 ▼
Midscene MCP Server (`midscene-mcp`)
 ├── Target Web: Puppeteer + Google Chrome
 ├── Target Computer: macOS native desktop automation
 ├── Replayable YAML Scenarios + Smart Visual Cache
 └── Report Extraction (`build-demo.js`) → Self-contained Walkthrough HTML
```

---

## Features

- **Conversational Testing Workflow**: Chat naturally with Codex or Claude to navigate, test, and validate complex application flows.
- **Dual Automation Targets**:
  - `web`: Direct browser control via Puppeteer & Chrome.
  - `computer`: Native macOS UI automation with mouse, keyboard, and screen capture.
- **10 Dedicated MCP Automation Tools**: Comprehensive toolkit including `act`, `query`, `assert`, `screenshot`, `save_scenario`, and `run_scenario`.
- **Intelligent Visual Caching**: Midscene's visual caching reuses coordinate mappings across test runs, significantly reducing VLM API calls and test execution times.
- **Budget Guarding**: Per-session AI operation limits protect against runaway loops and unexpected token usage.
- **Interactive Walkthrough Generation**: Generates standalone, visually rich HTML guides (`.demo.html`) from test executions.
- **Modern Desktop Experience**:
  - Live streaming responses with Markdown and reasoning blocks.
  - Interactive tool call inspections.
  - Multi-workspace and thread management.
  - Dynamic model selection per provider.
  - Granular permission dialogs with timeout handling and optional full-access mode.
  - Secure credential storage in macOS Keychain with `.env` fallback.

---

## Repository Structure

```text
midtest/
├── app/                  # Tauri 2 Desktop Application
│   ├── src/              # React 19 frontend (Vite, Tailwind, TanStack AI, Radix UI)
│   └── src-tauri/        # Rust backend (Tokio, ACP client, settings, command bridge)
├── midscene-mcp/         # Standalone Model Context Protocol (MCP) server
│   ├── src/              # MCP server, session manager, tools, and device adapters
│   └── test/             # Comprehensive unit and integration test suite (112 tests)
├── logo/                 # MidTest brand assets and visual identity
├── scripts/              # Automation and recording utility scripts
├── docs/                 # Architectural specifications, plans, and E2E notes
├── build-demo.js         # Walkthrough HTML report generator
├── demo-registrasi.mjs   # Direct Midscene browser demonstration script
├── example.ts            # Desktop automation example script
├── .env.example          # Template for VLM provider and environment configuration
└── package.json          # Root workspace configuration and test scripts
```

---

## Prerequisites

- **macOS** (currently required for desktop automation target; web automation runs Chrome).
- **Node.js >= 24** (leverages Node's native TypeScript execution/type stripping; no separate build step for MCP).
- **Rust toolchain** (latest stable) for building the Tauri backend.
- **Google Chrome** installed (used by Puppeteer for web target).
- **ACP Agent Adapter** (install at least one globally):
  ```bash
  npm install -g @agentclientprotocol/codex-acp
  # or
  npm install -g @agentclientprotocol/claude-agent-acp
  ```
- **Vision-Language Model (VLM) API Key**:
  Compatible with Midscene VLM families: `qwen2.5-vl`, `qwen3-vl`, `gemini`, `doubao-vision`, `vlm-ui-tars`, `gpt-5`, `glm-v`, `kimi`, etc.

---

## Quick Start

### 1. Clone & Install Dependencies

MidTest uses npm workspaces for the root and MCP server, with a dedicated installation for the Tauri frontend:

```bash
git clone https://github.com/bahrulbangsawan/midtest.git
cd midtest

# Install root dependencies & midscene-mcp workspace
npm install

# Install Tauri app dependencies
npm install --prefix app
```

### 2. Configure Environment

Copy the example environment configuration:

```bash
cp .env.example .env
```

Edit `.env` to configure your VLM provider credentials:

```dotenv
MIDSCENE_MODEL_BASE_URL="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
MIDSCENE_MODEL_API_KEY="your-api-key"
MIDSCENE_MODEL_NAME="qwen2.5-vl-72b-instruct"
MIDSCENE_MODEL_FAMILY="qwen2.5-vl"
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
MIDSCENE_MCP_BUDGET=40
```

> **Note:** API keys can also be entered directly in the desktop app under **Settings → Midscene / Vision Model**, where they are stored securely in macOS Keychain.

### 3. Launch Development Mode

Start the Tauri desktop app:

```bash
npm --prefix app run tauri -- dev
```

---

## MCP Tools Reference

The `midscene-mcp` server provides 10 tools accessible to ACP agents and any MCP-compliant client:

| Tool | Description |
|---|---|
| `start_session` | Opens an automation session for target `web` (Chrome) or `computer` (macOS desktop). |
| `act` | Executes UI actions using natural language instructions (click, type, scroll, drag). |
| `query` | Extracts structured data from the current screen using visual comprehension. |
| `assert` | Asserts conditions on the screen (verifies element existence, text, state). |
| `screenshot` | Captures a high-resolution screenshot without consuming AI operation budget. |
| `end_session` | Terminates the active session and releases browser or desktop resources. |
| `save_scenario` | Persists proven interaction steps into a reusable YAML scenario file. |
| `list_scenarios` | Lists saved test scenarios available for replay. |
| `run_scenario` | Executes a saved scenario with budget tracking and visual cache acceleration. |
| `build_walkthrough` | Compiles session reports into a standalone interactive HTML walkthrough. |

---

## Development & Verification

MidTest includes comprehensive automated tests across all components:

```bash
# Run all unit and integration tests (MCP + Frontend)
npm test

# Run TypeScript typechecks across all workspaces
npm run typecheck

# Build the frontend bundle
npm run build --prefix app

# Run Tauri Rust backend unit tests
cargo test --manifest-path app/src-tauri/Cargo.toml

# Run Rust linter
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
```

---

## Security & Privacy

- **No Credential Proxying**: Codex and Claude authentication is handled directly by your local CLI installations. MidTest never intercepts, proxies, or stores agent subscription credentials.
- **Keychain Storage**: Sensitive VLM API keys configured in the UI are stored securely in the native macOS Keychain via `security-framework`.
- **Local Stdio Communication**: All ACP and MCP communication occurs over local stdio pipes.
- **Permission Gatekeeper**: The app prompts before actions that modify files, run commands, or execute tests, with automatic timeout fallbacks.

---

## License

This project is licensed under the [ISC License](LICENSE).
