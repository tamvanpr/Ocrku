// Proxy Pages -> Worker lewat Service Binding (nama binding: OCR_WORKER).
// Frontend memanggil path relatif (/ocr, /edit), jadi tidak perlu URL Worker.
// _routes.json membatasi Function ini hanya untuk path API; file statis tidak lewat sini.
const API_PATHS = new Set(['/ocr', '/edit', '/health']);

export async function onRequest({ request, env, next }) {
  const { pathname } = new URL(request.url);
  if (!API_PATHS.has(pathname)) return next();

  if (!env.OCR_WORKER) {
    return new Response(
      JSON.stringify({ error: 'Service binding OCR_WORKER belum dipasang. Buka Pages > Settings > Bindings > Add > Service binding.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return env.OCR_WORKER.fetch(request);
}
