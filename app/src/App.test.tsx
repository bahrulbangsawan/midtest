// @vitest-environment jsdom
import { StrictMode } from 'react';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    /**
     * Nilai yang dikembalikan `get_full_permissions` untuk pemanggilan
     * berikutnya. Dibaca ulang di setiap panggilan (bukan dipatok sekali),
     * supaya test bisa mengubahnya di tengah jalan dan meniru "kebenaran di
     * memori Rust berubah walau `set_full_permissions` menolak".
     */
    izinPenuhAwal: false,
    /** Perintah `set_full_permissions` yang belum dijawab. */
    setFullPermissions: undefined as Tertunda | undefined,
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

  tauri.izinPenuhAwal = false;
  tauri.setFullPermissions = undefined;

  tauri.invoke.mockImplementation((cmd: string) => {
    if (cmd === 'connect_agent') {
      // Sengaja tertunda: jawaban `connect_agent` harus tiba *setelah* seluruh
      // rangkaian setup → cleanup → setup selesai, persis seperti di produksi
      // (perintahnya men-spawn proses adapter dan membuat sesi). Promise yang
      // sudah selesai lebih dulu akan menyembunyikan bug-nya.
      return new Promise((resolve, reject) => {
        tauri.connect = { resolve, reject };
      });
    }
    if (cmd === 'get_full_permissions') {
      // Dibaca dari `tauri.izinPenuhAwal` di setiap panggilan (bukan
      // dipatok saat mock didaftarkan), supaya test bisa mengganti nilainya
      // di antara panggilan pertama (mount) dan panggilan kedua (pembacaan
      // ulang setelah `set_full_permissions` menolak).
      return Promise.resolve(tauri.izinPenuhAwal);
    }
    if (cmd === 'set_full_permissions') {
      return new Promise((resolve, reject) => {
        tauri.setFullPermissions = { resolve, reject };
      });
    }
    return Promise.resolve(undefined);
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

  // Pesan yang sama seperti yang sungguhan dirangkai `missing_binary_message`
  // di `agents.rs`: sudah lengkap dengan nama biner dan cara memasangnya.
  // Frontend tidak lagi menambal apa pun ke pesan ini — lihat komentar di
  // `App.tsx` — jadi test ini menegaskan pesan itu tampil **apa adanya**.
  const PESAN_DARI_RUST =
    'Biner adapter "claude-agent-acp" untuk agen Claude tidak ditemukan di PATH. ' +
    'Pasang lebih dulu dengan `npm install -g @agentclientprotocol/claude-agent-acp`, ' +
    'lalu coba sambungkan lagi.';
  tauri.connect?.reject(PESAN_DARI_RUST);

  await waitFor(() => {
    expect(screen.getByText('Gagal tersambung')).toBeDefined();
  });

  // Kegagalan yang tidak bisa dibedakan dari "sedang menyambung" adalah
  // separuh kedua dari bug ini: sebelum perbaikan, kedua jalur sama-sama
  // berakhir di layar yang tidak berubah sama sekali.
  const kabar = screen.getByRole('alert');
  // Sama persis, bukan sekadar "mengandung": buktinya frontend tidak lagi
  // menambahkan atau memotong apa pun dari kalimat yang dikirim Rust.
  expect(kabar.textContent).toBe(PESAN_DARI_RUST);
  expect(kabar.textContent).toContain('claude-agent-acp');
  expect(kabar.textContent).toContain('npm install');
});

/**
 * Pemilih agen: memilih Codex memanggil `connect_agent` dengan id baru,
 * menampilkan keadaan menyambung selama prosesnya, dan menampilkan agen aktif
 * yang baru begitu berhasil — tanpa pernah diam-diam mengklaim agen lama
 * masih tersambung.
 */
test('memilih agen lain memanggil connect_agent dengan id baru dan menampilkan agen aktif yang baru', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  const tombolClaude = screen.getByRole('button', { name: 'Claude' });
  const tombolCodex = screen.getByRole('button', { name: 'Codex' });
  expect(tombolClaude.getAttribute('aria-pressed')).toBe('true');
  expect(tombolCodex.getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(tombolCodex);

  // Berpindah tidak pernah diam-diam: status kembali ke "menyambung" seketika.
  expect(screen.getByText('Menyambungkan…')).toBeDefined();
  expect(tombolCodex.hasAttribute('disabled')).toBe(true);

  const panggilanConnect = tauri.invoke.mock.calls.filter(
    (panggilan) => panggilan[0] === 'connect_agent',
  );
  expect(panggilanConnect).toHaveLength(2);
  expect(panggilanConnect[1]?.[1]).toEqual({ agentId: 'codex' });

  const INFO_CODEX = {
    ...INFO_AGEN,
    id: 'codex',
    label: 'Codex',
    name: 'codex-acp 1.0',
  };
  tauri.connect?.resolve(INFO_CODEX);

  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
    expect(screen.getByText(/codex-acp 1\.0/)).toBeDefined();
  });
  expect(
    screen.getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(
    screen.getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed'),
  ).toBe('false');
});

