// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useEffect } from 'react';

/**
 * Tauri IPC, dimock persis seperti `App.test.tsx`: `invoke` dan `listen`
 * dikendalikan penuh oleh test, tidak pernah menyentuh proses Tauri
 * sungguhan.
 */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

/**
 * `useChat` sungguhan (lewat `ChatClient` di `@tanstack/ai-react`) tidak
 * menyelesaikan `sendMessage()` sampai giliran itu sendiri selesai — yaitu
 * sampai potongan `RUN_FINISHED` diproses (lihat `Chat.tsx` untuk rujukan
 * ke kode sumbernya). Memalsukan seluruh protokol AG-UI di sini hanya untuk
 * menggerakkan `isLoading` akan menguji `@tanstack/ai-react`, bukan
 * `Chat.tsx`. Sebagai gantinya, `sendMessage` dimock sebagai promise yang
 * kendalinya dipegang test — persis meniru satu sifat yang penting bagi
 * `Chat.tsx`: promise itu tidak selesai sampai giliran (yang disimulasikan
 * di sini) selesai.
 */
const chat = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock('@tanstack/ai-react', () => ({
  useChat: (options: {
    connection: { subscribe: (signal?: AbortSignal) => AsyncIterable<unknown> };
    live?: boolean;
  }) => {
    // Chat.tsx's own `whenReady()` effect (see its top-of-component doc
    // comment) depends on `useChat`'s `live: true` effect having already
    // called `connection.subscribe()` — that's what registers the Tauri
    // listener `whenReady()` waits on. The real `useChat` does this via
    // `ChatClient.subscribe()`; this mock does the same minimal thing so
    // `whenReady()` resolves instead of rejecting with "dipanggil sebelum
    // subscribe()".
    useEffect(() => {
      if (options.live) {
        options.connection.subscribe();
      }
    }, [options.connection, options.live]);

    return {
      messages: [],
      sendMessage: chat.sendMessage,
      error: undefined,
    };
  },
}));

// Diimpor setelah `vi.mock` di atas terdaftar (vitest meng-hoist `vi.mock`).
const { Chat } = await import('./Chat');

/** Promise yang penyelesaiannya dipegang test, berdiri sebagai giliran yang sedang berjalan. */
function tunda<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (penyebab: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (penyebab: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  chat.sendMessage.mockReset();

  // Pendaftaran listener selesai seketika, supaya `whenReady()` di `Chat.tsx`
  // resolve tanpa perlu langkah tambahan di setiap test.
  tauri.listen.mockImplementation(() => Promise.resolve(vi.fn()));
  tauri.invoke.mockImplementation(() => Promise.resolve(undefined));
});

afterEach(() => {
  cleanup();
});

function ketik(teksInput: string): void {
  const kotak = screen.getByLabelText('Pesan untuk agen') as HTMLTextAreaElement;
  fireEvent.change(kotak, { target: { value: teksInput } });
}

/** Menunggu sampai gerbang `bolehKirim` (agenTersambung, langgananSiap, teks non-kosong) terpenuhi. */
async function tungguBolehKirim(): Promise<void> {
  await waitFor(() => {
    const tombol = screen.getByRole('button', {
      name: /^kirim$/i,
    }) as HTMLButtonElement;
    expect(tombol.disabled).toBe(false);
  });
}

/** Ketik, tunggu tombol kirim aktif, lalu klik — meninggalkan giliran berjalan (sendMessage tertunda). */
async function mulaiGiliran(): Promise<void> {
  ketik('halo agen');
  await tungguBolehKirim();
  fireEvent.click(screen.getByRole('button', { name: /^kirim$/i }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /hentikan/i })).toBeDefined();
  });
}

test('saat tidak ada giliran berjalan, tombol stop tidak ditampilkan', async () => {
  chat.sendMessage.mockResolvedValue(undefined);
  render(<Chat agenTersambung={true} />);

  ketik('halo agen');
  await tungguBolehKirim();

  expect(screen.queryByRole('button', { name: /hentikan/i })).toBeNull();
});

