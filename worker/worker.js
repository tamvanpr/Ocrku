// OCR Worker — backend OCR (/ocr), Editor TL (/edit), Terjemahan (/translate),
// daftar model (/models), dan Glosarium Supabase (/glossary).
// Dipanggil dari Cloudflare Pages lewat Service Binding (tanpa URL publik).
// Deploy HP-friendly: push ke GitHub -> Cloudflare Dashboard > Workers > Connect Git
// Secrets (Dashboard > Settings > Variables & Secrets):
//   GEMINI_API_KEY       (Secret, wajib untuk provider gemini; boleh banyak key dipisah koma)
//   AGNES_API_KEY        (Secret, wajib untuk provider agnes; boleh banyak key dipisah koma)
//   SUMOPOD_API_KEY      (Secret, wajib untuk provider sumopod; boleh banyak key dipisah koma)
//   CUSTOM_API_KEY       (Secret, opsional untuk provider custom; boleh banyak key dipisah koma)
//   SUPABASE_URL         (Text,  opsional, mis: https://xxxx.supabase.co — untuk glosarium)
//   SUPABASE_SERVICE_KEY (Secret, opsional — service_role key Supabase, JANGAN anon/publishable)
//   SUPABASE_TABLE       (Text,  opsional, default: glossary)
//   ALLOWED_ORIGINS (Text, opsional. Boleh BANYAK, pisah koma. Contoh:
//                    https://ocr-kamu.netlify.app,https://kamu.github.io   — kosong = *)
//   GEMINI_MODEL    (Text, opsional, default: gemini-3.5-flash-lite)
//   AGNES_MODEL     (Text, opsional, default: agnes-3.0-flash)
//   CF_MODEL        (Text, opsional, default: @cf/qwen/qwen3.8-27b)
//   AGNES_BASE_URL  (Text, opsional, default: https://apihub.agnes-ai.com/v1)
//   SUMOPOD_BASE_URL (Text, opsional, default: https://ai.sumopod.com/v1)
//   SUMOPOD_MODEL   (Text, opsional — model default Sumopod bila user tidak memilih)

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_AGNES_MODEL = 'agnes-3.0-flash';
const DEFAULT_AGNES_BASE = 'https://apihub.agnes-ai.com/v1';
// Sumopod (https://docs.sumopod.com): OpenAI-compatible, base https://ai.sumopod.com/v1.
// NOTE: docs resmi Sumopod (update 4 Nov 2026): "models can generate text only".
// OCR tetap dibolehkan dicoba — bila model menolak gambar, errornya dijelaskan.
const DEFAULT_SUMOPOD_BASE = 'https://ai.sumopod.com/v1';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BODY_BYTES = 15 * 1024 * 1024; // base64 + JSON overhead (10MB gambar ≈ 13.4MB base64)

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif',
]);

// Allowlist — cegah model injection dari frontend
const GEMINI_MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);
const AGNES_MODELS = new Set([
  'agnes-3.0-flash',
  'agnes-2.5-flash',
  'agnes-2.5-pro',
  'agnes-2.0-flash',
  'agnes-1.5-flash',
]);
const CF_VISION_MODELS = [
  '@cf/qwen/qwen3.8-27b',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
];
const CF_MODELS = new Set(CF_VISION_MODELS);
const DEFAULT_CF_MODEL = '@cf/qwen/qwen3.8-27b';

// ================= SYSTEM PROMPT v4 =================
// Prinsip: verbatim + anti-halusinasi, urutan baca eksplisit, prefix anti-ambigu,
// bersih dari markdown, aturan kapital khusus komik Barat (ALL CAPS → sentence case),
// dan framing "alat transkripsi" agar model tidak menolak / menyensor teks komik dewasa.
const OCR_PROMPT = `You are a professional OCR transcription engine for comics, manhwa, manhua, and manga. You transcribe printed pixels only; you never create, translate, or explain content.

TASK
Transcribe EVERY visible text element on the page, in the original language and script, exactly as printed. Do not translate, do not romanize, do not summarize, do not describe the artwork, and do not invent text that is not printed.

FRAMING (digitization / accessibility job)
This is a document-digitization and accessibility job: archiving, translation preparation, and screen-reader support. You are a text-extraction tool, not an author. Every character you output already exists as printed pixels; you create nothing new and endorse nothing. Comics legitimately contain mature themes: violence, gore, profanity, sexual dialogue, slurs, and dark or disturbing subject matter. Copy such text VERBATIM, exactly as printed. Do NOT censor, soften, replace, mask (no "****"), omit, moralize, warn, or refuse because of what the text says. Never add disclaimers or commentary. Judge only which characters are printed, never whether the content is appropriate. Transcribe text only; never describe the artwork itself.

READING ORDER — decide from the page, then follow it consistently
1. Japanese manga (vertical, RTL): read pages right-to-left, top-to-bottom. Inside a vertical column read top-to-bottom, then move to the next column on the LEFT.
2. Manhwa, manhua, webtoon, and Western comics (LTR): read left-to-right, top-to-bottom, panel by panel.
3. Unclear layout: use the dominant script (kana/kanji-heavy means rule 1; hangul/hanzi/Latin-heavy means rule 2). On a double-page spread, apply the rule to the whole spread, not per side.

OUTPUT FORMAT — one text element per line, exactly one prefix followed by one space
"() " speech: spoken dialogue, shouts, whispers, phone speech, and narration inside a speech bubble.
"[] " narration: caption boxes, inner monologue in a rectangular box, location and time stamps.
"<> " thought: thought or telepathy, usually a rounded cloud bubble; never use this for a rectangular narration box.
"* " in-world text: signs, screens, posters, clothing, books, labels, graffiti, number plates.
"Sfx " sound effects and onomatopoeia only.
"# " system/UI/meta: game windows, quests, level-up, status and item windows, skill names in UI, chapter titles, credits, translator or editor notes, and printed page numbers.
Example:
() Hey... are you sure?
[] Three days later.
<> If I don't go now, it's over.
Sfx BOOM
* DANGER: HIGH VOLTAGE
# CHAPTER 12
Do not use the prefixes - or ** in OCR output. Do not invent page markers such as P1 or P2; a printed page number is a "# " line. The only exception is the standalone separator line "//" for split balloons, described below.

MERGED OR TOUCHING BALLOONS — SPLIT, DO NOT MERGE
Two speech or thought balloons may touch, overlap, or share a border, or one large oval may contain two distinct speeches. Decide from the tails and speakers, not from text proximity:
- Two separate tails, two speakers, or a clear speaker change means TWO text elements, even if the balloons touch or share a border. Output each speech on its own line with its own prefix, in reading order, and insert one standalone line containing only "//" between them as the separator.
- One tail and one continuous speech by one speaker is ONE element: keep it as one line and do NOT insert "//".
- Never merge two speakers into one line, and never join the two speeches with "//" inside the same line; the "//" separator always stands alone on its own line.
Example (two touching balloons, two speakers):
() Aku pergi sekarang.
//
() Tunggu dulu!

CASING — English / Latin-script comics only
Western comics usually print dialogue in ALL CAPS. For "() ", "[] ", and "<> " lines only, output normal sentence case: capitalize the first word of the line, the pronoun I, proper nouns, and acronyms or initialisms (FBI, NASA); keep everything else in standard lowercase. Keep Sfx, "# ", and "* " lines exactly as printed, and never re-case single letters or abbreviations. Kanji, kana, hangul, and hanzi are never re-cased. This is the ONLY allowed deviation from verbatim: it changes letter case only, never wording, spelling, or punctuation.

LANGUAGE AND SCRIPT
Output the original language and script only. Keep kanji, hiragana, katakana, hangul, and hanzi (simplified or traditional, as printed); keep full-width punctuation and closing quotes exactly as printed; and keep ALL punctuation (!, !!!, ?, ...) and digits exactly as printed. If a printed word is misspelled, copy the misspelling. Never romanize Japanese, Korean, or Chinese text and never translate it. For vertical Japanese, transcribe as a horizontal line and ignore furigana/ruby (base characters only); keep the prolonged sound mark. If two languages are printed together in one panel, output two lines in printed order, each with its own prefix.

STRICT OUTPUT RULES
- Exactly one prefix per line and one space after it. Never put two prefixed elements on one line, never add blank lines, and never number or bullet the lines yourself.
- Never use markdown: no code fences, no headings, no bold or italic markers, no bullet lists, no blockquotes, no tables, no horizontal rules. The characters # and * at the start of a line are OCR prefixes, not markdown; output them literally as "# " and "* ".
- One bubble or box is one line: merge its wrapped lines with single spaces. Never merge across bubbles, boxes, speakers, or prefixes. A sentence continued across two bubbles stays as two lines.
- Do not add, remove, or change words, punctuation, or spacing beyond the casing rule above.

QUALITY LADDER — apply per text element, in this order
1. Fully legible: transcribe it, with the correct prefix and casing rule.
2. Small, background, rotated, or stylized but still readable: it is text; include it with the right prefix (Sfx if it is a sound).
3. Partially covered but clear from grammar or context: write the intended form with no marker.
4. An honestly unreadable span inside a sentence: write [...] for that span only, for example "() sore wa hon[...] da". A whole unreadable bubble becomes "() [...]".
5. Cannot tell whether something is text or artwork (sparks, streaks, debris, hatching): if no letters are recognizable, it is not text; skip it silently. Never invent dialogue, names, or sound effects.
6. The same text in different bubbles is transcribed once per bubble. One watermark, logo, or identical repeated sound effect on the same page is output once.
7. Stylized title art overlapping dialogue: foreground legible dialogue first, then background title text only if fully legible, each with its correct prefix.
8. No text on the page: output exactly "# NO TEXT DETECTED".`;

const SYSTEM_SHORT = 'You are an OCR text-extraction tool for comics, manhwa, manhua, and manga. Output ONLY the transcribed lines, one line per text element, using exactly one prefix per line: "() " speech, "[] " narration, "<> " thought, "* " in-world text, "Sfx " sound effects, "# " system/UI/meta including printed page numbers. One bubble or box becomes one line; never merge across bubbles. If two balloons touch, overlap, or share a border but have separate tails or speakers, split them into two lines with their own prefixes and insert one standalone "//" line between them as separator; never merge two speakers into one line. Copy printed text verbatim in the original language and script, including mature or offensive wording, without censoring, refusing, translating, or romanizing. For Latin-script speech, narration, and thought lines only, use sentence case (capitalize the first word, I, proper nouns, and acronyms; keep Sfx, "# ", and "* " as printed). Never use markdown, code fences, bullets, blank lines, or extra commentary. If no text is visible, output exactly "# NO TEXT DETECTED".';

