import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Nama event Tauri yang membawa satu permintaan izin. */
const EVENT_PERMISSION_REQUEST = 'permission-request';

/**
 * Satu opsi yang ditawarkan agen. Bentuk kawatnya berasal dari
 * `PermissionOption` di ACP: `optionId`, `name`, `kind`.
 */
interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

/**
 * Payload event `permission-request` seperti yang disusun `permission_gate`
 * di sisi Rust. `toolCall` adalah `ToolCallUpdate` yang diserialisasi: id-nya
 * selalu ada, `title` boleh kosong.
 */
interface PermissionRequest {
  requestId: string;
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
  } | null;
  options?: Array<PermissionOption> | null;
}

/**
 * Nama alat yang akan dijalankan.
 *
 * Judul yang ditulis agen lebih informatif, tetapi ia opsional; id panggilan
 * selalu ada. Tidak pernah mengembalikan string kosong — pengguna harus tahu
 * apa yang akan berjalan sebelum menekan "izinkan".
 */
function namaAlat(permintaan: PermissionRequest): string {
  const judul = permintaan.toolCall?.title;
  if (typeof judul === 'string' && judul.trim() !== '') return judul;

  const id = permintaan.toolCall?.toolCallId;
  if (typeof id === 'string' && id.trim() !== '') return id;

  return 'alat yang tidak disebutkan namanya';
}

/** Payload apa pun boleh datang lewat event; saring yang tidak berbentuk. */
function bacaPermintaan(payload: unknown): PermissionRequest | null {
  if (payload === null || typeof payload !== 'object') return null;
  const calon = payload as PermissionRequest;
  return typeof calon.requestId === 'string' ? calon : null;
}

/** Opsi penolakan diberi tampilan yang berbeda dari opsi persetujuan. */
function varianTombol(
  opsi: PermissionOption,
): 'default' | 'outline' | 'secondary' {
  if (opsi.kind === 'reject_once' || opsi.kind === 'reject_always') {
    return 'outline';
  }
  if (opsi.kind === 'allow_always') return 'secondary';
  return 'default';
}

/**
 * Dialog izin.
 *
 * Permintaan yang datang saat dialog masih terbuka diantre, bukan dibuang:
 * satu giliran bisa meminta izin lebih dari sekali, dan setiap permintaan
 * punya penunggu tersendiri di sisi Rust yang akan kedaluwarsa (dan menolak)
 * bila tidak dijawab.
 */
export function PermissionDialog() {
  const [antrean, setAntrean] = useState<Array<PermissionRequest>>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [menjawab, setMenjawab] = useState(false);

  useEffect(() => {
    let dibatalkan = false;
    let lepas: (() => void) | undefined;

    listen(EVENT_PERMISSION_REQUEST, (event) => {
      const permintaan = bacaPermintaan(event.payload);
      if (!permintaan) return;
      setAntrean((sebelumnya) =>
        sebelumnya.some((a) => a.requestId === permintaan.requestId)
          ? sebelumnya
          : [...sebelumnya, permintaan],
      );
    }).then(
      (stop) => {
        // Mount ganda StrictMode: bila efeknya sudah dibersihkan sebelum
        // pendaftaran selesai, lepas listener-nya alih-alih membocorkannya.
        if (dibatalkan) stop();
        else lepas = stop;
      },
      (penyebab: unknown) => {
        if (!dibatalkan) {
          setGalat(
            `Gagal mendengarkan permintaan izin: ${String(penyebab)}. ` +
              'Permintaan izin akan ditolak sendiri setelah dua menit.',
          );
        }
      },
    );

    return () => {
      dibatalkan = true;
      lepas?.();
    };
  }, []);

  const permintaan = antrean[0];

  async function jawab(optionId: string) {
    if (!permintaan || menjawab) return;
    setMenjawab(true);
    setGalat(null);
    try {
      await invoke('answer_permission', {
        requestId: permintaan.requestId,
        optionId,
      });
    } catch (penyebab) {
      // Permintaan basi (sudah kedaluwarsa atau dibatalkan agen) tetap harus
      // menutup dialognya — kalau tidak, dialog mati menghalangi yang berikut.
      setGalat(String(penyebab));
    } finally {
      setAntrean((sebelumnya) =>
        sebelumnya.filter((a) => a.requestId !== permintaan.requestId),
      );
      setMenjawab(false);
    }
  }

  const opsi = permintaan?.options ?? [];

  return (
    <Dialog open={permintaan !== undefined}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Agen meminta izin</DialogTitle>
          <DialogDescription>
            Agen ingin menjalankan alat{' '}
            <span className="font-mono text-foreground">
              {permintaan ? namaAlat(permintaan) : ''}
            </span>
            . Pilih salah satu di bawah. Tanpa jawaban, permintaan ini ditolak
            sendiri setelah dua menit.
          </DialogDescription>
        </DialogHeader>

        {galat ? (
          <p role="alert" className="text-sm text-destructive">
            {galat}
          </p>
        ) : null}

        {opsi.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Agen tidak menawarkan pilihan apa pun untuk permintaan ini.
          </p>
        ) : null}

        <DialogFooter>
          {opsi.map((pilihan) => (
            <Button
              key={pilihan.optionId}
              variant={varianTombol(pilihan)}
              disabled={menjawab}
              onClick={() => void jawab(pilihan.optionId)}
            >
              {pilihan.name}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
