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
1. Buka situs → ikon **Pengaturan** (bar atas, ikon slider) → tab **Sumopod**.
2. **Base URL**: biarkan default `https://ai.sumopod.com/v1` (bisa diubah bila endpoint berpindah).
3. Klik **Muat model** → tunggu toast "N model dimuat" → klik kolom *Model* dan pilih model
   dari daftar (daftar diambil langsung dari server Sumopod, jadi selalu terkini).
4. **API key**: tempel key. Bisa diisi banyak sekaligus dipisah koma: `k1,k2,k3` —
   kalau satu key kena limit (429) atau ditolak (401/403), otomatis lanjut ke key berikutnya.
5. Klik **Simpan**. Lalu di tab Sumopod klik **Tes koneksi Sumopod** — harus muncul
   *"Sumopod key valid"*. Tiap provider (Gemini, Agnes, Cloudflare, Sumopod, Custom)
   punya tombol Tes + status sendiri di tabnya masing-masing; yang dites adalah nilai
   yang sedang di kolom, jadi tidak wajib Simpan dulu. Tab **Cloudflare** khusus
   menguji binding AI Worker.
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
dll.) supaya terjemahan konsisten dari awal sampai akhir chapter.

Prinsipnya sekarang:

- **Daftar istilah selalu tersimpan di browser** (localStorage) — tanpa Supabase glosarium
  tetap berfungsi penuh: menambah, mencari, impor/ekspor, dan dipakai Terjemahan.
- **Supabase itu opsional & manual**: dipakai hanya saat kamu menekan tombol
  **Kirim ke Supabase** atau **Ambil** — tidak ada sinkron otomatis. Kalau tidak mau
  berurusan dengan Supabase sama sekali, glosarium tetap jalan.
- **Kode ruang = milikmu**: daftar yang dikirim/diambil punya identitas kode ruang
  (mis. `glos-7kfj2`). Beda kode ruang = beda glosarium, jadi tiap user punya daftarnya
  sendiri dan tidak saling menimpa. Salin kode ruang yang sama ke perangkat lain
  untuk memakai glosarium yang sama.

### 2.1 Buat proyek Supabase (sekali saja)
1. Buka **https://supabase.com** → **Start your project** → daftar/login.
2. **New project** → isi nama (mis. `ocr-glossary`), password database (simpan!), region
   terdekat (Singapore), → **Create new project**. Tunggu ± 2 menit sampai siap.
3. Di sidebar kiri → **SQL Editor** → **New query**, tempel SQL ini, lalu **Run**:

```sql
create table if not exists glossary (
  id bigserial primary key,
  workspace text not null default 'default',
  term text not null,
  translation text not null,
  kind text not null default 'other',
  note text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists glossary_ws_term on glossary(workspace, term);
```

**2.1b Upgrade untuk tabel yang SUDAH dibuat dulu** (kalau kamu sudah sempat menjalankan
SQL versi lama — kolom `workspace` belum ada):

```sql
alter table glossary add column if not exists workspace text not null default 'default';
alter table glossary drop constraint if exists glossary_term_key;
create unique index if not exists glossary_ws_term on glossary(workspace, term);
```

Bila hasilnya *Success*, tabel sudah jadi. Tidak perlu mengatur RLS khusus:
kita memakai **service key** yang mengakses tabel tanpa terkena RLS, dan Worker
tidak pernah mengekspos key itu ke browser.

4. Ambil kredensial Supabase (sesuai dashboard 2026):
   - **Project URL**: klik tombol **Connect** (tengah atas halaman dashboard) → tampil
     mis. `https://abcdefgh.supabase.co` → ini `SUPABASE_URL`.
   - **Secret key**: buka sidebar kiri → **Project Settings → API Keys** → tab
     **Publishable and secret API keys**. Ambil key tipe **secret** (`sb_secret_...`)
     → salin → ini `SUPABASE_SERVICE_KEY`.
     - Jika tombol **Add new API keys** tampil → klik sekali (perlu cek dahulu, tiap
       proyek baru punya key jenis baru ini).
     - Key format lama `anon`/`service_role` (JWT yang diawali `eyJ...`) dianggap
       legacy & dipensiunkan Supabase akhir 2026 — tetap jalan untuk sekarang,
       tapi gunakan `sb_secret_...` selalu kalau memungkinkan.

     ⚠ Secret key hanya boleh dipakai server-side (Worker kita); kalau ada yang mencoba
     dipakai dari browser, Supabase akan menolaknya (401). Worker kita aman.