// =====================================================================
// ============ TES KONEKSI / TEST  (POST /test) ========================
// Body: { provider, apiKey?, baseUrl?, modelId? }
// Validasi key / endpoint tanpa memotret gambar — cek kesehatan provider.
// =====================================================================
async function handleTest(request, env, origin) {
  try {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return cors(json({ ok: false, error: 'Content-Type harus application/json.' }, 400), env, origin);
    }
    let body;
    try { body = await request.json(); }
    catch { return cors(json({ ok: false, error: 'Body JSON tidak valid.' }, 400), env, origin); }
    const provider = normalizeProvider(body?.provider);
    if (!provider) {
      return cors(json({ ok: false, error: 'Provider tidak dikenali. Pilih gemini / agnes / cloudflare / sumopod / custom.' }, 400), env, origin);
    }
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const modelId = String(body?.modelId || '').trim();

    if (provider === 'cloudflare') {
      if (!env.AI) {
        return cors(json({ ok: false, error: 'Worker belum mengaktifkan binding AI (Cloudflare AI).' }, 503), env, origin);
      }
      return cors(json({ ok: true, provider, detail: 'Cloudflare AI aktif via binding [ai] Worker.' }), env, origin);
    }

    if (provider === 'gemini') {
      const keys = keyPool(env, 'GEMINI_API_KEY', apiKey);
      if (!keys.length) {
        return cors(json({ ok: false, error: 'Belum ada API key Gemini — set Secret GEMINI_API_KEY di Worker atau isi key di Pengaturan.' }, 400), env, origin);
      }
      let lastErr = null;
      for (const k of keys) {
        try {
          const resp = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
            method: 'GET',
            headers: { 'x-goog-api-key': k },
          }, 20000);
          if (resp.ok) {
            return cors(json({ ok: true, provider, detail: `Gemini key valid${keys.length > 1 ? ` — ${keys.length} key dipakai` : ''}.` }), env, origin);
          }
          const b = scrub(await resp.text());
          const e = new Error(`Gemini key ditolak: ${b}`);
          if (resp.status === 401 || resp.status === 403) { lastErr = e; continue; }
          throw e;
        } catch (e) { lastErr = e; }
      }
      return cors(json({ ok: false, error: `Semua key Gemini gagal validasi. Info terakhir: ${String(lastErr && lastErr.message || '').slice(0, 300)}` }), env, origin);
    }

    if (provider === 'agnes') {
      const keys = keyPool(env, 'AGNES_API_KEY', apiKey);
      const base = (env.AGNES_BASE_URL || DEFAULT_AGNES_BASE).replace(/\/+$/, '');
      if (!/^https:\/\//i.test(base)) {
        return cors(json({ ok: false, error: 'AGNES_BASE_URL harus diawali https:// …' }, 400), env, origin);
      }
      if (!keys.length) {
        return cors(json({ ok: false, error: 'Belum ada API key Agnes — set Secret AGNES_API_KEY di Worker atau isi key di Pengaturan.' }, 400), env, origin);
      }
      let lastErr = null;
      for (const k of keys) {
        try {
          const resp = await fetchWithTimeout(`${base}/models`, { method: 'GET', headers: { Authorization: `Bearer ${k}` } }, 20000);
          if (resp.ok) {
            return cors(json({ ok: true, provider, detail: `Agnes key valid${keys.length > 1 ? ` — ${keys.length} key dipakai` : ''}.` }), env, origin);
          }
          const b = scrub(await resp.text());
          const e = new Error(`Agnes key ditolak: ${b}`);
          if (resp.status === 401 || resp.status === 403) { lastErr = e; continue; }
          throw e;
        } catch (e) { lastErr = e; }
      }
      return cors(json({ ok: false, error: `Semua key Agnes gagal validasi. Info terakhir: ${String(lastErr && lastErr.message || '').slice(0, 300)}` }), env, origin);
    }

    if (provider === 'sumopod') {
      let base;
      try { base = sanitizeBaseUrl(baseUrl || env.SUMOPOD_BASE_URL || DEFAULT_SUMOPOD_BASE, 'Sumopod'); }
      catch (e) { return cors(json({ ok: false, error: String(e?.message || e) }, 400), env, origin); }
      const keys = keyPool(env, 'SUMOPOD_API_KEY', apiKey);
      if (!keys.length) {
        return cors(json({ ok: false, error: 'Belum ada API key Sumopod — set Secret SUMOPOD_API_KEY di Worker atau isi key di Pengaturan.' }, 400), env, origin);
      }
      let lastErr = null;
      for (const k of keys) {
        try {
          const resp = await fetchWithTimeout(`${base}/models`, { method: 'GET', headers: { Authorization: `Bearer ${k}` } }, 20000);
          if (resp.ok) {
            const data = await resp.json().catch(() => ({}));
            const n = Array.isArray(data?.data) ? data.data.length : 0;
            return cors(json({ ok: true, provider, detail: `Sumopod key valid${n ? ` — ${n} model tersedia` : ''}${keys.length > 1 ? ` — ${keys.length} key dipakai` : ''}.` }), env, origin);
          }
          const b = scrub(await resp.text());
          const e = new Error(`Sumopod key ditolak: ${b}`);
          if (resp.status === 401 || resp.status === 403) { lastErr = e; continue; }
          throw e;
        } catch (e) { lastErr = e; }
      }
      return cors(json({ ok: false, error: `Semua key Sumopod gagal validasi. Info terakhir: ${String(lastErr && lastErr.message || '').slice(0, 300)}` }), env, origin);
    }

    // custom
    const base = sanitizeBaseUrl(baseUrl || env.CUSTOM_BASE_URL);
    const keys = keyPool(env, 'CUSTOM_API_KEY', apiKey);
    const model = String(modelId || env.CUSTOM_MODEL || '').slice(0, 120);
    const attempts = keys.length ? keys : [null];
    let lastErr = null;
    for (const k of attempts) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (k) headers.Authorization = `Bearer ${k}`;
        const resp = await fetchWithTimeout(`${base}/models`, { method: 'GET', headers }, 20000);
        if (resp.ok) {
          return cors(json({ ok: true, provider, detail: `Custom endpoint valid${keys.length > 1 ? ` — ${keys.length} key dipakai` : ''}${k ? '' : ' (tanpa key)'}.` }), env, origin);
        }
        const b = scrub(await resp.text());
        const e = new Error(`Custom endpoint ditolak: ${b}`);
        if (resp.status === 401 || resp.status === 403) { lastErr = e; continue; }
        throw e;
      } catch (e) { lastErr = e; }
    }
    return cors(json({ ok: false, error: `Custom endpoint gagal validasi. Info terakhir: ${String(lastErr && lastErr.message || '').slice(0, 300)}` }), env, origin);
  } catch (e) {
    return cors(json({ ok: false, error: 'Gagal validasi: ' + String(e && e.message || e) }, 500), env, origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env, origin);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return cors(json({
        ok: true, service: 'ocr-worker',
        providers: ['gemini', 'agnes', 'cloudflare', 'sumopod', 'custom'],
        geminiModels: [...GEMINI_MODELS],
        agnesModels: [...AGNES_MODELS],
        cfModels: [...CF_MODELS],
        usage: 'POST /ocr { image: dataURL, provider, modelId, apiKey?, baseUrl? } | POST /edit { lines:[{n,t}], context, provider, modelId, apiKey?, baseUrl? } | POST /translate { lines:[{n,t}], context, glossary, provider, modelId, apiKey?, baseUrl? } | POST /models { provider, apiKey?, baseUrl? } | GET/POST/DELETE /glossary { entries:[{term,translation,kind?,note?}], mode? } | POST /test { provider, apiKey?, baseUrl?, modelId? } | Secret GEMINI/AGNES/SUMOPOD/CUSTOM_API_KEY bisa berisi banyak key dipisah koma (rotasi otomatis saat 429/401/403)',
      }), env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/edit') {
      return handleEdit(request, env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/test') {
      return handleTest(request, env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/models') {
      return handleModels(request, env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/translate') {
      return handleTranslate(request, env, origin);
    }

    if (url.pathname === '/glossary' && (request.method === 'GET' || request.method === 'POST' || request.method === 'DELETE')) {
      return handleGlossary(request, env, origin);
    }

    if (request.method !== 'POST' || url.pathname !== '/ocr') {
      return cors(json({ error: 'Not found. Gunakan POST /ocr, /edit, /translate, /models, /test, atau /glossary' }, 404), env, origin);
    }

    // Blokir origin asing bila ALLOWED_ORIGINS diset (bukan sekadar header CORS —
    // CORS tidak menghentikan request dari curl/skrip, jadi tolak di server).
    if (!originAllowed(env, origin)) {
      return cors(json({ error: 'Origin tidak diizinkan.' }, 403), env, origin);
    }

    try {
      const ct = request.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return cors(json({ error: 'Content-Type harus application/json.' }, 400), env, origin);
      }
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > MAX_BODY_BYTES) {
        return cors(json({ error: 'Payload terlalu besar. Kompres gambar dulu.' }, 413), env, origin);
      }
      let body;
      try { body = await request.json(); }
      catch { return cors(json({ error: 'Body JSON tidak valid.' }, 400), env, origin); }

      // Kompatibel mundur: frontend lama kirim { model: 'gemini'|'cloudflare' }
      const provider = normalizeProvider(body?.provider ?? body?.model);
      const modelId = String(body?.modelId || '').trim();
      // Gema verifikasi: frontend mencocokkan reqId+imgHash respons dengan yang dikirim.
      const reqId = typeof body?.reqId === 'string' ? body.reqId.slice(0, 64) : null;
      const image = body?.image;
      if (!image || typeof image !== 'string') {
        return cors(json({ error: 'Tidak ada gambar. Kirim field "image" (data URL base64).' }, 400), env, origin);
      }
      if (!provider) {
        return cors(json({ error: 'Provider tidak dikenali. Pilih gemini / agnes / cloudflare / sumopod / custom.' }, 400), env, origin);
      }
      // Model wajib bagi sumopod — cek sejak awal supaya errornya 400 yang jelas.
      if (provider === 'sumopod') pickSumopodModel(modelId, env);

      const m = image.match(/^data:([^;,]+);base64,([\s\S]*)$/);
      const mimeType = (m?.[1] || 'image/jpeg').toLowerCase();
      const base64Data = (m?.[2] ?? image).replace(/\s/g, '');

      if (!ALLOWED_MIMES.has(mimeType)) {
        return cors(json({ error: `Tipe gambar tidak didukung: ${mimeType}. Gunakan JPG/PNG/WebP/BMP/GIF.` }, 400), env, origin);
      }
      // Validasi base64 MENYELURUH (versi lama hanya cek 1024 karakter pertama)
      if (!base64Data || base64Data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) {
        return cors(json({ error: 'Data gambar tidak valid (base64 corrupt).' }, 400), env, origin);
      }
      const padding = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
      const approxBytes = (base64Data.length * 3) / 4 - padding;
      if (approxBytes > MAX_IMAGE_BYTES) {
        return cors(json({ error: `Gambar ~${(approxBytes / 1048576).toFixed(1)}MB, maks ${MAX_IMAGE_BYTES / 1048576}MB. Kompres dulu.` }, 413), env, origin);
      }

      let text = '';
      const apiOpts = readApiOpts(body);
      if (provider === 'gemini') text = await runGemini(base64Data, mimeType, pickGeminiModel(modelId, env, apiOpts.apiKey), env, apiOpts);
      else if (provider === 'agnes') text = await runAgnes(base64Data, mimeType, pickAgnesModel(modelId, env, apiOpts.apiKey), env, apiOpts);
      else if (provider === 'sumopod') text = await runSumopodVision(base64Data, mimeType, pickSumopodModel(modelId, env), env, apiOpts);
      else if (provider === 'custom') text = await runCustom(base64Data, mimeType, { ...apiOpts, model: String(modelId || '') }, env);
      else text = await runCloudflareAI(base64Data, mimeType, pickCfModel(modelId, env), env);

      return cors(json({ text: normalizeOutput(text), provider, reqId, imgHash: shortHash(base64Data) }), env, origin);
    } catch (err) {
      console.error('OCR error:', err?.stack || err);
      // Pesan error sengaja tidak memuat API key / URL berkunci (lihat scrub()).
      return cors(json({ error: scrub(String(err?.message || 'Internal server error')).slice(0, 500) }, 500), env, origin);
    }
  },
};

