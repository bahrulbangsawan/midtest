import { test, expect, vi } from 'vitest';
import { createTauriAcpConnection } from './tauri-acp-connection';

function deps() {
  const pendengar: Array<(e: { payload: unknown }) => void> = [];
  return {
    invoke: vi.fn(async () => undefined),
    listen: vi.fn(async (_e: string, cb: (e: { payload: unknown }) => void) => {
      pendengar.push(cb);
      return () => {};
    }),
    emit: (payload: unknown) => pendengar.forEach((cb) => cb({ payload })),
  };
}

test('send meneruskan teks pesan terakhir ke perintah Tauri', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  await conn.send([{ role: 'user', parts: [{ type: 'text', text: 'halo' }] } as never]);
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

test('abortSignal menghentikan iterasi', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  const ac = new AbortController();
  const iter = conn.subscribe(ac.signal)[Symbol.asyncIterator]();
  const berikut = iter.next();
  ac.abort();
  const hasil = await berikut;
  expect(hasil.done).toBe(true);
});
