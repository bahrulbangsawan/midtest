import { test, expect, vi } from 'vitest';
import { createTauriAcpConnection } from './tauri-acp-connection';

function deps() {
  const pendengar: Array<(e: { payload: unknown }) => void> = [];
  const stop = vi.fn();
  return {
    invoke: vi.fn(async () => undefined),
    listen: vi.fn(async (_e: string, cb: (e: { payload: unknown }) => void) => {
      pendengar.push(cb);
      return stop;
    }),
    stop,
    emit: (payload: unknown) => pendengar.forEach((cb) => cb({ payload })),
  };
}

test('send meneruskan teks pesan terakhir ke perintah Tauri', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  // Real `TextPart` (@tanstack/ai's installed types) carries text as
  // `content`, not `text` — this fixture matches that shape.
  await conn.send([{ role: 'user', parts: [{ type: 'text', content: 'halo' }] } as never]);
  expect(d.invoke).toHaveBeenCalledWith('send_prompt', { text: 'halo' });
});

test('subscribe menghasilkan event agui yang diterima', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  const iter = conn.subscribe()[Symbol.asyncIterator]();
  const berikut = iter.next();
  d.emit({ type: 'TEXT_MESSAGE_CHUNK', delta: 'halo' });
  const hasil = await berikut;
  expect(hasil.done).toBe(false);
  expect((hasil.value as { type: string }).type).toBe('TEXT_MESSAGE_CHUNK');
});

test('subscribe mendaftarkan listener sekali walau next() dipanggil berkali-kali', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  const iter = conn.subscribe()[Symbol.asyncIterator]();

  const pertama = iter.next();
  d.emit({ type: 'TEXT_MESSAGE_CHUNK', delta: 'satu' });
  expect((await pertama).value).toEqual({ type: 'TEXT_MESSAGE_CHUNK', delta: 'satu' });

  const kedua = iter.next();
  d.emit({ type: 'TEXT_MESSAGE_CHUNK', delta: 'dua' });
  expect((await kedua).value).toEqual({ type: 'TEXT_MESSAGE_CHUNK', delta: 'dua' });

  const ketiga = iter.next();
  d.emit({ type: 'TEXT_MESSAGE_CHUNK', delta: 'tiga' });
  expect((await ketiga).value).toEqual({ type: 'TEXT_MESSAGE_CHUNK', delta: 'tiga' });

  expect(d.listen).toHaveBeenCalledTimes(1);
});

test('abortSignal menghentikan iterasi dan melepas listener saat pendaftaran masih berjalan', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  const ac = new AbortController();
  const iter = conn.subscribe(ac.signal)[Symbol.asyncIterator]();
  const berikut = iter.next();
  ac.abort();
  const hasil = await berikut;
  expect(hasil.done).toBe(true);
  expect(d.stop).toHaveBeenCalledTimes(1);
});

test('abortSignal melepas listener yang sudah terdaftar sebelumnya', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  const ac = new AbortController();
  const iter = conn.subscribe(ac.signal)[Symbol.asyncIterator]();

  // Bawa listener sampai selesai terdaftar sebelum melakukan abort.
  const pertama = iter.next();
  d.emit({ type: 'TEXT_MESSAGE_CHUNK', delta: 'halo' });
  await pertama;

  ac.abort();
  const hasil = await iter.next();
  expect(hasil.done).toBe(true);
  expect(d.stop).toHaveBeenCalledTimes(1);
});