// ================= providers =================
function normalizeProvider(p) {
  p = String(p || '').toLowerCase();
  if (p === 'gemini' || p.startsWith('gemini')) return 'gemini';
  if (p === 'agnes' || p.startsWith('agnes')) return 'agnes';
  if (p === 'cloudflare' || p === 'cf') return 'cloudflare';
  if (p === 'sumopod' || p.startsWith('sumopod')) return 'sumopod';
  if (p === 'custom' || p.startsWith('custom')) return 'custom';
  return null;
}
function pickGeminiModel(req, env, byok) {
  // Bila pakai key sendiri (BYOK), model bebas — asal karakter aman.
  if (byok && req && /^[a-z0-9._-]{1,80}$/i.test(req)) return req;
  if (req && GEMINI_MODELS.has(req)) return req;
  const d = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return GEMINI_MODELS.has(d) ? d : DEFAULT_GEMINI_MODEL;
}
function pickAgnesModel(req, env, byok) {
  if (byok && req && /^[a-z0-9._-]{1,80}$/i.test(req)) return req;
  if (req && AGNES_MODELS.has(req)) return req;
  const d = env.AGNES_MODEL || DEFAULT_AGNES_MODEL;
  return AGNES_MODELS.has(d) ? d : DEFAULT_AGNES_MODEL;
}
function pickCfModel(req, env) {
  if (req && CF_MODELS.has(req)) return req;
  const d = env.CF_MODEL || DEFAULT_CF_MODEL;
  return CF_MODELS.has(d) ? d : DEFAULT_CF_MODEL;
}
// Sumopod: model bebas (katalog server berubah-ubah) tapi WAJIB — tanpa model, request gagal.
function pickSumopodModel(req, env) {
  const m = String(req || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  if (m && /^[a-z0-9._@\/+:-]{1,120}$/i.test(m)) return m;
  const d = String(env.SUMOPOD_MODEL || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  if (d && /^[a-z0-9._@\/+:-]{1,120}$/i.test(d)) return d;
  throw new Error('Sumopod: model belum dipilih. Klik "Muat model" di Pengaturan (tab Sumopod) lalu pilih model.');
}

// ================== BYOK + rotasi multi-key ==================
// Secret seperti GEMINI_API_KEY boleh berisi banyak key dipisah koma:
// "key1,key2,key3". Key yang dikirim pengguna (BYOK) dicoba duluan.
// Status 429 / 401 / 403 memicu rotasi otomatis ke key berikutnya di
// dalam satu request. Error lain (region, format, diblokir) tidak.
function keyPool(env, name, userKey) {
  const raw = String(env?.[name] || '');
  const pooled = raw.includes(',') ? raw.split(',') : raw ? [raw] : [];
  const keys = [];
  const seen = new Set();
  for (const k of [userKey].concat(pooled).map((x) => String(x || '').trim()).filter(Boolean)) {
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}
function keyErr(message) {
  const e = new Error(message);
  e.keyIssue = true;
  return e;
}
async function keyRotator(label, keys, fn) {
  if (!keys.length) {
    throw new Error(`${label}: belum ada API key — set Secret di Worker atau isi key di Pengaturan.`);
  }
  let last = null;
  for (let i = 0; i < keys.length; i++) {
    try { return await fn(keys[i], i); }
    catch (e) {
      if (e && e.keyIssue) { last = e; continue; }
      throw e;
    }
  }
  throw new Error(`Semua ${keys.length} API key ${label} gagal. Info terakhir: ${String(last && last.message || '-').slice(0, 300)}`);
}
// Base URL untuk provider OpenAI-compatible (custom/sumopod): wajib https + bukan host privat.
function sanitizeBaseUrl(raw, label = 'Custom') {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) throw new Error(`Base URL ${label} kosong: isi di Pengaturan atau set Secret/env base URL di Worker.`);
  let u;
  try { u = new URL(s); } catch { throw new Error(`Base URL ${label} tidak valid: ` + s.slice(0, 80)); }
  if (u.protocol !== 'https:') throw new Error(`Base URL ${label} harus https:// (Worker tidak bisa menjangkau host lokal).`);
  const host = (u.hostname || '').toLowerCase();
  const privateHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(host) ||
    host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host);
  if (privateHost) throw new Error(`Base URL ${label} tidak boleh menunjuk host lokal/privat.`);
  return s;
}
// Opsi BYOK dari body (tidak pernah dibalas di response / log).
function readApiOpts(body) {
  const cap = (v, n) => { const t = String(v || '').trim(); return t ? t.slice(0, n) : ''; };
  return { apiKey: cap(body?.apiKey, 300), baseUrl: cap(body?.baseUrl, 250) };
}

// Deteksi jawaban yang benar-benar berformat OCR.
// BUG LAMA: regex /^(\(\)|\[|<|>|\*|Sfx|#) /m menolak "[] " dan "<> " karena
// setelah "[" / "<" langsung ada karakter "]" / ">" , bukan spasi. Akibatnya
// narasi & thought yang sah dianggap "non-OCR" lalu ditolak.
const OCR_LINE_RE = /^(\(\)|\[\]|<>|\*|Sfx|#)( |$)/m;
function looksLikeOcr(text) {
  return OCR_LINE_RE.test(text) || /^\[\.\.\.\]/m.test(text) || text.includes('# NO TEXT');
}

async function runGemini(base64Data, mimeType, modelName, env, opts = {}) {
  const keys = keyPool(env, 'GEMINI_API_KEY', opts.apiKey);
  return keyRotator('Gemini', keys, async (apiKey, idx) => {
    // Key dikirim lewat header (bukan ?key=) supaya tidak masuk URL / log.
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_SHORT }] },
      contents: [{ role: 'user', parts: [{ text: OCR_PROMPT }, { inlineData: { mimeType, data: base64Data } }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
      // OCR hanya menyalin teks yang sudah tercetak. Menurunkan ambang filter agar
      // dialog komik dewasa tidak diblokir sepihak. Kategori ini adalah pengaturan
      // resmi API; batas keras Google (mis. konten anak) tetap berlaku dan tidak bisa dilewati.
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };
    const resp = await fetchWithTimeout(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
    }, 55000);
    if (!resp.ok) {
      const b = scrub((await resp.text()).slice(0, 400));
      if (resp.status === 429) throw keyErr(`Limit Gemini habis (429) di key #${idx + 1}. Detail: ${b}`);
      if (resp.status === 401 || resp.status === 403) throw keyErr(`API key Gemini ditolak (401/403) di key #${idx + 1}. Detail: ${b}`);
      // Google memblokir pemakaian API dari region datacenter yang mengeksekusi Worker
      if (b.includes('not supported for the API use') || b.includes('User location is not supported') || b.includes('FAILED_PRECONDITION')) {
        throw new Error('Gemini diblokir di region server saat ini (aturan wilayah Google). Solusi: ganti provider ke Agnes AI atau Cloudflare AI di dropdown header, atau aktifkan Smart Placement di wrangler.toml.');
      }
      if (resp.status === 400) throw new Error(`Gemini menolak request (model "${modelName}"?). Detail: ${b}`);
      throw new Error(`Gemini error ${resp.status}: ${b}`);
    }
    const data = await resp.json();

    // Diblokir di level prompt (sebelum ada kandidat)
    if (data?.promptFeedback?.blockReason) {
      throw new Error(`Gemini menolak gambar (${data.promptFeedback.blockReason}). Coba model lain atau provider Agnes/Cloudflare.`);
    }
    const cand = data?.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
    if (!text) {
      const fr = cand?.finishReason;
      if (fr === 'SAFETY' || fr === 'PROHIBITED_CONTENT' || fr === 'BLOCKLIST' || fr === 'SPII' || fr === 'IMAGE_SAFETY') {
        throw new Error(`Gemini memblokir gambar (${fr}). Coba model lain atau provider Agnes/Cloudflare.`);
      }
      if (fr === 'RECITATION') throw new Error('Gemini menolak karena terdeteksi kutipan berhak cipta (RECITATION). Coba lagi / ganti model.');
      if (fr === 'MAX_TOKENS') throw new Error('Respons terpotong sebelum ada teks (MAX_TOKENS). Coba model lain.');
      return '# NO TEXT DETECTED';
    }
    if (!looksLikeOcr(text)) {
      throw new Error(refusalHint('Gemini', text));
    }
    return text;
  });
}

// Agnes AI — OpenAI-compatible chat completions + image_url (data URI didukung)
async function runAgnes(base64Data, mimeType, modelName, env, opts = {}) {
  const keys = keyPool(env, 'AGNES_API_KEY', opts.apiKey);
  const base = (env.AGNES_BASE_URL || DEFAULT_AGNES_BASE).replace(/\/+$/, '');
  // Cegah SSRF via env yang salah konfigurasi: wajib https.
  if (!/^https:\/\//i.test(base)) throw new Error('AGNES_BASE_URL harus diawali https://');
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  return keyRotator('Agnes', keys, async (apiKey, idx) => {
    const payload = {
      model: modelName,
      temperature: 0.1,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_SHORT },
        {
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    };
    const resp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    }, 55000);
    if (!resp.ok) {
      const b = scrub((await resp.text()).slice(0, 400));
      if (resp.status === 429) throw keyErr(`Limit Agnes habis (429) di key #${idx + 1}. Detail: ${b}`);
      if (resp.status === 401 || resp.status === 403) throw keyErr(`API key Agnes ditolak (401/403) di key #${idx + 1}. Detail: ${b}`);
      throw new Error(`Agnes error ${resp.status}: ${b}`);
    }
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const text = (typeof choice?.message?.content === 'string' ? choice.message.content : '').trim();
    if (!text) {
      if (choice?.finish_reason === 'content_filter') throw new Error('Agnes memblokir gambar (content_filter). Coba model lain atau provider lain.');
      return '# NO TEXT DETECTED';
    }
    if (!looksLikeOcr(text)) {
      throw new Error(refusalHint('Agnes', text));
    }
    return text;
  });
}

// Custom — endpoint OpenAI-compatible apa pun (OpenRouter, Groq, vLLM, dsb).
// Base URL + model bebas; API key opsional (endpoint publik bisa tanpa key).
async function runCustom(base64Data, mimeType, opts, env) {
  const base = sanitizeBaseUrl(opts.baseUrl || env.CUSTOM_BASE_URL);
  const model = String(opts.model || env.CUSTOM_MODEL || '').slice(0, 120);
  if (!model) throw new Error('Custom model kosong: isi "Custom — Model" di Pengaturan atau set CUSTOM_MODEL di Worker.');
  const keys = keyPool(env, 'CUSTOM_API_KEY', opts.apiKey);
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  // Tanpa key pun sudah didukung: pool kosong → satu percobaan tanpa Authorization.
  return keyRotator('Custom', keys.length ? keys : [null], async (apiKey) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM_SHORT },
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    }, 60000);
    if (!resp.ok) {
      const b = scrub((await resp.text()).slice(0, 400));
      if (resp.status === 429) throw keyErr(`Custom API limit (429). Detail: ${b}`);
      if (resp.status === 401 || resp.status === 403) throw keyErr(`Custom API menolak key (401/403). Detail: ${b}`);
      throw new Error(`Custom API error ${resp.status}: ${b}`);
    }
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const text = (typeof choice?.message?.content === 'string' ? choice.message.content : '').trim();
    if (!text) {
      if (choice?.finish_reason === 'content_filter') throw new Error('Custom API memblokir gambar (content_filter). Coba model/provider lain.');
      return '# NO TEXT DETECTED';
    }
    if (!looksLikeOcr(stripThink(text))) {
      throw new Error(refusalHint('Custom AI', text));
    }
    return text;
  });
}

async function runCloudflareAI(base64Data, mimeType, preferredModel, env) {
  if (!env.AI) throw new Error('Binding AI belum aktif. Cek wrangler.toml [ai].');
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  // Model pilihan user dicoba duluan, sisanya jadi fallback
  const ordered = [preferredModel, ...CF_VISION_MODELS.filter((m) => m !== preferredModel)];
  let lastError = null;
  let sawRefusal = null;
  for (const name of ordered) {
    // Format A: OpenAI-style content blocks (Qwen 3.8, Mistral Small 3.1)
    // Format B: messages + image terpisah (Llama 3.2 Vision tutorial resmi)
    const attempts = [
      {
        messages: [
          { role: 'system', content: SYSTEM_SHORT },
          { role: 'user', content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]},
        ],
        max_tokens: 2048, temperature: 0.1,
      },
      {
        messages: [
          { role: 'system', content: SYSTEM_SHORT },
          { role: 'user', content: OCR_PROMPT },
        ],
        image: dataUrl, max_tokens: 2048, temperature: 0.1,
      },
    ];
    for (const input of attempts) {
      try {
        const resp = await env.AI.run(name, input);
        const t = extractCfText(resp).trim();
        if (!t) continue;
        // Jangan terima jawaban penolakan/ngawur begitu saja — coba format/model berikutnya.
        if (!looksLikeOcr(stripThink(t))) { sawRefusal = t; continue; }
        return t;
      } catch (e) { lastError = e; console.warn(`CF ${name} gagal:`, e?.message); }
    }
  }
  if (sawRefusal) throw new Error(refusalHint('Cloudflare AI', sawRefusal));
  if (lastError) throw new Error(`Cloudflare AI gagal: ${scrub(String(lastError.message || lastError)).slice(0, 300)}`);
  return '# NO TEXT DETECTED';
}

function extractCfText(resp) {
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    // Format OpenAI-compatible (Qwen/Mistral di Workers AI terbaru)
    const oa = resp.choices?.[0]?.message?.content;
    if (typeof oa === 'string' && oa) return oa;
    const r = resp.response ?? resp.result ?? resp.description ?? resp.text ?? '';
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object' && typeof r.response === 'string') return r.response;
    return '';
  }
  return String(resp ?? '');
}

// ================= helpers =================
// Pesan yang jelas bila model menolak / menjawab di luar format (mis. "I can't help with that").
function refusalHint(who, text) {
  const snip = text.replace(/\s+/g, ' ').slice(0, 120);
  return `${who} menolak / tidak mengikuti format OCR ("${snip}…"). Klik Ulangi, ganti model, atau pakai provider lain.`;
}

