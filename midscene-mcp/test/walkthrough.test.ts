import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { ScenarioStore } from '../src/scenarios.ts';
import { FakeDevice } from '../src/devices/fake.ts';

const BUILD_DEMO = join(import.meta.dirname, '..', '..', 'build-demo.js');

async function hubungkan() {
  const dir = await mkdtemp(join(tmpdir(), 'walkthrough-'));
  const sessions = new SessionManager(async (t) => new FakeDevice(t));
  const store = new ScenarioStore(dir);
  const server = createServer({ sessions, store, buildDemoPath: BUILD_DEMO });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dir };
}

test('build_walkthrough menolak report yang tidak ada', async () => {
  const { client, dir } = await hubungkan();
  const hasil = await client.callTool({
    name: 'build_walkthrough',
    arguments: { reportPath: join(dir, 'hantu.html'), out: join(dir, 'keluar.html') },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /REPORT_MISSING/);
});

test('build_walkthrough menghasilkan HTML dari report nyata', async (t) => {
  const reportNyata = join(
    import.meta.dirname,
    '..',
    '..',
    'midscene_run',
    'report',
    'computer-2026-08-04_10-01-05-ba195085.html',
  );
  // midscene_run/ masuk .gitignore: report contoh mungkin tidak ada di mesin CI
  // atau kloning bersih. Lewati dengan anggun bila memang tidak ada, tapi jalankan
  // sungguhan (dan wajib lulus) ketika berkasnya tersedia.
  if (!existsSync(reportNyata)) {
    t.skip('report contoh tidak tersedia di midscene_run/report');
    return;
  }

  const { client, dir } = await hubungkan();
  const out = join(dir, 'demo.html');
  const hasil = await client.callTool({
    name: 'build_walkthrough',
    arguments: { reportPath: reportNyata, out },
  });
  assert.notEqual(hasil.isError, true);
  const berkas = await readdir(dir);
  assert.ok(berkas.includes('demo.html'), 'berkas keluaran harus ada');
});

test('build_walkthrough melaporkan galat build-demo apa adanya', async () => {
  const { client, dir } = await hubungkan();
  const rusak = join(dir, 'rusak.html');
  await writeFile(rusak, '<html>tanpa blok dump</html>', 'utf8');
  const hasil = await client.callTool({
    name: 'build_walkthrough',
    arguments: { reportPath: rusak, out: join(dir, 'keluar.html') },
  });
  assert.equal(hasil.isError, true);
  // Memastikan stderr asli dari build-demo.js benar-benar diteruskan, bukan
  // pesan generik: build-demo.js selalu menulis "Tidak ada data langkah di
  // <basename>." ke stderr ketika berkas input tidak punya blok dump
  // (lihat build-demo.js baris ~930). rusak selalu bernama "rusak.html".
  assert.match(
    (hasil.content as any)[0].text,
    /Tidak ada data langkah di rusak\.html/,
  );
});
