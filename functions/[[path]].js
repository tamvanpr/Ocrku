// Proxy Pages -> Worker lewat Service Binding (nama binding: OCR_WORKER).
// Frontend memanggil path relatif (/ocr, /edit), jadi tidak perlu URL Worker.
// _routes.json membatasi Function ini hanya untuk path API; file statis tidak lewat sini.
// CATATAN DEPLOY: folder functions/ HARUS di root repo (sejajar frontend/), LEBIH
// ANDAL untuk Pages Git build: kalau functions/ taruh di dalam folder yang jadi
// Build output directory, sering tidak ikut ter-upload dan API membalas HTML/405.
const API_PATHS = new Set(['/ocr', '/edit', '/health']);

// Pembalas JSON agar frontend selalu menerima JSON, bukan halaman error HTML.
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });

export async function onRequest({ request, env, next }) {
  const { pathname } = new URL(request.url);
  if (!API_PATHS.has(pathname)) return next();

  if (!env || !env.OCR_WORKER) {
    return jsonRes(
      { error: 'Service binding OCR_WORKER belum dipasang. Buka Pages > Settings > Bindings > Add > Service binding.' },
      500,
    );
  }
  try {
    return await env.OCR_WORKER.fetch(request);
  } catch (err) {
    // Binding salah jenis (Variable biasa) / service salah nama -> dulu jadi HTML 500.
    const msg = (err && err.message) || 'binding error';
    return jsonRes({ error: `Service binding OCR_WORKER gagal: ${String(msg).slice(0, 200)}` }, 500);
  }
}
