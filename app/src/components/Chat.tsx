import { useChat } from '@tanstack/ai-react';
import type { UIMessage } from '@tanstack/ai-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useState } from 'react';
import { LoaderIcon, SendIcon, WrenchIcon } from 'lucide-react';

import { createTauriAcpConnection } from '../connection/tauri-acp-connection';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
  Message,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';

/** Ubah apa pun yang dilempar menjadi kalimat yang layak ditampilkan. */
function pesanGalat(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Terjadi galat yang tidak dikenali.';
}

function labelPeran(role: UIMessage['role']): string {
  if (role === 'user') return 'Anda';
  if (role === 'assistant') return 'Agen';
  return 'Sistem';
}

export interface ChatProps {
  /** `true` begitu `connect_agent` berhasil; input dikunci sebelum itu. */
  agenTersambung: boolean;
}

/**
 * Jendela percakapan.
 *
 * Komponen ini — bukan komponen lain — yang memasang `useChat`, dan karena itu
 * dia juga yang memegang `whenReady()`. Urutannya penting: hook dijalankan
 * sesuai urutan penulisan, jadi efek `live: true` milik `useChat` (yang
 * memanggil `connection.subscribe()`) selalu berjalan sebelum efek apa pun yang
 * ditulis di bawahnya di komponen ini. Menaruh `whenReady()` di komponen anak
 * akan membalik urutan itu — efek anak berjalan lebih dulu — dan gerbangnya
 * menjadi tidak berarti.
 */
export function Chat({ agenTersambung }: ChatProps) {
  const connection = useMemo(
    () => createTauriAcpConnection({ invoke, listen }),
    [],
  );
  const { messages, sendMessage, isLoading, error } = useChat({
    connection,
    live: true,
  });

  const [teks, setTeks] = useState('');
  const [langgananSiap, setLanggananSiap] = useState(false);
  const [galatLokal, setGalatLokal] = useState<string | null>(null);
  const [mengirim, setMengirim] = useState(false);

  // Efek ini hidup di komponen yang sama dengan `useChat` di atas, sehingga
  // `subscribe()` dijamin sudah dipanggil ketika badan efek ini jalan.
  // `whenReady()` sendiri yang menangani mount ganda StrictMode: ia mengikuti
  // langganan pengganti, dan menolak bila tidak ada penggantinya.
  useEffect(() => {
    let dibatalkan = false;
    connection.whenReady().then(
      () => {
        if (!dibatalkan) setLanggananSiap(true);
      },
      (penyebab: unknown) => {
        if (!dibatalkan) {
          setLanggananSiap(false);
          setGalatLokal(
            `Aliran kejadian agen gagal disiapkan: ${pesanGalat(penyebab)}`,
          );
        }
      },
    );
    return () => {
      dibatalkan = true;
    };
  }, [connection]);

  const bolehKirim =
    agenTersambung && langgananSiap && !mengirim && teks.trim().length > 0;

  async function kirim() {
    const isi = teks.trim();
    if (!isi || mengirim) return;

    setMengirim(true);
    setGalatLokal(null);
    try {
      // Gerbang sesungguhnya. `RUN_STARTED` diemisikan Rust begitu
      // `send_prompt` jalan; bila pendengar `agui` belum terdaftar saat itu,
      // event-nya hilang dan spinner tidak pernah berhenti.
      await connection.whenReady();
      setTeks('');
      await sendMessage(isi);
    } catch (penyebab) {
      setGalatLokal(pesanGalat(penyebab));
    } finally {
      setMengirim(false);
    }
  }

  const galat = galatLokal ?? (error ? pesanGalat(error) : null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1 rounded-lg border">
          <MessageScrollerViewport className="p-4">
            <MessageScrollerContent>
              {messages.length === 0 ? (
                <p className="m-auto max-w-md text-center text-sm text-muted-foreground">
                  Belum ada percakapan. Mulailah dengan satu permintaan.
                </p>
              ) : (
                messages.map((pesan) => (
                  <MessageScrollerItem
                    key={pesan.id}
                    messageId={pesan.id}
                    scrollAnchor={pesan.role === 'user'}
                  >
                    <MessageGroup>
                      <Message align={pesan.role === 'user' ? 'end' : 'start'}>
                        <MessageContent>
                          <MessageHeader>{labelPeran(pesan.role)}</MessageHeader>
                          {pesan.parts.map((bagian, indeks) => {
                            if (bagian.type === 'text') {
                              return (
                                <p
                                  key={indeks}
                                  className="rounded-lg bg-muted px-3 py-2 whitespace-pre-wrap"
                                >
                                  {bagian.content}
                                </p>
                              );
                            }
                            if (bagian.type === 'thinking') {
                              return (
                                <p
                                  key={indeks}
                                  className="px-3 text-sm whitespace-pre-wrap text-muted-foreground italic"
                                >
                                  {bagian.content}
                                </p>
                              );
                            }
                            if (bagian.type === 'tool-call') {
                              return (
                                <Marker key={indeks} className="px-3">
                                  <MarkerIcon>
                                    <WrenchIcon />
                                  </MarkerIcon>
                                  <MarkerContent>
                                    Menjalankan alat{' '}
                                    <span className="font-mono">
                                      {bagian.name}
                                    </span>
                                  </MarkerContent>
                                </Marker>
                              );
                            }
                            return null;
                          })}
                        </MessageContent>
                      </Message>
                    </MessageGroup>
                  </MessageScrollerItem>
                ))
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {galat ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
          {galat}
        </p>
      ) : null}

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void kirim();
        }}
      >
        <Textarea
          value={teks}
          onChange={(e) => setTeks(e.target.value)}
          onKeyDown={(e) => {
            // Enter mengirim, Shift+Enter menyisipkan baris baru. Saat IME
            // sedang menyusun huruf, Enter itu milik IME — jangan dirampas.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) {
              return;
            }
            e.preventDefault();
            void kirim();
          }}
          rows={3}
          disabled={!agenTersambung}
          aria-label="Pesan untuk agen"
          placeholder="Minta sesuatu — misalnya: buat dokumentasi alur checkout"
          className="min-h-[72px] resize-none"
        />
        <Button type="submit" disabled={!bolehKirim}>
          {isLoading || mengirim ? (
            <LoaderIcon className="animate-spin" />
          ) : (
            <SendIcon />
          )}
          Kirim
        </Button>
      </form>
    </div>
  );
}
