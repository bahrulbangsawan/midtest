import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { StreamProcessor } from '@tanstack/ai/client';
import type { StreamChunk } from '@tanstack/ai/client';
import { expect, test } from 'vitest';

/**
 * Jahitan Rust → `StreamProcessor`, diuji dari sisi TypeScript.
 *
 * Dua test yang sudah ada tidak pernah menyeberangi jahitan ini, dan itulah
 * sebabnya nama event yang salah lolos sampai ke tinjauan terakhir:
 *
 * - `events.rs` mencocokkan string yang dibuatnya sendiri dengan dirinya
 *   sendiri (`assert_eq!(ev["type"], "…")`). Sebuah nama bisa konsisten
 *   sempurna di seluruh sisi Rust dan tetap tidak berarti apa-apa di
 *   frontend.
 * - `tauri-acp-connection.test.ts` membuktikan adapter mengangkut apa pun
 *   yang diberikan padanya. Adapter memang tidak peduli isi `type` — dan
 *   memang tidak seharusnya peduli.
 *
 * Yang tidak diuji siapa pun: apakah `StreamProcessor` — pustaka yang
 * benar-benar mengubah event jadi pesan di layar — mengenali nama-nama itu.
 * `processChunk` adalah satu `switch` tanpa `default`: `type` yang tak
 * dikenal jatuh ke ujungnya tanpa error dan tanpa log. Itu bukan kegagalan
 * yang bisa dilihat, hanya chat yang diam.
 *
 * Fikstur di bawah **dihasilkan oleh `events.rs`**, bukan disalin tangan
 * (lihat `fikstur_agui_untuk_typescript_mutakhir` di sana; segarkan dengan
 * `UPDATE_AGUI_FIXTURE=1 cargo test fikstur_agui`). Salinan tangan akan
 * membusuk diam-diam persis seperti nama event tadi.
 */
const FIXTURE_URL = new URL('./__fixtures__/agui-events.json', import.meta.url);

/**
 * Jalur ke `StreamProcessor` yang benar-benar terpasang. Dibaca sebagai teks,
 * bukan diimpor: test `semua_type` di bawah perlu melihat daftar `case`-nya,
 * dan pustaka itu tidak mengekspornya dalam bentuk apa pun.
 */
const PROCESSOR_SOURCE_URL = new URL(
  '../../node_modules/@tanstack/ai/dist/esm/activities/chat/stream/processor.js',
  import.meta.url,
);

function eventDariRust(): Array<StreamChunk> {
  return JSON.parse(
    readFileSync(fileURLToPath(FIXTURE_URL), 'utf8'),
  ) as Array<StreamChunk>;
}

function proses(chunks: Array<StreamChunk>) {
  const processor = new StreamProcessor();
  for (const chunk of chunks) processor.processChunk(chunk);
  processor.finalizeStream();
  return processor;
}

