# Panduan Fitur Baru — Terjemahan, Glosarium Supabase, & Provider Sumopod

Panduan singkat tapi lengkap untuk 3 fitur baru. Ikuti berurutan dari atas ke bawah;
bagian yang tidak kamu pakai bisa dilewati.

---

## 1. Provider Sumopod

Sumopod layanan AI Indonesia yang kompatibel API OpenAI: base URL-nya
`https://ai.sumopod.com/v1`.

### Ambil API key
1. Masuk Dashboard Sumopod → menu **AI** → tab **API Keys** → **+ API Key**.
   (Harus punya **AI Balance** dulu — top up lewat tombol **Top up** di halaman AI.)
2. Salin key-nya (hanya muncul sekali).

### Pasang di OCR Studio
1. Buka situs → ikon **⚙ Pengaturan** → tab **Sumopod**.
2. **Base URL**: biarkan default `https://ai.sumopod.com/v1` (bisa diubah bila endpoint berpindah).
3. Klik **Muat model** → tunggu toast "N model dimuat" → klik kolom *Model* dan pilih model
   dari daftar (daftar diambil langsung dari server Sumopod, jadi selalu terkini).
4. **API key**: tempel key. Bisa diisi banyak sekaligus dipisah koma: `k1,k2,k3` —
   kalau satu key kena limit (429) atau ditolak (401/403), otomatis lanjut ke key berikutnya.
5. Klik **Simpan** lalu **Tes Koneksi** (di pojok kiri atas modal). Harus muncul
   *"Sumopod key valid — N model tersedia"*.
6. (Opsional, cara owner) Set di Worker saja supaya berlaku untuk semua pengguna:

| Secret/Env di Worker | Isi |
|---|---|
| `SUMOPOD_API_KEY` | key Sumopod (boleh `k1,k2,k3`) |
| `SUMOPOD_BASE_URL` | default `https://ai.sumopod.com/v1` |
| `SUMOPOD_MODEL` | model default bila user tidak memilih |

### Penting: Sumopod & OCR
Klaim resmi Sumopod (docs, update 4 Nov 2026): **"models can generate text only"** —
jadi Sumopod dianjurkan untuk **Editor TL** dan **Terjemahan**. Untuk OCR gambar pakai
Gemini / Agnes / Cloudflare. Meski begitu kalau kamu ikhlas mencoba model vision di
Sumopod untuk OCR, aplikasi **tetap mengirim request-nya**: yang berhasil ya berhasil,
yang gagal akan muncul pesan jelas *"Model Sumopod … menolak input gambar"*.

---

## 2. Glosarium di Supabase

Glosarium menyimpan padanan istilah (nama tempat, gelar/julukan, item, skill, nama tokoh
dll.) supaya terjemahan konsisten dari awal sampai akhir chapter. Mode penyimpanan:

- **Supabase** (disarankan — tersinkron antar perangkat/browser), atau
- **Lokal (browser)** — otomatis dipakai bila Supabase belum dikonfigurasi.
  Badge di kartu Glosarium menuntunmu: `Supabase · N` atau kuning `Lokal · N`.

### 2.1 Buat proyek Supabase (sekali saja)
1. Buka **https://supabase.com** → **Start your project** → daftar/login.
2. **New project** → isi nama (mis. `ocr-glossary`), password database (simpan!), region
   terdekat (Singapore), → **Create new project**. Tunggu ± 2 menit sampai siap.
3. Di sidebar kiri → **SQL Editor** → **New query**, tempel SQL ini, lalu **Run**:

```sql
create table if not exists glossary (
  id bigserial primary key,
  term text unique not null,
  translation text not null,
  kind text not null default 'other',
  note text not null default '',
  created_at timestamptz not null default now()
);
```

   Bila hasilnya *Success*, tabel sudah jadi. Tidak perlu mengatur RLS khusus:
   kita memakai **service key** yang mengakses tabel tanpa terkena RLS, dan Worker
   tidak pernah mengekspos key itu ke browser.

4. Ambil kredensial: **Project Settings → API**:
   - **Project URL** → mis. `https://abcdefgh.supabase.co` → ini `SUPABASE_URL`.
   - **service_role key** (kolom *service_role*, tanda ⚠ rahasia) → klik **Reveal** →
     salin → ini `SUPABASE_SERVICE_KEY`. **JANGAN** pakai *anon/public* key, dan
     jangan pernah disebarkan ke mana pun.

