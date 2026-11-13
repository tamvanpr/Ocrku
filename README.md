# OCR Studio — Pages + Worker (Service Binding)

```
ocr-studio/
├── functions/                 → Pages Functions (HARUS di root repo!)
│   └── [[path]].js            (meneruskan /ocr, /edit, /translate, /models, /glossary, /health, /test ke Worker via binding OCR_WORKER)
├── frontend/                  → situs statis Cloudflare Pages
│   ├── index.html
│   └── _routes.json           (Function hanya jalan untuk daftar path di atas)
└── worker/                    → Cloudflare Worker (tanpa URL publik)
    ├── worker.js              (/ocr, /edit, /translate, /models, /glossary, /test)
    └── wrangler.toml
```

> Panduan pemakaian fitur terbaru (Terjemahan, Glosarium Supabase, provider Sumopod,
> tombol "Muat model") ada di **[GUIDE.md](GUIDE.md)**.

## Langkah (semua bisa dari HP lewat dashboard)

1. Push folder ini ke satu repo GitHub.
2. **Deploy Worker dulu.** Workers & Pages → Create → Workers → Import a repository.
   - Root directory: `worker`
   - Nama Worker harus sama dengan `name` di `worker/wrangler.toml` (`ocr-worker`).
     Kalau Worker lamamu bernama lain (mis. `ocr`), ubah `name` di wrangler.toml.
   - Setelah deploy: Settings → Variables and Secrets → tambah secret
     `GEMINI_API_KEY` dan/atau `AGNES_API_KEY`.
3. **Deploy Pages.** Workers & Pages → Create → Pages → Connect to Git.
   - Root directory: **kosong** (jangan diisi!)
   - Build command: kosongkan. Build output directory: `frontend`
   - Cloudflare otomatis mendeteksi folder `functions/` di root repo; kalau Function
     tidak aktif, jalankan Retry deployment lalu cek menu Functions (harusnya tidak kosong).
4. **Pasang Service Binding.** Pages → Settings → Bindings → Add → Service binding
   - Variable name: `OCR_WORKER`
   - Service: `ocr-worker`
   - Lalu deploy ulang Pages (Deployments → Retry deployment) agar binding aktif.
5. Buka domain `*.pages.dev`. Saat ini ada **5 tab/area: OCR, Editor TL, Terjemahan, Glosarium, dan Pengaturan** — semuanya terhubung ke Worker. Pengaturan & Glosarium sekarang **halaman terpisah (tab)** di dalam aplikasi (bukan popup floating).

## Catatan
- Bila OCR sampai error **"Respons server bukan JSON"** padahal binding sudah dipasang: hampir
  pasti Pages Functions tidak ikut ter-deploy. Tes cepat: buka `https://<domain>/health` — bila
  yang muncul situs (HTML), bukan `{"ok":true,...}`, berarti Function-nya belum aktif. Solusi:
  pastikan `functions/` ada di **root repo** dan Build output directory = `frontend`
  (bukan `/`), lalu Retry deployment.
