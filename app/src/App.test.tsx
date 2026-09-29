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
    /**
     * Jadi `true` begitu `set_full_permissions` pernah dipanggil sekali.
     * Dipakai untuk membedakan panggilan `get_full_permissions` "saat mount"
     * dari panggilan "pembacaan ulang setelah galat" — dua fase yang finding
     * tinjauan pra-gabung minta diuji terpisah (skenario a vs skenario b).
     */
    setFullPermissionsDipanggil: false,
    /**
     * Bila terisi, SETIAP panggilan `get_full_permissions` sebelum
     * `set_full_permissions` pernah dipanggil akan ditolak dengan nilai ini
     * (skenario a: pembacaan mount gagal di lapisan IPC).
     */
    tolakGetFullPermissionsSaatMount: undefined as unknown,
    /**
     * Bila terisi, SETIAP panggilan `get_full_permissions` setelah
     * `set_full_permissions` pernah dipanggil akan ditolak dengan nilai ini
     * (skenario b: pembacaan ulang setelah `set_full_permissions` menolak
     * juga gagal di lapisan IPC).
     */
    tolakGetFullPermissionsSetelahSet: undefined as unknown,
    appSettings: undefined as unknown,
    addWorkspaceResult: undefined as unknown,
    modelState: undefined as unknown,
  };
});

const nativeDialog = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: nativeDialog.open }));

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
  tauri.setFullPermissionsDipanggil = false;
  tauri.tolakGetFullPermissionsSaatMount = undefined;
  tauri.tolakGetFullPermissionsSetelahSet = undefined;
  tauri.appSettings = undefined;
  tauri.addWorkspaceResult = undefined;
  tauri.modelState = undefined;
  nativeDialog.open.mockReset();
  nativeDialog.open.mockResolvedValue(null);

  tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
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
      // Fase "sebelum set_full_permissions pernah dipanggil" (mount) dan fase
      // "sesudahnya" (pembacaan ulang setelah galat) sengaja diberi jalur
      // penolakan terpisah — lihat komentar pada dua field `tolak...` di atas.
      if (!tauri.setFullPermissionsDipanggil) {
        if (tauri.tolakGetFullPermissionsSaatMount !== undefined) {
          return Promise.reject(tauri.tolakGetFullPermissionsSaatMount);
        }
      } else if (tauri.tolakGetFullPermissionsSetelahSet !== undefined) {
        return Promise.reject(tauri.tolakGetFullPermissionsSetelahSet);
      }
      // Dibaca dari `tauri.izinPenuhAwal` di setiap panggilan (bukan
      // dipatok saat mock didaftarkan), supaya test bisa mengganti nilainya
      // di antara panggilan pertama (mount) dan panggilan kedua (pembacaan
      // ulang setelah `set_full_permissions` menolak).
      return Promise.resolve(tauri.izinPenuhAwal);
    }
    if (cmd === 'set_full_permissions') {
      tauri.setFullPermissionsDipanggil = true;
      return new Promise((resolve, reject) => {
        tauri.setFullPermissions = { resolve, reject };
      });
    }
    if (cmd === 'get_app_settings') {
      return Promise.resolve(tauri.appSettings);
    }
    if (cmd === 'save_app_settings') {
      return Promise.resolve(args?.value);
    }
    if (cmd === 'add_workspace') {
      return Promise.resolve(tauri.addWorkspaceResult);
    }
    if (cmd === 'set_agent_model') {
      return Promise.resolve(tauri.modelState);
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
  // Detail biner sengaja tidak diekspos lagi; identitas agen cukup terlihat
  // dari tombol provider di composer.
  expect(screen.getByRole('button', { name: 'Claude' })).toBeDefined();
  expect(screen.queryByText(/claude-agent-acp 1\.0/)).toBeNull();

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
  fireEvent.click(tombolClaude);
  const tombolCodex = await screen.findByRole('menuitem', { name: 'Codex' });
  expect(tombolCodex.getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(tombolCodex);

  // Berpindah tidak pernah diam-diam: status kembali ke "menyambung" seketika.
  expect(screen.getByText('Menyambungkan…')).toBeDefined();
  expect(screen.queryByRole('menuitem', { name: 'Codex' })).toBeNull();

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
    expect(screen.getByRole('button', { name: 'Codex' })).toBeDefined();
  });
  expect(screen.queryByText(/codex-acp 1\.0/)).toBeNull();
});