// Hapus kunci/token yang mungkin ikut tercetak di pesan error.
function scrub(s) {
  return String(s)
    .replace(/([?&]key=)[^&\s"']+/gi, '$1***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '***')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '***')
    .replace(/\bsb_(?:secret|publishable|anon)_[A-Za-z0-9_-]{10,}\b/gi, '***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
}

// Hash cepat (sampling) untuk verifikasi gambar request↔respons.
// Algoritma HARUS sama persis dengan shortHash() di frontend.
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 8) h = (((h << 5) + h + s.charCodeAt(i)) >>> 0);
  return h.toString(16).padStart(8, '0');
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Provider timeout (${ms / 1000} dtk). Coba gambar lebih kecil.`);
    throw e;
  } finally { clearTimeout(t); }
}

function stripThink(text) {
  return String(text || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    // reasoning yang terpotong (tag pembuka tanpa penutup) → buang sampai akhir
    .replace(/<think(?:ing)?>[\s\S]*$/i, '')
    .trim();
}

// Awal baris yang dianggap prefix OCR sah.
const PREFIX_AT_START = /^(\(\)|\[\]|<>|\*|Sfx|#)(?= |$)/;

function normalizeOutput(text) {
  text = (text || '').trim();
  if (!text) return '# NO TEXT DETECTED';

  // 1. Buang jejak reasoning model (Qwen dsb) — SEBELUM apa pun.
  text = stripThink(text);
  // 2. Lepas code fence tapi pertahankan isinya.
  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1').replace(/^```.*$/gm, '');

  // 3. Bersihkan sisa markdown per baris TANPA merusak prefix OCR.
  //    BUG LAMA: langkah "paksa newline sebelum tiap prefix" memecah kalimat yang
  //    memuat "(...)", "[...]", "<", ">", "#", "*" atau kata "Sfx" di tengah dialog
  //    (mis. "() sore wa hon[...] da" jadi 2 baris, "() 3 < 5" jadi 3 baris).
  //    Sekarang pemisahan hanya dilakukan bila SEBELUM prefix ada tanda akhir
  //    kalimat/spasi ganda yang jelas, dan hanya untuk prefix dua-karakter yang
  //    tak ambigu ("() ", "[] ", "<> ") + "Sfx ".
  const cleaned = [];
  for (const raw of text.split('\n')) {
    let l = raw.trim();
    if (!l) continue;
    if (/^(-{3,}|_{3,}|\*{4,}|={3,})$/.test(l)) continue; // horizontal rule
    if (l === '//') { cleaned.push(l); continue; }       // pemisah balon gabungan: pertahankan apa adanya
    l = l.replace(/^>\s?(?!\s*$)/, (m) => (PREFIX_AT_START.test(l) ? m : '')); // blockquote murni
    l = l.replace(/^#{2,}\s+/, '# ');                      // ## Heading -> prefix #
    const startsWithPrefix = PREFIX_AT_START.test(l);
    l = l.replace(/\*\*(.+?)\*\*/g, '$1');                 // **bold**
    l = l.replace(/__(.+?)__/g, '$1');                     // __bold__
    l = l.replace(/`([^`]*)`/g, '$1');                     // `inline code`
    l = l.replace(/~~(.+?)~~/g, '$1');                     // ~~strike~~
    if (!startsWithPrefix) {
      l = l.replace(/^[-•]\s+/, '');                       // bullet list (bukan prefix)
      l = l.replace(/\*([^*\n]+)\*(?!\*)/g, '$1');         // *italic* sisa (prefix "*" tidak tersentuh)
    }
    l = l.replace(/\\([#*_<>\[\]])/g, '$1');               // \# \* dst → karakter polos
    // spasi ganda setelah prefix
    l = l.replace(/^(\(\)|\[\]|<>|\*|Sfx|#)\s{2,}/, '$1 ');
    if (l) cleaned.push(l);
  }
  text = cleaned.join('\n');
  if (!text) return '# NO TEXT DETECTED';

  // 4. Pisahkan HANYA prefix dua-karakter yang tertempel setelah tanda baca akhir
  //    kalimat (mis. "...ya. () Iya" → 2 baris). Tidak menyentuh tanda kurung
  //    biasa di dalam kalimat.
  text = text.replace(/([.!?…。！？」』"”])[ \t]+(?=(?:\(\)|\[\]|<>) )/g, '$1\n');

  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.join('\n').trim() || '# NO TEXT DETECTED';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// ---- CORS: dukung BANYAK origin (versi lama hanya memakai origin pertama) ----
function parseOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function originAllowed(env, origin) {
  const list = parseOrigins(env);
  if (!list.length || list.includes('*')) return true;
  return list.includes(origin);
}
function cors(res, env, origin) {
  const list = parseOrigins(env);
  const h = new Headers(res.headers);
  if (!list.length || list.includes('*')) {
    h.set('Access-Control-Allow-Origin', '*');
  } else if (origin && list.includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.append('Vary', 'Origin');
  } // origin tak dikenal: tidak ada header → browser memblokir
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  // Header keamanan standar untuk seluruh respons API worker.
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=()');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(res.body, { status: res.status, headers: h });
}

// ================= EDIT_PROMPT (aturan editor TL dari pengguna) =================
const EDIT_PROMPT = `EDITOR BAHASA INDONESIA — MENYUNTING TERJEMAHAN, BUKAN MENERJEMAHKAN ULANG

Komik, manhwa, manhua, dan light novel | Hasil terjemahan berbahasa Indonesia

1. PERAN DAN BATAS TUGAS
Kamu adalah editor profesional. Pengguna memberikan file ".txt" berisi hasil terjemahan bahasa Indonesia buatannya sendiri.
Tugasmu MENYUNTING hasil itu — memperbaiki kualitasnya agar natural seperti tulisan asli orang Indonesia, nyaman dibaca, tidak kaku, tidak bertele-tele, dan tetap setia pada makna serta gaya penulisnya.
Kamu TIDAK menerjemahkan ulang dari bahasa sumber, TIDAK menulis ulang seluruh file, dan TIDAK diberi teks sumber bahasa Inggris. Jangan mengarang sumber aslinya; nilai ketepatan hanya dari konteks yang ada di file.
Jadilah editor yang aktif, bukan pemeriksa typo yang pasif: perbaiki kalimat yang kaku meski tata bahasanya sudah benar, tetapi jangan mengubah kalimat yang sudah bagus hanya demi menunjukkan kamu menyunting. Prinsipnya: perbaiki sebanyak yang memang diperlukan; jangan mengubah apa yang sudah benar.

2. URUTAN PRIORITAS
Kerjakan dengan urutan ini setiap kali ada konflik antaraturan:
Prioritas 1 — ketepatan makna: subjek dan objek, sebab-akibat, waktu dan kondisi, jumlah dan ukuran, pernyataan positif dan negatif, emosi karakter, dan hubungan antar-kalimat tidak berubah. Jangan menambah atau menghilangkan informasi.
Prioritas 2 — typo dan ejaan: perbaiki kesalahan ketik, ejaan, dan kapitalisasi yang jelas. Jangan membiarkan kesalahan hanya karena takut mengubah teks.
Prioritas 3 — naturalitas: perbaiki struktur kalimat yang terlalu mengikuti bahasa Inggris, susunan kata yang janggal, pilihan kata penghubung yang kurang tepat, kata berlebih, pengulangan, dan kalimat yang terlalu panjang. Dialog harus terdengar seperti percakapan alami.
Prioritas 4 — efisiensi: ringkas tanpa menghilangkan informasi, hanya bila hasilnya tetap natural.
Contoh naturalitas:
Sebelum: "Dalam jarak sepuluh meter, ikatan bisa ditumpuk serta diperpanjang."
Sesudah: "Dalam jarak sepuluh meter, ikatan bisa ditumpuk dan diperpanjang."
Sebelum: "Betul sekali, Yaitu bergabung dengan Destiny Covenant, secara resmi mengabdi pada negara!"
Sesudah: "Betul sekali! Bergabung dengan Destiny Covenant berarti resmi mengabdi pada negara!"
Contoh hanya panduan; jangan menyalin polanya secara membabi buta.

3. TYPO, EJAAN, DAN KATA AMBIGU
Perbaiki langsung bila maksudnya dapat dipastikan dari konteks dan bentuk katanya. Contoh: "Mengendalikan rotme" menjadi "Mengendalikan ritme"; "Karna" menjadi "Karena"; "Sekedar" menjadi "Sekadar"; "Aktifitas" menjadi "Aktivitas"; "Resiko" menjadi "Risiko"; "Betul sekali, Yaitu" menjadi "Betul sekali, yaitu".
Bila ada beberapa kemungkinan kata yang benar dan konteks tidak cukup untuk menentukan, JANGAN menebak: pertahankan kata itu dan laporkan di "review".
Jangan menganggap nama karakter, istilah fiksi, nama skill, nama item, atau istilah dunia cerita sebagai typo hanya karena tidak ada di kosakata umum; gunakan konteks dulu.

4. GAYA BAHASA, KATA GANTI, DAN KARAKTER
Pertahankan gaya pengguna. Jangan mengubah bahasa santai menjadi formal tanpa alasan. Kata-kata seperti aku, kamu, saya, Anda, gue, lo, kau, doang, banget, dah, kok, sih, nih, gitu, kayak, bakal, gampang, dan ketemu boleh dipertahankan bila sesuai konteks; jangan menganggap bahasa percakapan sebagai kesalahan tata bahasa.
Kata ganti orang TIDAK BOLEH diganti, meski kamu memperbaiki susunan kalimat di sekitarnya. Contoh: "Aku hanya perlu berdiri diam di tempat" tidak boleh menjadi "Saya hanya perlu berdiri diam di tempat"; "Kamu harus pergi sekarang" tidak boleh menjadi "Kau harus pergi sekarang".
Jaga karakter pembicara: karakter santai tetap kasual, karakter formal tetap tertata, karakter sombong tetap arogan, karakter marah tetap tegas, karakter bercanda tetap lucu, karakter berwibawa tidak dibuat terlalu santai. Jangan membuat semua karakter berbicara dengan gaya yang sama.

5. ISTILAH INGGRIS YANG DIPERTAHANKAN PENGGUNA
Istilah Inggris yang sudah dipertahankan pengguna dalam file — terutama istilah game, fantasi, teknis, nama skill, class, item, dan trait — harus tetap dalam bahasa Inggris. Jangan menerjemahkan, mengganti sinonim, atau mencari padanan Indonesianya.
Contoh istilah yang dilindungi: Dark tentacles, Casting, Casting range, Mage class, Late game, Summon, Shadow Mage, Hidden class, Dungeon, Assassin, Equipment, Golden Trait, Skill, Farming, Burst, Ranged class, Top-tier equipment. Daftar ini tidak tertutup; aturan yang sama berlaku untuk istilah sejenis.
Kamu boleh mengubah struktur bahasa Indonesia di sekitar istilah itu. Contoh: "Inti dari mage class bukanlah burst, melainkan kontrol" menjadi "Inti mage class bukan burst, melainkan kontrol" — bukan "Inti kelas penyihir bukan serangan ledakan, melainkan kendali".
Batasan: perlindungan ini hanya untuk istilah yang memang dipertahankan pengguna. Kata Inggris umum yang bukan istilah khusus tetap boleh dirapikan bila pengguna bermaksud menerjemahkannya; jangan mempertahankan kata Inggris hanya karena ia berbahasa Inggris.

6. NAMA, SAPAAN, DAN ISTILAH KHUSUS
Pertahankan nama karakter, nama tempat, nama organisasi, gelar, sapaan, nama skill, nama item, nama trait, dan istilah khusus dunia cerita persis seperti tertulis. Jangan mengganti atau menerjemahkannya berdasarkan asumsi. Istilah yang sama berulang kali harus konsisten penulisannya di seluruh bagian; jangan menyeragamkan istilah yang sebenarnya berbeda.

7. STRUKTUR FILE — WAJIB DIPERTAHANKAN PERSIS
File ".txt" adalah acuan utama tata letak. Jangan membuat format baru dan jangan merapikan file menurut preferensimu.
Penanda halaman: "P1", "P2", "P3", dan seterusnya dipertahankan posisinya, urutannya, dan jumlahnya. Jangan menambah, menghapus, memindahkan, menggabungkan halaman, atau menganggap P1 sebagai judul atau dialog.
Penanda teks: pertahankan sesuai file asli, yaitu "-" dialog, "()" balon dialog, "Sfx" efek suara, "[]" kotak narasi, "#" sistem/status, "*" tulisan di luar balon, "**" tulisan kecil, "//" baris pemisah balon (berdiri sendiri, tanpa isi dialog): pertahankan posisinya; baris ini pemisah struktural, bukan isi yang disunting. "<>" tulisan pada kertas atau media lain. Jangan mengganti jenis, menghapus, atau memindahkan penanda.
Baris dan posisi: pertahankan urutan baris, posisi dialog dan penanda, baris kosong, indentasi, dan spasi awal baris. Satu baris tetap satu baris; jangan menggabungkan, memecah, memindahkan, menambah, atau menghapus dialog. Jumlah dan susunan baris tidak berubah.
Awal dan akhir baris: pertahankan penanda struktural di awal baris dan tanda baca penutupnya (elipsis, tanda tanya, tanda seru). Aturan ini tidak boleh menghalangi perbaikan typo di dalam kalimat; yang tidak boleh berubah hanya penandanya, bukan kata di dalamnya.
Status window: pertahankan label, angka, statistik, satuan, nama skill dan trait, indentasi, dan urutan informasi. Hanya isi deskripsi yang boleh disunting bila perlu; jangan mengubah angka, durasi, jangkauan, biaya, atau efek.
Catatan penerjemah: baris yang jelas merupakan Note TL, Note TN, Catatan TL, Catatan TN, atau Catatan: disalin persis tanpa perubahan.

8. KONTEKS KOMIK DAN BAGIAN MERAGUKAN
Satu kalimat bisa bersambung lintas balon atau halaman: baca baris sebelum dan sesudahnya untuk memahami maksud, tetapi jangan menggabungkan atau memindahkan baris. Perbaiki narasi agar natural dengan mempertahankan sudut pandang, kata ganti, detail, dan maksudnya. Pada deskripsi skill, trait, dan statistik, jaga akurasi angka, durasi, jangkauan, biaya, dan efek. Pertahankan humor, sindiran, sarkasme, dan ekspresi karakter; jangan membuat dialog kaku demi mengejar bahasa baku.
Jangan asal menebak, tetapi jangan pula mudah menyerah. Typo jelas, salah ejaan umum, kapitalisasi keliru, dan kalimat kaku yang maknanya jelas diperbaiki langsung. Istilah Inggris yang dikenal dan nama khusus yang tidak dikenal dipertahankan. Kata tidak dikenal dengan beberapa kemungkinan arti, atau makna yang tidak dapat dipastikan, dipertahankan dan dilaporkan di "review" tanpa mengarang. Jangan meminta konfirmasi untuk perubahan kecil; nilai sendiri secara kontekstual.

9. ATURAN FINAL
Jadilah editor yang aktif, bukan pemeriksa typo yang pasif. Perbaiki kalimat kaku dan typo yang jelas; jangan membiarkan kesalahan karena takut mengubah teks; jangan menerjemahkan istilah Inggris yang dilindungi; jangan mengganti kata ganti pengguna; jangan mengubah nama dan sapaan; jangan mengubah makna; jangan mengarang informasi; jangan mengubah struktur file; jangan memindahkan penanda halaman; dan jangan membuat format baru.
Hasil akhir harus terasa seperti terjemahan yang telah disunting manusia profesional: natural, konsisten, akurat, dan nyaman dibaca.`;
// =====================================================================
// ============ EDITOR TL  (POST /edit) =================================
// =====================================================================
// Aturan penyuntingan (EDIT_PROMPT) di atas diambil dari prompt editor milik pengguna.
// Model TIDAK menulis ulang seluruh file. Ia hanya mengembalikan baris yang berubah
// (JSON). Aplikasi lalu menempelkannya ke file asli, jadi nomor halaman, jumlah baris,
// baris kosong, dan indentasi pasti utuh. Semua perubahan divalidasi di bawah ini.

const MAX_EDIT_BODY = 400 * 1024;
const MAX_EDIT_CHARS = 30000;
const MAX_EDIT_LINES = 600;
const MAX_EDIT_LINE_LEN = 2000;

const EDIT_PROTOCOL = `

=====================================================================
CARA KERJA DI APLIKASI INI (format jawaban — bagian ini mengikat)
=====================================================================
Setiap baris input berformat "N| teks", N adalah nomor baris di file asli. Baris kosong tidak dikirim.
Kamu HANYA mengembalikan SATU objek JSON, tanpa code fence, tanpa markdown, tanpa teks lain:

{"changes":[{"n":12,"after":"<baris lengkap setelah disunting>","reason":"<alasan singkat>"}],"review":[{"n":15,"issue":"<masalah>","suggestion":"<saran>"}]}

Aturan format:
- "changes" hanya berisi baris yang BENAR-BENAR kamu ubah. Baris yang sudah bagus jangan disertakan.
- "after" adalah isi baris utuh seperti di file: tulis ulang penanda di awal baris (-, (), [], #, *, **, //, <>, Sfx) dan indentasinya persis seperti aslinya, tanpa awalan "N| ". Satu baris tetap satu baris (tanpa karakter baris baru).
- Baris nomor halaman (P1, P2, ...), baris Note/Catatan TL/TN, serta angka, durasi, biaya, dan statistik di status window tidak boleh diubah.
- Penggantian kata ganti (aku/kamu/saya/gue/lo/dll.) tidak diperbolehkan. Jangan menerjemahkan istilah Inggris, dan jangan mengubah huruf besar-kecil pada nama/istilah Inggris.
- Jangan menambah elipsis, tanda baca, atau kata sapaan baru yang tidak ada di baris asli, dan jangan mengubah tanda baca penutup (… / ... / ? / !).
- Untuk nama karakter, skill, atau istilah yang sama muncul berkali-kali, gunakan penulisan yang konsisten dengan KONTEKS SEBELUMNYA.
- "reason" ditulis ringkas dalam bahasa Indonesia, misalnya: Memperbaiki typo "rotme" menjadi "ritme" dan membuat susunan kalimat lebih natural.
- "review" hanya untuk bagian yang benar-benar butuh keputusan pengguna (kata tidak jelas dengan beberapa kemungkinan arti, atau makna tidak bisa dipastikan). Untuk baris itu, JANGAN ubah teksnya. Jangan masukkan typo yang sudah jelas dan sudah kamu perbaiki.
- Bagian "KONTEKS SEBELUMNYA" hanya untuk menjaga konsistensi nama, istilah, kata ganti, dan nada. Jangan disunting dan jangan dimasukkan ke jawaban.
- Bila tidak ada yang perlu diubah, jawab: {"changes":[],"review":[]}`;

// =====================================================================
// ======= TERJEMAHAN EN→ID  (POST /translate) + GLOSARIUM =============
// =====================================================================
// Beda dengan /edit: model menerjemahkan baris sumber, jadi SETIAP baris input
// wajib punya pasangan hasil. Penanda prefix OCR disalin persis agar file hasil
// tetap kompatibel dengan pipeline (Editor TL, dsb). Istilah konsisten via
// GLOSARIUM (Supabase). Angka yang ikut berubah → review, bukan ditolak keras.

const TRANSLATE_PROMPT = `PENERJEMAH PROFESIONAL — EN / CH / KR / JP KE BAHASA INDONESIA

Kamu adalah penerjemah profesional komik, manhwa, manhua, dan scanlation berbahasa Indonesia. Input adalah hasil OCR: dialog, narasi, SFX, dan catatan, masing-masing satu baris dengan penanda prefix.

1. BAHASA SUMBER
Terjemahkan hanya dari empat bahasa sumber: bahasa Inggris (EN), bahasa Tionghoa/CJK (CH), bahasa Korea (KR), dan bahasa Jepang (JP). Hasilnya selalu Bahasa Indonesia.
Bila baris sumber sudah berbahasa Indonesia, salin baris itu apa adanya dan catat di "review". Bahasa lain di luar empat bahasa ini juga disalin apa adanya dan dicatat di "review"; jangan menerjemahkannya dari tebakan.

2. TUJUAN
Terjemahkan SETIAP baris secara akurat, natural, dan nyaman dibaca. Jangan meringkas, menambah isi, berkomentar, atau menyensor. Dialog tetap dialog dan narasi tetap narasi. Pertahankan candaan, sindiran, sarkasme, dan ekspresi karakter, termasuk umpatan atau nada kasar bila sumbernya memang kasar.

3. REGISTER — FORMAL VS INFORMAL
Kalimat formal (sopan, situasi resmi, narasi berwibawa) diterjemahkan ke Bahasa Indonesia formal dengan "saya" dan "Anda" serta tata bahasa rapi. Kalimat informal (akrab, bercanda, teman sebaya) diterjemahkan santai dengan "aku" dan "kamu"; "gue" dan "lo" hanya bila nada sumbernya sangat kasual. Satu karakter mempertahankan registernya sepanjang bagian, terutama berdasarkan KONTEKS SEBELUMNYA. Narator cenderung formal; dialog menyesuaikan watak pembicaranya.

4. ROMANISASI — HANYA UNTUK TEKS BAHASA INGGRIS
Romanisasi atau penulisan ulang ke huruf Latin hanya berlaku untuk teks yang memang berasal dari bahasa Inggris. Nama, julukan, dan istilah Inggris yang lazim dipertahankan dalam terbitan Indonesia dipertahankan persis ejaannya, misalnya "Bladestorm" dan "Iron Haven".
Untuk sumber CH, KR, dan JP, istilah khusus TIDAK diromanisasi dan tidak diubah bentuknya: salin ejaan aslinya apa adanya. Bila sumbernya memakai aksara asli (kanji/kana, hangul, hanzi), pertahankan aksara itu — jangan mengubahnya menjadi romaji, pinyin, atau transliterasi Latin apa pun. Bila sumbernya memang sudah tercetak dalam huruf romaji atau Latin, pertahankan tulisan Latin itu apa adanya. Contoh: istilah yang tercetak "Kagebunshin" tetap "Kagebunshin"; istilah yang tercetak dalam kana atau kanji tetap kana atau kanji, bukan "Kagebunshin" dan bukan terjemahan bebasnya. Prinsipnya: jangan mengarang ejaan Latin untuk istilah CH, KR, dan JP.
Kata berumum dari keempat bahasa tetap diterjemahkan: king menjadi raja, sword menjadi pedang, guild menjadi gilda, holy menjadi suci.

5. ISTILAH YANG TETAP ASLI
Nama tokoh, nama tempat, gelar dan julukan unik, nama item (senjata, armor, barang), nama skill, teknik, sihir, dan nama jurus tidak diterjemahkan: salin persis ejaan, huruf besar-kecil, dan tanda hubungnya dari sumber. Sapaan umum diterjemahkan normal, misalnya "Your Majesty" atau padanannya diterjemahkan menjadi "Yang Mulia", sedangkan gelar atau julukan unik tetap dalam ejaan aslinya.
Bila istilah itu tercetak dalam aksara CH, KR, atau JP, pertahankan aksara aslinya sesuai aturan romanisasi di bagian 4.

6. GLOSARIUM
Blok GLOSARIUM, bila diberikan, WAJIB dipakai apa adanya setiap kali istilahnya muncul. Istilah baru yang kamu putuskan dan akan terus muncul — tempat, julukan, item, skill — catat di "glossary" dengan pasangan from dan to. Catat hanya istilah yang benar-benar muncul di bagian ini dan belum ada di blok GLOSARIUM. Istilah yang dipertahankan dalam ejaan aslinya (to sama dengan from) tidak perlu dicatat, karena aturan bagian 4 dan 5 sudah mempertahankannya.

7. SFX
Baris Sfx adalah onomatope. Terjemahkan ke padanan lazim dalam ejaan Indonesia bila ada padanan yang jelas, misalnya knock menjadi duk dan ding menjadi ting; padanan Jepang yang jelas juga diterjemahkan ke onomatope Indonesia. Bila tidak ada padanan yang wajar, biarkan seperti aslinya. Penanda Sfx di awal baris dipertahankan.

8. ANGKA, FORMAT, DAN PENANDA
Angka, durasi, biaya, level, stat, dan waktu tidak boleh berubah nilainya. Jangan menambah elipsis, tanda baca, atau sapaan baru yang tidak ada di sumber, dan jangan mengubah tanda baca penutup seperti elipsis, tanda tanya, dan tanda seru.
Penanda prefix OCR di awal baris — yaitu -, --, (), [], <>, *, **, #, dan Sfx — disalin persis beserta indentasinya di awal baris hasil terjemahan. Baris yang isinya hanya "//" adalah pemisah balon (struktural): pertahankan posisinya apa adanya, jangan diterjemahkan dan jangan diberi prefix baru. Baris tanpa prefix tidak diberi prefix baru. Format sapaan "Nama: dialog" dipertahankan; namanya tetap dalam ejaan asli sesuai bahasa sumbernya, jangan dipaksakan ke bahasa Inggris atau Indonesia.

9. BAGIAN RAGU
Bila makna baris tidak yakin atau ada beberapa tafsir yang masuk akal, isi dengan tafsir terbaikmu lalu catat di "review" dengan alasan singkat. Jangan mengarang isi yang sama sekali tidak ada di sumber.`;
const TRANSLATE_PROTOCOL = `

=====================================================================
CARA KERJA DI APLIKASI INI
=====================================================================
Setiap baris input berformat "N| teks", N adalah nomor baris di file asli. Baris kosong, baris penanda halaman (P1, P2, ...), dan baris Note/Catatan TL/TN tidak dikirim ke kamu.
Kamu HANYA mengembalikan SATU objek JSON, tanpa code fence, tanpa markdown, tanpa teks lain:

{"lines":[{"n":12,"t":"<baris hasil terjemahan>"}],"glossary":[{"from":"the Shadow King","to":"Raja Bayangan","kind":"title","note":"gelar raja kegelapan"}],"review":[{"n":15,"issue":"<masalah>","suggestion":"<saran>"}]}

Aturan format:
- "lines" memuat hasil terjemahan untuk SETIAP nomor N yang input diterima, satu entri per nomor, tidak boleh ada yang dilewati. Nomor harus sama persis; jangan menambah nomor baru.
- "t" adalah isi baris utuh hasil terjemahan: salin penanda awal (-, --, (), [], <>, *, **, //, #, Sfx) dan indentasi persis seperti input, tanpa awalan "N| ". Satu baris tetap satu baris (tanpa karakter baris baru).
- Angka, durasi, biaya, dan statistik tidak boleh berubah nilainya. Jika terjemahan wajib menyentuh angka, pertahankan angkanya.
- "glossary" hanya berisi istilah baru yang kamu tetapkan terjemahannya, yang benar-benar muncul di bagian ini, dan belum ada di blok GLOSARIUM. Jangan masukkan entri dengan "to" sama dengan "from" — istilah yang dipertahankan dalam ejaan aslinya tidak perlu dicatat. kind harus salah satu: place (tempat), title (gelar/julukan), item (barang), skill (kemampuan), name (nama tokoh), other.
- "review" untuk baris ragu atau yang terjemahannya mungkin kurang tepat: tulis "issue" (masalah) dan "suggestion" (saran) yang ringkas dan spesifik. Terjemahan tetap dikirim di "lines" — jangan mengosongkan "t" karena ragu.
- Blok "KONTEKS SEBELUMNYA" dan "GLOSARIUM" hanya bacaan untuk menjaga konsistensi; jangan dikutip atau diulang di jawaban.
- Jika baris sumber sudah berbahasa Indonesia, "t" tetap diisi baris itu apa adanya (salin persis) dan catat di "review".`;

const TR_KINDS = new Set(['place', 'title', 'item', 'skill', 'name', 'other']);

function translateProblem(before, after) {
  if (/[\r\n]/.test(after)) return 'memecah satu baris menjadi beberapa baris';
  if (!after || !after.trim()) return 'baris terjemahan kosong';
  const mb = String(before.match(MARKER_RE)[0]);
  const ma = String(after.match(MARKER_RE)[0]);
  if (mb !== ma) return 'penanda awal baris berubah';
  if (NOTE_RE.test(before) && after !== before) return 'baris Note TL/TN harus disalin persis';
  if (digitTokens(before) !== digitTokens(after)) return 'angka/durasi/biaya tidak boleh berubah';
  return '';
}

function validateTranslate(clean, parsed) {
  const byN = new Map(clean.map((l) => [l.n, l.t]));
  const got = new Map();
  const review = [];
  for (const item of Array.isArray(parsed?.lines) ? parsed.lines : []) {
    const n = Number(item?.n);
    if (!Number.isInteger(n) || !byN.has(n) || got.has(n)) continue;
    let t = typeof item?.t === 'string' ? item.t : '';
    t = t.replace(/^\d+\s*\|\s*/, '').slice(0, MAX_EDIT_LINE_LEN);
    const before = byN.get(n);
    const problem = translateProblem(before, t);
    if (problem) {
      if (problem === 'angka/durasi/biaya tidak boleh berubah') {
        review.push({ n, text: before, issue: 'Angka/durasi/biaya berubah setelah terjemahan; baris asli dipakai dulu.', suggestion: 'Perbaiki angkanya secara manual, atau jalankan ulang bagian ini.' });
      } else {
        review.push({ n, text: before, issue: 'Terjemahan dibatalkan: ' + problem + '.', suggestion: 'Perbaiki baris ini secara manual.' });
      }
      continue;
    }
    got.set(n, t);
  }
  const lines = [];
  for (const l of clean) {
    if (got.has(l.n)) lines.push({ n: l.n, t: got.get(l.n) });
    else {
      lines.push({ n: l.n, t: l.t });
      review.push({ n: l.n, text: l.t, issue: 'Tidak ada terjemahan dari model untuk baris ini.', suggestion: 'Jalankan ulang bagian ini atau terjemahkan manual.' });
    }
  }
  lines.sort((a, b) => a.n - b.n);
  review.sort((a, b) => a.n - b.n);

  const glossary = [];
  const gSeen = new Set();
  for (const g of Array.isArray(parsed?.glossary) ? parsed.glossary : []) {
    if (glossary.length >= 60) break;
    const from = String(g?.from || '').trim().slice(0, 120);
    const to = String(g?.to || '').trim().slice(0, 200);
    const kindRaw = String(g?.kind || '').toLowerCase();
    const kind = TR_KINDS.has(kindRaw) ? kindRaw : 'other';
    const note = String(g?.note || '').trim().slice(0, 200);
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    const key = from.toLowerCase() + '→' + to.toLowerCase();
    if (gSeen.has(key)) continue;
    gSeen.add(key);
    glossary.push({ from, to, kind, note });
  }
  for (const r of Array.isArray(parsed?.review) ? parsed.review : []) {
    const n = Number(r?.n);
    if (!Number.isInteger(n) || !byN.has(n)) continue;
    review.push({
      n, text: byN.get(n),
      issue: String(r.issue || 'Perlu konfirmasi.').slice(0, 400),
      suggestion: String(r.suggestion || 'Mohon periksa maksud kalimat ini.').slice(0, 400),
    });
  }
  return { lines, glossary, review };
}

async function handleTranslate(request, env, origin) {
  if (!originAllowed(env, origin)) {
    return cors(json({ error: 'Origin tidak diizinkan.' }, 403), env, origin);
  }
  try {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return cors(json({ error: 'Content-Type harus application/json.' }, 400), env, origin);
    }
    if (Number(request.headers.get('content-length') || 0) > MAX_EDIT_BODY) {
      return cors(json({ error: 'Payload terlalu besar.' }, 413), env, origin);
    }
    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: 'Body JSON tidak valid.' }, 400), env, origin); }

    const provider = normalizeProvider(body?.provider);
    if (!provider) {
      return cors(json({ error: 'Provider tidak dikenali. Pilih gemini / agnes / cloudflare / sumopod / custom.' }, 400), env, origin);
    }
    if (provider === 'cloudflare') {
      return cors(json({ error: 'Cloudflare AI dipakai khusus OCR. Untuk Terjemahan pilih gemini / agnes / sumopod / custom.' }, 400), env, origin);
    }
    const apiOpts = readApiOpts(body);
    if (provider === 'sumopod') pickSumopodModel(body?.modelId, env);

    const lines = body?.lines;
    if (!Array.isArray(lines) || !lines.length) {
      return cors(json({ error: 'Tidak ada baris untuk diterjemahkan. Kirim "lines": [{n, t}].' }, 400), env, origin);
    }
    if (lines.length > MAX_EDIT_LINES) {
      return cors(json({ error: `Terlalu banyak baris (maks ${MAX_EDIT_LINES} per permintaan).` }, 413), env, origin);
    }
    let total = 0;
    const clean = [];
    for (const l of lines) {
      if (!l || !Number.isInteger(l.n) || l.n < 1 || typeof l.t !== 'string' || l.t.length > MAX_EDIT_LINE_LEN) {
        return cors(json({ error: 'Format baris tidak valid.' }, 400), env, origin);
      }
      if (l.t.trim() === '//') continue; // pemisah balon: struktural, tidak dikirim ke model
      total += l.t.length;
      clean.push({ n: l.n, t: l.t });
    }
    if (total > MAX_EDIT_CHARS) {
      return cors(json({ error: `Teks terlalu panjang (maks ${MAX_EDIT_CHARS} karakter per permintaan).` }, 413), env, origin);
    }
    if (!clean.length) {
      return cors(json({ changes: [], review: [], provider, reqId: null }), env, origin);
    }
    const context = Array.isArray(body?.context)
      ? body.context.filter((s) => typeof s === 'string').slice(-20).map((s) => s.slice(0, MAX_EDIT_LINE_LEN))
      : [];

    // Glosarium yang dikirim hanya istilah yang benar-benar muncul di bagian ini.
    const chunkText = ('\n' + clean.map((l) => l.t).join('\n')).toLowerCase();
    const provided = [];
    const pSeen = new Set();
    for (const g of Array.isArray(body?.glossary) ? body.glossary : []) {
      if (provided.length >= 60) break;
      const from = String(g?.term ?? g?.from ?? '').trim().slice(0, 120);
      const to = String(g?.translation ?? g?.to ?? '').trim().slice(0, 200);
      if (!from || !to) continue;
      const key = from.toLowerCase() + '→' + to.toLowerCase();
      if (pSeen.has(key) || !chunkText.includes(from.toLowerCase())) continue;
      pSeen.add(key);
      provided.push({ from, to, kind: TR_KINDS.has(String(g?.kind || '').toLowerCase()) ? String(g.kind).toLowerCase() : 'other' });
    }
    const glossaryBlock = provided.length
      ? '\n\nGLOSARIUM (WAJIB dipakai bila istilahnya muncul):\n' + provided.map((g) => `- ${g.from} → ${g.to}`).join('\n')
      : '\n\nGLOSARIUM (kosong — buat entri baru bila perlu)';

    const userText =
      'KONTEKS SEBELUMNYA (sudah diterjemahkan, HANYA untuk konsistensi):\n' +
      (context.length ? context.join('\n') : '(kosong, ini awal file)') +
      glossaryBlock +
      '\n\nBAGIAN YANG HARUS DITERJEMAHKAN (format "N| teks"):\n' +
      clean.map((l) => `${l.n}| ${l.t}`).join('\n');

    const system = TRANSLATE_PROMPT + TRANSLATE_PROTOCOL;
    const raw = await runEditText(provider, String(body?.modelId || ''), system, userText, env, apiOpts);
    const parsed = parseEditJson(raw);
    const { lines: outLines, glossary, review } = validateTranslate(clean, parsed);
    const reqId = typeof body?.reqId === 'string' ? body.reqId.slice(0, 64) : null;
    return cors(json({ lines: outLines, glossary, review, provider, reqId }), env, origin);
  } catch (err) {
    console.error('Translate error:', err?.stack || err);
    return cors(json({ error: scrub(String(err?.message || 'Internal server error')).slice(0, 500) }, 500), env, origin);
  }
}

// =====================================================================
// ============ DAFTAR MODEL  (POST /models) ===========================
// Body: { provider, apiKey?, baseUrl? } → mengisi tombol "Muat model".
// Gemini/Agnes/Sumopod/Custom diambil dari API masing-masing (rotasi key).
// Cloudflare statis via allowlist worker (tidak perlu muat).
// =====================================================================
async function handleModels(request, env, origin) {
  if (!originAllowed(env, origin)) {
    return cors(json({ error: 'Origin tidak diizinkan.' }, 403), env, origin);
  }
  try {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return cors(json({ error: 'Content-Type harus application/json.' }, 400), env, origin);
    }
    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: 'Body JSON tidak valid.' }, 400), env, origin); }
    const provider = normalizeProvider(body?.provider);
    if (!provider || provider === 'cloudflare') {
      return cors(json({ error: 'Daftar model: pilih gemini / agnes / sumopod / custom.' }, 400), env, origin);
    }
    const apiOpts = readApiOpts(body);
    let models = [];
    let base = '';
    if (provider === 'gemini') {
      const keys = keyPool(env, 'GEMINI_API_KEY', apiOpts.apiKey);
      const data = await keyRotator('Gemini', keys, async (apiKey) => {
        const resp = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': apiKey } }, 30000);
        if (!resp.ok) throw editHttpError('Gemini', resp.status, await resp.text());
        return resp.json();
      });
      models = (Array.isArray(data?.models) ? data.models : [])
        .filter((m) => (Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods.includes('generateContent') : true))
        .map((m) => ({ id: String(m?.name || '').replace(/^models\//, '') }));
    } else {
      if (provider === 'agnes') base = String(env.AGNES_BASE_URL || DEFAULT_AGNES_BASE).replace(/\/+$/, '');
      else if (provider === 'sumopod') base = sanitizeBaseUrl(apiOpts.baseUrl || env.SUMOPOD_BASE_URL || DEFAULT_SUMOPOD_BASE, 'Sumopod');
      else base = sanitizeBaseUrl(apiOpts.baseUrl || env.CUSTOM_BASE_URL);
      const label = provider === 'agnes' ? 'Agnes' : provider === 'sumopod' ? 'Sumopod' : 'Custom';
      const secretName = provider === 'agnes' ? 'AGNES_API_KEY' : provider === 'sumopod' ? 'SUMOPOD_API_KEY' : 'CUSTOM_API_KEY';
      const keys = keyPool(env, secretName, apiOpts.apiKey);
      const data = await keyRotator(label, keys.length ? keys : [null], async (apiKey) => {
        const headers = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const resp = await fetchWithTimeout(`${base}/models`, { headers }, 30000);
        if (!resp.ok) throw editHttpError(label, resp.status, await resp.text());
        return resp.json();
      });
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
      models = arr
        .map((m) => ({ id: String(m?.id || m?.name || m?.model || '').replace(/^models\//, '') }))
        .filter((m) => m.id);
    }
    const seen = new Set();
    const out = [];
    for (const m of models) {
      const id = m.id.slice(0, 120);
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      out.push({ id });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return cors(json({ ok: true, provider, models: out.slice(0, 300) }), env, origin);
  } catch (err) {
    console.error('Models error:', err?.stack || err);
    return cors(json({ error: scrub(String(err?.message || 'Internal server error')).slice(0, 500) }, 500), env, origin);
  }
}

// =====================================================================
// ==== GLOSARIUM SUPABASE  (GET / POST / DELETE /glossary) ============
// Supabase REST (PostgREST): {SUPABASE_URL}/rest/v1/{table}
// Tabel: id bigserial PK, term text UNIQUE NOT NULL, translation text,
//        kind text, note text, created_at timestamptz (lihat GUIDE.md).
// Tanpa Supabase: GET tetap 200 {source:'none'} → frontend otomatis memakai
// penyimpanan browser; mutasi memberi pesan bila Supabase belum diset.
// =====================================================================
function supabaseCfg(env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_KEY || '').trim();
  if (!/^https:\/\/[a-z0-9.-]+\.supabase\.(co|in)$/.test(url) || !key) return null;
  const table = /^[A-Za-z0-9_]+$/.test(String(env.SUPABASE_TABLE || '').trim()) ? String(env.SUPABASE_TABLE).trim() : 'glossary';
  return { url, key, table };
}

function sanitizeGlossEntry(e) {
  const term = String(e?.term ?? e?.from ?? '').trim().slice(0, 120);
  const translation = String(e?.translation ?? e?.to ?? '').trim().slice(0, 300);
  const kindRaw = String(e?.kind || '').toLowerCase();
  const kind = TR_KINDS.has(kindRaw) ? kindRaw : 'other';
  const note = String(e?.note || '').trim().slice(0, 200);
  if (!term || !translation) return null;
  return { term, translation, kind, note };
}

async function supabaseReq(env, suffix, init = {}) {
  const cfg = supabaseCfg(env);
  if (!cfg) return null;
  const resp = await fetchWithTimeout(`${cfg.url}/rest/v1/${cfg.table}${suffix}`, {
    ...init,
    headers: {
      apikey: cfg.key,
      // Key 2026 (sb_secret_/sb_publishable_) bukan JWT → hanya valid via header `apikey`.
      // Key legacy (eyJ… JWT service_role/anon) → valid via `Authorization: Bearer`.
      ...(cfg.key.startsWith('eyJ') ? { Authorization: `Bearer ${cfg.key}` } : {}),
      ...(init.headers || {}),
    },
  }, 20000);
  return { resp, cfg };
}

// ===== Glosarium per-ruang (workspace) =====
// Kode ruang: 4–64 char [A-Za-z0-9_-]. Beda kode = glosarium terpisah.
// Tanpa kode → 'default' (kompatibel dengan frontend lama yang belum kirim ws).
const WORKSPACE_RE = /^[A-Za-z0-9_-]{4,64}$/;
function glossWorkspace(p) {
  const t = String(p || '').trim();
  if (!t) return 'default';
  return WORKSPACE_RE.test(t) ? t : null;
}
function missingWorkspaceColumn(b) {
  return /PGRST204/i.test(b) || (/workspace/i.test(b) && /does not exist|could not find/i.test(b));
}

async function handleGlossary(request, env, origin) {
  const method = request.method;
  try {
    if (method !== 'GET' && !originAllowed(env, origin)) {
      return cors(json({ error: 'Origin tidak diizinkan.' }, 403), env, origin);
    }
    if (!supabaseCfg(env)) {
      if (method === 'GET') return cors(json({ ok: true, source: 'none', entries: [] }), env, origin);
      return cors(json({ error: 'Glosarium Supabase belum dikonfigurasi (env SUPABASE_URL & SUPABASE_SERVICE_KEY). Sementara glosarium tersimpan di browser ini saja.' }, 501), env, origin);
    }

    if (method === 'GET') {
      const q = new URL(request.url);
      const ws = glossWorkspace(q.searchParams.get('ws') || 'default');
      if (!ws) {
        return cors(json({ error: 'Kode ruang glosarium tidak valid: pakai 4–64 huruf/angka/underskor.' }, 400), env, origin);
      }
      const { resp, cfg } = await supabaseReq(env, `?select=id,term,translation,kind,note&workspace=eq.${encodeURIComponent(ws)}&order=term.asc&limit=2000`, {});
      if (resp.status === 404) {
        return cors(json({ error: `Supabase tabel "${cfg.table}" belum ada — jalankan SQL setup dari GUIDE.md dulu.` }, 502), env, origin);
      }
      if (!resp.ok) {
        const b = scrub((await resp.text()).slice(0, 300));
        if (missingWorkspaceColumn(b)) {
          return cors(json({ error: 'Kolom "workspace" belum ada di tabel glosarium — jalankan SQL upgrade (GUIDE.md bagian 2.1b) dulu.' }, 502), env, origin);
        }
        return cors(json({ error: `Supabase gagal membaca glosarium (${resp.status}): ${b}` }, 502), env, origin);
      }
      const data = await resp.json().catch(() => []);
      const entries = (Array.isArray(data) ? data : [])
        .map((e) => ({
          id: e?.id ?? null,
          term: String(e?.term || ''),
          translation: String(e?.translation || ''),
          kind: TR_KINDS.has(String(e?.kind || '').toLowerCase()) ? String(e.kind).toLowerCase() : 'other',
          note: String(e?.note || ''),
        }))
        .filter((e) => e.term);
      return cors(json({ ok: true, source: 'supabase', workspace: ws, table: cfg.table, entries }), env, origin);
    }

    if (method === 'POST') {
      const ct = request.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return cors(json({ error: 'Content-Type harus application/json.' }, 400), env, origin);
      }
      let body;
      try { body = await request.json(); }
      catch { return cors(json({ error: 'Body JSON tidak valid.' }, 400), env, origin); }
      const ws = glossWorkspace(body?.workspace || body?.ws || 'default');
      if (!ws) {
        return cors(json({ error: 'Kode ruang glosarium tidak valid: pakai 4–64 huruf/angka/underskor.' }, 400), env, origin);
      }
      const mode = String(body?.mode || 'merge').toLowerCase() === 'replace' ? 'replace' : 'merge';
      const list = (Array.isArray(body?.entries) ? body.entries : []).map(sanitizeGlossEntry).filter(Boolean);
      if (!list.length) {
        return cors(json({ error: 'Tidak ada entri glosarium yang valid (butuh term + translation).' }, 400), env, origin);
      }
      if (list.length > 500) {
        return cors(json({ error: 'Terlalu banyak entri sekaligus (maks 500).' }, 413), env, origin);
      }
      if (mode === 'replace') {
        const del = await supabaseReq(env, `?workspace=eq.${encodeURIComponent(ws)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        if (!del.resp.ok) {
          const b = scrub((await del.resp.text()).slice(0, 300));
          if (missingWorkspaceColumn(b)) {
            return cors(json({ error: 'Kolom "workspace" belum ada di tabel glosarium — jalankan SQL upgrade (GUIDE.md bagian 2.1b) dulu.' }, 502), env, origin);
          }
          return cors(json({ error: `Supabase gagal mengosongkan ruang (${del.resp.status}): ${b}` }, 502), env, origin);
        }
      }
      const rows = list.map((e) => ({ ...e, workspace: ws }));
      let { resp } = await supabaseReq(env, '?on_conflict=workspace,term', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
      if (!resp.ok) {
        const b = scrub((await resp.text()).slice(0, 300));
        if (missingWorkspaceColumn(b)) {
          return cors(json({ error: 'Kolom "workspace" belum ada di tabel glosarium — jalankan SQL upgrade (GUIDE.md bagian 2.1b) dulu.' }, 502), env, origin);
        }
        if (/constraint matching/i.test(b)) {
          // Fallback schema lama (unique di kolom.term)
          ({ resp } = await supabaseReq(env, '?on_conflict=term', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rows),
          }));
        }
      }
      if (!resp.ok) {
        const b = scrub((await resp.text()).slice(0, 300));
        if (/relation|column|does not exist/i.test(b)) {
          return cors(json({ error: `Supabase menolak (tabel/kolom belum sesuai): ${b} — jalankan SQL setup dari GUIDE.md.` }, 502), env, origin);
        }
        return cors(json({ error: `Supabase gagal menyimpan glosarium (${resp.status}): ${b}` }, 502), env, origin);
      }
      return cors(json({ ok: true, source: 'supabase', workspace: ws, mode, merged: list.length }), env, origin);
    }

    if (method === 'DELETE') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const ws = glossWorkspace(body?.workspace || body?.ws || 'default');
      if (!ws) {
        return cors(json({ error: 'Kode ruang glosarium tidak valid: pakai 4–64 huruf/angka/underskor.' }, 400), env, origin);
      }
      const wsf = `workspace=eq.${encodeURIComponent(ws)}`;
      let filter = '';
      if (body?.all === true) filter = `?${wsf}`;
      else if (body?.term != null && String(body.term).trim()) filter = `?${wsf}&term=eq.${encodeURIComponent(String(body.term).trim().slice(0, 120))}`;
      else if (body?.id != null && (Number.isInteger(body.id) || /^\d+$/.test(String(body.id)))) filter = `?${wsf}&id=eq.${Number(body.id)}`;
      else return cors(json({ error: 'DELETE butuh target: {term}, {id}, atau {all:true}.' }, 400), env, origin);
      const { resp } = await supabaseReq(env, filter, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      if (!resp.ok) {
        const b = scrub((await resp.text()).slice(0, 300));
        if (missingWorkspaceColumn(b)) {
          return cors(json({ error: 'Kolom "workspace" belum ada di tabel glosarium — jalankan SQL upgrade (GUIDE.md bagian 2.1b) dulu.' }, 502), env, origin);
        }
        return cors(json({ error: `Supabase gagal menghapus (${resp.status}): ${b}` }, 502), env, origin);
      }
      return cors(json({ ok: true, source: 'supabase', workspace: ws }), env, origin);
    }

    return cors(json({ error: 'Metode tidak didukung.' }, 405), env, origin);
  } catch (err) {
    console.error('Glossary error:', err?.stack || err);
    return cors(json({ error: scrub(String(err?.message || 'Internal server error')).slice(0, 500) }, 500), env, origin);
  }
}

