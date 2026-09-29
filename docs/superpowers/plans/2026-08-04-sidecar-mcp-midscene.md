# Rencana Implementasi: Verifikasi + Sidecar MCP Midscene

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun MCP server Node yang membungkus Midscene, sehingga agen ACP mana pun (Codex, Claude Code, atau Zed) dapat menjalankan skenario QA dan membangun walkthrough berbahasa Indonesia — tanpa memerlukan aplikasi Tauri.

**Architecture:** Satu paket Node berdiri sendiri di `midscene-mcp/`. Server MCP berbicara stdio. Semua operasi Midscene disembunyikan di balik antarmuka `Device` sehingga seluruh kontrak tool dapat diuji dengan device palsu — tanpa browser, tanpa VLM, tanpa biaya. Adapter nyata (`computer` dan `web`) hanya dipakai di jalur integrasi manual.

**Tech Stack:** Node 26, TypeScript dijalankan langsung lewat type stripping bawaan Node (tanpa build step), `@modelcontextprotocol/sdk`, `@midscene/computer`, `@midscene/web`, test dengan `node:test` bawaan.

## Global Constraints

- Node `>=24` — type stripping bawaan tanpa flag. Mesin pengembangan: v26.5.1.
- **Tanpa build step.** Sumber `.ts` dijalankan langsung oleh `node`. Import antar-berkas wajib menyertakan ekstensi `.ts`.
- Type stripping bukan type checking. `tsc --noEmit` dijalankan terpisah sebagai script `typecheck`.
- Tanpa framework test. Hanya `node:test` dan `node:assert/strict`.
- `midscene-mcp/` **tidak boleh** mengimpor apa pun yang berkaitan dengan Tauri, ACP, atau React.
- `build-demo.js` di root **tidak boleh diubah**. Sidecar membungkusnya, tidak menyuntingnya.
- Deskripsi tool MCP ditulis dalam **bahasa Inggris** — itu dibaca model. README dan dokumentasi pengguna ditulis dalam **bahasa Indonesia**.
- `.env` tidak pernah dibaca oleh sidecar secara langsung; konfigurasi model datang dari environment proses yang memanggilnya.
- Setiap task diakhiri commit.

---

### Task 1: Verifikasi asumsi Tahap 0

Task ini adalah investigasi, bukan TDD. Deliverable-nya adalah dokumen temuan yang menentukan bentuk Rencana 2.

**Files:**
- Create: `docs/superpowers/notes/2026-08-04-verifikasi-tahap-0.md`

- [ ] **Step 1: Install Codex CLI dan periksa mode ACP**

Login bersifat interaktif, jadi jalankan sendiri di sesi ini dengan awalan `!`:

```
! npm install -g @openai/codex && codex --version && codex --help
```

### TERJAWAB — dijalankan 2026-08-04 pada `codex-cli` 0.146.0

**Codex TIDAK punya mode ACP native.** Tidak ada subcommand `acp`. Yang tersedia:
`mcp` (mengelola server MCP eksternal lewat config), `mcp-server` (Codex *sebagai*
server MCP), dan `app-server` (eksperimental, **protokol milik Codex sendiri**, bukan ACP —
punya `generate-json-schema` dan `generate-ts` tersendiri).

ACP datang dari **adapter terpisah**, persis seperti sisi Claude:
`@agentclientprotocol/codex-acp` 1.1.9, binary `codex-acp`.
Paket lama `@zed-industries/codex-acp` 0.16.0 sudah deprecated dengan pesan yang sepola:
*"This package has been replaced by @agentclientprotocol/codex-acp."*

Konsekuensi untuk desain: **dua-duanya adapter yang mengemudikan CLI lokal milik pengguna.**
Ini justru memperkuat argumen kepatuhan ToS di spec, bukan melemahkannya — aplikasi tetap
sekadar ACP client, dan login tetap terjadi di `codex login` milik pengguna.

Prasyarat yang harus dideteksi aplikasi jadi **empat**, bukan dua: `codex` CLI **dan**
`codex-acp` untuk sisi Codex; Claude Code **dan** `claude-agent-acp` untuk sisi Claude.

Handshake `codex-acp` 1.1.9 sudah dijalankan. Balasannya:

```json
{"protocolVersion":1,
 "agentInfo":{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"1.1.9"},
 "agentCapabilities":{
   "promptCapabilities":{"embeddedContext":true,"image":true},
   "mcpCapabilities":{"acp":false,"http":true,"sse":false},
   "auth":{"logout":{}},"loadSession":true,
   "sessionCapabilities":{"resume":{},"list":{},"close":{},"delete":{},
                          "additionalDirectories":{}}},
 "authMethods":[
   {"id":"api-key","name":"API Key","_meta":{"api-key":{"provider":"openai"}}},
   {"id":"chat-gpt","name":"ChatGPT","description":"Use ChatGPT to authenticate"}]}
```

Catatan: `codex-acp` tidak berbicara langsung ke model. Ia men-spawn
`${CODEX_PATH ?? "codex"} app-server` — jadi ia penerjemah ACP ⟷ protokol app-server
milik Codex, dan mengemudikan CLI `codex` global milik pengguna. Paket ini memang
membundel salinan Codex sendiri, tetapi resolusinya default ke `"codex"` dari PATH.
`CODEX_PATH` bisa dipakai untuk mengarahkan ulang.

**AUTH — ini yang paling penting bagi tujuan biaya.** Codex menawarkan dua metode:
`api-key` (OpenAI) dan **`chat-gpt`** — jalur langganan yang memang kamu inginkan.
Aplikasi harus mengimplementasikan method `authenticate` ACP dan membiarkan pengguna
memilih. Bandingkan dengan Claude yang mengembalikan `authMethods: []` karena sudah
terautentikasi. **Kedua agen butuh alur auth yang berbeda di UI** — Codex meminta
pilihan eksplisit, Claude tidak.

## Perbedaan antar-adapter yang mengikat Rencana 2

| | `codex-acp` 1.1.9 | `claude-agent-acp` 0.64.2 |
|---|---|---|
| `authMethods` | `api-key`, `chat-gpt` | `[]` (sudah terautentikasi) |
| MCP stdio | ya, varian tanpa `type` | ya, varian tanpa `type` |
| MCP http | ya | ya |
| MCP sse | **tidak** | ya |
| MCP varian `acp` | ya (`serverId`) | tidak |
| `promptCapabilities.image` | ya | ya |
| `sessionCapabilities.fork` | tidak | ya |
| `resume`/`list`/`close`/`delete` | ya | ya |

**Bentuk stdio untuk klien Rust — dikoreksi setelah uji nyata.**

Bentuk kanoniknya adalah **tanpa field `type`**: di kedua skema, varian stdio memang
varian yang tidak punya literal `type`. Pakai bentuk itu.

Koreksi atas versi awal dokumen ini: saya sempat menyatakan bahwa mengirim
`type: "stdio"` eksplisit akan membuat server MCP **dibuang diam-diam**, berdasarkan
cabang `else if (!("type" in server))` di `dist/acp-agent.js`. **Itu terbukti salah.**
Diuji langsung terhadap `claude-agent-acp` 0.64.2 dengan nama server unik, dua kali —
tanpa `type` dan dengan `type: "stdio"` — dan **kedua-duanya menghasilkan 10/10 tool
terlihat oleh agen**. Ada lapisan validasi yang membuang field itu sebelum mencapai
pemetaan. Pembacaan kode saya tidak lengkap; hasil empiris yang berlaku.

Sisi `codex-acp` belum diuji dengan cara ini karena butuh login. Skemanya
(`zMcpServer` union + `vecSkipError`) secara struktur memang membuang entri yang gagal
divalidasi, jadi tetap **pakai bentuk tanpa `type`** sampai ada bukti sebaliknya.

**Yang tetap wajib, dengan alasan yang berdiri sendiri:** Rencana 2 harus punya test
integrasi yang menegaskan tool Midscene benar-benar muncul di sesi. `session/new` yang
sukses tidak membuktikan server terpasang — dan konfigurasi MCP bisa salah karena banyak
sebab lain di luar soal `type`.

