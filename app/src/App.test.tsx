// @vitest-environment jsdom
import { StrictMode } from 'react';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * Efek koneksi di `App.tsx`, diuji lewat urutan yang benar-benar dijalankan
 * React 19 di mode pengembangan: setup → cleanup → setup.
 *
 * Satu mount saja tidak akan pernah menemukan bug yang test ini dibuat untuk
 * menahannya. Bug-nya justru lahir dari kombinasi dua penjaga yang masing-
 * masing benar sendirian: ref penjaga membuat `connect_agent` dipanggil tepat
 * sekali (mencegah adapter di-spawn dua kali), sementara bendera `dibatalkan`
 * membuang hasil promise begitu setup yang menembakkannya dibersihkan. Di
 * mount tunggal keduanya tidak pernah bertemu. Di StrictMode: cleanup #1
 * menyalakan bendera pada satu-satunya closure yang memegang promise, setup #2
 * berhenti di ref dan tidak memasang penerima baru, dan hasilnya — sukses
 * maupun gagal — tidak pernah sampai ke state.
 *
 * `main.tsx` merender `<App />` di dalam `<React.StrictMode>`, jadi
 * pembungkus di bawah ini bukan kondisi buatan: itu produksi-di-pengembangan.
 */

const tauri = vi.hoisted(() => {
  interface Tertunda {
    resolve: (nilai: unknown) => void;
    reject: (penyebab: unknown) => void;
  }
  return {
    invoke: vi.fn(),
    listen: vi.fn(),
    /** Perintah `connect_agent` yang belum dijawab. */
    connect: undefined as Tertunda | undefined,
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

/** Nama event yang dipakai `listen()` di seluruh berkas ini. */
function eventYangDidengar(): Array<string> {
  return tauri.listen.mock.calls.map((panggilan) => panggilan[0] as string);
}

const INFO_AGEN = {
  id: 'claude',
  label: 'Claude',
  name: 'claude-agent-acp 1.0',
  sessionId: 'sesi-1',
  threadId: 'utas-1',
  cwd: '/tmp/proyek',
  supportsImagePrompt: false,
};

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  tauri.connect = undefined;

  // Pendaftaran pendengar selesai, tetapi pelepasannya dicatat — supaya test
  // bisa melihat cleanup StrictMode benar-benar terjadi.
  tauri.listen.mockImplementation(() => Promise.resolve(vi.fn()));

  tauri.invoke.mockImplementation((cmd: string) => {
    if (cmd !== 'connect_agent') return Promise.resolve(undefined);
    // Sengaja tertunda: jawaban `connect_agent` harus tiba *setelah* seluruh
    // rangkaian setup → cleanup → setup selesai, persis seperti di produksi
    // (perintahnya men-spawn proses adapter dan membuat sesi). Promise yang
    // sudah selesai lebih dulu akan menyembunyikan bug-nya.
    return new Promise((resolve, reject) => {
      tauri.connect = { resolve, reject };
    });
  });
});

afterEach(() => {
  cleanup();
});

async function renderDalamStrictMode() {
  const hasil = render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Gerbang atas gerbangnya sendiri. Bila React tidak menjalankan efek dua
  // kali (build produksi, StrictMode hilang, versi React berubah), test ini
  // akan lolos tanpa pernah menguji apa pun. Efek `listen` di `App.tsx`
  // tidak punya ref penjaga, jadi jumlah pendaftarannya adalah bukti
  // langsung bahwa setup berjalan dua kali.
  await waitFor(() => {
    expect(
      eventYangDidengar().filter((nama) => nama === 'agent-disconnected'),
    ).toHaveLength(2);
  });

  return hasil;
}

// `App` diimpor setelah `vi.mock` di atas terdaftar (vitest meng-hoist
// `vi.mock`, jadi impor statis pun aman — impor dinamis di sini hanya untuk
// menegaskan urutannya kepada pembaca).
const { default: App } = await import('./App');

test('hasil connect_agent yang sukses sampai ke status walau melewati mount ganda StrictMode', async () => {
  await renderDalamStrictMode();

  expect(screen.getByText('Menyambungkan…')).toBeDefined();

  // Satu-satunya panggilan `connect_agent`: ref penjaga tetap bekerja, dan
  // adapter tidak di-spawn dua kali.
  const panggilanConnect = tauri.invoke.mock.calls.filter(
    (panggilan) => panggilan[0] === 'connect_agent',
  );
  expect(panggilanConnect).toHaveLength(1);

  tauri.connect?.resolve(INFO_AGEN);

  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });
  // Detail agen ikut terpasang — buktinya `setAgen` juga jalan, bukan hanya
  // `setStatus`.
  expect(screen.getByText(/claude-agent-acp 1\.0/)).toBeDefined();

  // Dan konsekuensi yang dilihat pengguna: kotak pesannya hidup.
  const kotak = screen.getByLabelText('Pesan untuk agen') as HTMLTextAreaElement;
  expect(kotak.disabled).toBe(false);

  expect(tauri.invoke.mock.calls.filter((p) => p[0] === 'connect_agent')).toHaveLength(1);
});

test('kegagalan connect_agent sampai ke layar sebagai pesan, bukan diam', async () => {
  await renderDalamStrictMode();

  tauri.connect?.reject('Biner tidak ditemukan.');

  await waitFor(() => {
    expect(screen.getByText('Gagal tersambung')).toBeDefined();
  });

  // Kegagalan yang tidak bisa dibedakan dari "sedang menyambung" adalah
  // separuh kedua dari bug ini: sebelum perbaikan, kedua jalur sama-sama
  // berakhir di layar yang tidak berubah sama sekali.
  const kabar = screen.getByRole('alert');
  expect(kabar.textContent).toContain('Biner tidak ditemukan.');
  expect(kabar.textContent).toContain('claude-agent-acp');
});
