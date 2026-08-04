#!/usr/bin/env node
// Adapter ACP tiruan untuk satu tujuan: membuktikan `new_session` menyerah
// alih-alih menggantung.
//
// Kenapa perlu proses tersendiri, bukan mock di dalam Rust: `AcpHandle` hanya
// bisa lahir dari `connect`, yang men-spawn proses sungguhan lewat `AcpAgent`.
// Jadi satu-satunya cara menguji jalur ini dari luar adalah lawan bicara yang
// juga proses sungguhan.
//
// Kenapa `tail` (trik Task 3) tidak cukup di sini: `tail` membisu sejak awal,
// jadi ia gugur di `initialize` dan tidak pernah sampai ke `session/new`. Yang
// dibutuhkan adalah adapter yang **sehat sampai handshake selesai** lalu diam —
// persis bentuk kegagalan sungguhan yang dijaga, yaitu server MCP yang di-spawn
// agen tidak pernah siap.
//
// Transportnya newline-delimited JSON di atas stdin/stdout
// (`agent-client-protocol-2.0.0/src/stdio.rs`: `BufReader::new(stdin).lines()`).
// `InitializeResponse` hanya mewajibkan `protocolVersion`; semua field lain
// `#[serde(default)]` (`agent-client-protocol-schema-1.5.0/src/v1/agent.rs:134-167`),
// dan `ProtocolVersion` adalah angka telanjang (`.../src/version.rs:23`).

let sisa = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (potongan) => {
  sisa += potongan;

  for (;;) {
    const batas = sisa.indexOf('\n');
    if (batas < 0) break;

    const baris = sisa.slice(0, batas).trim();
    sisa = sisa.slice(batas + 1);
    if (baris === '') continue;

    let pesan;
    try {
      pesan = JSON.parse(baris);
    } catch {
      continue;
    }

    if (pesan.method === 'initialize' && pesan.id !== undefined) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: pesan.id,
          result: { protocolVersion: 1 },
        })}\n`,
      );
    }

    // Selain `initialize`: diam, dan tetap hidup. Tidak ada balasan, tidak ada
    // error, tidak ada EOF — tepatnya kondisi yang membuat `block_task`
    // menunggu selamanya.
  }
});

// Keluar begitu klien menutup stdin, supaya tidak ada proses tertinggal bila
// sesuatu di sisi Rust gagal sebelum sempat membunuh process group.
process.stdin.on('end', () => process.exit(0));