test('saat giliran berjalan, tombol stop muncul dan tombol kirim tidak bisa ditekan', async () => {
  const giliran = tunda<void>();
  chat.sendMessage.mockReturnValue(giliran.promise);
  render(<Chat agenTersambung={true} />);

  await mulaiGiliran();

  expect(screen.getByRole('button', { name: /hentikan/i })).toBeDefined();
  expect(screen.queryByRole('button', { name: /^kirim$/i })).toBeNull();

  giliran.resolve();
  // Bersihkan agar giliran tidak menggantung ke test berikutnya.
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /^kirim$/i })).toBeDefined();
  });
});

test('menekan stop memanggil invoke("cancel_turn") tepat satu kali', async () => {
  const giliran = tunda<void>();
  chat.sendMessage.mockReturnValue(giliran.promise);
  render(<Chat agenTersambung={true} />);

  await mulaiGiliran();
  fireEvent.click(screen.getByRole('button', { name: /hentikan/i }));

  await waitFor(() => {
    expect(
      tauri.invoke.mock.calls.filter((panggilan) => panggilan[0] === 'cancel_turn'),
    ).toHaveLength(1);
  });

  giliran.resolve();
});

test('bila cancel_turn menolak, pesan galat Indonesia tampil dan tombol stop bisa ditekan lagi', async () => {
  const giliran = tunda<void>();
  chat.sendMessage.mockReturnValue(giliran.promise);
  tauri.invoke.mockImplementation((cmd: string) => {
    if (cmd === 'cancel_turn') {
      return Promise.reject(new Error('Sesi tidak ditemukan.'));
    }
    return Promise.resolve(undefined);
  });

  render(<Chat agenTersambung={true} />);
  await mulaiGiliran();

  const tombolStop = screen.getByRole('button', { name: /hentikan/i });
  fireEvent.click(tombolStop);

  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain('Sesi tidak ditemukan.');
  });

  // Bukan mati permanen: tombolnya bisa ditekan lagi.
  const tombolStopLagi = screen.getByRole('button', {
    name: /hentikan/i,
  }) as HTMLButtonElement;
  expect(tombolStopLagi.disabled).toBe(false);

  giliran.resolve();
});

test('cancel_turn yang selesai tidak langsung mengakhiri giliran — hanya RUN_FINISHED yang mengakhirinya', async () => {
  const giliran = tunda<void>();
  chat.sendMessage.mockReturnValue(giliran.promise);
  // `invoke('cancel_turn')` default resolve seketika (lihat beforeEach) —
  // itulah yang justru diuji di sini: penyelesaiannya sendiri tidak boleh
  // berpengaruh pada keadaan giliran.
  render(<Chat agenTersambung={true} />);
  await mulaiGiliran();

  fireEvent.click(screen.getByRole('button', { name: /hentikan/i }));
  await waitFor(() => {
    expect(tauri.invoke).toHaveBeenCalledWith('cancel_turn');
  });

  // `cancel_turn` sudah selesai (resolve), tapi `sendMessage()` — pemegang
  // giliran sesungguhnya — belum. Tombol stop harus tetap tampil, tombol
  // kirim harus tetap tidak ada, dan kotak pesan tidak boleh diam-diam
  // terkunci-lepas seolah giliran sudah berakhir.
  await new Promise((selesai) => setTimeout(selesai, 0));
  expect(screen.getByRole('button', { name: /hentikan/i })).toBeDefined();
  expect(screen.queryByRole('button', { name: /^kirim$/i })).toBeNull();

  // Baru sekarang giliran benar-benar berakhir — jalur RUN_FINISHED yang
  // sudah ada, disimulasikan lewat penyelesaian `sendMessage()`.
  giliran.resolve();

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /^kirim$/i })).toBeDefined();
  });
  expect(screen.queryByRole('button', { name: /hentikan/i })).toBeNull();
});