### 2.2 Isi kredensial ke Worker
Workers & Pages → **ocr-worker** → Settings → **Variables and Secrets** → Add:

| Tipe | Nama | Nilai |
|---|---|---|
| Text | `SUPABASE_URL` | `https://abcdefgh.supabase.co` |
| Secret | `SUPABASE_SERVICE_KEY` | `sb_secret_...` (atau key `service_role` legacy — keduanya diterima) |
| Text (ops.) | `SUPABASE_TABLE` | default `glossary` (biarkan bila pakai SQL di atas) |

Lalu **Retry deployment** Worker agar env aktif.

Uji: buka situs → ikon glosarium di bar atas → kartu **Ruang & Supabase (opsional)** →
isi kode ruang (klik **Kode baru** untuk membuat acak) → tekan **Ambil**. Hasilnya
(status sukses/gagal + jumlah entri) tampil persis di bawah tombol-tombol itu.

### 2.3 Pakai glosarium di aplikasi
- **Tambah manual**: kolom *istilah / terjemahan / jenis* (place, title, item, skill,
  name, other) → **Tambah**. Tersimpan di browser.
- **Hapus satu**: tombol **Hapus** di barisnya. **Kosongkan semua**: tombol
  **Kosongkan** (diminta konfirmasi; hanya menghapus di browser, isi Di Supabase
  tidak tersentuh).
- **Cari**: kolom pencarian menyaring istilah/terjemahan/jenis.
- **Dari hasil terjemahan**: setelah menerjemahkan, istilah baru muncul di kartu
  **Glosarium baru** — centang yang mau disimpan (boleh utak-atik terjemahannya sebelum
  disimpan) → **Simpan ke Glosarium** (masuk daftar browser).
- **Kirim ke Supabase**: seluruh daftar browser MENGGANTI isi ruang kode itu di Supabase
  (diminta konfirmasi dulu).
- **Ambil**: isi ruang kode itu digabung ke daftar browser (istilah sama ditimpa,
  diminta konfirmasi dulu). Arah sync dua-duanya selalu manual — tidak ada yang otomatis.

### 2.4 Impor & Ekspor glosarium

Tombolnya ada di sheet **Glosarium**: **Impor JSON/CSV**, **Ekspor JSON**, **Ekspor CSV**.

**Apa itu?**
Bakal berguna kalau kamu ingin:
- Menyalin daftar istilah antar perangkat (sorot: kirim/ambil via kode ruang lebih
  praktis; ini untuk transfer manual).
- Mengolah pakai spreadsheet (Excel / Google Sheets) lalu mengimpor balik.

**Ekspor CSV** — menghasilkan file `.csv` dengan 4 kolom:
```
term,translation,kind,note
Iron Haven,Iron Haven,place,ibu kota kerajaan
Bladestorm,Bladestorm,skill,jurus pedang
```
- `term` = istilah aslinya (EN / CJK / KR / JP apa saja).
- `translation` = terjemahannya.
- `kind` = salah satu: `place`, `title`, `item`, `skill`, `name`, `other`.
- `note` = keterangan bebas (boleh kosong).

**Ekspor JSON** — format yang sama tapi berupa file `.json`:
```json
{
  "entries": [
    { "term": "Iron Haven", "translation": "Iron Haven", "kind": "place", "note": "ibu kota kerajaan" },
    { "term": "Bladestorm", "translation": "Bladestorm", "kind": "skill", "note": "jurus pedang" }
  ]
}
```

**Impor** (tombol **Impor JSON/CSV**):
- Menerima file `.csv` (4 kolom di atas) atau `.json` (objek `{"entries": [...]}` atau array langsung).
- **Mode merge**: istilah yang sama → ditimpa terjemahannya, istilah baru → ditambah. Tidak menghapus entri lain.
- Maksimal 500 entri per kali impor — kalau lebih, aplikasi memecah otomatis (sisa diimpor juga, hanya butuh waktu lebih).
- Dari Google Sheets: **File → Unduh → .csv** → langsung diimpor, asalkan kolomnya `term,translation,kind,note` (atau `from,to,kind,note` — kedua nama ini dikenali).

**Cara pakai praktis:**
1. Klik **Ekspor CSV** → file diunduh.
2. Buka di Excel/Sheets → edit / tambah baris.
3. Simpan / unduh lagi → di sheet Glosarium, klik **Impor JSON/CSV** → pilih file → entri ter-merge.

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
5. **Kartu "Perlu dicek"**: baris ambigu, baris yang terjemahannya dibatalkan
   (penanda berubah), angka yang ikut berubah, atau baris yang model buang.

