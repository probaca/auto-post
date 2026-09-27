/**
 * auto-post-luna.js
 * ---------------------------------------------------------------
 * Sistem auto-posting artikel menggunakan model OpenAI GPT-5.6 Luna
 * untuk menulis ulang/meringkas artikel berdasarkan sumber RESMI
 * lengkap dengan foto dari sumber yang sama beserta kredit fotonya.
 * PENTING (baca dulu sebelum pakai):
 * 1) Skrip ini secara default membuat DRAFT, bukan langsung tayang
 *    (lihat POST_STATUS di .env). Selalu ada proses review redaksi
 *    manusia sebelum publish. Ini bukan cuma soal hukum, tapi juga
 *    tanggung jawab jurnalistik.
 * 2) Hanya gunakan sumber yang memang boleh diringkas/diolah ulang,
 *    termasuk fotonya (rilis pers resmi, data pemerintah, feed yang
 *    punya izin sindikasi). Jangan menarik artikel/foto penuh dari
 *    media lain lalu menyuruh AI "menulis ulang", itu berisiko
 *    pelanggaran hak cipta & plagiarisme, walau kata-katanya beda.
 * 3) Selalu cantumkan atribusi sumber di setiap artikel DAN di
 *    setiap foto yang dipakai (sudah otomatis dilakukan skrip ini).
 * ---------------------------------------------------------------
 */

require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');
const OpenAI = require('openai');
const fs = require('fs');
const cheerio = require('cheerio');

// ---------- KONFIGURASI ----------
const WP_URL = process.env.WP_URL; // contoh: https://namawebsite.com
const WP_USER = process.env.WP_USER; // username Anda
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD; // application password user pengguna
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_CATEGORY_ID = parseInt(process.env.DEFAULT_CATEGORY_ID || '1', 10);
const POST_STATUS = process.env.POST_STATUS || 'draft'; // 'draft' (disarankan) atau 'publish'
const SERTAKAN_FOTO = (process.env.SERTAKAN_FOTO || 'true') === 'true'; // set 'false' untuk matikan seluruh fitur foto (tidak ambil & tidak upload foto sama sekali)
const MINIMAL_LEBAR_GAMBAR = parseInt(process.env.MINIMAL_LEBAR_GAMBAR || '800', 10); // tolak og:image di bawah lebar ini (piksel)
const SISIPKAN_FOTO_DI_ARTIKEL = (process.env.SISIPKAN_FOTO_DI_ARTIKEL || 'false') === 'true'; // default MATI supaya tidak dobel dengan featured image yang sudah ditampilkan tema JNews di atas artikel
const MAKS_BERITA_PER_PROSES = parseInt(process.env.MAKS_BERITA_PER_PROSES || '2', 10); // batas jumlah berita yang diproses dalam satu kali jalan
const SERTAKAN_RINGKASAN = (process.env.SERTAKAN_RINGKASAN || 'true') === 'true'; // tampilkan kotak ringkasan/highlight di awal artikel
const SERTAKAN_TAG_OTOMATIS = (process.env.SERTAKAN_TAG_OTOMATIS || 'true') === 'true'; // isi 4 tag WordPress secara otomatis
const MODE_ATRIBUSI_SUMBER = process.env.MODE_ATRIBUSI_SUMBER || 'link'; // 'link' (nama sumber jadi hyperlink), 'teks' (nama sumber tanpa link), 'tidak' (tidak ditampilkan sama sekali)
const AMBIL_ARTIKEL_LENGKAP = (process.env.AMBIL_ARTIKEL_LENGKAP || 'true') === 'true'; // ambil teks lengkap halaman sumber (bukan cuma cuplikan RSS) supaya kutipan tidak hilang

// Daftar sumber RSS. GANTI dengan sumber RESMI sesuai rubrik Anda.
// Field "selector" OPSIONAL: CSS selector kontainer isi artikel di halaman
// sumber (mis. '.entry-content', '.post-content', '.detail-konten'). Isi
// kalau Anda tahu strukturnya supaya ekstraksi lebih akurat; kalau dikosongkan,
// skrip mencoba beberapa selector umum lalu fallback ke gabungan semua <p>.
const RSS_SOURCES = [
  { name: 'Setkab RI', url: 'https://setkab.go.id/feed/', selector: '.entry-content' },
  { name: 'Antaranews Rilis Pers', url: 'https://www.antaranews.com/rss/rilis-pers.xml', selector: '.post-content' },
  { name: 'Detikcom', url: 'https://news.detik.com/berita/rss', selector: '.post-content' },
];