### 2.2 Isi kredensial ke Worker
Workers & Pages → **ocr-worker** → Settings → **Variables and Secrets** → Add:

| Tipe | Nama | Nilai |
|---|---|---|
| Text | `SUPABASE_URL` | `https://abcdefgh.supabase.co` |
| Secret | `SUPABASE_SERVICE_KEY` | service_role key |
| Text (ops.) | `SUPABASE_TABLE` | default `glossary` (biarkan bila pakai SQL di atas) |

Lalu **Retry deployment** Worker agar env aktif. Uji: buka situs → tab **Terjemahan** →
kartu **Glosarium** → **Muat ulang** → badge berubah jadi `Supabase · 0`.

### 2.3 Pakai glosarium di aplikasi
- **Tambah manual**: kolom *istilah / terjemahan / jenis* (place, title, item, skill,
  name, other) → **Tambah**.
- **Hapus satu**: tombol **Hapus** di barisnya. **Kosongkan semua**: tombol
  **Kosongkan** (diminta konfirmasi).
- **Cari**: kolom pencarian menyaring istilah/terjemahan/jenis.
- **Dari hasil terjemahan**: setelah menerjemahkan, istilah baru muncul di kartu
  **Glosarium baru** — centang yang mau disimpan (boleh utak-atik terjemahannya sebelum
  disimpan) → **Simpan ke Glosarium**.

### 2.4 Impor & Ekspor
- **Ekspor JSON**: `{"entries":[{"term":"Iron Haven","translation":"Iron Haven","kind":"place","note":"ibu kota"}]}`.
- **Ekspor CSV**: kepala kolom wajib `term,translation,kind,note`, contoh:

```csv
term,translation,kind,note
"Iron Haven","Iron Haven","place","ibu kota kerajaan"
"Bladestorm","Bladestorm","skill","jurus pedang sang tokoh"
```

- **Impor** menerima keduanya (tombol **Impor JSON/CSV**): beralih otomatis dari isi file,
  kepala CSV wajib memuat `term`/`from` dan `translation`/`to`. **Mode merge** — entri
  dengan istilah yang sama ditimpa, yang baru ditambah (tidak menghapus yang lain).
  Maks 500 entri per ukuran file/dorongan — sisanya dipecah otomatis.
- File besar dari Google Sheets: **File → Download → .csv** langsung bisa diimpor
  (pastikan kolomnya `term,translation,kind,note` atau `from,to,kind,note`).

---

## 3. Terjemahan (tab baru di samping Editor TL)

Input-nya persis seperti Editor TL: tempel teks `.txt` (paling bagus hasil OCR), seret file,
atau klik **Pilih file .txt** (maks 2 MB; file dipecah di penanda halaman `P1`, `P2`, …).

1. Pilih provider berteks: **Gemini**, **Agnes**, **Sumopod**, atau **Custom**
   (Cloudflare khusus OCR).
2. Klik **Terjemahkan**. Progres per bagian sama sistem dengan Editor TL, bisa
   **Hentikan/Lanjutkan**.
3. Hasil muncul sebagai file utuh — nomor halaman, baris kosong, dan baris Notes
   **tidak tersentuh**, penanda prefix OCR (`-`, `()`, `[]`, `<>`, `*`, `#`, `Sfx`)
   dipertahankan persis sehingga file hasil siap diteruskan ke Editor TL.
4. **Kartu "Glosarium baru"**: istilah baru yang AI putuskan (tempat, gelar, item, skill)
   tampil dengan kotak centang; perbaiki kalimatnya bila perlu → **Simpan ke Glosarium**.
5. **Kartu "Perlu dicek ⚠️"**: baris ambigu, baris yang terjemahannya dibatalkan
   (penanda berubah), angka yang ikut berubah, atau baris yang model buang.

### Aturan yang berlaku pada penerjemahan
- **Register formal vs kasual** dipisah: dialog sopan → bahasa Indonesia formal
  (`saya`/`Anda`); dialog teman → kasual (`aku`/`kamu`, boleh `gue/lo` bila nada
  sumbernya sangat kasual); konsistensi register dijaga per karakter sepanjang bagian.