Kelola glosarium (tambah/hapus/cari/impor-ekspor/kirim-ambil Supabase) lewat **ikon
daftar di bar atas** (buka sheet Glosarium); Pengaturan juga lewat **ikon di bar atas**.
Di tab Terjemahan cukup ada kartu **"Glosarium baru"** yang muncul setelah menjalankan
Terjemahkan.

### Aturan yang berlaku pada penerjemahan
- **Register formal vs kasual** dipisah: dialog sopan → bahasa Indonesia formal
  (`saya`/`Anda`); dialog teman → kasual (`aku`/`kamu`, boleh `gue/lo` bila nada
  sumbernya sangat kasual); konsistensi register dijaga per karakter sepanjang bagian.
- **Sumber yang didukung**: EN, CH (Han/Sinitik), KR, JP — hasil selalu Bahasa Indonesia.
- **Istilah khusus tetap pakai ejaan aslinya**: nama tokoh, nama tempat, gelar/julukan
  unik, nama item, nama skill/teknik/jurus. Contoh: 북한산 tetap 북한산 (bukan
  "bukhansan"), 魔剣グングニル tetap 魔剣グングニル (bukan "maken gungnir").
  Kata baku biasa tetap diterjemahkan (king → raja, sword → pedang).
- **Romanisasi hanya untuk EN**: hanya teks bahasa Inggris yang ditulis Latin apa
  adanya; istilah CH/KR/JP tidak pernah diromanisasi ke Latin oleh model.
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
Tes koneksi Custom ada tombolnya sendiri di tab Custom (tiap provider punya Tes + status sendiri).

---

## 5. Tabel env/Secret langsung di Worker (versi terkini)

| Nama | Tipe | Wajib? | Fungsi |
|---|---|---|---|
| `GEMINI_API_KEY` | Secret | provider gemini | boleh `k1,k2,k3` (dipisah koma) |
| `AGNES_API_KEY` | Secret | provider agnes | bisa `k1,k2,k3` |
| `SUMOPOD_API_KEY` | Secret | provider sumopod | bisa `k1,k2,k3` |
| `CUSTOM_API_KEY` | Secret | provider custom | opsional bila endpoint publik |
| `SUPABASE_URL` | Text | glosarium | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Secret | glosarium | key `sb_secret_...` (atau legacy `service_role`) |
| `SUPABASE_TABLE` | Text | opsional | default `glossary` |
| `ALLOWED_ORIGINS` | Text | opsional | daftar origin frontend, pisah koma |
| `GEMINI_MODEL` / `AGNES_MODEL` / `CF_MODEL` | Text | opsional | default masing-masing |
| `AGNES_BASE_URL` / `SUMOPOD_BASE_URL` | Text | opsional | base URL kustom |
| `SUMOPOD_MODEL` / `CUSTOM_MODEL` | Text | opsional | model khusus default |

---

## 6. Kalau macet (troubleshooting kilat)

| Gejala | Penyebab & solusi |
|---|---|
| Klik **Ambil/Kirim** muncul "Kolom workspace belum ada" | SQL upgrade 2.1b belum dijalankan — tempel alter table dari bagian 2.1b lalu **Run**. |
| Ambil selalu "ruang kosong" padahal sudah kirim | Kode ruang beda antara perangkat (cek ejaan kode di kolom Ruang) atau kirim sebelumnya ke ruang lain. |
| "Supabase tabel \"glossary\" belum ada" | SQL tabel belum dijalankan — lihat bagian 2.1 langkah 3. |
| Supabase 401/403 / key tidak dipakai | Key salah (mis. publishable/anon yang harus diganti ke secret), key ada spasi/baris baru, atau tabel `glossary` belum dibuat (lihat bagian 2.1). Secret key `sb_secret_...` hanya boleh dipakai dari Worker — kalau dipakai browser, Supabase langsung menolak (401). |
| "Muat model" gagal di Sumopod | Base URL salah / key kosong. Periksa base URL `https://ai.sumopod.com/v1` + isi key. |
| OCR via Sumopod: "menolak input gambar" | Bukti model Sumopod itu teks saja. Pindah provider OCR ke Gemini/Agnes/Cloudflare. |
| "Tidak ada terjemahan dari model untuk baris ini" | Bagian itu gagal (timeout/limit) — bagian asli dipertahankan; klik **Lanjutkan** atau jalankan ulang. |
| Glosarium gagal sync ke Supabase saat offline | Sync manual selalu bisa diulang setelah koneksi pulih — daftar browser tidak pernah hilang karena Supabase. |
