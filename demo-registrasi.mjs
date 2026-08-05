/**
 * Merekam walkthrough pendaftaran faskes di rekamedika.com.
 *
 *   node --env-file=.env demo-registrasi.mjs
 *
 * Memakai @midscene/web (puppeteer) supaya tangkapan layar hanya berisi
 * jendela browser — bukan seluruh desktop seperti @midscene/computer.
 */

import puppeteer from 'puppeteer';
import { PuppeteerAgent } from '@midscene/web/puppeteer';

process.env.MIDSCENE_REPORT_TAG_NAME ??= 'registrasi-rekamedika';

// Midscene mematok mutu JPEG di 90 dan tidak menyediakan pengaturannya, jadi satu-
// satunya tuas ketajaman adalah deviceScaleFactor: 2 menghasilkan 2880x1800.
const browser = await puppeteer.launch({
  headless: false,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  args: ['--window-size=1456,1000'],
});

try {
  const page = await browser.newPage();
  await page.goto('https://rekamedika.com', { waitUntil: 'networkidle2', timeout: 60000 });

  const agent = new PuppeteerAgent(page, {
    aiActionContext:
      'Ini situs Rekamedika, sistem informasi manajemen rumah sakit dan klinik. ' +
      'Bahasa antarmukanya Indonesia.',
  });

  // 1 — beranda
  await agent.aiAssert('Halaman beranda Rekamedika tampil beserta menu navigasi di bagian atas');

  // 2 — masuk ke alur pendaftaran
  await agent.aiAct('klik tombol "Coba Gratis" di bagian kanan atas halaman');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

  // 3 — halaman pendaftaran
  await agent.aiAssert('Halaman pendaftaran faskes terbuka dengan judul "Daftarkan faskes Anda"');

  // 4 — menjawab pertanyaan pertama wizard
  await agent.aiAct('pilih jawaban bahwa fasyankes sudah terdaftar di Kemenkes');

  // 5 — hasil setelah menjawab
  const lanjutan = await agent.aiQuery(
    '{pertanyaan: string, pilihan: string[]}, pertanyaan atau isian yang muncul di layar saat ini',
  );
  console.log('Tahap berikutnya:', lanjutan);

  console.log('Selesai. Report ada di ./midscene_run/report/');
} finally {
  await browser.close();
}