test('event dari events.rs jadi pesan asisten lewat StreamProcessor sungguhan', () => {
  const processor = proses(eventDariRust());
  const messages = processor.getMessages();

  // Satu giliran = satu pesan asisten.
  //
  // Catatan tentang bagaimana test ini gagal ketika nama event salah: yang
  // jatuh **bukan** baris ini. `TOOL_CALL_START` tetap membuat pesan
  // asistennya, jadi `messages` tetap berisi satu elemen; yang kosong adalah
  // isinya — `parts` hanya memuat bagian `tool-call`. Assertion pertama yang
  // merah adalah `pemikiran` di bawah. (Diverifikasi, bukan diperkirakan.)
  expect(messages).toHaveLength(1);
  expect(messages[0].role).toBe('assistant');

  const bagian = messages[0].parts;

  // `thinking` — bentuk bagian yang dirender `Chat.tsx` sebagai teks miring.
  const pemikiran = bagian.filter((b) => b.type === 'thinking');
  expect(pemikiran).toHaveLength(1);
  expect(pemikiran[0]).toMatchObject({
    type: 'thinking',
    content: 'Perlu membuka halamannya dulu.',
  });

  // `text` — kata-kata asisten, digabung dari beberapa delta.
  //
  // Tiga rentang teks yang dipisahkan dua tool call, dan **setiap rentang
  // hanya memuat isinya sendiri**. Inilah assertion yang menahan cacat
  // pengulangan: tanpa `TEXT_MESSAGE_START` ber-`messageId` dari
  // `agui_text_chunk`, rentang kedua berbunyi
  // `"Baik, saya buka halamannya. Halamannya sudah terbuka."` dan rentang
  // ketiga mengulang seluruh narasi giliran. Skenario fikstur sengaja
  // memakai dua tool call, bukan satu, karena pengulangannya bertumpuk —
  // satu tool call hanya menunjukkan separuh gejalanya.
  const teks = bagian.filter((b) => b.type === 'text');
  expect(teks.map((b) => b.content)).toEqual([
    'Baik, saya buka halamannya.',
    ' Halamannya sudah terbuka.',
    ' Judulnya "Masuk".',
  ]);

  // Dinyatakan sekali lagi sebagai larangan yang eksplisit, supaya niatnya
  // tidak hilang kalau kalimat fiksturnya berubah nanti: tidak boleh ada
  // rentang teks selain yang pertama yang memuat ulang isi rentang pertama.
  for (const potongan of teks.slice(1)) {
    expect(potongan.content).not.toContain('Baik, saya buka halamannya.');
  }

  // `tool-call` — satu-satunya bagian yang sudah bekerja sebelum perbaikan
  // nama event, karena `TOOL_CALL_*` kebetulan sudah bernama benar.
  // Diikutkan supaya test ini gagal juga bila perbaikan di jalur teks
  // merusak jalur tool.
  const alat = bagian.filter((b) => b.type === 'tool-call');
  expect(alat).toHaveLength(2);
  expect(alat[0]).toMatchObject({
    type: 'tool-call',
    id: 'call-1',
    name: 'mcp__midscene__act',
    input: { instruction: 'klik tombol Masuk' },
    state: 'complete',
  });
  expect(alat[1]).toMatchObject({
    type: 'tool-call',
    id: 'call-2',
    name: 'mcp__midscene__query',
    input: { query: 'judul halaman' },
    state: 'complete',
  });

  const hasilAlat = bagian.filter((b) => b.type === 'tool-result');
  expect(hasilAlat).toHaveLength(2);
  expect(hasilAlat.every((result) => result.state === 'complete')).toBe(true);

  // Urutan bagian sebagaimana `Chat.tsx` akan merendernya, dari atas ke
  // bawah. Bagian teks yang benar tetapi tersusun salah tetap salah di mata
  // pengguna.
  expect(bagian.map((b) => b.type)).toEqual([
    'thinking',
    'text',
    'tool-call',
    'tool-result',
    'text',
    'tool-call',
    'tool-result',
    'text',
  ]);

  // Agregat yang sama, dibaca lewat jalur `getState()` — `getResult()`
  // privat di tipe yang dipublikasikan pustakanya.
  expect(processor.getState()).toMatchObject({
    content: 'Baik, saya buka halamannya. Halamannya sudah terbuka. Judulnya "Masuk".',
    thinking: 'Perlu membuka halamannya dulu.',
  });
});

/**
 * Mengapa test di atas bisa dipercaya: buktikan bahwa kegagalannya memang
 * diam, dengan menjalankan fikstur yang sama memakai nama lama.
 *
 * Tanpa test ini, seseorang bisa menyimpulkan "`StreamProcessor` pasti akan
 * protes kalau namanya salah" — dan itu asumsi yang justru membuat bug ini
 * bertahan sampai tinjauan terakhir.
 */
test('nama event lama dibuang StreamProcessor tanpa error dan tanpa pesan', () => {
  const namaLama: Record<string, string> = {
    TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CHUNK',
    REASONING_MESSAGE_CONTENT: 'THINKING_TEXT_MESSAGE_CONTENT',
  };
  const chunks = eventDariRust().map((chunk) => {
    const type = (chunk as { type: string }).type;
    return namaLama[type] ? { ...chunk, type: namaLama[type] } : chunk;
  }) as Array<StreamChunk>;

  const processor = proses(chunks);

  // Tool call tetap muncul — itu sebabnya jendelanya tampak "hidup" sambil
  // tidak pernah menampilkan satu kata pun.
  const teks = processor
    .getMessages()
    .flatMap((pesan) => pesan.parts)
    .filter((bagian) => bagian.type === 'text' || bagian.type === 'thinking');
  expect(teks).toEqual([]);
  expect(processor.getState().content).toBe('');
  expect(processor.getState().thinking).toBe('');
});

