import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';

import { Chat } from './components/Chat';
import { PermissionDialog } from './components/PermissionDialog';

/** Nama event Tauri yang mengabarkan transport agen tertutup di luar kehendak kita. */
const EVENT_AGENT_DISCONNECTED = 'agent-disconnected';

/**
 * Agen yang dipakai jendela ini.
 *
 * `bin` diulang di sisi webview dengan sengaja: `connect_agent` mengembalikan
 * kalimat galat yang tidak menyebut nama binernya (lihat `user_message` di
 * `commands.rs`), padahal "biner mana yang harus saya pasang" adalah satu-satunya
 * hal yang ingin diketahui pengguna ketika sambungannya gagal.
 */
const AGEN = { id: 'claude', label: 'Claude', bin: 'claude-agent-acp' } as const;

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

function App() {
  const [status, setStatus] = useState<StatusKoneksi>('menyambung');
  const [agen, setAgen] = useState<AgentInfo | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [terputus, setTerputus] = useState<string | null>(null);

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
    invoke<AgentInfo>('connect_agent', { agentId: AGEN.id }).then(
      (info) => {
        setAgen(info);
        setStatus('tersambung');
      },
      (penyebab: unknown) => {
        setStatus('gagal');
        setGalat(
          `Agen ${AGEN.label} gagal disambungkan: ${String(penyebab)} ` +
            `Pastikan biner "${AGEN.bin}" sudah terpasang dan bisa ditemukan di PATH.`,
        );
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
          Midscene Desktop — {AGEN.label}
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
      </header>

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
          Koneksi ke agen {AGEN.label} terputus ({terputus}). Tutup dan buka
          kembali jendela ini untuk menyambung ulang.
        </p>
      ) : null}

      <Chat agenTersambung={status === 'tersambung'} />
      <PermissionDialog />
    </main>
  );
}

export default App;
