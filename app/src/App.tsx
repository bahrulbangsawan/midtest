import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';

import { Chat } from './components/Chat';
import { PermissionDialog } from './components/PermissionDialog';

/** Nama event Tauri yang mengabarkan transport agen tertutup di luar kehendak kita. */
const EVENT_AGENT_DISCONNECTED = 'agent-disconnected';

/**
 * Agen yang bisa dipilih pengguna di jendela ini.
 *
 * Sengaja hanya `id`/`label`: nama biner adapter dan paket npm-nya cuma dan
 * pernah didefinisikan di `agents.rs` (lihat `AgentSpec` dan
 * `missing_binary_message`). `connect_agent` sudah mengembalikan kalimat
 * galat lengkap — termasuk nama biner dan cara memasangnya — sehingga tidak
 * ada lagi salinan itu untuk ditempelkan di sini.
 */
const AGEN_TERSEDIA = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
] as const;

/** Agen yang disambungkan otomatis saat jendela pertama kali dibuka. */
const AGEN_BAWAAN = AGEN_TERSEDIA[0];

/** Bentuk `AgentInfo` dari `commands.rs`, diserialisasi camelCase. */
interface AgentInfo {
  id: string;
  label: string;
  name: string;
  sessionId: string;
  threadId: string;
  cwd: string;
  supportsImagePrompt: boolean;
}

type StatusKoneksi = 'menyambung' | 'tersambung' | 'gagal';

function labelStatus(status: StatusKoneksi): string {
  if (status === 'menyambung') return 'Menyambungkan…';
  if (status === 'tersambung') return 'Tersambung';
  return 'Gagal tersambung';
}

/**
 * Keadaan mode izin penuh sebagaimana diketahui frontend.
 *
 * Sengaja tiga nilai, bukan `boolean`. Temuan tinjauan pra-gabung yang
 * memicu berkas ini: `get_full_permissions` dan `set_full_permissions` bisa
 * gagal di lapisan IPC itu sendiri — bukan `Err` yang dikembalikan Rust,
 * tapi kegagalan transport sebelum perintahnya sempat berjalan sama sekali
 * (jendela tertutup separuh, sidecar belum siap, dsb). Pada kegagalan itu
 * frontend sungguh tidak tahu apakah flag di memori Rust sedang menyala atau
 * mati; Rust sendiri boleh jadi masih menyetujui setiap permintaan izin
 * otomatis. Menjatuhkan kegagalan itu ke `'mati'` (persis yang dilakukan
 * `boolean` lama lewat nilai bawaan `false`-nya) berarti pil amber penanda
 * satu-satunya di header — lihat header di bawah — lenyap padahal
 * persetujuan otomatis sungguhan mungkin masih berjalan. Itulah arah yang
 * tidak boleh pernah terjadi pada kendali ini: "tidak tahu" wajib tampak
 * sebagai "tidak tahu", bukan diam-diam sebagai "aman".
 */
type KeadaanIzinPenuh = 'nyala' | 'mati' | 'tidak-diketahui';