const LOG_FILE = './posted-log.json'; // penyimpanan sederhana anti-duplikat
// -----------------------------------

// customFields ditambahkan supaya rss-parser juga menangkap tag
// media:content / media:thumbnail (ekstensi Media RSS yang sering
// dipakai untuk menyisipkan foto di feed lembaga resmi).
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
    ],
  },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function loadPostedLinks() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function savePostedLink(link) {
  const links = loadPostedLinks();
  links.push(link);
  fs.writeFileSync(LOG_FILE, JSON.stringify(links, null, 2));
}

async function fetchNewItems() {
  const posted = loadPostedLinks();
  const newItems = [];
  for (const source of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items) {
        if (item.link && !posted.includes(item.link)) {
          newItems.push({ ...item, sourceName: source.name, sourceSelector: source.selector });
        }
      }
    } catch (err) {
      console.error(`Gagal mengambil feed "${source.name}":`, err.message);
    }
  }
  return newItems;
}

/**
 * Mencari URL foto dari item RSS, dengan urutan prioritas:
 * 1) tag <enclosure> standar RSS (kalau tipenya gambar)
 * 2) tag Media RSS <media:content> / <media:thumbnail>
 * 3) gambar pertama yang ditemukan di dalam isi/HTML artikel
 * Kembalikan null kalau tidak ada foto yang bisa dipakai.
 */
function ekstrakUrlGambar(item) {
  if (item.enclosure && item.enclosure.url) {
    const tipe = item.enclosure.type || '';
    if (!tipe || tipe.startsWith('image')) return item.enclosure.url;
  }

  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
    return item.mediaContent.$.url;
  }
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) {
    return item.mediaThumbnail.$.url;
  }

  const html = item['content:encoded'] || item.content || item.contentSnippet || '';
  const match = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match) return match[1];

  return null;
}

/**
 * FALLBACK kalau ekstrakUrlGambar() di atas tidak menemukan apa-apa —
 * terjadi kalau feed RSS sumbernya sama sekali tidak menyertakan gambar.
 * Solusinya: buka halaman artikel ASLI dan baca tag
 * <meta property="og:image">, yang hampir selalu ada di situs modern
 * (dipakai untuk pratinjau saat dibagikan ke media sosial).
 */
