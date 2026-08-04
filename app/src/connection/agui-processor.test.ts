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

  // Gerbangnya. Dengan `TEXT_MESSAGE_CHUNK` /
  // `THINKING_TEXT_MESSAGE_CONTENT` (nama yang dipakai sebelum perbaikan
  // ini) baris ini gagal dengan `messages` berisi nol elemen: setiap kata
  // asisten dibuang sebelum sempat dirender.
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
  const teks = bagian.filter((b) => b.type === 'text');
  expect(teks.length).toBeGreaterThan(0);
  expect(teks[0]).toMatchObject({
    type: 'text',
    content: 'Baik, saya buka halamannya.',
  });

  // `tool-call` — satu-satunya bagian yang sudah bekerja sebelum perbaikan
  // ini, karena `TOOL_CALL_*` kebetulan sudah bernama benar. Diikutkan
  // supaya test ini gagal juga bila perbaikan nama teks merusak jalur tool.
  const alat = bagian.filter((b) => b.type === 'tool-call');
  expect(alat).toHaveLength(1);
  expect(alat[0]).toMatchObject({
    type: 'tool-call',
    id: 'call-1',
    name: 'mcp__midscene__act',
    input: { instruction: 'klik tombol Masuk' },
  });

  // Agregat yang sama, dibaca lewat jalur `getState()` — `getResult()`
  // privat di tipe yang dipublikasikan pustakanya.
  expect(processor.getState()).toMatchObject({
    content: 'Baik, saya buka halamannya. Halamannya sudah terbuka.',
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