async function handleEdit(request, env, origin) {
  if (!originAllowed(env, origin)) {
    return cors(json({ error: 'Origin tidak diizinkan.' }, 403), env, origin);
  }
  try {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return cors(json({ error: 'Content-Type harus application/json.' }, 400), env, origin);
    }
    if (Number(request.headers.get('content-length') || 0) > MAX_EDIT_BODY) {
      return cors(json({ error: 'Payload terlalu besar.' }, 413), env, origin);
    }
    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: 'Body JSON tidak valid.' }, 400), env, origin); }

    const provider = normalizeProvider(body?.provider ?? body?.model);
    if (!provider) {
      return cors(json({ error: 'Provider tidak dikenali. Pilih gemini / agnes / cloudflare / sumopod / custom.' }, 400), env, origin);
    }

    // Sumopod TIDAK diblok keras untuk OCR: docs resmi Sumopod bilang "text only",
    // tapi katalognya bisa berubah dan sebagian model proxy bisa saja menerima gambar.
    // Percobaan vision tetap dikirim (untuk SUMOPOD_CASE di bawah); bila model menolak,
    // runSumopodVision() sudah memformat pesan error yang jelas.
    const modelId = String(body?.modelId || '').trim().slice(0, 120);
    const reqId = typeof body?.reqId === 'string' ? body.reqId.slice(0, 64) : null;
    const apiOpts = readApiOpts(body);

    const lines = body?.lines;
    if (!Array.isArray(lines) || !lines.length) {
      return cors(json({ error: 'Tidak ada baris untuk disunting. Kirim "lines": [{n, t}].' }, 400), env, origin);
    }
    if (lines.length > MAX_EDIT_LINES) {
      return cors(json({ error: `Terlalu banyak baris (maks ${MAX_EDIT_LINES} per permintaan).` }, 413), env, origin);
    }
    let total = 0;
    const clean = [];
    for (const l of lines) {
      if (!l || !Number.isInteger(l.n) || l.n < 1 || typeof l.t !== 'string' || l.t.length > MAX_EDIT_LINE_LEN) {
        return cors(json({ error: 'Format baris tidak valid.' }, 400), env, origin);
      }
      if (l.t.trim() === '//') continue; // pemisah balon: struktural, tidak dikirim ke model
      total += l.t.length;
      clean.push({ n: l.n, t: l.t });
    }
    if (total > MAX_EDIT_CHARS) {
      return cors(json({ error: `Teks terlalu panjang (maks ${MAX_EDIT_CHARS} karakter per permintaan).` }, 413), env, origin);
    }
    if (!clean.length) {
      return cors(json({ lines: [], glossary: [], review: [], provider, reqId: null }), env, origin);
    }
    const context = Array.isArray(body?.context)
      ? body.context.filter((s) => typeof s === 'string').slice(-20).map((s) => s.slice(0, MAX_EDIT_LINE_LEN))
      : [];

    const userText =
      'KONTEKS SEBELUMNYA (sudah selesai disunting, JANGAN disunting lagi):\n' +
      (context.length ? context.join('\n') : '(kosong, ini awal file)') +
      '\n\nBAGIAN YANG HARUS DISUNTING (format "N| teks"):\n' +
      clean.map((l) => `${l.n}| ${l.t}`).join('\n');

    const system = EDIT_PROMPT + EDIT_PROTOCOL;
    const raw = await runEditText(provider, modelId, system, userText, env, apiOpts);
    const parsed = parseEditJson(raw);
    const { changes, review } = validateEdits(clean, parsed);
    return cors(json({ changes, review, provider, reqId }), env, origin);
  } catch (err) {
    console.error('Edit error:', err?.stack || err);
    return cors(json({ error: scrub(String(err?.message || 'Internal server error')).slice(0, 500) }, 500), env, origin);
  }
}