/**
 * Gerbang struktural: setiap `type` yang dikirim Rust harus punya `case` di
 * `switch` milik `processChunk`.
 *
 * Test pertama menjaga event yang ada di fikstur hari ini. Test ini menjaga
 * event apa pun yang ditambahkan ke fikstur besok — termasuk yang tidak
 * menghasilkan bagian pesan yang bisa di-assert (`RUN_STARTED`,
 * `RUN_FINISHED`) dan karenanya bisa salah nama tanpa membuat test pertama
 * merah.
 */
test('setiap type yang dikirim Rust punya case di switch processChunk', () => {
  const sumber = readFileSync(fileURLToPath(PROCESSOR_SOURCE_URL), 'utf8');
  const switchProcessChunk = sumber.slice(sumber.indexOf('processChunk(chunk)'));
  const dikenal = new Set(
    [...switchProcessChunk.matchAll(/case "([A-Z_]+)":/g)].map((m) => m[1]),
  );

  // Sanity check pada cara membaca sumbernya sendiri: kalau regex atau
  // slice-nya meleset, `dikenal` jadi kosong dan test di bawah lolos secara
  // palsu.
  expect(dikenal.has('TEXT_MESSAGE_CONTENT')).toBe(true);
  expect(dikenal.has('TEXT_MESSAGE_CHUNK')).toBe(false);

  const dikirim = [
    ...new Set(eventDariRust().map((c) => (c as { type: string }).type)),
  ];
  expect(dikirim.filter((type) => !dikenal.has(type))).toEqual([]);
});

test('tool call diperbarui berdasarkan id melalui queued, running, failed tanpa duplikasi', () => {
  const processor = new StreamProcessor();
  const chunks = [
    { type: 'RUN_STARTED', runId: 'run-fail', threadId: 'thread-1' },
    {
      type: 'TOOL_CALL_START',
      runId: 'run-fail',
      threadId: 'thread-1',
      toolCallId: 'call-fail',
      toolCallName: 'mcp__midscene__act',
    },
    {
      type: 'TOOL_CALL_ARGS',
      runId: 'run-fail',
      threadId: 'thread-1',
      toolCallId: 'call-fail',
      delta: '{"instruction":"click a missing button"}',
    },
  ] as Array<StreamChunk>;

  for (const chunk of chunks) processor.processChunk(chunk);
  let toolParts = processor.getMessages().flatMap((message) => message.parts).filter(
    (part) => part.type === 'tool-call',
  );
  expect(toolParts).toHaveLength(1);
  expect(toolParts[0]).toMatchObject({ id: 'call-fail', state: 'input-streaming' });

  processor.processChunk({
    type: 'TOOL_CALL_END',
    runId: 'run-fail',
    threadId: 'thread-1',
    toolCallId: 'call-fail',
  } as StreamChunk);
  toolParts = processor.getMessages().flatMap((message) => message.parts).filter(
    (part) => part.type === 'tool-call',
  );
  expect(toolParts).toHaveLength(1);
  expect(toolParts[0]).toMatchObject({ id: 'call-fail', state: 'input-complete' });

  processor.processChunk({
    type: 'TOOL_CALL_RESULT',
    runId: 'run-fail',
    threadId: 'thread-1',
    messageId: 'tool-result-call-fail',
    toolCallId: 'call-fail',
    role: 'tool',
    content: '{"error":"button was not found"}',
    state: 'output-error',
  } as StreamChunk);
  processor.processChunk({
    type: 'RUN_FINISHED',
    runId: 'run-fail',
    threadId: 'thread-1',
  } as StreamChunk);

  toolParts = processor.getMessages().flatMap((message) => message.parts).filter(
    (part) => part.type === 'tool-call',
  );
  expect(toolParts).toHaveLength(1);
  expect(toolParts[0]).toMatchObject({
    id: 'call-fail',
    state: 'error',
    output: { error: 'button was not found' },
  });
});