- Frontend memanggil `/ocr` dan `/edit` (path relatif). `WORKER_URL` di index.html sengaja kosong.
- Worker memakai `workers_dev = false`, jadi tidak bisa dipanggil langsung dari luar.
- **Dark mode**: tampilan ikut sistem, plus tombol tema di header (siklus: ikuti sistem → terang → gelap; pilihan tersimpan di localStorage).
- **Multi-gambar**: pilih/seret/tempel hingga 20 halaman sekaligus. Tiap halaman diproses berurutan (ada progres + tombol Hentikan, tombol Ulangi per halaman), lalu dibuat kartu gabungan satu chapter (Salin/Unduh chapter).
- **Anti-markdown**: sisa markdown dari model (code fence, **bold**, bullet, heading) dibersihkan otomatis di worker dan sekali lagi di frontend; prefix OCR `()`, `[]`, `<>`, `*`, `Sfx`, `#` tidak pernah ikut terhapus.
- **Kapital komik Barat**: dialog/narasi/monolog ber-alfabet yang dicetak ALL CAPS dikembalikan dalam sentence case sesuai aturan penulisan; `Sfx`, teks sistem `#`, dan tulisan rambat `*` tetap persis seperti tercetak (akronim & nama tetap kapital).
- **BYOK (key sendiri)**: di Pengaturan bisa mengisi key Gemini/Agnes/Custom milikmu — tersimpan hanya di browser (localStorage), hanya dikirim ke Worker-mu sendiri, dan tidak pernah ter-log. Key owner tetap jadi fallback bila BYOK kosong.
- **Multi-key rotasi otomatis**: value Secret (`GEMINI_API_KEY`, `AGNES_API_KEY`, `SUMOPOD_API_KEY`, `CUSTOM_API_KEY`) boleh `k1,k2,k3`. Saat 429/401/403, request lanjut ke key berikutnya; bila semua gagal, pesan error menyebut kuncinya.
- **Provider Sumopod**: OpenAI-compatible ala Sumopod (`https://ai.sumopod.com/v1`), multi-key, tombol **Muat model** mengisi daftar model langsung dari server. Klaim resmi Sumopod: teks saja — dipakai untuk Editor TL & Terjemahan; OCR via model vision tetap bisa dicoba (pesannya jelas bila model menolak gambar).
- **Tombol "Muat model"**: tersedia di tab Sumopod **dan** Custom — daftar model diambil dari `{base}/models`, cukup pilih tanpa menulis manual.
- **Provider Custom (OpenAI-compatible)**: base URL + model bebas (OpenRouter, Groq, vLLM, dsb), tanpa key pun bisa. Set via Pengaturan di browser, atau `CUSTOM_BASE_URL`/`CUSTOM_MODEL` di Worker. Key owner via Secret `CUSTOM_API_KEY`.
- Situs Pages sendiri tetap publik. Siapa pun yang membuka situsmu bisa memakai OCR/Editor
  dan memakai kuota API-mu. Untuk membatasi, aktifkan Cloudflare Access (gratis) pada domain Pages,
  atau tambahkan aturan Rate Limiting.
- Editor TL: file dipecah per halaman (P1, P2, ...), tiap bagian dikirim berurutan. Model hanya
  mengembalikan baris yang berubah, lalu aplikasi menempelkannya ke file asli. Jadi nomor halaman,
  jumlah baris, baris kosong, dan indentasi dijamin sama. Perubahan yang mengubah penanda awal baris,
  angka, tanda baca penutup (... ? !), nomor halaman, atau catatan TL/TN otomatis ditolak
  dan dipindah ke "Perlu dicek". Aturan penyuntingannya mengikuti prompt editor milik pengguna
  (seksi 0-10, aturan keras K1-K12, prioritas ATURAN KERAS > makna > typo > naturalitas > efisiensi,
  larangan gue/lo/loe/elo, UJI WAJIB kata isi); format jawaban tiga bagian di file prompt itu
  digantikan protokol JSON aplikasi.
- Nomor baris di laporan "Perubahan" adalah nomor baris di file asli (mulai dari 1).
- **Terjemahan (tab Terjemahan)**: input seperti Editor TL; sumber EN/CH/KR/JP → Bahasa Indonesia dengan register formal/informal, **romanisasi hanya untuk teks EN** (istilah CH/KR/JP tetap ejaan aslinya, kecuali user menetapkan lewat Glosarium), prefix OCR & halaman & baris Notes dipertahankan utuh, angka berubah → masuk "Perlu dicek". Endpoint `/translate` di Worker.
- **Glosarium**: tersimpan di Supabase (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`; SQL setup di GUIDE.md), fallback otomatis ke penyimpanan browser bila belum dikonfigurasi. Mendukung tambah/hapus/cari, simpan istilah hasil terjemahan, impor/ekspor JSON & CSV. Di aplikasi, kini ada tab **Glosarium** khusus; kartu "Glosarium baru" khusus (dari hasil Terjemahan) tetap muncul di tab Terjemahan setelah menjalankan **Terjemahkan**.