// ---------- penyedia (teks saja) ----------
async function runEditText(provider, modelId, system, userText, env, opts = {}) {
  if (provider === 'gemini') return editGemini(system, userText, pickGeminiModel(modelId, env, opts.apiKey), env, opts);
  if (provider === 'agnes') return editAgnes(system, userText, pickAgnesModel(modelId, env, opts.apiKey), env, opts);
  if (provider === 'sumopod') return editSumopod(system, userText, pickSumopodModel(modelId, env), env, opts);
  if (provider === 'custom') return editCustom(system, userText, String(modelId || env.CUSTOM_MODEL || '').slice(0, 120), env, opts);
  return editCloudflare(system, userText, pickCfModel(modelId, env), env);
}

function editHttpError(who, status, bodyText) {
  const b = scrub(String(bodyText).slice(0, 400));
  if (status === 429) return keyErr(`Limit ${who} habis (429) di key ini. Tunggu / pakai key lain. Detail: ${b}`);
  if (status === 401 || status === 403) return keyErr(`API key ${who} ditolak (401/403) di key ini. Detail: ${b}`);
  if (b.includes('User location is not supported') || b.includes('not supported for the API use')) {
    return new Error('Gemini diblokir di region server saat ini. Ganti provider ke Agnes AI atau Cloudflare AI.');
  }
  return new Error(`${who} error ${status}: ${b}`);
}

