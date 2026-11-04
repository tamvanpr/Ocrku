# OCR Studio — Pages + Worker (Service Binding)

```
ocr-studio/
├── frontend/                  → proyek Cloudflare Pages
│   ├── index.html
│   ├── _routes.json           (Function hanya jalan untuk /ocr, /edit, /health)
│   └── functions/[[path]].js  (meneruskan request ke Worker lewat binding OCR_WORKER)
└── worker/                    → Cloudflare Worker (tanpa URL publik)
    ├── worker.js              (/ocr dan /edit)
    └── wrangler.toml
```

## Langkah (semua bisa dari HP lewat dashboard)

1. Push folder ini ke satu repo GitHub.
2. **Deploy Worker dulu.** Workers & Pages → Create → Workers → Import a repository.
   - Root directory: `worker`
   - Nama Worker harus sama dengan `name` di `worker/wrangler.toml` (`ocr-worker`).
     Kalau Worker lamamu bernama lain (mis. `ocr`), ubah `name` di wrangler.toml.
   - Setelah deploy: Settings → Variables and Secrets → tambah secret
     `GEMINI_API_KEY` dan/atau `AGNES_API_KEY`.
3. **Deploy Pages.** Workers & Pages → Create → Pages → Connect to Git.
   - Root directory: `frontend`
   - Build command: kosongkan. Build output directory: `/`
4. **Pasang Service Binding.** Pages → Settings → Bindings → Add → Service binding
   - Variable name: `OCR_WORKER`
   - Service: `ocr-worker`
   - Lalu deploy ulang Pages (Deployments → Retry deployment) agar binding aktif.
5. Buka domain `*.pages.dev`. Tab **OCR** dan **Editor TL** sudah terhubung ke Worker.

## Catatan
- Frontend memanggil `/ocr` dan `/edit` (path relatif). `WORKER_URL` di index.html sengaja kosong.
- Worker memakai `workers_dev = false`, jadi tidak bisa dipanggil langsung dari luar.
- **Dark mode**: tampilan ikut sistem, plus tombol tema di header (siklus: ikuti sistem → terang → gelap; pilihan tersimpan di localStorage).
- **Multi-gambar**: pilih/seret/tempel hingga 20 halaman sekaligus. Tiap halaman diproses berurutan (ada progres + tombol Hentikan, tombol Ulangi per halaman), lalu dibuat kartu gabungan satu chapter (Salin/Unduh chapter).
- **Anti-markdown**: sisa markdown dari model (code fence, **bold**, bullet, heading) dibersihkan otomatis di worker dan sekali lagi di frontend; prefix OCR `()`, `[]`, `<>`, `*`, `Sfx`, `#` tidak pernah ikut terhapus.
- **Kapital komik Barat**: dialog/narasi/monolog ber-alfabet yang dicetak ALL CAPS dikembalikan dalam sentence case sesuai aturan penulisan; `Sfx`, teks sistem `#`, dan tulisan rambat `*` tetap persis seperti tercetak (akronim & nama tetap kapital).
- Situs Pages sendiri tetap publik. Siapa pun yang membuka situsmu bisa memakai OCR/Editor
  dan memakai kuota API-mu. Untuk membatasi, aktifkan Cloudflare Access (gratis) pada domain Pages,
  atau tambahkan aturan Rate Limiting.
- Editor TL: file dipecah per halaman (P1, P2, ...), tiap bagian dikirim berurutan. Model hanya
  mengembalikan baris yang berubah, lalu aplikasi menempelkannya ke file asli. Jadi nomor halaman,
  jumlah baris, baris kosong, dan indentasi dijamin sama. Perubahan yang mengubah penanda awal baris,
  angka, tanda baca penutup (... ? !), nomor halaman, atau catatan TL/TN otomatis ditolak
  dan dipindah ke "Perlu dicek".
- Nomor baris di laporan "Perubahan" adalah nomor baris di file asli (mulai dari 1).