/** Kegagalan saat berpindah agen tampil apa adanya, bukan diam-diam mengklaim agen lama masih aktif. */
test('kegagalan saat berpindah agen menampilkan pesan dan tidak lagi mengklaim agen lama aktif', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Codex' }));

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

/**
 * Skenario (a) dari temuan tinjauan pra-gabung: `get_full_permissions` gagal
 * di lapisan IPC begitu jendela dibuka (bukan `Err` dari Rust — perintahnya
 * sendiri tidak sempat berjalan). Berkas pengaturan di disk boleh jadi
 * menyimpan `full_permissions: true`, jadi Rust boleh jadi sungguh sedang
 * menyetujui semua permintaan izin secara otomatis. UI wajib menampilkan
 * "tidak diketahui" — satu-satunya keadaan yang jujur di sini — dan bukan
 * diam-diam berperilaku seolah mode itu mati.
 */
test('get_full_permissions gagal saat mount: UI menampilkan keadaan tidak diketahui, bukan diam-diam "mati"', async () => {
  tauri.tolakGetFullPermissionsSaatMount = 'transport IPC terputus sebelum perintah berjalan';
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  const toggle = await screen.findByRole('switch', { name: 'Izin penuh' });
  await waitFor(() => {
    // Bukan "false" (itulah persis bug yang ditemukan tinjauan): nilai
    // ketiga yang programatis berbeda dari "mati" maupun "nyala".
    expect(toggle.getAttribute('aria-checked')).toBe('mixed');
  });

  // Terlihat tanpa membuka menu apa pun, dalam Bahasa Indonesia. Pil di
  // header (`role="alert"`) adalah penanda global yang butir 4 (Task 8)
  // minta selalu tampak — keterangan di dekat toggle mengulanginya, jadi
  // dua elemen cocok dengan pola ini; tegaskan setidaknya satu yang muncul
  // di dalam sebuah `role="alert"`.
  expect(screen.getAllByText(/tidak diketahui/i).length).toBeGreaterThanOrEqual(1);
  expect(screen.getByRole('alert').textContent).toMatch(/tidak diketahui/i);

  // Togglenya sendiri dimatikan: "kebalikan dari tidak diketahui" tidak
  // punya arti untuk dikirim ke Rust (lihat komentar `ubahIzinPenuh`/JSX).
  expect(toggle.hasAttribute('disabled')).toBe(true);
});

/**
 * Skenario (b) dari temuan tinjauan pra-gabung: pengguna menekan toggle,
 * `set_full_permissions` gagal, DAN pembacaan ulang `get_full_permissions`
 * yang harusnya jadi sumber kebenaran ikut gagal di lapisan IPC. Kontrak
 * "flag memori Rust sudah berubah tanpa syarat" hanya berlaku untuk `Err`
 * yang sungguh datang dari `set_full_permissions` berjalan — begitu
 * pembacaan ulang pun gagal di transport, tidak ada lagi dasar untuk
 * mengklaim keadaan apa pun. UI wajib mengaku tidak tahu, bukan mengklaim
 * "mati".
 */
test('set_full_permissions dan pembacaan ulang get_full_permissions berdua gagal: UI tidak mengklaim mode mati', async () => {
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

  // Begitu set_full_permissions pernah dipanggil, setiap get_full_permissions
  // berikutnya (pembacaan ulang di dalam `catch`) ikut gagal di transport.
  tauri.tolakGetFullPermissionsSetelahSet = 'transport IPC terputus saat pembacaan ulang';

  const PESAN_GALAT_RUST =
    'Mode izin penuh menyala sekarang, tetapi gagal disimpan: disk penuh ' +
    '(/tmp/config). Saat aplikasi dibuka lagi mode ini akan kembali mati ' +
    'dan setiap permintaan izin akan ditanyakan seperti biasa.';
  tauri.setFullPermissions?.reject(PESAN_GALAT_RUST);

  await waitFor(() => {
    expect(toggle.getAttribute('aria-checked')).toBe('mixed');
  });

  // Klaim yang dilarang temuan ini secara eksplisit: layar tidak boleh
  // bilang "mati" ("false") pada keadaan ini.
  expect(toggle.getAttribute('aria-checked')).not.toBe('false');
  expect(screen.getAllByText(/tidak diketahui/i).length).toBeGreaterThanOrEqual(1);

  // Pesan galat dari Rust sendiri tetap tampil apa adanya — tidak dibuang
  // hanya karena pembacaan ulang juga gagal.
  const semuaAlert = screen.getAllByRole('alert');
  expect(semuaAlert.some((el) => el.textContent === PESAN_GALAT_RUST)).toBe(true);
});

test('sidebar membuka Settings dan dapat kembali ke thread aktif', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('heading', { name: 'General' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
  expect(screen.getByText('Agent default')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  expect(screen.getByText('/tmp/proyek')).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'New thread' }));
  expect(screen.getByLabelText('Pesan untuk agen')).toBeDefined();
});