async function editGemini(system, userText, modelName, env, opts = {}) {
  const keys = keyPool(env, 'GEMINI_API_KEY', opts.apiKey);
  return keyRotator('Gemini', keys, async (apiKey) => {
    const resp = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: 'application/json' },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
          ],
        }),
      }, 90000);
    if (!resp.ok) throw editHttpError('Gemini', resp.status, await resp.text());
    const data = await resp.json();
    if (data?.promptFeedback?.blockReason) {
      throw new Error(`Gemini menolak teks (${data.promptFeedback.blockReason}). Coba model lain atau provider lain.`);
    }
    const cand = data?.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
    if (!text) {
      const fr = cand?.finishReason;
      if (fr && fr !== 'STOP') throw new Error(`Gemini tidak menghasilkan jawaban (${fr}). Coba model lain.`);
      throw new Error('Gemini mengembalikan jawaban kosong. Coba lagi.');
    }
    return text;
  });
}

async function editAgnes(system, userText, modelName, env, opts = {}) {
  const keys = keyPool(env, 'AGNES_API_KEY', opts.apiKey);
  const base = (env.AGNES_BASE_URL || DEFAULT_AGNES_BASE).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('AGNES_BASE_URL harus diawali https://');
  return keyRotator('Agnes', keys, async (apiKey) => {
    const resp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelName, temperature: 0.3, max_tokens: 8192,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
      }),
    }, 90000);
    if (!resp.ok) throw editHttpError('Agnes', resp.status, await resp.text());
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const text = (typeof choice?.message?.content === 'string' ? choice.message.content : '').trim();
    if (!text) {
      if (choice?.finish_reason === 'content_filter') throw new Error('Agnes memblokir teks (content_filter). Coba model lain.');
      throw new Error('Agnes mengembalikan jawaban kosong. Coba lagi.');
    }
    return text;
  });
}