async function ambilOgImage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-jnews bot)' },
    });
    const $ = cheerio.load(res.data);
    const ogImage =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content');
    if (!ogImage) return null;

    // Kalau situsnya mencantumkan lebar gambar (og:image:width), cek dulu
    // supaya tidak mengambil gambar yang memang aslinya kecil/buram --
    // kalau tidak dicantumkan, tetap dicoba (banyak situs tidak mengisi ini).
    const lebar = parseInt($('meta[property="og:image:width"]').attr('content') || '0', 10);
    if (lebar && lebar < MINIMAL_LEBAR_GAMBAR) {
      console.log(`  og:image ditemukan tapi resolusinya kecil (${lebar}px, minimal ${MINIMAL_LEBAR_GAMBAR}px) -- dilewati.`);
      return null;
    }
    return ogImage;
  } catch (err) {
    console.warn(`  Gagal mengambil og:image dari ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Mengunduh foto dari sumber, mengunggahnya ke Media Library WordPress,
 * lalu menandai caption & alt text-nya dengan kredit foto berdasarkan
 * nama sumber. Mengembalikan { mediaId, sourceUrlWp } atau null kalau
 * gagal/tidak ada foto.
 */
async function unggahFotoDenganKredit(urlGambar, sourceName) {
  if (!urlGambar) return null;

  try {
    const unduhan = await axios.get(urlGambar, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-jnews bot)' },
    });

    const contentType = unduhan.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      console.warn(`Dilewati: URL bukan gambar (${contentType || 'tidak diketahui'}) -> ${urlGambar}`);
      return null;
    }

    const ekstensi = contentType.split('/')[1].split('+')[0].split(';')[0] || 'jpg';
    const namaFile = `berita-${Date.now()}.${ekstensi}`;
    const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

    const unggah = await axios.post(`${WP_URL}/wp-json/wp/v2/media`, unduhan.data, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${namaFile}"`,
      },
      maxBodyLength: Infinity,
    });

    const mediaId = unggah.data.id;
    const teksKredit = `Sumber ${sourceName}`;

    // Tandai caption & alt text supaya kredit foto ikut tampil
    // (JNews umumnya menampilkan caption media di bawah featured image).
    await axios.post(
      `${WP_URL}/wp-json/wp/v2/media/${mediaId}`,
      { caption: teksKredit, alt_text: teksKredit, description: teksKredit },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );

    return { mediaId, sourceUrlWp: unggah.data.source_url };
  } catch (err) {
    console.error('Gagal mengunggah foto:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Mencari ID tag WordPress berdasarkan nama; kalau belum ada, membuat tag
 * baru. Mengembalikan ID (number) atau null kalau gagal.
 */
async function dapatkanIdTag(namaTag) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  try {
    const cari = await axios.get(`${WP_URL}/wp-json/wp/v2/tags`, {
      params: { search: namaTag, per_page: 100 },
      headers: { Authorization: `Basic ${auth}` },
    });
    const cocok = cari.data.find((t) => t.name.toLowerCase() === namaTag.toLowerCase());
    if (cocok) return cocok.id;

    const buat = await axios.post(
      `${WP_URL}/wp-json/wp/v2/tags`,
      { name: namaTag },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );
    return buat.data.id;
  } catch (err) {
    console.error(`Gagal memproses tag "${namaTag}":`, err.response?.data || err.message);
    return null;
  }
}

/** Memanggil dapatkanIdTag() untuk beberapa nama tag sekaligus. */
async function dapatkanIdTagBanyak(daftarNamaTag) {
  const ids = [];
  for (const nama of daftarNamaTag) {
    const id = await dapatkanIdTag(nama);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Mengambil teks artikel LENGKAP dari halaman sumber (bukan cuma cuplikan
 * RSS yang sering terpotong/tanpa kutipan). Mencoba selector kustom dulu
 * (kalau diisi di RSS_SOURCES), lalu beberapa selector umum, lalu fallback
 * ke gabungan semua tag <p> di halaman. Mengembalikan null kalau gagal —
 * pemanggilnya lalu jatuh balik memakai cuplikan RSS seperti biasa.
 */
async function ambilTeksArtikelLengkap(url, selectorKustom) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-jnews bot)' },
    });
    const $ = cheerio.load(res.data);

    const daftarSelector = [selectorKustom, '.entry-content', '.post-content', '.detail-konten', '.content-detail', 'article'].filter(Boolean);
    for (const sel of daftarSelector) {
      const teks = $(sel).first().text().replace(/\s+/g, ' ').trim();
      if (teks && teks.length > 200) return teks.slice(0, 6000); // batasi panjang supaya hemat token
    }

    // Fallback terakhir: gabungkan semua paragraf di halaman.
    const gabunganParagraf = $('p').map((_, el) => $(el).text().trim()).get().filter(Boolean).join('\n');
    return gabunganParagraf ? gabunganParagraf.slice(0, 6000) : null;
  } catch (err) {
    console.warn(`  Gagal mengambil artikel lengkap dari ${url}: ${err.message} — memakai cuplikan RSS saja.`);
    return null;
  }
}