**Temuan tambahan dari uji nyata.** Sesi ACP mewarisi server MCP milik pengguna dari
konfigurasi Claude Code-nya, digabung dengan yang dikirim klien
(`mcpServers: { ...userProvidedOptions.mcpServers, ...mcpServers }` di `acp-agent.js`).
Pada mesin uji, agen melihat `pencil` dan `mobbin` milik pengguna di samping server kita.
Aplikasi **tidak boleh berasumsi hanya tool-nya sendiri yang tersedia di sesi.**

Skema stdio Codex juga menuntut `args` dan `env` sebagai array **wajib**, bukan opsional.
Kirim array kosong, jangan hilangkan field-nya.

- [ ] **Step 2: Install Claude Code ACP adapter dan periksa dukungan `mcpServers`**

Paket ini **berganti nama**. `@zed-industries/claude-code-acp` sudah deprecated dan
berhenti di 0.16.2, dengan pesan resmi di registry: *"This package has been renamed to
@agentclientprotocol/claude-agent-acp. Please migrate to continue receiving updates."*
Nama binary-nya ikut berubah menjadi `claude-agent-acp`. Per 2026-08-04 paket baru
sudah di 0.64.2 — selisih yang besar, jadi asumsi apa pun tentang perilaku ACP yang
diambil dari versi lama harus diverifikasi ulang, bukan dibawa begitu saja.

```
! npm install -g @agentclientprotocol/claude-agent-acp && claude-agent-acp --version
```

Untuk memastikan dukungan `mcpServers` pada `session/new`, kirim handshake ACP manual:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}' \
  | claude-agent-acp
```

Catat balasan `initialize` secara utuh — khususnya `agentCapabilities` dan `promptCapabilities`.

### TERJAWAB — dijalankan 2026-08-04 pada `claude-agent-acp` 0.64.2

Balasan `initialize` sebenarnya:

```json
{"protocolVersion":1,
 "agentCapabilities":{
   "promptCapabilities":{"image":true,"embeddedContext":true},
   "mcpCapabilities":{"http":true,"sse":true},
   "auth":{"logout":{}},"loadSession":true,
   "sessionCapabilities":{"additionalDirectories":{},"close":{},"delete":{},
                          "fork":{},"list":{},"resume":{}}},
 "agentInfo":{"name":"@agentclientprotocol/claude-agent-acp","version":"0.64.2"},
 "authMethods":[]}
```

**`mcpServers` didukung, termasuk stdio.** `mcpCapabilities` hanya mendeklarasikan
transport *tambahan* di luar stdio baseline. Terbukti dari kode pemetaan di
`dist/acp-agent.js`:

```js
if ("type" in server && (server.type === "http" || server.type === "sse")) { ... }
else if (!("type" in server)) { /* stdio: command, args, env */ }
```

**JEBAKAN — WAJIB DIPATUHI RENCANA 2.** Cabang stdio adalah `else if (!("type" in server))`.
Klien yang mengirim `{ "type": "stdio", "command": ..., "args": [...] }` dengan field
`type` eksplisit **tidak cocok dengan cabang mana pun dan server MCP-nya dibuang tanpa
error**. Agen akan berjalan tanpa tool Midscene sama sekali, dan tidak ada yang melapor.
Klien ACP di Rust **harus menghilangkan** field `type` untuk server stdio.
Tulis test integrasi yang menegaskan tool Midscene benar-benar muncul di sesi — jangan
percaya bahwa `session/new` yang sukses berarti server-nya terpasang.

**Gambar didukung** — `promptCapabilities.image: true`. Pertanyaan terbuka soal apakah
agen bisa menerima screenshot terjawab untuk sisi Claude.

**Auth: API key TIDAK diwajibkan.** `ANTHROPIC_API_KEY` hanya muncul di daftar
`PROVIDER_ROUTING_ENV_VARS` yang dipakai untuk scoping cache, bukan sebagai kredensial
wajib. `authMethods: []` dengan kapabilitas `auth.logout` hadir, dan `systemPrompt`
memakai preset `"claude_code"` — mengarah ke pemakaian kredensial Claude Code yang sudah
ada di mesin. **Belum dibuktikan** dengan menjalankan sesi sungguhan; itu memakai kuota.
Premis kepatuhan ToS di spec tetap berlaku sejauh bukti ini, tapi konfirmasi akhirnya
adalah satu prompt yang benar-benar jalan.

**Bonus untuk Rencana 2:** `sessionCapabilities` menyediakan `fork`, `resume`, `list`,
`close`, `delete`, dan `additionalDirectories`; `loadSession: true`. Riwayat percakapan
persisten yang ditunda dari v1 ternyata didukung agen secara native.

Catatan: paket ini membundel `@anthropic-ai/claude-agent-sdk` — memang adapter Agent SDK,
bukan pembungkus Claude Code CLI, persis seperti klaim repo-nya.

- [ ] **Step 3: Periksa API connection kustom TanStack AI**

Buka dokumentasi `useChat` TanStack AI dan catat bentuk objek `connection` yang diterima: method apa yang wajib ada, dan event AG-UI apa yang harus diemisikan untuk teks streaming dan tool call.

- [ ] **Step 4: Catat status `runYaml`**

Sudah terverifikasi saat penyusunan spec dan dicatat di sini agar lengkap:

- `agentForComputer(opts?: LocalComputerAgentOpt)` mengembalikan `ComputerAgent`
- `ComputerAgent.prototype.runYaml` tersedia sebagai method publik
- Opsi agent menerima `cacheId?: string`, aktif bila env `MIDSCENE_CACHE` diset

- [ ] **Step 5: Tulis dokumen temuan**

Buat `docs/superpowers/notes/2026-08-04-verifikasi-tahap-0.md` berisi satu bagian per item di atas. Tiap bagian memuat: perintah yang dijalankan, keluaran apa adanya, dan kesimpulan satu kalimat berupa **TERPENUHI** atau **TIDAK TERPENUHI**.

Bila item 2 **TIDAK TERPENUHI**, catat konsekuensinya: sidecar harus dipanggil lewat jalur lain untuk Claude Code, dan Rencana 2 harus menanganinya.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/2026-08-04-verifikasi-tahap-0.md
git commit -m "docs: catat hasil verifikasi Tahap 0"
```

---

### Task 2: Kerangka paket dan server MCP yang bisa handshake

**Files:**
- Create: `midscene-mcp/package.json`
- Create: `midscene-mcp/tsconfig.json`
- Create: `midscene-mcp/src/server.ts`
- Create: `midscene-mcp/src/index.ts`
- Test: `midscene-mcp/test/server.test.ts`

**Interfaces:**
- Produces: `createServer(deps: ServerDeps): McpServer` — pabrik server dengan dependensi disuntikkan, sehingga dapat diuji tanpa stdio. `ServerDeps` diperluas oleh task-task berikutnya.

- [ ] **Step 1: Buat `midscene-mcp/package.json`**

```json
{
  "name": "midscene-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "midscene-mcp": "./src/index.ts" },
  "scripts": {
    "test": "node --test test/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@midscene/computer": "^1.10.8"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Buat `midscene-mcp/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Install dependensi**

```bash
cd midscene-mcp && npm install
```

- [ ] **Step 4: Tulis test yang gagal**

Buat `midscene-mcp/test/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';

test('server terdaftar dengan nama dan versi', () => {
  const server = createServer();
  assert.ok(server, 'createServer harus mengembalikan instance server');
});
```

- [ ] **Step 5: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/server.ts'`

- [ ] **Step 6: Tulis implementasi minimal**

Buat `midscene-mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function createServer(): McpServer {
  return new McpServer({
    name: 'midscene-mcp',
    version: '0.1.0',
  });
}
```

- [ ] **Step 7: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS

- [ ] **Step 8: Tulis entry point stdio**

Buat `midscene-mcp/src/index.ts`:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';