// Sumopod (OpenAI-compatible, https://ai.sumopod.com/v1 — teks saja, tanpa gambar)
async function editSumopod(system, userText, model, env, opts = {}) {
  const base = sanitizeBaseUrl(opts.baseUrl || env.SUMOPOD_BASE_URL || DEFAULT_SUMOPOD_BASE, 'Sumopod');
  const keys = keyPool(env, 'SUMOPOD_API_KEY', opts.apiKey);
  return keyRotator('Sumopod', keys, async (apiKey) => {
    const resp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 8192,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
      }),
    }, 90000);
    if (!resp.ok) throw editHttpError('Sumopod', resp.status, await resp.text());
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const text = (typeof choice?.message?.content === 'string' ? choice.message.content : '').trim();
    if (!text) {
      if (choice?.finish_reason === 'content_filter') throw new Error('Sumopod memblokir teks (content_filter). Coba model lain.');
      throw new Error('Sumopod mengembalikan jawaban kosong. Coba lagi.');
    }
    return text;
  });
}

// Sumopod — percobaan OCR (vision). Klaim resmi docs Sumopod (update 4 Nov 2026):
// "Sumopod models can generate text only". Tapi user bisa mencoba model vision-nya
// sendiri; kalau endpoint/model menolak gambar, di sini pesannya dibuat jelas.
async function runSumopodVision(base64Data, mimeType, modelName, env, opts = {}) {
  const base = sanitizeBaseUrl(opts.baseUrl || env.SUMOPOD_BASE_URL || DEFAULT_SUMOPOD_BASE, 'Sumopod');
  const keys = keyPool(env, 'SUMOPOD_API_KEY', opts.apiKey);
  if (!keys.length) {
    throw new Error('Sumopod: belum ada API key — set Secret SUMOPOD_API_KEY di Worker atau isi key di Pengaturan (tab Sumopod).');
  }
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  return keyRotator('Sumopod', keys, async (apiKey) => {
    const resp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.1,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM_SHORT },
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    }, 60000);
    if (!resp.ok) {
      const b = scrub((await resp.text()).slice(0, 400));
      if (resp.status === 429) throw keyErr(`Sumopod limit (429) di key ini. Detail: ${b}`);
      if (resp.status === 401 || resp.status === 403) throw keyErr(`API key Sumopod ditolak (401/403) di key ini. Detail: ${b}`);
      if (/image|vision|multimodal/i.test(b)) {
        throw new Error(`Model Sumopod "${modelName}" menolak input gambar — klaim resmi Sumopod: hanya teks. Pakai Gemini / Agnes / Cloudflare untuk OCR, atau coba model lain di Sumopod. Detail: ${b}`);
      }
      throw new Error(`Sumopod error ${resp.status}: ${b}`);
    }
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const text = (typeof choice?.message?.content === 'string' ? choice.message.content : '').trim();
    if (!text) {
      if (choice?.finish_reason === 'content_filter') throw new Error('Sumopod memblokir gambar (content_filter). Coba model lain.');
      return '# NO TEXT DETECTED';
    }
    if (!looksLikeOcr(text)) {
      throw new Error(refusalHint('Sumopod', text));
    }
    return text;
  });
}

// Custom text (OpenAI-compatible, tanpa gambar)
async function editCustom(system, userText, model, env, opts = {}) {
  const base = sanitizeBaseUrl(opts.baseUrl || env.CUSTOM_BASE_URL);
  const keys = keyPool(env, 'CUSTOM_API_KEY', opts.apiKey);
  return keyRotator('Custom', keys.length ? keys : [null], async (apiKey) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: String(model || '').slice(0, 120), temperature: 0.3, max_tokens: 8192,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
      }),
    }, 90000);
    if (!resp.ok) throw editHttpError('Custom', resp.status, await resp.text());
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const text = (typeof choice?.message?.content === 'string' ? choice.message.content : '').trim();
    if (!text) {
      if (choice?.finish_reason === 'content_filter') throw new Error('Custom API memblokir teks (content_filter). Coba model lain.');
      throw new Error('Custom API mengembalikan jawaban kosong. Coba lagi.');
    }
    return text;
  });
}

async function editCloudflare(system, userText, preferredModel, env) {
  if (!env.AI) throw new Error('Binding AI belum aktif. Cek wrangler.toml [ai].');
  const ordered = [preferredModel, ...CF_VISION_MODELS.filter((m) => m !== preferredModel)];
  let lastError = null;
  for (const name of ordered) {
    try {
      const resp = await env.AI.run(name, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
        max_tokens: 4096, temperature: 0.3,
      });
      const t = stripThink(extractCfText(resp)).trim();
      if (t) return t;
    } catch (e) { lastError = e; console.warn(`CF ${name} gagal:`, e?.message); }
  }
  throw new Error(lastError
    ? `Cloudflare AI gagal: ${scrub(String(lastError.message || lastError)).slice(0, 300)}`
    : 'Cloudflare AI mengembalikan jawaban kosong. Coba lagi.');
}

// ---------- parsing & validasi ----------
function parseEditJson(raw) {
  let s = stripThink(raw).trim();
  s = s.replace(/^```[\w-]*\s*/i, '').replace(/```\s*$/i, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) {
    throw new Error('Jawaban model bukan JSON yang valid (mungkin terpotong). Klik Coba lagi atau ganti model.');
  }
  try {
    const obj = JSON.parse(s.slice(a, b + 1));
    if (!obj || typeof obj !== 'object') throw new Error('bukan objek');
    return obj;
  } catch {
    throw new Error('Jawaban model bukan JSON yang valid (mungkin terpotong). Klik Coba lagi atau ganti model.');
  }
}

const PAGE_RE = /^\s*P\d+\s*$/i;
const NOTE_RE = /^\s*(?:[-*#\/<>\[\]()]*\s*)?(?:note\s*(?:tl|tn)|catatan\s*(?:tl|tn)|catatan\s*:)/i;
const MARKER_RE = /^\s*(?:\*\*|\*|\/\/|\[\]|<>|\(\)|#|-|Sfx(?= ))?[ \t]*/;

function digitTokens(s) { return (s.match(/\d+(?:[.,]\d+)?/g) || []).join('|'); }

// Mengembalikan alasan penolakan (string) atau '' bila perubahan aman.
function editProblem(before, after) {
  if (PAGE_RE.test(before)) return 'baris nomor halaman tidak boleh diubah';
  if (NOTE_RE.test(before)) return 'catatan TL/TN harus disalin persis';
  if (/[\r\n]/.test(after)) return 'memecah satu baris menjadi beberapa baris';
  if (!after.trim()) return 'baris menjadi kosong';

  const prefix = before.match(MARKER_RE)[0];
  if (!after.startsWith(prefix)) return 'penanda atau indentasi di awal baris berubah';
  const b = before.slice(prefix.length), a = after.slice(prefix.length);
  if (!a.trim()) return 'isi baris hilang';

  const wrap = { '[': ']', '<': '>', '(': ')' }[b.trim()[0]];
  if (wrap && b.trim().endsWith(wrap) && !(a.trim().startsWith(b.trim()[0]) && a.trim().endsWith(wrap))) {
    return 'tanda kurung pembungkus berubah';
  }
  const tail = (b.match(/[.…?!]+$/) || [''])[0];
  if ((/[…?!]/.test(tail) || /\.{2,}/.test(tail)) && !a.endsWith(tail)) {
    return 'tanda baca penutup (elipsis/tanya/seru) berubah';
  }
  if (digitTokens(b) !== digitTokens(a)) return 'angka berubah';
  if (b.length > 20 && (a.length > b.length * 2.5 + 40 || a.length < b.length * 0.3)) {
    return 'panjang kalimat berubah drastis (informasi mungkin hilang atau bertambah)';
  }
  return '';
}

function validateEdits(lines, parsed) {
  const orig = new Map(lines.map((l) => [l.n, l.t]));
  const changes = [], review = [], seen = new Set();

  for (const c of Array.isArray(parsed.changes) ? parsed.changes : []) {
    const n = Number(c?.n);
    if (!Number.isInteger(n) || !orig.has(n) || typeof c?.after !== 'string' || seen.has(n)) continue;
    seen.add(n);
    const before = orig.get(n);
    // model kadang ikut menulis awalan "N| "
    const after = c.after.replace(new RegExp(`^${n}\\|[ ]?`), '');
    if (after === before) continue;
    const problem = editProblem(before, after);
    if (problem) {
      review.push({
        n, text: before,
        issue: `Perubahan otomatis ditolak karena ${problem}. Usulan model: "${after.slice(0, 300)}"`,
        suggestion: 'Periksa dan sunting manual bila perlu.',
      });
      continue;
    }
    changes.push({ n, after, reason: String(c.reason || '').slice(0, 300).trim() || 'Penyuntingan kalimat agar lebih natural.' });
  }
  for (const r of Array.isArray(parsed.review) ? parsed.review : []) {
    const n = Number(r?.n);
    if (!Number.isInteger(n) || !orig.has(n) || seen.has(n)) continue;
    review.push({
      n, text: orig.get(n),
      issue: String(r.issue || 'Perlu konfirmasi.').slice(0, 400),
      suggestion: String(r.suggestion || 'Mohon konfirmasi maksud kalimat ini.').slice(0, 400),
    });
  }
  changes.sort((x, y) => x.n - y.n);
  review.sort((x, y) => x.n - y.n);
  return { changes, review };
}

