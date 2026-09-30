/**
 * auto-post-sport.js
 * ---------------------------------------------------------------
 * Auto-posting KONTEN Sport/Olahraga
 * ---------------------------------------------------------------
 */

require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');
const OpenAI = require('openai');
const fs = require('fs');
const cheerio = require('cheerio');

// ---------- KONFIGURASI ----------
const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const KATEGORI_SPORT_ID = parseInt(process.env.KATEGORI_SPORT_ID || '1', 10); // ID kategori "Sport"/"Iptek" di WordPress
const POST_STATUS_SPORT = process.env.POST_STATUS_SPORT || 'draft';
const MAKS_SPORT_PER_PROSES = parseInt(process.env.MAKS_SPORT_PER_PROSES || '2', 10);
const AMBIL_ARTIKEL_LENGKAP = (process.env.AMBIL_ARTIKEL_LENGKAP || 'true') === 'true';
const SERTAKAN_FOTO = (process.env.SERTAKAN_FOTO || 'true') === 'true';
const MINIMAL_LEBAR_GAMBAR = parseInt(process.env.MINIMAL_LEBAR_GAMBAR || '800', 10); // tolak og:image di bawah lebar ini (piksel)
const SISIPKAN_FOTO_DI_ARTIKEL = (process.env.SISIPKAN_FOTO_DI_ARTIKEL || 'false') === 'true';
const SERTAKAN_RINGKASAN = (process.env.SERTAKAN_RINGKASAN || 'true') === 'true';
const SERTAKAN_TAG_OTOMATIS = (process.env.SERTAKAN_TAG_OTOMATIS || 'true') === 'true';
const MODE_ATRIBUSI_SUMBER = process.env.MODE_ATRIBUSI_SUMBER || 'link'; // 'link' (nama sumber jadi hyperlink), 'teks' (nama sumber tanpa link), 'tidak' (tidak ditampilkan sama sekali)

// Field "selector" OPSIONAL: CSS selector kontainer isi artikel di halaman
// sumber. Kalau dikosongkan, skrip mencoba selector umum lalu fallback ke
// gabungan semua <p>. Cara menemukannya sama seperti panduan Bagian 5A.4.
const RSS_SOURCES = [
  { name: 'AScom', url: 'https://as.com/rss/futbol/portada.xml', selector: '.entry-content' },
  { name: 'Football Italia', url: 'https://football-italia.net/feed/', selector: '.entry-content' },
  { name: 'Antaranews', url: 'https://www.antaranews.com/rss/sepakbola-liga-indonesia.xml', selector: '.entry-content' },
];

const LOG_FILE = './posted-sport-log.json'; // dedup terpisah dari modul lain
// -----------------------------------

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

function ekstrakUrlGambar(item) {
  if (item.enclosure && item.enclosure.url) {
    const tipe = item.enclosure.type || '';
    if (!tipe || tipe.startsWith('image')) return item.enclosure.url;
  }
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;

  const html = item['content:encoded'] || item.content || item.contentSnippet || '';
  const match = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

/**
 * FALLBACK kalau ekstrakUrlGambar() di atas tidak menemukan apa-apa —
 * ini terjadi kalau feed RSS-nya memang sama sekali tidak menyertakan
 * gambar (mis. ScienceDaily). Solusinya: buka halaman artikel ASLI dan
 * baca tag <meta property="og:image">, yang hampir selalu ada di situs
 * modern (dipakai untuk pratinjau saat dibagikan ke media sosial).
 */
async function ambilOgImage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-sport bot)' },
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

async function ambilTeksArtikelLengkap(url, selectorKustom) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-sport bot)' },
    });
    const $ = cheerio.load(res.data);
    const daftarSelector = [selectorKustom, '#text', '.entry-content', '.post-content', 'article'].filter(Boolean);
    for (const sel of daftarSelector) {
      const teks = $(sel).first().text().replace(/\s+/g, ' ').trim();
      if (teks && teks.length > 200) return teks.slice(0, 6000);
    }
    const gabunganParagraf = $('p').map((_, el) => $(el).text().trim()).get().filter(Boolean).join('\n');
    return gabunganParagraf ? gabunganParagraf.slice(0, 6000) : null;
  } catch (err) {
    console.warn(`  Gagal mengambil artikel lengkap dari ${url}: ${err.message} — memakai cuplikan RSS saja.`);
    return null;
  }
}

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
async function dapatkanIdTagBanyak(daftarNama) {
  const ids = [];
  for (const nama of daftarNama) {
    const id = await dapatkanIdTag(nama);
    if (id) ids.push(id);
  }
  return ids;
}