const server = createServer();
await server.connect(new StdioServerTransport());
```

- [ ] **Step 9: Verifikasi handshake stdio secara manual**

```bash
cd midscene-mcp && printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  | node src/index.ts
```

Expected: satu baris JSON berisi `"serverInfo":{"name":"midscene-mcp"`.

- [ ] **Step 10: Commit**

```bash
git add midscene-mcp/
git commit -m "feat(mcp): kerangka server MCP dengan transport stdio"
```

---

### Task 3: Antarmuka Device dan device palsu

Ini fondasi yang membuat seluruh rencana dapat diuji tanpa biaya. Semua task berikutnya diuji lewat `FakeDevice`.

**Files:**
- Create: `midscene-mcp/src/devices/types.ts`
- Create: `midscene-mcp/src/devices/fake.ts`
- Test: `midscene-mcp/test/fake-device.test.ts`

**Interfaces:**
- Produces: `interface Device`, `type DeviceTarget = 'web' | 'computer'`, `class FakeDevice implements Device` dengan properti `calls: string[]` untuk inspeksi test.

- [ ] **Step 1: Tulis test yang gagal**

Buat `midscene-mcp/test/fake-device.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDevice } from '../src/devices/fake.ts';

test('FakeDevice mencatat setiap operasi yang dipanggil', async () => {
  const device = new FakeDevice('web');
  await device.act('klik tombol masuk');
  await device.assert('halaman beranda tampil');
  assert.deepEqual(device.calls, [
    'act:klik tombol masuk',
    'assert:halaman beranda tampil',
  ]);
});

test('FakeDevice mengembalikan hasil query yang sudah diprogram', async () => {
  const device = new FakeDevice('web');
  device.queryResult = { judul: 'Beranda' };
  assert.deepEqual(await device.query('{judul: string}'), { judul: 'Beranda' });
});

test('FakeDevice mengembalikan screenshot palsu', async () => {
  const device = new FakeDevice('computer');
  const shot = await device.screenshot();
  assert.equal(shot.mimeType, 'image/png');
  assert.ok(shot.base64.length > 0);
});