test('sidebar dapat dilipat dan dibuka kembali tanpa menghilangkan workspace', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => {
    expect(screen.getByText(/Tersambung/)).toBeDefined();
  });

  fireEvent.click(screen.getByRole('button', { name: 'Tutup sidebar' }));
  expect(screen.getByRole('button', { name: 'Open MidTest sidebar' })).toBeDefined();
  expect(screen.getByLabelText('Pesan untuk agen')).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'Open MidTest sidebar' }));
  expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined();
});

test('save preferensi berurutan dan respons lama tidak mengembalikan state UI', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => expect(screen.getByText(/Tersambung/)).toBeDefined());

  const pending: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    value: unknown;
  }> = [];
  tauri.invoke.mockImplementation((command: string, args?: { value?: unknown }) => {
    if (command === 'save_app_settings') {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject, value: args?.value });
      });
    }
    return Promise.resolve(undefined);
  });

  fireEvent.click(screen.getByRole('button', { name: 'Tutup sidebar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open MidTest sidebar' }));

  await waitFor(() => expect(pending).toHaveLength(1));
  expect((pending[0]?.value as { sidebarCollapsed?: boolean }).sidebarCollapsed).toBe(true);

  pending[0]?.resolve(pending[0].value);
  await waitFor(() => expect(pending).toHaveLength(2));
  expect((pending[1]?.value as { sidebarCollapsed?: boolean }).sidebarCollapsed).toBe(false);

  // Resolving the old request must not fold the sidebar again while the newer
  // snapshot waits in the persistence queue.
  expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined();
  pending[1]?.resolve(pending[1].value);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined());
});

test('membatalkan native folder picker tidak menambah workspace dan tidak menampilkan galat', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => expect(screen.getByText(/Tersambung/)).toBeDefined());

  nativeDialog.open.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'Add project folder' }));

  await waitFor(() => expect(nativeDialog.open).toHaveBeenCalledTimes(1));
  expect(tauri.invoke.mock.calls.some((call) => call[0] === 'add_workspace')).toBe(false);
});