/** Kegagalan saat berpindah agen tampil apa adanya, bukan diam-diam mengklaim agen lama masih aktif. */
test('kegagalan saat berpindah agen menampilkan pesan dan tidak lagi mengklaim agen lama aktif', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

  const PESAN_CODEX_LOGIN =
    'Codex menolak membuka sesi: authentication required. Kemungkinan besar ' +
    'Codex belum diautentikasi di mesin ini. Jalankan `codex login` lewat ' +
    'terminal, lalu coba sambungkan lagi.';
  tauri.connect?.reject(PESAN_CODEX_LOGIN);

  await waitFor(() => {
    expect(screen.getByText('Gagal tersambung')).toBeDefined();
  });
  expect(screen.getByRole('alert').textContent).toBe(PESAN_CODEX_LOGIN);
  // Tidak ada lagi klaim diam-diam bahwa Claude masih tersambung.
  expect(screen.queryByText(/claude-agent-acp/)).toBeNull();
});

/**
 * Toggle "Izin penuh" (Task 8).
 *
 * `set_full_permissions` **selalu** mengubah flag di memori Rust, termasuk
 * saat mengembalikan `Err` — `Err` hanya berarti gagal *disimpan ke disk*.
 * Konvensi biasa ("gagal, jadi kembalikan toggle ke nilai sebelumnya") karena
 * itu keliru di sini: itu bisa menampilkan "mati" padahal persetujuan
 * otomatis sungguhan menyala untuk sisa sesi. Test-test ini menegaskan UI
 * membaca ulang `get_full_permissions()` setelah galat, bukan berasumsi
 * rollback.
 */

test('saat mount, get_full_permissions dipanggil dan keadaannya tercermin di UI tanpa membuka menu apa pun', async () => {
  tauri.izinPenuhAwal = true;
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  const toggle = await screen.findByRole('switch', { name: 'Izin penuh' });
  await waitFor(() => {
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  expect(
    tauri.invoke.mock.calls.some((p) => p[0] === 'get_full_permissions'),
  ).toBe(true);

  // Butir 4: penanda yang selalu terlihat, tanpa interaksi apa pun (tidak
  // ada menu yang dibuka di test ini).
  expect(screen.getByText(/menyala/i)).toBeDefined();
});

test('menekan toggle memanggil set_full_permissions dengan nilai kebalikannya', async () => {
  tauri.izinPenuhAwal = false;
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  const toggle = await screen.findByRole('switch', { name: 'Izin penuh' });
  await waitFor(() => {
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  fireEvent.click(toggle);

  await waitFor(() => {
    const panggilan = tauri.invoke.mock.calls.filter(
      (p) => p[0] === 'set_full_permissions',
    );
    expect(panggilan).toHaveLength(1);
    expect(panggilan[0]?.[1]).toEqual({ enabled: true });
  });
});

test('set_full_permissions menolak: UI mengikuti pembacaan ulang get_full_permissions, bukan rollback ke nilai sebelumnya, dan galat tampil apa adanya', async () => {
  tauri.izinPenuhAwal = false;
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  const toggle = await screen.findByRole('switch', { name: 'Izin penuh' });
  await waitFor(() => {
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  fireEvent.click(toggle);

  await waitFor(() => {
    expect(
      tauri.invoke.mock.calls.some((p) => p[0] === 'set_full_permissions'),
    ).toBe(true);
  });

  // Kontrak Rust: flag di memori sudah berubah sebelum penyimpanan dicoba,
  // jadi apa pun hasil penyimpanannya, pembacaan ulang mengembalikan nilai
  // yang BARU (true) — bukan nilai sebelum toggle ditekan (false).
  tauri.izinPenuhAwal = true;

  const PESAN_GALAT_RUST =
    'Mode izin penuh menyala sekarang, tetapi gagal disimpan: disk penuh ' +
    '(/tmp/config). Saat aplikasi dibuka lagi mode ini akan kembali mati ' +
    'dan setiap permintaan izin akan ditanyakan seperti biasa.';
  tauri.setFullPermissions?.reject(PESAN_GALAT_RUST);

  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toBe(PESAN_GALAT_RUST);
  });

  // Bukti tidak ada rollback: state yang tampil adalah hasil pembacaan
  // ulang (menyala), bukan nilai sebelum toggle ditekan (mati).
  expect(toggle.getAttribute('aria-checked')).toBe('true');

  // get_full_permissions dipanggil lagi (mount + pembacaan ulang setelah galat).
  const panggilanBaca = tauri.invoke.mock.calls.filter(
    (p) => p[0] === 'get_full_permissions',
  );
  expect(panggilanBaca.length).toBeGreaterThanOrEqual(2);
});