test('FakeDevice melempar galat bila diprogram gagal', async () => {
  const device = new FakeDevice('web');
  device.failNext = 'elemen tidak ditemukan';
  await assert.rejects(() => device.act('klik apa saja'), /elemen tidak ditemukan/);
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/devices/fake.ts'`

- [ ] **Step 3: Tulis antarmuka Device**

Buat `midscene-mcp/src/devices/types.ts`:

```ts
export type DeviceTarget = 'web' | 'computer';

export interface Screenshot {
  mimeType: string;
  base64: string;
}

export interface Device {
  readonly target: DeviceTarget;
  act(instruction: string): Promise<void>;
  query(schema: string): Promise<unknown>;
  assert(claim: string): Promise<void>;
  screenshot(): Promise<Screenshot>;
  runYaml(yaml: string): Promise<void>;
  reportPath(): string | undefined;
  end(): Promise<void>;
}
```

- [ ] **Step 4: Tulis FakeDevice**

Buat `midscene-mcp/src/devices/fake.ts`:

```ts
import type { Device, DeviceTarget, Screenshot } from './types.ts';

const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export class FakeDevice implements Device {
  readonly calls: string[] = [];
  queryResult: unknown = null;
  failNext: string | null = null;
  fakeReportPath: string | undefined = undefined;
  ended = false;

  constructor(readonly target: DeviceTarget) {}

  private record(entry: string): void {
    if (this.failNext !== null) {
      const pesan = this.failNext;
      this.failNext = null;
      throw new Error(pesan);
    }
    this.calls.push(entry);
  }

  async act(instruction: string): Promise<void> {
    this.record(`act:${instruction}`);
  }

  async query(schema: string): Promise<unknown> {
    this.record(`query:${schema}`);
    return this.queryResult;
  }

  async assert(claim: string): Promise<void> {
    this.record(`assert:${claim}`);
  }

  async screenshot(): Promise<Screenshot> {
    this.record('screenshot');
    return { mimeType: 'image/png', base64: PIXEL_PNG_BASE64 };
  }

  async runYaml(yaml: string): Promise<void> {
    this.record(`runYaml:${yaml}`);
  }

  reportPath(): string | undefined {
    return this.fakeReportPath;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}
```

- [ ] **Step 5: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, 4 test

- [ ] **Step 6: Commit**

```bash
git add midscene-mcp/src/devices midscene-mcp/test/fake-device.test.ts
git commit -m "feat(mcp): antarmuka Device dan device palsu untuk pengujian"
```

---

### Task 4: Galat terstruktur

Dibuat lebih dulu karena dipakai setiap task sesudahnya. Tujuannya agar agen menerima sebab yang jelas dan tidak mencoba ulang membabi buta — yang akan menggandakan tagihan VLM.

**Files:**
- Create: `midscene-mcp/src/errors.ts`
- Test: `midscene-mcp/test/errors.test.ts`

**Interfaces:**
- Produces: `class ToolError extends Error` dengan `code: ToolErrorCode` dan `retryable: boolean`; `type ToolErrorCode`; `toToolResult(err: unknown): { content: [{ type: 'text'; text: string }]; isError: true }`.

- [ ] **Step 1: Tulis test yang gagal**

Buat `midscene-mcp/test/errors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError, toToolResult } from '../src/errors.ts';

test('ToolError membawa kode dan status retryable', () => {
  const err = new ToolError('NO_SESSION', 'belum ada sesi aktif');
  assert.equal(err.code, 'NO_SESSION');
  assert.equal(err.retryable, false);
});

test('galat kuota ditandai tidak boleh diulang', () => {
  const err = new ToolError('BUDGET_EXCEEDED', 'batas 40 operasi tercapai');
  assert.equal(err.retryable, false);
});

test('galat device ditandai boleh diulang', () => {
  const err = new ToolError('DEVICE_FAILED', 'elemen tidak ditemukan');
  assert.equal(err.retryable, true);
});

test('toToolResult memformat ToolError dengan kode dan saran', () => {
  const hasil = toToolResult(new ToolError('NO_SESSION', 'belum ada sesi aktif'));
  assert.equal(hasil.isError, true);
  assert.match(hasil.content[0].text, /NO_SESSION/);
  assert.match(hasil.content[0].text, /belum ada sesi aktif/);
  assert.match(hasil.content[0].text, /do not retry/i);
});

test('toToolResult membungkus galat tak dikenal sebagai INTERNAL', () => {
  const hasil = toToolResult(new Error('sesuatu meledak'));
  assert.match(hasil.content[0].text, /INTERNAL/);
  assert.match(hasil.content[0].text, /sesuatu meledak/);
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/errors.ts'`

- [ ] **Step 3: Tulis implementasi**

Buat `midscene-mcp/src/errors.ts`:

```ts
export type ToolErrorCode =
  | 'NO_SESSION'
  | 'SESSION_ACTIVE'
  | 'BUDGET_EXCEEDED'
  | 'DEVICE_FAILED'
  | 'SCENARIO_NOT_FOUND'
  | 'REPORT_MISSING'
  | 'INTERNAL';

const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'DEVICE_FAILED',
]);

export class ToolError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'ToolError';
    this.retryable = RETRYABLE.has(code);
  }
}

export interface ToolResult {
  content: [{ type: 'text'; text: string }];
  isError: true;
}

export function toToolResult(err: unknown): ToolResult {
  const toolError =
    err instanceof ToolError
      ? err
      : new ToolError('INTERNAL', err instanceof Error ? err.message : String(err));

  const saran = toolError.retryable
    ? 'You may retry once with a different instruction.'
    : 'Do not retry. Report this to the user and ask how to proceed.';

  return {
    content: [{ type: 'text', text: `[${toolError.code}] ${toolError.message}\n${saran}` }],
    isError: true,
  };
}
```

- [ ] **Step 4: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, 5 test baru

- [ ] **Step 5: Commit**

```bash
git add midscene-mcp/src/errors.ts midscene-mcp/test/errors.test.ts
git commit -m "feat(mcp): galat terstruktur dengan penanda retryable"
```

---

### Task 5: SessionManager dengan budget guard

Ini komponen yang menjawab kekhawatiran biaya secara langsung. Ia menghitung operasi yang didukung AI dan berhenti saat batas tercapai.

Catatan jujur soal metrik: hitungan ini adalah **jumlah operasi berbasis AI** (`act`, `query`, `assert`), bukan jumlah panggilan model mentah. Satu `act` dapat memicu lebih dari satu panggilan model. Metrik ini dipilih karena dapat diprediksi dan dijelaskan ke pengguna; ia adalah batas bawah, bukan angka tagihan persis.

**Files:**
- Create: `midscene-mcp/src/session.ts`
- Test: `midscene-mcp/test/session.test.ts`

**Interfaces:**
- Consumes: `Device`, `DeviceTarget` (Task 3); `ToolError` (Task 4)
- Produces: `class SessionManager` dengan `start(target, opts)`, `current()`, `spend()`, `budgetStatus()`, `end()`; `interface SessionStatus { target; used; limit; remaining }`; `type DeviceFactory = (target: DeviceTarget) => Promise<Device>`

- [ ] **Step 1: Tulis test yang gagal**

Buat `midscene-mcp/test/session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';
import { ToolError } from '../src/errors.ts';

function buatManager(limit = 3) {
  const dibuat: FakeDevice[] = [];
  const manager = new SessionManager(async (target) => {
    const device = new FakeDevice(target);
    dibuat.push(device);
    return device;
  }, limit);
  return { manager, dibuat };
}

test('current melempar NO_SESSION sebelum sesi dimulai', () => {
  const { manager } = buatManager();
  assert.throws(() => manager.current(), (err: ToolError) => err.code === 'NO_SESSION');
});

test('start membuat device dan current mengembalikannya', async () => {
  const { manager, dibuat } = buatManager();
  await manager.start('web');
  assert.equal(manager.current(), dibuat[0]);
  assert.equal(dibuat[0].target, 'web');
});

test('start kedua tanpa end melempar SESSION_ACTIVE', async () => {
  const { manager } = buatManager();
  await manager.start('web');
  await assert.rejects(
    () => manager.start('computer'),
    (err: ToolError) => err.code === 'SESSION_ACTIVE',
  );
});

test('spend mengurangi sisa budget', async () => {
  const { manager } = buatManager(3);
  await manager.start('web');
  manager.spend();
  assert.deepEqual(manager.budgetStatus(), {
    target: 'web',
    used: 1,
    limit: 3,
    remaining: 2,
  });
});

test('spend melampaui batas melempar BUDGET_EXCEEDED', async () => {
  const { manager } = buatManager(2);
  await manager.start('web');
  manager.spend();
  manager.spend();
  assert.throws(() => manager.spend(), (err: ToolError) => err.code === 'BUDGET_EXCEEDED');
});

test('end menutup device dan mereset budget', async () => {
  const { manager, dibuat } = buatManager(2);
  await manager.start('web');
  manager.spend();
  await manager.end();
  assert.equal(dibuat[0].ended, true);
  assert.throws(() => manager.current(), (err: ToolError) => err.code === 'NO_SESSION');
  await manager.start('computer');
  assert.equal(manager.budgetStatus().used, 0);
});

test('end tanpa sesi aktif tidak melempar', async () => {
  const { manager } = buatManager();
  await manager.end();
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/session.ts'`

- [ ] **Step 3: Tulis implementasi**

Buat `midscene-mcp/src/session.ts`:

```ts
import type { Device, DeviceTarget } from './devices/types.ts';
import { ToolError } from './errors.ts';

export type DeviceFactory = (target: DeviceTarget) => Promise<Device>;

export interface SessionStatus {
  target: DeviceTarget;
  used: number;
  limit: number;
  remaining: number;
}

export const DEFAULT_BUDGET = 40;

export class SessionManager {
  #device: Device | null = null;
  #used = 0;

  constructor(
    private readonly buatDevice: DeviceFactory,
    private readonly limit: number = DEFAULT_BUDGET,
  ) {}

  async start(target: DeviceTarget): Promise<void> {
    if (this.#device !== null) {
      throw new ToolError(
        'SESSION_ACTIVE',
        'a session is already running; call end_session first',
      );
    }
    this.#used = 0;
    this.#device = await this.buatDevice(target);
  }

  current(): Device {
    if (this.#device === null) {
      throw new ToolError('NO_SESSION', 'no active session; call start_session first');
    }
    return this.#device;
  }

  spend(): void {
    const device = this.current();
    if (this.#used >= this.limit) {
      throw new ToolError(
        'BUDGET_EXCEEDED',
        `AI operation budget of ${this.limit} reached for this ${device.target} session`,
      );
    }
    this.#used += 1;
  }

  budgetStatus(): SessionStatus {
    const device = this.current();
    return {
      target: device.target,
      used: this.#used,
      limit: this.limit,
      remaining: this.limit - this.#used,
    };
  }

  async end(): Promise<void> {
    if (this.#device === null) return;
    const device = this.#device;
    this.#device = null;
    this.#used = 0;
    await device.end();
  }
}
```

- [ ] **Step 4: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, 7 test baru

- [ ] **Step 5: Commit**

```bash
git add midscene-mcp/src/session.ts midscene-mcp/test/session.test.ts
git commit -m "feat(mcp): SessionManager dengan budget guard operasi AI"
```

---

### Task 6: Tool eksplorasi

Enam tool: `start_session`, `act`, `query`, `assert`, `screenshot`, `end_session`.

**Files:**
- Modify: `midscene-mcp/src/server.ts`
- Create: `midscene-mcp/src/tools/exploration.ts`
- Test: `midscene-mcp/test/exploration.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 5), `toToolResult` (Task 4)
- Produces: `registerExplorationTools(server: McpServer, sessions: SessionManager): void`; `createServer(deps: ServerDeps)` dengan `interface ServerDeps { sessions: SessionManager }`

- [ ] **Step 1: Tulis test yang gagal**

Buat `midscene-mcp/test/exploration.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';

async function hubungkan(limit = 40) {
  const dibuat: FakeDevice[] = [];
  const sessions = new SessionManager(async (target) => {
    const device = new FakeDevice(target);
    dibuat.push(device);
    return device;
  }, limit);

  const server = createServer({ sessions });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dibuat, sessions };
}

test('tools/list memuat keenam tool eksplorasi', async () => {
  const { client } = await hubungkan();
  const { tools } = await client.listTools();
  const nama = tools.map((t) => t.name).sort();
  for (const wajib of ['act', 'assert', 'end_session', 'query', 'screenshot', 'start_session']) {
    assert.ok(nama.includes(wajib), `tool ${wajib} harus terdaftar`);
  }
});

test('start_session membuat device sesuai target', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  assert.equal(dibuat.length, 1);
  assert.equal(dibuat[0].target, 'web');
});

test('act meneruskan instruksi ke device', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  await client.callTool({ name: 'act', arguments: { instruction: 'klik tombol masuk' } });
  assert.deepEqual(dibuat[0].calls, ['act:klik tombol masuk']);
});

test('act tanpa sesi mengembalikan galat NO_SESSION', async () => {
  const { client } = await hubungkan();
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'klik' } });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /NO_SESSION/);
});

test('act melaporkan pemakaian budget di hasil sukses', async () => {
  const { client } = await hubungkan(5);
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'klik' } });
  assert.match((hasil.content as any)[0].text, /Budget used: 1 of 5/);
});

test('act berhenti dengan BUDGET_EXCEEDED saat batas tercapai', async () => {
  const { client } = await hubungkan(1);
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  await client.callTool({ name: 'act', arguments: { instruction: 'pertama' } });
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'kedua' } });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /BUDGET_EXCEEDED/);
});

test('query mengembalikan hasil sebagai JSON', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  dibuat[0].queryResult = { judul: 'Beranda' };
  const hasil = await client.callTool({ name: 'query', arguments: { schema: '{judul: string}' } });
  assert.match((hasil.content as any)[0].text, /"judul": ?"Beranda"/);
});