async function tulisArtikelDenganLuna(item) {
  const systemPrompt = `Bertindaklah sebagai jurnalis dan editor profesional sekaligus spesialis SEO berpengalaman.
Tugas Anda: menyusun ULANG sebuah berita dari sumber resmi menjadi tulisan berbahasa 
Indonesia yang terasa seperti hasil kerja redaksi manusia, bukan tulisan generik dan
formulaik. Tentukan angle yang paling relevan kemudian susun ulang artikel menjadi baru. 
Bukan menerjemahkan, menyalin, atau memparafrasekan setiap kalimat satu per satu. 
Anda boleh mengubah urutan paragraf; menggabungkan informasi yang berulang; 
memecah paragraf yang terlalu panjang; memilih informasi terpenting untuk 
ditempatkan pada bagian awal artikel, namun, jangan mengubah makna informasi.

Aturan ketat yang WAJIB dipatuhi:
1. Gunakan HANYA informasi yang terdapat dalam sumber. Jangan mencari, 
   menambahkan, mengasumsikan, atau mengarang informasi dari luar sumber.
2. PERTAHANKAN seluruh kutipan LANGSUNG (perkataan narasumber dalam tanda
   kutip) PERSIS SAMA kata-katanya. Jangan diparafrasekan, ditambah,
   dikurangi, atau diubah sama sekali. Ini termasuk aturan paling penting,
   kecuali hanya menerjemahkannya ke dalam Bahasa Indonesia.
3. PERTAHANKAN juga substansi kutipan TIDAK LANGSUNG (mis. "menurut ...",
   "... menjelaskan bahwa ...", "... menyatakan ..."). Redaksi kalimatnya
   boleh disusun ulang secukupnya, tapi seluruh informasi & atribusinya
   (siapa yang menyatakan apa) harus tetap ada, jangan sampai hilang atau
   dilebur jadi kalimat umum tanpa atribusi.
4. Pertahankan detail konkret dari sumber: angka, nama, lokasi, waktu,
   jabatan, nama instansi. JANGAN diringkas jadi kalimat umum yang kehilangan
   detail tersebut, karena hasilnya akan terasa hambar dan tidak jurnalistik.
5. Jangan menambahkan fakta, angka, tanggal, lokasi, jabatan, identitas, 
   latar belakang, konteks, kesimpulan, atau kutipan yang tidak tersedia 
   dalam sumber.
6. Jika informasi pada sumber kurang lengkap untuk mengisi salah satu unsur
   5W+1H (siapa, apa, kapan, di mana, mengapa, bagaimana), tetap berdasarkan 
   informasi yang tersedia dan jangan mengisi kekosongan dengan asumsi.
7. Jaga nada netral dan objektif; hindari opini pribadi atau bahasa yang
   menghakimi/menyimpulkan sepihak.
8. Hindari kalimat filler dan generik yang tidak memberikan informasi baru, seperti:
   - “Hal ini menjadi pencapaian penting...”
   - “Momentum tersebut menjadi bukti...”
   - “Langkah ini diharapkan dapat...”
   - “Peristiwa tersebut menjadi perhatian...”
   - “Hal ini menunjukkan bahwa...”
   - “menjadi suntikan semangat...”
   - “membawa nama harum...”
   atau ungkapan sejenis jika tidak secara eksplisit berasal dari narasumber.
9. Jangan membuat interpretasi atas nama penulis. Hindari menyimpulkan dampak, 
   harapan, motivasi, keberhasilan, kegagalan, atau arti penting suatu peristiwa 
   apabila kesimpulan tersebut tidak dinyatakan atau didukung oleh sumber.
10. Gunakan transisi secara natural. Jangan memulai setiap paragraf dengan pola 
   berulang seperti “Dalam kesempatan tersebut”, “Lebih lanjut”, “Sementara itu”, 
   “Di sisi lain”, “Dalam perbincangan tersebut”, atau “Tak hanya itu” jika tidak diperlukan.
11. Variasikan struktur paragraf dan kalimat. Hindari pola paragraf yang terlalu seragam. 
   Gunakan kombinasi kalimat pendek dan sedang secara natural, tetapi prioritaskan kejelasan.
12. Buat lead yang langsung pada inti berita. Hindari lead berbunga-bunga, dramatis, promosi, 
   atau terlalu panjang.
13. Jangan membuat paragraf hanya untuk menghubungkan dua kutipan. Jika kutipan dapat 
   ditempatkan langsung setelah atribusi singkat, lakukan itu.
14. Jangan memaksakan panjang artikel. Jika bahan sumber hanya cukup untuk berita pendek, 
   buat berita pendek. Jangan menambah paragraf kosong hanya agar artikel terlihat panjang.
15. Gunakan bahasa jurnalistik Indonesia yang sederhana dan natural. Hindari bahasa birokratis, 
   hiperbolis, klise, dan pilihan kata yang terdengar seperti promosi atau humas, 
   kecuali terdapat dalam kutipan langsung.
16. Bedakan fakta dan pernyataan narasumber. Klaim, pendapat, penilaian, dan harapan dari narasumber harus memiliki atribusi yang jelas.
17. Sebelum memberikan hasil akhir, periksa secara internal bahwa tidak ada 
   fakta baru yang ditambahkan; tidak ada angka baru; tidak ada nama baru;
   tidak ada konteks dari luar sumber; tidak ada kutipan yang dibuat sendiri;
   tidak ada kesimpulan spekulatif; artikel sudah terasa seperti tulisan 
   jurnalistik baru yang alami.
18. Tuliskan teks "PROBACA.COM - " pada lead paragraf pertama sebelum artikel 
   ditulis, dan teks "***" di akhir artikel.
19. Tambahkan teks "DISCLAIMER: Sebagian proses pengolahan artikel ini dibantu 
   oleh teknologi AI. Pembaca disarankan memverifikasi kembali data dan informasi 
   melalui sumber resmi atau sumber primer" di bawah tanda teks "***" pada akhir
   artikel menggunakan huruf miring (italic).

Keluarkan jawaban PERSIS dalam format berikut, tanpa teks tambahan lain:
JUDUL: <judul berita, maksimal 12 kata, ringkas dan SEO-friendly>
RINGKASAN: <ringkasan/highlight inti berita dalam SATU paragraf singkat (2-3 kalimat, sekitar 40-60 kata), ditulis dalam satu baris tanpa enter. Akan ditampilkan di kotak highlight terpisah di awal artikel, jadi jangan sekadar mengulang kalimat pertama isi berita>
TAG: <PERSIS 4 kata kunci/frasa pendek, dipisah koma, tanpa tanda pagar #, mewakili topik utama artikel (mis. nama tempat, nama instansi, isu, sektor)>
ISI: <isi berita dalam HTML sederhana, gunakan tag <p> per paragraf, panjangnya MENYESUAIKAN panjang materi sumber. Jangan dipangkas drastis kalau sumbernya memang panjang dan detail>`;

  // Coba ambil teks LENGKAP dari halaman sumber dulu (bukan cuma cuplikan
  // RSS yang sering terpotong tanpa kutipan). Kalau gagal/dimatikan, jatuh
  // balik memakai content/contentSnippet dari feed seperti biasa.
  let materiSumber = null;
  if (AMBIL_ARTIKEL_LENGKAP) {
    materiSumber = await ambilTeksArtikelLengkap(item.link, item.sourceSelector);
  }
  if (!materiSumber) {
    materiSumber = item.content || item.contentSnippet || '(tidak ada ringkasan tersedia)';
  }

  const userPrompt = `Sumber: ${item.sourceName}
Judul asli: ${item.title}
Materi sumber:
${materiSumber}

Tautan sumber asli: ${item.link}`;

  const response = await openai.responses.create({
    model: 'gpt-5.6-luna',
    reasoning: { effort: 'medium' }, // cukup untuk tugas rewrite/ringkas; lihat panduan Bagian 2.4
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const text = response.output_text || '';
  const judulMatch = text.match(/JUDUL:\s*(.+)/);
  const ringkasanMatch = text.match(/RINGKASAN:\s*(.+)/);
  const tagMatch = text.match(/TAG:\s*(.+)/);
  const isiMatch = text.match(/ISI:\s*([\s\S]+)/);

  const tags = tagMatch
    ? tagMatch[1].split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4)
    : [];

  return {
    judul: judulMatch ? judulMatch[1].trim() : item.title,
    ringkasan: ringkasanMatch ? ringkasanMatch[1].trim() : '',
    tags,
    isi: isiMatch ? isiMatch[1].trim() : `<p>${text.trim()}</p>`,
  };
}

async function postingKeWordPress({ judul, isi, sourceLink, sourceName, foto, ringkasan, tagIds }) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  let kontenLengkap = '';

  // Foto sudah ditampilkan lewat featured_media (diatur JNews otomatis di atas
  // artikel). Sisipan <figure> berikut ini OPSIONAL, dimatikan secara default,
  // supaya foto tidak muncul dua kali. Aktifkan lewat SISIPKAN_FOTO_DI_ARTIKEL=true
  // di .env kalau tema/tampilan Anda ternyata TIDAK menampilkan featured image
  // secara otomatis.
  if (SISIPKAN_FOTO_DI_ARTIKEL && foto && foto.sourceUrlWp) {
    kontenLengkap += `<figure class="wp-block-image"><img src="${foto.sourceUrlWp}" alt="Foto: ${sourceName}" /><figcaption>Foto: ${sourceName}</figcaption></figure>\n`;
  }

  // Kotak ringkasan/highlight di awal artikel, sebelum isi berita.
  // Styling ditulis inline (bukan bergantung pada class tema tertentu) supaya
  // tetap tampil rapi di JNews versi apa pun. Sesuaikan warna/gaya sesukanya.
  if (SERTAKAN_RINGKASAN && ringkasan) {
    kontenLengkap += `<div class="ringkasan-berita" style="background:#f6f6f6;border-left:4px solid #c0392b;padding:14px 18px;margin:0 0 22px;font-size:1.05em;line-height:1.5;">
  <strong style="display:block;margin-bottom:6px;text-transform:uppercase;font-size:0.8em;letter-spacing:0.05em;color:#c0392b;">Ringkasan</strong>
  ${ringkasan}
</div>\n`;
  }

  kontenLengkap += isi;
  if (MODE_ATRIBUSI_SUMBER === 'link') {
    kontenLengkap += `\n<p><em>Sumber: <a href="${sourceLink}" target="_blank" rel="noopener nofollow">${sourceName}</a></em></p>`;
  } else if (MODE_ATRIBUSI_SUMBER === 'teks') {
    kontenLengkap += `\n<p><em>Sumber: ${sourceName}</em></p>`;
  }
  // kalau MODE_ATRIBUSI_SUMBER === 'tidak', tidak ada apa pun yang ditambahkan

  const payload = {
    title: judul,
    content: kontenLengkap,
    status: POST_STATUS,
    categories: [DEFAULT_CATEGORY_ID],
  };
  if (foto && foto.mediaId) {
    payload.featured_media = foto.mediaId;
  }
  if (SERTAKAN_RINGKASAN && ringkasan) {
    payload.excerpt = ringkasan; // ikut mengisi excerpt WordPress (dipakai JNews di listing/arsip & meta SEO)
  }
  if (SERTAKAN_TAG_OTOMATIS && tagIds && tagIds.length) {
    payload.tags = tagIds;
  }

  const res = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, payload, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

async function main() {
  console.log('Mengecek sumber berita baru...');
  const semuaItemBaru = await fetchNewItems();
  console.log(`Ditemukan ${semuaItemBaru.length} item baru total.`);

  const items = semuaItemBaru.slice(0, MAKS_BERITA_PER_PROSES);
  if (semuaItemBaru.length > items.length) {
    console.log(`Memproses ${items.length} item dulu (batas MAKS_BERITA_PER_PROSES=${MAKS_BERITA_PER_PROSES}). Sisanya ${semuaItemBaru.length - items.length} item akan diproses di jadwal berikutnya.`);
  } else {
    console.log(`Memproses ${items.length} item.`);
  }

  for (const item of items) {
    try {
      console.log(`Memproses: ${item.title}`);
      const artikel = await tulisArtikelDenganLuna(item);

      let foto = null;
      if (SERTAKAN_FOTO) {
        let urlGambar = ekstrakUrlGambar(item);
        if (!urlGambar) {
          urlGambar = await ambilOgImage(item.link); // fallback: og:image dari halaman artikel asli
        }
        if (urlGambar) {
          foto = await unggahFotoDenganKredit(urlGambar, item.sourceName);
        } else {
          console.log('  Tidak ditemukan foto pada item ini, dilanjutkan tanpa foto.');
        }
      }

      let tagIds = [];
      if (SERTAKAN_TAG_OTOMATIS && artikel.tags && artikel.tags.length) {
        tagIds = await dapatkanIdTagBanyak(artikel.tags);
      }

      const hasil = await postingKeWordPress({
        judul: artikel.judul,
        isi: artikel.isi,
        sourceLink: item.link,
        sourceName: item.sourceName,
        foto,
        ringkasan: artikel.ringkasan,
        tagIds,
      });
      console.log(`Berhasil dibuat sebagai "${POST_STATUS}" -> ID: ${hasil.id}${foto ? ' (dengan foto + kredit)' : ''}${tagIds.length ? ` (${tagIds.length} tag)` : ''}`);
      savePostedLink(item.link);
    } catch (err) {
      console.error(`Gagal memproses "${item.title}":`, err.response?.data || err.message);
    }
  }

  console.log('Selesai.');
}

main().catch((err) => {
  console.error('Terjadi error fatal:', err);
  process.exit(1);
});