test('folder pilihan native divalidasi backend, disimpan, lalu dipakai untuk sesi agen berikutnya', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => expect(screen.getByText(/Tersambung/)).toBeDefined());

  nativeDialog.open.mockResolvedValueOnce('/tmp/project-baru');
  tauri.addWorkspaceResult = {
    added: true,
    settings: {
      fullPermissions: false,
      workspaces: [{
        path: '/tmp/project-baru',
        name: 'project-baru',
        threads: [{ id: 'thread-main', title: 'New thread' }],
        selectedThreadId: 'thread-main',
      }],
      selectedWorkspace: '/tmp/project-baru',
      defaultProvider: 'claude',
      selectedModels: {},
      sidebarCollapsed: false,
      uiScale: 'comfortable',
    },
  };

  fireEvent.click(screen.getByRole('button', { name: 'Add project folder' }));

  await waitFor(() => {
    expect(tauri.invoke).toHaveBeenCalledWith('add_workspace', { path: '/tmp/project-baru' });
    const connects = tauri.invoke.mock.calls.filter((call) => call[0] === 'connect_agent');
    expect(connects[connects.length - 1]?.[1]).toEqual({
      agentId: 'claude',
      workspacePath: '/tmp/project-baru',
    });
  });
  expect(screen.getByText('Workspace added.')).toBeDefined();
});

test('melupakan workspace terakhir menutup sesi agen yang masih aktif', async () => {
  tauri.appSettings = {
    fullPermissions: false,
    workspaces: [{
      path: '/tmp/project-tunggal',
      name: 'project-tunggal',
      threads: [{ id: 'thread-main', title: 'New thread' }],
      selectedThreadId: 'thread-main',
    }],
    selectedWorkspace: '/tmp/project-tunggal',
    defaultProvider: 'claude',
    selectedModels: {},
    sidebarCollapsed: false,
    uiScale: 'comfortable',
  };

  await renderDalamStrictMode();
  tauri.connect?.resolve({ ...INFO_AGEN, cwd: '/tmp/project-tunggal' });
  await waitFor(() => expect(screen.getByText(/Tersambung/)).toBeDefined());

  const actions = screen.getByRole('button', { name: 'Project actions for project-tunggal' });
  fireEvent.pointerDown(actions, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Forget project' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Forget project' }));

  await waitFor(() => {
    expect(tauri.invoke).toHaveBeenCalledWith('disconnect_agent');
  });
  expect(screen.getByText('No workspace is open. Add a folder to continue.')).toBeDefined();
});

test('model dari ACP dapat diubah lewat Settings dan pilihan baru disimpan', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve({
    ...INFO_AGEN,
    models: [
      { id: 'sonnet', label: 'Claude Sonnet' },
      { id: 'opus', label: 'Claude Opus' },
    ],
    selectedModel: 'sonnet',
    supportsModelSelection: true,
  });
  await waitFor(() => expect(screen.getByText(/Tersambung/)).toBeDefined());
  tauri.modelState = {
    models: [
      { id: 'sonnet', label: 'Claude Sonnet' },
      { id: 'opus', label: 'Claude Opus' },
    ],
    selectedModel: 'opus',
    supportsModelSelection: true,
  };

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Agents' }));
  const modelSelect = await screen.findByLabelText('Default model') as HTMLSelectElement;
  fireEvent.change(modelSelect, { target: { value: 'opus' } });

  await waitFor(() => {
    expect(tauri.invoke).toHaveBeenCalledWith('set_agent_model', { modelId: 'opus' });
    expect(modelSelect.value).toBe('opus');
  });
  const saves = tauri.invoke.mock.calls.filter((call) => call[0] === 'save_app_settings');
  expect(saves.some((call) => (call[1] as { value?: { selectedModels?: Record<string, string> } })?.value?.selectedModels?.claude === 'opus')).toBe(true);
});

test('keadaan sidebar tersimpan saat dilipat', async () => {
  await renderDalamStrictMode();
  tauri.connect?.resolve(INFO_AGEN);
  await waitFor(() => expect(screen.getByText(/Tersambung/)).toBeDefined());

  fireEvent.click(screen.getByRole('button', { name: 'Tutup sidebar' }));

  await waitFor(() => {
    const saves = tauri.invoke.mock.calls.filter((call) => call[0] === 'save_app_settings');
    expect(saves.some((call) => (call[1] as { value?: { sidebarCollapsed?: boolean } })?.value?.sidebarCollapsed === true)).toBe(true);
  });
});