test('screenshot mengembalikan content block gambar dan tidak memotong budget', async () => {
  const { client } = await hubungkan(2);
  await client.callTool({ name: 'start_session', arguments: { target: 'computer' } });
  const hasil = await client.callTool({ name: 'screenshot', arguments: {} });
  const blok = (hasil.content as any)[0];
  assert.equal(blok.type, 'image');
  assert.equal(blok.mimeType, 'image/png');
  const setelah = await client.callTool({ name: 'act', arguments: { instruction: 'klik' } });
  assert.match((setelah.content as any)[0].text, /1 of 2/);
});

test('galat device dibungkus sebagai DEVICE_FAILED', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  dibuat[0].failNext = 'elemen tidak ditemukan';
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'klik hantu' } });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /DEVICE_FAILED/);
});

test('end_session menutup device', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  await client.callTool({ name: 'end_session', arguments: {} });
  assert.equal(dibuat[0].ended, true);
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `createServer` belum menerima argumen `deps`

- [ ] **Step 3: Tulis tool eksplorasi**

Buat `midscene-mcp/src/tools/exploration.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session.ts';
import { ToolError, toToolResult } from '../errors.ts';

function bungkusGalatDevice(err: unknown): never {
  if (err instanceof ToolError) throw err;
  throw new ToolError('DEVICE_FAILED', err instanceof Error ? err.message : String(err));
}

export function registerExplorationTools(server: McpServer, sessions: SessionManager): void {
  server.registerTool(
    'start_session',
    {
      description:
        'Open an automation session. Use target "web" for a browser, "computer" for the macOS desktop. Only one session may run at a time.',
      inputSchema: {
        target: z.enum(['web', 'computer']),
        url: z.string().optional().describe('Initial URL, web target only'),
      },
    },
    async ({ target }) => {
      try {
        await sessions.start(target);
        const { limit } = sessions.budgetStatus();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Session started on ${target}. AI operation budget: ${limit}.`,
            },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'act',
    {
      description:
        'Perform one UI action described in natural language, e.g. "click the sign in button". Consumes one AI operation from the budget.',
      inputSchema: { instruction: z.string() },
    },
    async ({ instruction }) => {
      try {
        const device = sessions.current();
        sessions.spend();
        await device.act(instruction).catch(bungkusGalatDevice);
        const { used, limit } = sessions.budgetStatus();
        return {
          content: [
            { type: 'text' as const, text: `Done. Budget used: ${used} of ${limit}.` },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'query',
    {
      description:
        'Extract structured data from the current screen. Pass a shape description such as "{title: string, price: number}". Consumes one AI operation.',
      inputSchema: { schema: z.string() },
    },
    async ({ schema }) => {
      try {
        const device = sessions.current();
        sessions.spend();
        const hasil = await device.query(schema).catch(bungkusGalatDevice);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(hasil, null, 2) }],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'assert',
    {
      description:
        'Verify a claim about the current screen, e.g. "the cart shows 2 items". Fails the tool call if untrue. Consumes one AI operation.',
      inputSchema: { claim: z.string() },
    },
    async ({ claim }) => {
      try {
        const device = sessions.current();
        sessions.spend();
        await device.assert(claim).catch(bungkusGalatDevice);
        const { used, limit } = sessions.budgetStatus();
        return {
          content: [
            { type: 'text' as const, text: `Assertion holds. Budget used: ${used} of ${limit}.` },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'screenshot',
    {
      description:
        'Capture the current screen. Free — does not consume the AI operation budget.',
      inputSchema: {},
    },
    async () => {
      try {
        const device = sessions.current();
        const shot = await device.screenshot().catch(bungkusGalatDevice);
        return {
          content: [
            { type: 'image' as const, data: shot.base64, mimeType: shot.mimeType },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'end_session',
    {
      description: 'Close the running session and release the browser or desktop connection.',
      inputSchema: {},
    },
    async () => {
      try {
        await sessions.end();
        return { content: [{ type: 'text' as const, text: 'Session closed.' }] };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );
}
```

- [ ] **Step 4: Tambahkan `zod` sebagai dependensi**

```bash
cd midscene-mcp && npm install zod
```

- [ ] **Step 5: Ubah `createServer` agar menerima dependensi**

Ganti seluruh isi `midscene-mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from './session.ts';
import { registerExplorationTools } from './tools/exploration.ts';

export interface ServerDeps {
  sessions: SessionManager;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'midscene-mcp', version: '0.1.0' });
  registerExplorationTools(server, deps.sessions);
  return server;
}
```

- [ ] **Step 6: Perbarui test Task 2 yang kini kadaluwarsa**

Ganti seluruh isi `midscene-mcp/test/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';

test('createServer mengembalikan instance server', () => {
  const sessions = new SessionManager(async (target) => new FakeDevice(target));
  assert.ok(createServer({ sessions }));
});
```

- [ ] **Step 7: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, seluruh test

- [ ] **Step 8: Commit**

```bash
git add midscene-mcp/
git commit -m "feat(mcp): enam tool eksplorasi dengan penegakan budget"
```

---

### Task 7: Penyimpanan skenario dan replay

**Files:**
- Create: `midscene-mcp/src/scenarios.ts`
- Create: `midscene-mcp/src/tools/scenarios.ts`
- Modify: `midscene-mcp/src/server.ts`
- Test: `midscene-mcp/test/scenarios.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 5), `ToolError` (Task 4)
- Produces: `class ScenarioStore` dengan `save(name, yaml)`, `load(name)`, `list()`, `pathFor(name)`; `registerScenarioTools(server, sessions, store)`

- [ ] **Step 1: Tulis test yang gagal**

Buat `midscene-mcp/test/scenarios.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenarioStore } from '../src/scenarios.ts';
import { ToolError } from '../src/errors.ts';

async function buatStore() {
  const dir = await mkdtemp(join(tmpdir(), 'skenario-'));
  return { store: new ScenarioStore(dir), dir };
}

test('save menulis berkas YAML dan load membacanya kembali', async () => {
  const { store, dir } = await buatStore();
  await store.save('checkout', 'tasks:\n  - name: masuk\n');
  const isi = await readFile(join(dir, 'checkout.yaml'), 'utf8');
  assert.match(isi, /tasks:/);
  assert.equal(await store.load('checkout'), 'tasks:\n  - name: masuk\n');
});

test('load skenario tak dikenal melempar SCENARIO_NOT_FOUND', async () => {
  const { store } = await buatStore();
  await assert.rejects(
    () => store.load('hantu'),
    (err: ToolError) => err.code === 'SCENARIO_NOT_FOUND',
  );
});

test('list mengembalikan nama skenario terurut tanpa ekstensi', async () => {
  const { store } = await buatStore();
  await store.save('zebra', 'tasks: []\n');
  await store.save('alpha', 'tasks: []\n');
  assert.deepEqual(await store.list(), ['alpha', 'zebra']);
});

test('nama yang mengandung pemisah path ditolak', async () => {
  const { store } = await buatStore();
  await assert.rejects(
    () => store.save('../keluar', 'tasks: []\n'),
    (err: ToolError) => err.code === 'INTERNAL',
  );
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/scenarios.ts'`

- [ ] **Step 3: Tulis ScenarioStore**

Buat `midscene-mcp/src/scenarios.ts`:

```ts
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from './errors.ts';

const NAMA_SAH = /^[a-zA-Z0-9_-]+$/;

export class ScenarioStore {
  constructor(private readonly dir: string) {}

  #validasi(name: string): void {
    if (!NAMA_SAH.test(name)) {
      throw new ToolError(
        'INTERNAL',
        `invalid scenario name "${name}"; use letters, digits, hyphen and underscore only`,
      );
    }
  }

  pathFor(name: string): string {
    this.#validasi(name);
    return join(this.dir, `${name}.yaml`);
  }

  async save(name: string, yaml: string): Promise<string> {
    const path = this.pathFor(name);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, yaml, 'utf8');
    return path;
  }

  async load(name: string): Promise<string> {
    const path = this.pathFor(name);
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new ToolError('SCENARIO_NOT_FOUND', `scenario "${name}" does not exist`);
    }
  }

  async list(): Promise<string[]> {
    try {
      const berkas = await readdir(this.dir);
      return berkas
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => f.slice(0, -'.yaml'.length))
        .sort();
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, 4 test baru

- [ ] **Step 5: Tulis test untuk tool skenario**

Tambahkan ke `midscene-mcp/test/scenarios.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';

async function hubungkanDenganStore() {
  const { store, dir } = await buatStore();
  const dibuat: FakeDevice[] = [];
  const sessions = new SessionManager(async (target) => {
    const device = new FakeDevice(target);
    dibuat.push(device);
    return device;
  }, 40);
  const server = createServer({ sessions, store });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dibuat, store, dir };
}

test('save_scenario menulis YAML ke disk', async () => {
  const { client, store } = await hubungkanDenganStore();
  await client.callTool({
    name: 'save_scenario',
    arguments: { name: 'checkout', yaml: 'tasks:\n  - name: masuk\n' },
  });
  assert.match(await store.load('checkout'), /tasks:/);
});

test('run_scenario memulai sesi dan meneruskan YAML ke device', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore();
  await store.save('checkout', 'tasks: []\n');
  await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'checkout', target: 'web' },
  });
  assert.equal(dibuat.length, 1);
  assert.deepEqual(dibuat[0].calls, ['runYaml:tasks: []\n']);
});

test('run_scenario menutup sesi meski YAML gagal', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore();
  await store.save('rusak', 'tasks: []\n');

  // Device dibuat di dalam run_scenario, jadi kegagalan diprogram lewat pabriknya:
  // FakeDevice.failNext dipasang pada device berikutnya yang dibuat.
  const asli = dibuat.push.bind(dibuat);
  (dibuat as { push: typeof asli }).push = (...d) => {
    d.forEach((device) => (device.failNext = 'yaml ditolak device'));
    return asli(...d);
  };

  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'rusak', target: 'web' },
  });

  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /DEVICE_FAILED/);
  assert.equal(dibuat[0].ended, true, 'sesi harus tetap ditutup meski gagal');
});