async function unggahFotoDenganKredit(urlGambar, sourceName) {
  if (!urlGambar) return null;
  try {
    const unduhan = await axios.get(urlGambar, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-sport bot)' },
    });
    const contentType = unduhan.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) return null;

    const ekstensi = contentType.split('/')[1].split('+')[0].split(';')[0] || 'jpg';
    const namaFile = `sport-${Date.now()}.${ekstensi}`;
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
    const teksKredit = `Foto: ${sourceName}`;
    await axios.post(
      `${WP_URL}/wp-json/wp/v2/media/${mediaId}`,
      { caption: teksKredit, alt_text: teksKredit, description: teksKredit },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );
    return { mediaId, sourceUrlWp: unggah.data.source_url };
  } catch (err) {
    console.warn('  Gagal mengunggah foto:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Prompt perintah untuk dieksekusi AI Generated
 */
async function tulisArtikelSportDenganLuna(item) {
  const systemPrompt = `Anda adalah editor berita olahraga profesional.

Tugas Anda: mengubah materi sumber menjadi artikel olahraga BERBAHASA INDONESIA yang seru dibaca orang awam,
TETAP akurat berdasarkan sumber. Kalau materi sumber berbahasa Inggris,
TERJEMAHKAN SEKALIGUS ADAPTASI gayanya ke Bahasa Indonesia. jangan
menerjemahkan kaku kata demi kata.

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
16. Bedakan fakta dan pernyataan narasumber. Klaim, pendapat, penilaian, dan harapan dari 
   narasumber harus memiliki atribusi yang jelas.
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
RINGKASAN: <SATU kalimat penggoda/hook (bukan ringkasan formal), akan tampil sebagai teaser di awal artikel, satu baris tanpa enter>
TAG: <PERSIS 4 kata kunci/frasa pendek dipisah koma, mewakili topik utama. Jika artikel berkaitan dengan sepakbola tambahkan tag "sepakbola">
ISI: <isi berita dalam HTML sederhana, gunakan tag <p> per paragraf, panjangnya MENYESUAIKAN panjang materi sumber. Jangan dipangkas drastis kalau sumbernya memang panjang dan detail>`;


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
    reasoning: { effort: 'medium' },
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

  if (SISIPKAN_FOTO_DI_ARTIKEL && foto && foto.sourceUrlWp) {
    kontenLengkap += `<figure class="wp-block-image"><img src="${foto.sourceUrlWp}" alt="Foto: ${sourceName}" /><figcaption>Foto: ${sourceName}</figcaption></figure>\n`;
  }
  if (SERTAKAN_RINGKASAN && ringkasan) {
    kontenLengkap += `<div class="ringkasan-berita" style="background:#f6f6f6;border-left:4px solid #2980b9;padding:14px 18px;margin:0 0 22px;font-size:1.05em;line-height:1.5;font-style:italic;">
  ${ringkasan}
</div>\n`;
  }
  kontenLengkap += isi;
  if (MODE_ATRIBUSI_SUMBER === 'link') {
    kontenLengkap += `\n<p><em>Disadur dari laporan <a href="${sourceLink}" target="_blank" rel="noopener nofollow">${sourceName}</a></em></p>`;
  } else if (MODE_ATRIBUSI_SUMBER === 'teks') {
    kontenLengkap += `\n<p><em>Disadur dari laporan ${sourceName}</em></p>`;
  }
  // kalau MODE_ATRIBUSI_SUMBER === 'tidak', tidak ada apa pun yang ditambahkan

  const payload = {
    title: judul,
    content: kontenLengkap,
    status: POST_STATUS_SPORT,
    categories: [KATEGORI_SPORT_ID],
  };
  if (foto && foto.mediaId) payload.featured_media = foto.mediaId;
  if (SERTAKAN_RINGKASAN && ringkasan) payload.excerpt = ringkasan;
  if (SERTAKAN_TAG_OTOMATIS && tagIds && tagIds.length) payload.tags = tagIds;

  const res = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, payload, {
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function main() {
  console.log('Mengecek konten sport baru...');
  const semuaItemBaru = await fetchNewItems();
  console.log(`Ditemukan ${semuaItemBaru.length} item baru total.`);

  const items = semuaItemBaru.slice(0, MAKS_SPORT_PER_PROSES);
  if (semuaItemBaru.length > items.length) {
    console.log(`Memproses ${items.length} dulu (batas MAKS_SPORT_PER_PROSES=${MAKS_SPORT_PER_PROSES}); sisanya menyusul di jadwal berikutnya.`);
  }

  for (const item of items) {
    try {
      console.log(`Memproses: ${item.title}`);
      const artikel = await tulisArtikelSportDenganLuna(item);

      let foto = null;
      if (SERTAKAN_FOTO) {
        let urlGambar = ekstrakUrlGambar(item);
        if (!urlGambar) {
          urlGambar = await ambilOgImage(item.link); // fallback: og:image dari halaman artikel asli
        }
        if (urlGambar) foto = await unggahFotoDenganKredit(urlGambar, item.sourceName);
      }

      let tagIds = [];
      if (SERTAKAN_TAG_OTOMATIS && artikel.tags.length) {
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
      console.log(`Berhasil dibuat sebagai "${POST_STATUS_SPORT}" -> ID: ${hasil.id}${foto ? ' (dengan foto)' : ''}${tagIds.length ? ` (${tagIds.length} tag)` : ''}`);
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
