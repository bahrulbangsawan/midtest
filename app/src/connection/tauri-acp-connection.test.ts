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

// --------------------------------------------------------------- whenReady

/**
 * Like `deps()`, but the `listen()` promise is only settled when the test says
 * so. Production `listen()` is an IPC round-trip; the synchronous double above
 * hides exactly the window `whenReady()` exists to close.
 */
function depsTertunda(readyTimeoutMs?: number) {
  const daftarkan: Array<{
    resolve: (stop: () => void) => void;
    reject: (penyebab: unknown) => void;
  }> = [];
  const stop = vi.fn();
  return {
    invoke: vi.fn(async () => undefined),
    listen: vi.fn(
      () =>
        new Promise<() => void>((resolve, reject) => {
          daftarkan.push({ resolve, reject });
        }),
    ),
    readyTimeoutMs,
    stop,
    /** Selesaikan pendaftaran listener ke-`indeks`. */
    selesaikan: (indeks: number) => daftarkan[indeks]?.resolve(stop),
    /** Gagalkan pendaftaran listener ke-`indeks`. */
    gagalkan: (indeks: number, penyebab: unknown) =>
      daftarkan[indeks]?.reject(penyebab),
    jumlahTertunda: () => daftarkan.length,
  };
}

/**
 * Beri promise kesempatan untuk selesai tanpa membiarkan test menggantung
 * bila ternyata ia tidak pernah selesai — inti dari seluruh berkas ini.
 */
async function hasilnya(
  promise: Promise<unknown>,
): Promise<'selesai' | 'menolak' | 'menggantung'> {
  const penanda = Symbol('menggantung');
  const hasil = await Promise.race([
    promise.then(
      () => 'selesai' as const,
      () => 'menolak' as const,
    ),
    // Satu macrotask. Rantai `.then` di adapter — termasuk rekursi
    // `whenReady()` — seluruhnya microtask, dan antrean microtask selalu
    // terkuras habis sebelum timer 0 ms berjalan. Menghitung putaran
    // microtask satu per satu (dan salah hitung) adalah cara test ini
    // sempat melaporkan "menggantung" untuk promise yang sebenarnya sehat.
    new Promise<typeof penanda>((resolve) => {
      setTimeout(() => resolve(penanda), 0);
    }),
  ]);
  return hasil === penanda ? 'menggantung' : hasil;
}

test('whenReady menolak bila dipanggil sebelum subscribe() pernah jalan', async () => {
  const conn = createTauriAcpConnection(deps());
  await expect(conn.whenReady()).rejects.toThrow(/sebelum subscribe/);
});

test('whenReady selesai setelah listener benar-benar terdaftar', async () => {
  const d = depsTertunda();
  const conn = createTauriAcpConnection(d);
  conn.subscribe();

  let siap = false;
  const menunggu = conn.whenReady().then(() => {
    siap = true;
  });

  // Belum ada yang menyelesaikan pendaftaran: whenReady tidak boleh selesai.
  await Promise.resolve();
  expect(siap).toBe(false);

  d.selesaikan(0);
  await menunggu;
  expect(siap).toBe(true);
});

test('whenReady mengikuti langganan pengganti saat mount ganda StrictMode', async () => {
  const d = depsTertunda();
  const conn = createTauriAcpConnection(d);

  // Mount pertama: subscribe, lalu whenReady ditangkap dari mount itu.
  const ac = new AbortController();
  conn.subscribe(ac.signal);
  const menunggu = conn.whenReady();

  // StrictMode: cleanup mount pertama, lalu mount kedua — keduanya terjadi
  // sebelum pendaftaran listener mana pun sempat selesai.
  ac.abort();
  conn.subscribe();
  expect(d.jumlahTertunda()).toBe(2);

  // Pendaftaran pertama akhirnya selesai (dan langsung dilepas). Itu tidak
  // boleh dilaporkan sebagai "siap": listener-nya sudah mati.
  d.selesaikan(0);
  let siap = false;
  const dijaga = menunggu.then(() => {
    siap = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(siap).toBe(false);
  expect(d.stop).toHaveBeenCalledTimes(1);

  // Baru pendaftaran mount kedua yang sah.
  d.selesaikan(1);
  await dijaga;
  expect(siap).toBe(true);
});

test('whenReady menolak bila langganan dibatalkan tanpa pengganti', async () => {
  const d = depsTertunda();
  const conn = createTauriAcpConnection(d);
  const ac = new AbortController();
  conn.subscribe(ac.signal);

  const menunggu = conn.whenReady();
  ac.abort();
  d.selesaikan(0);

  await expect(menunggu).rejects.toThrow(/sudah dilepas/);
});

/**
 * Probe 1 dari tinjauan. Menunggu `ready` saja adalah kemacetan, bukan
 * gerbang: pemanggil yang tertambat pada langganan mati tidak akan pernah
 * dilepaskan oleh pengganti yang justru sudah hidup.
 */
test('whenReady selesai lewat pengganti yang hidup walau pendaftaran lama tidak pernah selesai', async () => {
  const d = depsTertunda();
  const conn = createTauriAcpConnection(d);

  const ac = new AbortController();
  conn.subscribe(ac.signal);
  const menunggu = conn.whenReady(); // ditangkap pada langganan #1

  ac.abort();
  conn.subscribe(); // #2
  d.selesaikan(1); // hanya #2 yang terdaftar; #1 tidak pernah selesai

  expect(await hasilnya(menunggu)).toBe('selesai');
});

/**
 * Probe 2 dari tinjauan. Pendaftaran lama yang *gagal* tidak boleh
 * dilaporkan sebagai kegagalan ketika penggantinya hidup.
 */
test('whenReady tidak menolak karena pendaftaran lama gagal bila penggantinya hidup', async () => {
  const d = depsTertunda();
  const conn = createTauriAcpConnection(d);

  const ac = new AbortController();
  conn.subscribe(ac.signal);
  const menunggu = conn.whenReady();

  ac.abort();
  conn.subscribe(); // #2
  d.gagalkan(0, new Error('IPC pendaftaran #1 gagal'));
  d.selesaikan(1);

  expect(await hasilnya(menunggu)).toBe('selesai');
});

/**
 * Jalur produksi yang sebenarnya, dan yang belum diuji sama sekali:
 * `whenReady()` dipanggil *setelah* remount selesai, terhadap langganan #2.
 */
test('whenReady selesai bila dipanggil setelah remount, terhadap langganan kedua', async () => {
  const d = depsTertunda();
  const conn = createTauriAcpConnection(d);

  const ac = new AbortController();
  conn.subscribe(ac.signal);
  ac.abort();
  conn.subscribe(); // #2, satu-satunya yang hidup

  const menunggu = conn.whenReady(); // ditangkap setelah remount
  expect(await hasilnya(menunggu)).toBe('menggantung');

  d.selesaikan(1);
  expect(await hasilnya(menunggu)).toBe('selesai');
});

/**
 * Batas waktu wajib: pendaftaran yang tersendat tanpa pengganti harus
 * berakhir dengan penolakan, bukan promise yang menggantung selamanya.
 */
test('whenReady menolak bila pendaftaran tersendat melewati batas waktu', async () => {
  const d = depsTertunda(20);
  const conn = createTauriAcpConnection(d);
  conn.subscribe(); // pendaftarannya tidak pernah diselesaikan

  await expect(conn.whenReady()).rejects.toThrow(/tidak selesai dalam 20 ms/);
});