test('run_scenario skenario tak dikenal mengembalikan SCENARIO_NOT_FOUND', async () => {
  const { client } = await hubungkanDenganStore();
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'hantu', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /SCENARIO_NOT_FOUND/);
});

test('list_scenarios mengembalikan nama tersimpan', async () => {
  const { client, store } = await hubungkanDenganStore();
  await store.save('alpha', 'tasks: []\n');
  const hasil = await client.callTool({ name: 'list_scenarios', arguments: {} });
  assert.match((hasil.content as any)[0].text, /alpha/);
});
```

- [ ] **Step 6: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `createServer` belum menerima `store`

- [ ] **Step 7: Tulis tool skenario**

Buat `midscene-mcp/src/tools/scenarios.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session.ts';
import type { ScenarioStore } from '../scenarios.ts';
import { ToolError, toToolResult } from '../errors.ts';

export function registerScenarioTools(
  server: McpServer,
  sessions: SessionManager,
  store: ScenarioStore,
): void {
  server.registerTool(
    'save_scenario',
    {
      description:
        'Freeze a sequence of steps that worked during exploration into a reusable Midscene YAML scenario. Run this once the flow is proven.',
      inputSchema: {
        name: z.string().describe('Letters, digits, hyphen and underscore only'),
        yaml: z.string().describe('Midscene YAML flow'),
      },
    },
    async ({ name, yaml }) => {
      try {
        const path = await store.save(name, yaml);
        return { content: [{ type: 'text' as const, text: `Scenario saved to ${path}` }] };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'list_scenarios',
    {
      description: 'List saved scenario names.',
      inputSchema: {},
    },
    async () => {
      try {
        const nama = await store.list();
        const teks = nama.length > 0 ? nama.join('\n') : 'No scenarios saved yet.';
        return { content: [{ type: 'text' as const, text: teks }] };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'run_scenario',
    {
      description:
        'Replay a saved scenario end to end with the Midscene cache enabled. Cheap: cached steps skip the vision model entirely. Use this for regression runs.',
      inputSchema: {
        name: z.string(),
        target: z.enum(['web', 'computer']),
      },
    },
    async ({ name, target }) => {
      try {
        const yaml = await store.load(name);
        await sessions.start(target);
        try {
          const device = sessions.current();
          await device.runYaml(yaml).catch((err: unknown) => {
            throw new ToolError(
              'DEVICE_FAILED',
              err instanceof Error ? err.message : String(err),
            );
          });
          const report = device.reportPath();
          const teks = report
            ? `Scenario "${name}" finished. Report: ${report}`
            : `Scenario "${name}" finished. No report was written.`;
          return { content: [{ type: 'text' as const, text: teks }] };
        } finally {
          await sessions.end();
        }
      } catch (err) {
        return toToolResult(err);
      }
    },
  );
}
```

- [ ] **Step 8: Perbarui `createServer`**

Ganti seluruh isi `midscene-mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from './session.ts';
import type { ScenarioStore } from './scenarios.ts';
import { registerExplorationTools } from './tools/exploration.ts';
import { registerScenarioTools } from './tools/scenarios.ts';

export interface ServerDeps {
  sessions: SessionManager;
  store: ScenarioStore;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'midscene-mcp', version: '0.1.0' });
  registerExplorationTools(server, deps.sessions);
  registerScenarioTools(server, deps.sessions, deps.store);
  return server;
}
```

- [ ] **Step 9: Perbarui pemanggil `createServer` di test lama**

Di `midscene-mcp/test/server.test.ts` dan `midscene-mcp/test/exploration.test.ts`, tiap pemanggilan `createServer({ sessions })` menjadi `createServer({ sessions, store })` dengan store dari direktori sementara:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenarioStore } from '../src/scenarios.ts';

const store = new ScenarioStore(await mkdtemp(join(tmpdir(), 'skenario-')));
```

- [ ] **Step 10: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, seluruh test

- [ ] **Step 11: Commit**

```bash
git add midscene-mcp/
git commit -m "feat(mcp): penyimpanan skenario YAML dan replay dengan cache"
```

---

### Task 8: Tool build_walkthrough

Membungkus `build-demo.js` yang sudah ada tanpa menyuntingnya.

**Files:**
- Create: `midscene-mcp/src/tools/walkthrough.ts`
- Modify: `midscene-mcp/src/server.ts`
- Test: `midscene-mcp/test/walkthrough.test.ts`

**Interfaces:**
- Consumes: `toToolResult`, `ToolError` (Task 4)
- Produces: `registerWalkthroughTool(server, opts: { buildDemoPath: string })`

- [ ] **Step 1: Tulis test yang gagal**

Buat `midscene-mcp/test/walkthrough.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { ScenarioStore } from '../src/scenarios.ts';
import { FakeDevice } from '../src/devices/fake.ts';

const BUILD_DEMO = join(import.meta.dirname, '..', '..', 'build-demo.js');

async function hubungkan() {
  const dir = await mkdtemp(join(tmpdir(), 'walkthrough-'));
  const sessions = new SessionManager(async (t) => new FakeDevice(t));
  const store = new ScenarioStore(dir);
  const server = createServer({ sessions, store, buildDemoPath: BUILD_DEMO });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dir };
}

test('build_walkthrough menolak report yang tidak ada', async () => {
  const { client, dir } = await hubungkan();
  const hasil = await client.callTool({
    name: 'build_walkthrough',
    arguments: { reportPath: join(dir, 'hantu.html'), out: join(dir, 'keluar.html') },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /REPORT_MISSING/);
});

test('build_walkthrough menghasilkan HTML dari report nyata', async () => {
  const { client, dir } = await hubungkan();
  const reportNyata = join(
    import.meta.dirname,
    '..',
    '..',
    'midscene_run',
    'report',
    'computer-2026-08-04_10-01-05-ba195085.html',
  );
  const out = join(dir, 'demo.html');
  const hasil = await client.callTool({
    name: 'build_walkthrough',
    arguments: { reportPath: reportNyata, out },
  });
  assert.notEqual(hasil.isError, true);
  const berkas = await readdir(dir);
  assert.ok(berkas.includes('demo.html'), 'berkas keluaran harus ada');
});

test('build_walkthrough melaporkan galat build-demo apa adanya', async () => {
  const { client, dir } = await hubungkan();
  const rusak = join(dir, 'rusak.html');
  await writeFile(rusak, '<html>tanpa blok dump</html>', 'utf8');
  const hasil = await client.callTool({
    name: 'build_walkthrough',
    arguments: { reportPath: rusak, out: join(dir, 'keluar.html') },
  });
  assert.equal(hasil.isError, true);
});
```

Catatan: test kedua bergantung pada report yang sudah ada di repositori. `midscene_run/` masuk `.gitignore`, jadi bila berkas itu tidak ada di mesin, test dilewati dengan `t.skip`. Tambahkan penjagaan berikut di awal test kedua:

```ts
  const { existsSync } = await import('node:fs');
  if (!existsSync(reportNyata)) return t.skip('report contoh tidak tersedia');
```

dan ubah tanda tangan test menjadi `async (t) => {`.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `createServer` belum menerima `buildDemoPath`

- [ ] **Step 3: Tulis tool walkthrough**

Buat `midscene-mcp/src/tools/walkthrough.ts`:

```ts
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError, toToolResult } from '../errors.ts';

const jalankan = promisify(execFile);

export interface WalkthroughOpts {
  buildDemoPath: string;
}

export function registerWalkthroughTool(server: McpServer, opts: WalkthroughOpts): void {
  server.registerTool(
    'build_walkthrough',
    {
      description:
        'Turn a Midscene report into a standalone Indonesian walkthrough page. Provide stepsPath to supply your own step titles and explanations; omit it to use defaults.',
      inputSchema: {
        reportPath: z.string(),
        out: z.string(),
        stepsPath: z.string().optional(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
      },
    },
    async ({ reportPath, out, stepsPath, title, subtitle }) => {
      try {
        if (!existsSync(reportPath)) {
          throw new ToolError('REPORT_MISSING', `report not found at ${reportPath}`);
        }

        const argv = [opts.buildDemoPath, reportPath, '--out', out];
        if (stepsPath) argv.push('--steps', stepsPath);
        if (title) argv.push('--title', title);
        if (subtitle) argv.push('--subtitle', subtitle);

        try {
          const { stdout } = await jalankan(process.execPath, argv);
          return {
            content: [
              { type: 'text' as const, text: `Walkthrough written to ${out}\n${stdout}`.trim() },
            ],
          };
        } catch (err) {
          const pesan =
            err instanceof Error && 'stderr' in err
              ? String((err as { stderr: unknown }).stderr) || err.message
              : String(err);
          throw new ToolError('INTERNAL', `build-demo failed: ${pesan}`);
        }
      } catch (err) {
        return toToolResult(err);
      }
    },
  );
}
```

- [ ] **Step 4: Perbarui `createServer`**

Di `midscene-mcp/src/server.ts`, tambahkan `buildDemoPath: string` ke `ServerDeps`, impor `registerWalkthroughTool`, dan panggil:

```ts
registerWalkthroughTool(server, { buildDemoPath: deps.buildDemoPath });
```

- [ ] **Step 5: Perbarui pemanggil `createServer` di seluruh test lama**

Tambahkan `buildDemoPath: BUILD_DEMO` pada tiap pemanggilan, dengan konstanta yang sama seperti di test ini.

- [ ] **Step 6: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, seluruh test

- [ ] **Step 7: Commit**

```bash
git add midscene-mcp/
git commit -m "feat(mcp): tool build_walkthrough membungkus build-demo.js"
```

---

### Task 9: Adapter device nyata

Adapter ini tidak diuji otomatis — mereka butuh browser, layar, dan API key. Yang diuji adalah bahwa pabriknya memilih kelas yang benar.

**Files:**
- Create: `midscene-mcp/src/devices/computer.ts`
- Create: `midscene-mcp/src/devices/web.ts`
- Create: `midscene-mcp/src/devices/factory.ts`
- Modify: `midscene-mcp/src/index.ts`
- Test: `midscene-mcp/test/factory.test.ts`

**Interfaces:**
- Consumes: `Device`, `DeviceTarget` (Task 3)
- Produces: `createDevice(target: DeviceTarget, opts: DeviceOpts): Promise<Device>`; `interface DeviceOpts { cacheId?: string; url?: string }`

- [ ] **Step 1: Tulis test yang gagal**

Buat `midscene-mcp/test/factory.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pilihKelasDevice } from '../src/devices/factory.ts';

test('target computer memilih ComputerDeviceAdapter', () => {
  assert.equal(pilihKelasDevice('computer'), 'ComputerDeviceAdapter');
});

test('target web memilih WebDeviceAdapter', () => {
  assert.equal(pilihKelasDevice('web'), 'WebDeviceAdapter');
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `cd midscene-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/devices/factory.ts'`

- [ ] **Step 3: Tulis adapter computer**

Buat `midscene-mcp/src/devices/computer.ts`:

```ts
import { agentForComputer } from '@midscene/computer';
import type { Device, Screenshot } from './types.ts';

type ComputerAgent = Awaited<ReturnType<typeof agentForComputer>>;

export class ComputerDeviceAdapter implements Device {
  readonly target = 'computer' as const;

  private constructor(private readonly agent: ComputerAgent) {}

  static async open(cacheId?: string): Promise<ComputerDeviceAdapter> {
    const agent = await agentForComputer({
      aiActionContext: 'You are controlling a macOS desktop computer.',
      ...(cacheId ? { cacheId } : {}),
    });
    return new ComputerDeviceAdapter(agent);
  }

  async act(instruction: string): Promise<void> {
    await this.agent.aiAct(instruction);
  }

  async query(schema: string): Promise<unknown> {
    return this.agent.aiQuery(schema);
  }

  async assert(claim: string): Promise<void> {
    await this.agent.aiAssert(claim);
  }

  async screenshot(): Promise<Screenshot> {
    const base64 = await this.agent.logScreenshot();
    return { mimeType: 'image/jpeg', base64: String(base64 ?? '') };
  }

  async runYaml(yaml: string): Promise<void> {
    await this.agent.runYaml(yaml);
  }

  reportPath(): string | undefined {
    return (this.agent as { reportFile?: string }).reportFile;
  }

  async end(): Promise<void> {
    await this.agent.destroy();
  }
}
```

Catatan implementasi: bentuk kembalian `logScreenshot` dan nama properti report belum diverifikasi. Sebelum menulis kode ini, jalankan sekali untuk memeriksa keduanya:

```bash
cd /Users/rulisme/midtest && node --env-file=.env -e "
const { agentForComputer } = await import('@midscene/computer');
const a = await agentForComputer({});
console.log('logScreenshot →', typeof (await a.logScreenshot()));
console.log('properti report →', Object.keys(a).filter(k => /report|file|dump/i.test(k)));
await a.destroy();
"
```

Sesuaikan `screenshot()` dan `reportPath()` dengan hasil nyata sebelum melanjutkan.

- [ ] **Step 4: Tulis adapter web**

Install dependensinya lebih dulu:

```bash
cd midscene-mcp && npm install @midscene/web puppeteer
```

Buat `midscene-mcp/src/devices/web.ts`:

```ts
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { PuppeteerAgent } from '@midscene/web/puppeteer';
import type { Device, Screenshot } from './types.ts';

export class WebDeviceAdapter implements Device {
  readonly target = 'web' as const;

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly agent: PuppeteerAgent,
  ) {}

  static async open(url?: string, cacheId?: string): Promise<WebDeviceAdapter> {
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    const page = await browser.newPage();
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    const agent = new PuppeteerAgent(page, cacheId ? { cacheId } : {});
    return new WebDeviceAdapter(browser, page, agent);
  }

  async act(instruction: string): Promise<void> {
    await this.agent.aiAct(instruction);
  }

  async query(schema: string): Promise<unknown> {
    return this.agent.aiQuery(schema);
  }

  async assert(claim: string): Promise<void> {
    await this.agent.aiAssert(claim);
  }

  async screenshot(): Promise<Screenshot> {
    const base64 = await this.page.screenshot({ encoding: 'base64', type: 'png' });
    return { mimeType: 'image/png', base64: String(base64) };
  }

  async runYaml(yaml: string): Promise<void> {
    await this.agent.runYaml(yaml);
  }

  reportPath(): string | undefined {
    return (this.agent as { reportFile?: string }).reportFile;
  }

  async end(): Promise<void> {
    await this.browser.close();
  }
}
```

Catatan implementasi: jalur impor `@midscene/web/puppeteer` dan konstruktor `PuppeteerAgent` belum diverifikasi karena paket ini belum terpasang. Setelah `npm install`, periksa `node_modules/@midscene/web/package.json` bagian `exports` dan sesuaikan.

- [ ] **Step 5: Tulis pabrik device**

Buat `midscene-mcp/src/devices/factory.ts`:

```ts
import type { Device, DeviceTarget } from './types.ts';

export interface DeviceOpts {
  cacheId?: string;
  url?: string;
}

export function pilihKelasDevice(target: DeviceTarget): string {
  return target === 'computer' ? 'ComputerDeviceAdapter' : 'WebDeviceAdapter';
}

export async function createDevice(
  target: DeviceTarget,
  opts: DeviceOpts = {},
): Promise<Device> {
  if (target === 'computer') {
    const { ComputerDeviceAdapter } = await import('./computer.ts');
    return ComputerDeviceAdapter.open(opts.cacheId);
  }
  const { WebDeviceAdapter } = await import('./web.ts');
  return WebDeviceAdapter.open(opts.url, opts.cacheId);
}
```

Impor dinamis dipakai dengan sengaja: menjalankan target web tidak boleh memaksa memuat `@midscene/computer`, dan sebaliknya. Ini juga menjaga test tetap ringan.

- [ ] **Step 6: Jalankan test untuk memastikan lulus**

Run: `cd midscene-mcp && npm test`
Expected: PASS, 2 test baru

- [ ] **Step 7: Sambungkan entry point ke device nyata**

Ganti seluruh isi `midscene-mcp/src/index.ts`:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { createServer } from './server.ts';
import { SessionManager, DEFAULT_BUDGET } from './session.ts';
import { ScenarioStore } from './scenarios.ts';
import { createDevice } from './devices/factory.ts';

const akar = process.env.MIDSCENE_MCP_ROOT ?? process.cwd();
const budget = Number(process.env.MIDSCENE_MCP_BUDGET ?? DEFAULT_BUDGET);

const sessions = new SessionManager(
  (target) => createDevice(target, { cacheId: `midscene-mcp-${target}` }),
  budget,
);

const server = createServer({
  sessions,
  store: new ScenarioStore(join(akar, 'scenarios')),
  buildDemoPath: join(akar, 'build-demo.js'),
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 8: Commit**

```bash
git add midscene-mcp/
git commit -m "feat(mcp): adapter device nyata untuk target web dan desktop"
```

---

### Task 10: Dokumentasi dan pemakaian dari agen nyata

Deliverable terakhir yang membuat sidecar berguna bagi orang lain — dan yang memvalidasi seluruh rencana ini secara nyata.

**Files:**
- Create: `midscene-mcp/README.md`
- Create: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Tulis `.env.example`**

```bash
# Konfigurasi model VLM untuk grounding Midscene.
# Ini API key berbayar milikmu sendiri — terpisah dari langganan Codex/Claude.
# Family yang didukung — MODEL_FAMILY_VALUES di @midscene/shared@1.10.8:
#   doubao-vision, doubao-seed, gemini, qwen2.5-vl, qwen3-vl, qwen3, qwen3.5,
#   qwen3.6, vlm-ui-tars, vlm-ui-tars-doubao, vlm-ui-tars-doubao-1.5, glm-v,
#   auto-glm, auto-glm-multilingual, gpt-5, kimi, kimi3, xiaomi-mimo
# CATATAN: versi awal rencana ini menyebut "gpt-4o" — itu SALAH. Nilai tersebut
# tidak ada di MODEL_FAMILY_VALUES; ia hanya muncul sebagai contoh nama model di
# komentar JSDoc. getModelAdapter melempar untuk family tak dikenal.
MIDSCENE_MODEL_BASE_URL=
MIDSCENE_MODEL_API_KEY=
MIDSCENE_MODEL_NAME=
MIDSCENE_MODEL_FAMILY=

# Aktifkan cache. Tanpa ini setiap run membayar VLM penuh.
MIDSCENE_CACHE=1

# Chrome bawaan puppeteer tidak ter-sign dengan benar di Apple Silicon.
PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# Batas operasi AI per sesi eksplorasi.
MIDSCENE_MCP_BUDGET=40
```

- [ ] **Step 2: Tambahkan `scenarios/` ke `.gitignore`**

Sisipkan setelah baris `midscene_run/`:

```
# Skenario tersimpan bersifat lokal per proyek yang diuji
scenarios/
```

- [ ] **Step 3: Tulis `midscene-mcp/README.md`**

Isi wajib, dalam bahasa Indonesia:

- **Apa ini** — MCP server yang membungkus Midscene, dipakai dari agen ACP mana pun
- **Prasyarat** — Node >=24, Chrome, API key VLM
- **Konfigurasi** — salin `.env.example`, isi kunci
- **Menjalankan dari Zed atau Claude Code** — cuplikan konfigurasi MCP:

```json
{
  "mcpServers": {
    "midscene": {
      "command": "node",
      "args": ["/absolute/path/to/midtest/midscene-mcp/src/index.ts"],
      "env": {
        "MIDSCENE_MCP_ROOT": "/absolute/path/to/midtest"
      }
    }
  }
}
```

- **Daftar tool** — sepuluh tool dengan satu kalimat penjelasan masing-masing
- **Alur kerja** — eksplorasi sekali (bayar), `save_scenario`, `run_scenario` berulang (cache, murah), `build_walkthrough`
- **Biaya** — jelaskan terus terang: langganan agen tidak menggantikan API key VLM; yang menghemat adalah cache. Sertakan tabel struktur biaya dari spec.
- **Batas budget** — apa yang dihitung (operasi berbasis AI, bukan panggilan model mentah) dan cara mengubahnya

- [ ] **Step 4: Verifikasi integrasi nyata**

Ini satu-satunya langkah yang memakai API key dan membakar biaya. Jalankan sendiri:

```
! cd /Users/rulisme/midtest && npm test --prefix midscene-mcp
```

Lalu daftarkan server ke Claude Code atau Zed dengan konfigurasi di atas, dan minta agen: *"gunakan tool midscene: mulai sesi web ke https://example.com, pastikan judulnya memuat kata Example, lalu tutup sesi."*

Konfirmasikan: sesi terbuka, assert lulus, sesi tertutup, dan sisa budget dilaporkan.

- [ ] **Step 5: Commit**

```bash
git add midscene-mcp/README.md .env.example .gitignore
git commit -m "docs(mcp): README, contoh env, dan panduan pemakaian dari agen ACP"
```

---

## Penyimpangan dari spec

Dua hal berubah saat penyusunan rencana ini, dan spec perlu diperbarui agar cocok:

**Tool bertambah dari sembilan menjadi sepuluh.** `list_scenarios` ditambahkan di
Task 7. Tanpa itu agen tidak punya cara menemukan nama skenario yang sudah
tersimpan, sehingga `run_scenario` hanya dapat dipakai bila nama diingat manual.

**Tombol "bersihkan cache skenario" belum tertangani di mana pun.** Spec
menempatkannya di UI, tetapi kemampuan penghapusannya harus ada di sidecar. Ini
celah nyata: bila UI target berubah, cache yang kadaluwarsa tidak punya jalan
keluar. Perlu tool `clear_cache(name)` — dipindahkan ke Rencana 2 agar tool dan
tombolnya dikerjakan bersama, bukan terbelah antar rencana.

## Yang tidak termasuk rencana ini

Ditangani Rencana 2, disusun setelah Task 1 selesai:

- Tool `clear_cache(name)` beserta tombolnya di UI

- Klien ACP Rust dan lifecycle sidecar
- Antarmuka chat React dengan shadcn dan TanStack AI
- Connection adapter event Tauri → AG-UI
- Panel progres langkah dan preview walkthrough
- Deteksi prasyarat dan gerbang izin di UI