- **Tetap bahasa Inggris**: nama tokoh, nama tempat, gelar/julukan unik, nama item
  (paket senjata/armor/barang), nama skill/teknik/jurus. Kata baku biasa tetap
  diterjemahkan (king → raja, sword → pedang).
- **Angka, durasi, biaya, stat** dipertahankan; kalau berubah, barisnya TIDAK dipakai
  dan pindah ke *Perlu dicek*.
- **SFX**: diterjemahkan ke onomatope Indonesia bila jelas (`knock` → `duk`,
  `ding` → `ting`); bila tak ada padanan yang natural, biarkan seperti aslinya.
- Glosarium yang kamu simpan otomatis dipakai oleh terjemahan berikutnya
  (hanya istilah yang memang muncul di bagian itu yang dikirim, biar hemat token).

> Catatan: terjemahan memakai model yang sama dengan Editor TL (`/translate` di Worker,
> protokol jawaban JSON-nya diserialisasi serupa). Bila bagian gagal terjemahkan,
> teks aslinya dipertahankan — klik **Lanjutkan**/**Mulai ulang**, atau ganti model.

---

## 4. "Muat model" untuk Custom

Tab **Pengaturan → Custom** kini punya tombol **Muat model**: daftar model diambil dari
`{Base URL}/models` endpoint milikmu (OpenRouter, vLLM, dll.), ditampilkan sebagai
sugesti di kolom Model — tinggal klik salah satu, tak perlu menulis manual.
Tes Koneksi di tab Custom juga tetap berfungsi seperti biasa.

---

## 5. Tabel env/Secret langsung di Worker (versi terkini)

| Nama | Tipe | Wajib? | Fungsi |
|---|---|---|---|
| `GEMINI_API_KEY` | Secret | provider gemini | boleh `k1,k2,k3` (dipisah koma) |
| `AGNES_API_KEY` | Secret | provider agnes | bisa `k1,k2,k3` |
| `SUMOPOD_API_KEY` | Secret | provider sumopod | bisa `k1,k2,k3` |
| `CUSTOM_API_KEY` | Secret | provider custom | opsional bila endpoint publik |
| `SUPABASE_URL` | Text | glosarium | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Secret | glosarium | service_role (bukan anon!) |
| `SUPABASE_TABLE` | Text | opsional | default `glossary` |
| `ALLOWED_ORIGINS` | Text | opsional | daftar origin frontend, pisah koma |
| `GEMINI_MODEL` / `AGNES_MODEL` / `CF_MODEL` | Text | opsional | default masing-masing |
| `AGNES_BASE_URL` / `SUMOPOD_BASE_URL` | Text | opsional | base URL kustom |
| `SUMOPOD_MODEL` / `CUSTOM_MODEL` | Text | opsional | model khusus default |

---

## 6. Kalau macet (troubleshooting kilat)

| Gejala | Penyebab & solusi |
|---|---|
| Badge glosarium tetap `Lokal` padahal sudah isi Supabase | `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` salah atau belum Retry deployment Worker. Cek juga SQL tabel sudah di-Run. |
| "Supabase tabel \"glossary\" belum ada" | SQL tabel belum dijalankan — lihat bagian 2.1 langkah 3. |
| service_role ditolak / 401 | Key yang dipasang key *anon*, atau key mengandung spasi/baris baru. Tempel dulu di Notepad lalu salin ulang. |
| "Muat model" gagal di Sumopod | Base URL salah / key kosong. Periksa base URL `https://ai.sumopod.com/v1` + isi key. |
| OCR via Sumopod: "menolak input gambar" | Bukti model Sumopod itu teks saja. Pindah provider OCR ke Gemini/Agnes/Cloudflare. |
| "Tidak ada terjemahan dari model untuk baris ini" | Bagian itu gagal (timeout/limit) — bagian asli dipertahankan; klik **Lanjutkan** atau jalankan ulang. |
| Glosarium gagal tersimpan ke Supabase saat offline | Aplikasi otomatis jatuh ke penyimpanan browser (badge berubah `Lokal`) — sinkronkan lagi dengan **Muat ulang** setelah koneksi pulih. |