function App() {
  const [status, setStatus] = useState<StatusKoneksi>('menyambung');
  const [agen, setAgen] = useState<AgentInfo | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [terputus, setTerputus] = useState<string | null>(null);

  const [izinPenuh, setIzinPenuh] = useState<KeadaanIzinPenuh>('mati');
  const [izinPenuhGalat, setIzinPenuhGalat] = useState<string | null>(null);
  const [sedangMengubahIzin, setSedangMengubahIzin] = useState(false);

  /**
   * Sambungkan (atau pindahkan) sesi ke `agentId`.
   *
   * Satu-satunya jalur yang memanggil `connect_agent` — dipakai baik oleh
   * penyambungan awal maupun oleh pemilih agen — supaya perilakunya tidak
   * pernah bercabang jadi dua salinan yang diam-diam berbeda.
   *
   * Berpindah tidak pernah diam-diam: status berubah ke "menyambung" seketika
   * dipanggil (agen yang lama dilepas dari layar sampai kita tahu hasilnya),
   * dan galat sebelumnya dibuang supaya tidak nyangkut dari percobaan lama.
   * Rust sendiri sudah menutup sesi lama sebelum membuka yang baru — lihat
   * `connect_agent_body` di `commands.rs` — jadi baik sambungan ini berhasil
   * maupun gagal, sesi lama sudah pasti tidak lagi hidup.
   */
  function sambungKe(agentId: string) {
    setStatus('menyambung');
    setAgen(null);
    setGalat(null);
    setTerputus(null);

    invoke<AgentInfo>('connect_agent', { agentId }).then(
      (info) => {
        setAgen(info);
        setStatus('tersambung');
      },
      (penyebab: unknown) => {
        setStatus('gagal');
        // Rust sudah merangkai kalimat lengkap — termasuk nama biner dan cara
        // memasangnya bila itu sebabnya (lihat `missing_binary_message` di
        // `agents.rs`). Tampilkan apa adanya; menambal di sini berarti dua
        // sumber kebenaran untuk satu nama biner.
        setGalat(String(penyebab));
      },
    );
  }

  /**
   * Nyalakan/matikan mode izin penuh, sesuai nilai kebalikan dari yang
   * sedang tampil.
   *
   * # Kontrak `set_full_permissions`: perubahan di memori Rust selalu
   *   berlaku, termasuk saat hasilnya `Err`
   *
   * Ini menyimpang dari konvensi biasa ("gagal, jadi kembalikan tombolnya").
   * Rollback di sini justru berbahaya: `Err` hanya berarti gagal *disimpan
   * ke disk* — flag di memori Rust sudah berubah lebih dulu, tanpa syarat
   * (lihat `apply_and_persist_full_permissions` di `commands.rs`). Menampilkan
   * nilai sebelum tombol ditekan setelah `Err` berarti layar bilang "mati"
   * sementara persetujuan otomatis sungguhan tetap *menyala* untuk sisa sesi
   * — kebohongan UI tepat pada kendali yang paling tidak boleh berbohong.
   *
   * Jadi: set optimis dulu (nilai barunya memang yang berlaku di memori
   * seketika `set_full_permissions` dipanggil), dan bila `Err`, baca ulang
   * `get_full_permissions()` alih-alih menebak — itulah satu-satunya sumber
   * kebenaran tentang apa yang sungguh berlaku sekarang. Pesan galatnya
   * sendiri sudah dirangkai Rust sesuai arah perubahan (lihat
   * `persist_failure_message`) dan ditampilkan apa adanya, sama seperti
   * `galat` koneksi di atas.
   *
   * # Saat pembacaan ulang itu SENDIRI gagal
   *
   * Ini beda dari `Err` yang dikembalikan `set_full_permissions`. Jaminan
   * kontrak Rust ("flag memori sudah berubah tanpa syarat") hanya berlaku
   * untuk `Err` yang sungguh datang dari perintah itu berjalan. Bila
   * `get_full_permissions()` gagal di lapisan IPC (perintahnya sendiri tidak
   * sempat berjalan), tidak ada jaminan apa pun tentang keadaan sungguhan —
   * nilai optimis di atas cuma tebakan yang kebetulan pernah benar sesaat.
   * Menampilkannya sebagai kebenaran final berarti persis kegagalan yang
   * memicu berkas ini: pengguna klik "matikan", kedua panggilan gagal di
   * transport, dan layar bilang "mati" sementara Rust tetap menyetujui
   * segalanya. Jadi jatuhkan ke `'tidak-diketahui'`, bukan nilai optimis dan
   * bukan nilai sebelum tombol ditekan.
   */
  async function ubahIzinPenuh() {
    if (sedangMengubahIzin) return;
    // Tidak terdefinisi untuk keadaan 'tidak-diketahui': lihat tombolnya di
    // JSX, sengaja dimatikan pada keadaan itu karena "kebalikan dari yang
    // tidak diketahui" tidak punya arti untuk dikirim ke Rust.
    if (izinPenuh === 'tidak-diketahui') return;
    const nilaiBaru: KeadaanIzinPenuh = izinPenuh === 'nyala' ? 'mati' : 'nyala';

    setSedangMengubahIzin(true);
    setIzinPenuhGalat(null);
    setIzinPenuh(nilaiBaru);

    try {
      await invoke('set_full_permissions', { enabled: nilaiBaru === 'nyala' });
    } catch (penyebab) {
      try {
        const nyata = await invoke<boolean>('get_full_permissions');
        setIzinPenuh(nyata ? 'nyala' : 'mati');
      } catch {
        // Pembacaan ulang pun gagal lewat lapisan IPC — lihat penjelasan di
        // atas kenapa nilai optimis tidak lagi bisa dipakai di sini.
        setIzinPenuh('tidak-diketahui');
      }
      setIzinPenuhGalat(String(penyebab));
    } finally {
      setSedangMengubahIzin(false);
    }
  }

  // StrictMode menjalankan efek dua kali di mode pengembangan. `connect_agent`
  // menutup sesi lama sebelum membuka yang baru, jadi memanggilnya dua kali
  // tetap benar — tapi berarti men-spawn proses adapter dua kali untuk satu
  // jendela. Ref-nya bertahan melintasi mount ganda itu (fiber-nya sama), jadi
  // cukup untuk menahan panggilan kedua.
  const sudahMenyambung = useRef(false);

  useEffect(() => {
    if (sudahMenyambung.current) return;
    sudahMenyambung.current = true;

    // Sengaja tanpa bendera `dibatalkan` dan tanpa fungsi cleanup, tidak
    // seperti efek `listen` di bawahnya.
    //
    // Bendera semacam itu mengikat hasil sebuah promise pada umur satu
    // *pemanggilan* efek. Di sini kepemilikannya justru bukan per-pemanggilan:
    // ref di atas membuat `connect_agent` dipanggil tepat sekali per fiber,
    // jadi promise-nya milik komponen, bukan milik setup yang kebetulan
    // menembakkannya. StrictMode (setup → cleanup → setup) memutus dua hal itu
    // dan bendera tadi menelan hasilnya: cleanup #1 membatalkan satu-satunya
    // closure yang memegang promise, sementara setup #2 berhenti di ref dan
    // tidak pernah memasang penerima baru. Yang tersisa: Rust sudah tersambung,
    // sesi sudah dibuat, sidecar sudah jalan — dan jendelanya diam di
    // "Menyambungkan…" selamanya, dengan kegagalan yang sungguhan pun tampak
    // sama persis.
    //
    // Menaikkan bendera itu ke sebuah ref yang dibersihkan setup #2 juga
    // menutup bug-nya, tapi mempertahankan pembatalan yang tidak menjaga
    // apa-apa: sejak React 18, `setState` pada komponen yang sudah dilepas
    // hanyalah no-op, bukan kebocoran dan bukan peringatan. Jadi yang benar di
    // sini adalah membuang mekanismenya, bukan menambal mekanismenya.
    //
    // Efek `listen` di bawah tetap memakai idiom itu dan memang harus: ia tidak
    // punya ref penjaga, jadi setup #2 memasangnya ulang — dan cleanup-nya
    // melepas pendengar Tauri sungguhan, yang bukan no-op.
    sambungKe(AGEN_BAWAAN.id);
  }, []);

  // Baca keadaan izin penuh yang sungguh berlaku (bertahan lintas peluncuran
  // lewat berkas pengaturan) begitu jendela dibuka — lihat brief Task 8, butir
  // 1. Bawaan `'mati'` di atas hanya berlaku sampai jawaban ini tiba — jendela
  // yang baru saja dibuka belum sempat menanyakan apa pun, jadi tidak ada
  // bacaan sebelumnya untuk ditampilkan; ini murni jeda singkat sebelum
  // panggilan di bawah selesai, sama seperti `agen` yang mulai dari `null`.
  //
  // Wajib ada cabang penolakan (temuan tinjauan pra-gabung yang memicu
  // berkas ini): `get_full_permissions` bisa gagal di lapisan IPC itu sendiri
  // sebelum perintahnya sempat berjalan sama sekali — beda dari `Err` yang
  // dikembalikan Rust. Tanpa cabang ini, kegagalan itu meninggalkan keadaan
  // di `'mati'` selamanya sementara flag di memori Rust mungkin sungguh
  // menyala dan menyetujui semua permintaan izin secara otomatis — persis
  // arah yang tidak boleh pernah terjadi pada kendali ini. Jatuhkan ke
  // `'tidak-diketahui'`, bukan diam-diam dibiarkan seperti `'mati'`.
  //
  // Tanpa ref penjaga dan tanpa bendera `dibatalkan`, tidak seperti
  // `sambungKe`: `get_full_permissions` murni membaca, tidak men-spawn apa
  // pun, jadi StrictMode memanggilnya dua kali tidak berakibat apa-apa selain
  // dua pembacaan yang sama (sukses maupun gagal). `setState` pada komponen
  // yang sudah dilepas pun sekadar no-op sejak React 18 — lihat catatan
  // panjang di efek `sambungKe`.
  useEffect(() => {
    invoke<boolean>('get_full_permissions').then(
      (nilai) => {
        setIzinPenuh(nilai ? 'nyala' : 'mati');
      },
      () => {
        setIzinPenuh('tidak-diketahui');
      },
    );
  }, []);

  useEffect(() => {
    let dibatalkan = false;
    let lepas: (() => void) | undefined;

    listen(EVENT_AGENT_DISCONNECTED, (event) => {
      const alasan = (event.payload as { reason?: unknown } | null)?.reason;
      setTerputus(
        typeof alasan === 'string' ? alasan : 'transport agen tertutup',
      );
      setStatus('gagal');
    }).then(
      (stop) => {
        if (dibatalkan) stop();
        else lepas = stop;
      },
      () => {
        // Tidak ada yang berguna untuk ditampilkan: kegagalan mendaftar
        // pendengar ini hanya berarti kabar putusnya koneksi tidak sampai,
        // dan itu sudah terlihat dari giliran yang gagal.
      },
    );

    return () => {
      dibatalkan = true;
      lepas?.();
    };
  }, []);

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-heading text-lg font-medium">
          Midscene Desktop — {agen?.label ?? AGEN_BAWAAN.label}
        </h1>
        <p className="text-sm text-muted-foreground">
          <span
            aria-hidden="true"
            className={
              status === 'tersambung'
                ? 'mr-2 inline-block size-2 rounded-full bg-emerald-500'
                : status === 'menyambung'
                  ? 'mr-2 inline-block size-2 animate-pulse rounded-full bg-amber-500'
                  : 'mr-2 inline-block size-2 rounded-full bg-destructive'
            }
          />
          {labelStatus(status)}
          {agen ? ` — ${agen.name} di ${agen.cwd}` : null}
        </p>

        {/*
          Butir 4 dari brief Task 8: saat mode izin penuh menyala, penandanya
          wajib terlihat tanpa membuka menu apa pun — bertahan lintas
          peluncuran lewat berkas pengaturan (Task 3) berarti pengguna bisa
          membuka jendela ini besok dalam keadaan menyetujui segalanya tanpa
          sadar kalau penandanya disembunyikan di balik interaksi. Ditaruh di
          header, bukan di dekat togglenya saja, supaya tetap terlihat
          sekalipun toggle dan header nanti dipisah tata letaknya di 2b-3.

          Keadaan `'tidak-diketahui'` (temuan tinjauan pra-gabung) dapat pil
          sendiri, bukan sekadar tidak menampilkan apa-apa seperti `'mati'`:
          diam di sini persis kebalikan dari yang boleh terjadi pada kendali
          ini, karena Rust boleh jadi masih menyetujui semuanya otomatis.
          `role="alert"` (bukan `role="status"` seperti pil "menyala") supaya
          pembaca layar mengabarkannya seketika, bukan menunggu giliran fokus.
        */}
        {izinPenuh === 'nyala' ? (
          <p
            role="status"
            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
          >
            <span
              aria-hidden="true"
              className="mr-1 inline-block size-1.5 rounded-full bg-amber-500"
            />
            Izin penuh menyala — permintaan izin disetujui otomatis
          </p>
        ) : izinPenuh === 'tidak-diketahui' ? (
          <p
            role="alert"
            className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
          >
            <span
              aria-hidden="true"
              className="mr-1 inline-block size-1.5 rounded-full bg-destructive"
            />
            Status izin penuh tidak diketahui — mode ini bisa saja masih
            menyala
          </p>
        ) : null}
      </header>

      {/*
        Pemilih agen. Agen yang aktif selalu terlihat lewat `aria-pressed` dan
        gaya tombolnya — berpindah tidak pernah sesuatu yang terjadi diam-diam
        (lihat `sambungKe`: status langsung berubah ke "menyambung" begitu
        tombol ditekan). Tombol dimatikan selama penyambungan berlangsung
        supaya tidak ada dua percobaan `connect_agent` yang tumpang tindih.
        Penataan visualnya seadanya — lihat brief Task 7, penataan sungguhan
        adalah pekerjaan 2b-3.
      */}
      <div role="group" aria-label="Pilih agen" className="flex flex-wrap gap-2">
        {AGEN_TERSEDIA.map((a) => {
          const aktif = agen?.id === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => sambungKe(a.id)}
              disabled={status === 'menyambung'}
              aria-pressed={aktif}
              className={
                aktif
                  ? 'rounded-md border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary'
                  : 'rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50'
              }
            >
              {a.label}
            </button>
          );
        })}
      </div>

      {/*
        Toggle mode izin penuh (Task 3 menyimpannya, Task 8 memberinya
        kendali). Nilainya diset optimis begitu ditekan: kontrak
        `set_full_permissions` menjamin flag di memori Rust sudah berubah
        seketika perintah dipanggil, terlepas dari berhasil-tidaknya
        penyimpanan ke disk (lihat `ubahIzinPenuh` di atas) — jadi menunggu
        jawaban dulu sebelum mengubah tampilan hanya akan membuat togglenya
        terasa tertunda tanpa alasan. Bila jawabannya `Err`, keadaan dibaca
        ulang dari `get_full_permissions`, bukan dikembalikan ke nilai
        sebelumnya. Penataan visualnya seadanya, sama seperti pemilih agen di
        atas — lihat brief Task 8, penataan sungguhan adalah pekerjaan 2b-3.

        Keadaan `'tidak-diketahui'`: tombolnya sengaja DIMATIKAN, bukan
        dibiarkan bisa ditekan dengan peringatan. Alasannya bukan estetika:
        `ubahIzinPenuh` menghitung nilai baru sebagai kebalikan dari yang
        tampil sekarang (`izinPenuh === 'nyala' ? 'mati' : 'nyala'`), dan
        "kebalikan dari tidak diketahui" tidak punya arti — mengirim tebakan
        itu ke `set_full_permissions` bisa menyalakan sesuatu yang sebetulnya
        sudah menyala (menyimpan ulang yang sama, tidak berbahaya) atau
        mematikan sesuatu yang pengguna kira sudah mati padahal justru
        sedang menyala (persis kegagalan yang harus dihindari kendali ini).
        Jalan pulih yang ditawarkan sama seperti pola putusnya koneksi di
        bawah: tutup dan buka kembali jendela, yang memicu pembacaan mount
        yang baru. `aria-checked="mixed"` dipakai apa adanya sebagai nilai
        ketiga yang tidak bisa disalahartikan sebagai "mati" — ARIA baku
        untuk `role="switch"` sebetulnya cuma mengenal true/false, tapi pil
        di header dan galat di bawah (keduanya `role="alert"`) yang membawa
        kabar sungguhan untuk pembaca layar; atribut ini hanya menjaga supaya
        togglenya sendiri tidak ikut berbohong "mati".
      */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <div>
          <p className="text-sm font-medium">Izin penuh</p>
          <p className="text-xs text-muted-foreground">
            {izinPenuh === 'tidak-diketahui'
              ? 'Status sebenarnya tidak diketahui — tutup dan buka kembali jendela ini untuk memastikan.'
              : 'Permintaan izin dari agen akan disetujui otomatis tanpa bertanya.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={
            izinPenuh === 'nyala' ? true : izinPenuh === 'tidak-diketahui' ? 'mixed' : false
          }
          aria-label="Izin penuh"
          onClick={() => void ubahIzinPenuh()}
          disabled={sedangMengubahIzin || izinPenuh === 'tidak-diketahui'}
          className={
            izinPenuh === 'nyala'
              ? 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-primary transition-colors disabled:opacity-50'
              : izinPenuh === 'tidak-diketahui'
                ? 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-muted ring-2 ring-destructive/60 transition-colors disabled:opacity-50'
                : 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-muted transition-colors disabled:opacity-50'
          }
        >
          <span
            aria-hidden="true"
            className={
              izinPenuh === 'nyala'
                ? 'inline-block size-4 translate-x-4 rounded-full bg-background transition-transform'
                : izinPenuh === 'tidak-diketahui'
                  ? 'inline-block size-4 translate-x-2 rounded-full bg-background transition-transform'
                  : 'inline-block size-4 translate-x-0.5 rounded-full bg-background transition-transform'
            }
          />
        </button>
      </div>

      {izinPenuhGalat ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {izinPenuhGalat}
        </p>
      ) : null}

      {/*
        Paling banyak satu kabar buruk untuk satu kegagalan. Sambungan yang
        tidak pernah jadi mengembalikan galat dari `connect_agent` dan tidak
        mengemisikan `agent-disconnected`; menampilkan keduanya berarti
        pengguna membaca dua kabar untuk satu peristiwa.
      */}
      {galat ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {galat}
        </p>
      ) : terputus ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          Koneksi ke agen {agen?.label ?? AGEN_BAWAAN.label} terputus (
          {terputus}). Tutup dan buka kembali jendela ini untuk menyambung
          ulang.
        </p>
      ) : null}

      <Chat agenTersambung={status === 'tersambung'} />
      <PermissionDialog />
    </main>
  );
}

export default App;
