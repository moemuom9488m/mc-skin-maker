// Cloud Run proxy: holds the Google credentials and calls a Nano Banana image model for the skin page.
// Auth: GEMINI_API_KEY (AI Studio key) if set, otherwise Vertex AI with the Cloud Run service account.
import http from 'node:http';

const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || 'gemini-3.1-flash-image';
const API_KEY = process.env.GEMINI_API_KEY || '';
const LOCATION = process.env.VERTEX_LOCATION || 'global';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const RATE_PER_HOUR = Number(process.env.RATE_PER_HOUR || 20);
const MAX_BODY = 8 * 1024 * 1024;

const STYLE_TEXT = {
  classic: 'regular Minecraft player look wearing their own clothes',
  diamond: 'wearing a full set of Minecraft diamond armor (cyan helmet, chestplate, leggings, boots) with the face still visible under the helmet',
  creeper: 'wearing a green pixel-camouflage Creeper hoodie and green clothes',
  enderman: 'Enderman-inspired: very dark black-purple clothing, glowing purple eyes accent',
  zombie: 'Minecraft Zombie look: green-tinted skin, cyan shirt, blue-purple pants',
  skeleton: 'Minecraft Skeleton look: light grey bone colors, visible ribs on the chest',
  netherknight: 'wearing dark Netherite armor with gold trim',
  knight: 'medieval knight in iron armor with a red tabard and a gold cross on the chest',
  dragon: 'Ender Dragon themed: black scaly armor with purple accents',
  hero: 'pixel superhero: bright saturated outfit, gold chest emblem and belt, red boots',
};

function buildPrompt(style, desc) {
  return [
    'Turn the person in this photo into one Minecraft player character.',
    'Front view, standing straight and facing the camera, arms straight down at the sides, legs together, full body from the top of the head to the feet visible and centered.',
    'Exact Minecraft proportions: a cube head, a rectangular torso, straight block arms and legs (head 8, torso 12, legs 12 units tall).',
    'Flat pixel-art texture with clearly visible square pixels, no anti-aliasing, no outlines, no text, no logo.',
    'Keep the person recognizable on the front of the cube head: hairstyle and hair color, skin tone, eye color, glasses or facial hair if present. Keep their clothing colors on the torso, arms and legs.',
    `Style: ${STYLE_TEXT[style] || STYLE_TEXT.classic}.`,
    desc ? `Extra request from the user: ${desc}` : '',
    'Plain flat light grey background (#d9d9d9), no shadow, no scenery, portrait 3:4 framing.',
  ].filter(Boolean).join('\n');
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= RATE_PER_HOUR) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list); return false;
}

async function metadata(path) {
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/' + path, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error('metadata ' + r.status);
  return r.text();
}

async function callModel(body) {
  let url, headers = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    headers['x-goog-api-key'] = API_KEY;
  } else {
    const project = process.env.GOOGLE_CLOUD_PROJECT || await metadata('project/project-id');
    const { access_token } = JSON.parse(await metadata('instance/service-accounts/default/token'));
    const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
    url = `https://${host}/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
    headers.Authorization = `Bearer ${access_token}`;
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(150e3) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('model error', r.status, JSON.stringify(j).slice(0, 800));
    throw Object.assign(new Error(r.status === 429 ? 'AI 用量已達上限，請稍後再試。' : `模型呼叫失敗（${r.status}）`), { status: 502 });
  }
  const cand = j.candidates?.[0];
  const part = cand?.content?.parts?.find(p => p.inlineData || p.inline_data);
  if (!part) {
    const reason = cand?.finishReason || j.promptFeedback?.blockReason || 'NO_IMAGE';
    console.error('no image', reason);
    throw Object.assign(new Error(`模型沒有回傳圖片（${reason}），請換一張照片或修改描述。`), { status: 422 });
  }
  const d = part.inlineData || part.inline_data;
  return { image: d.data, mime: d.mimeType || d.mime_type || 'image/png' };
}

function send(res, status, obj, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const reqOrigin = req.headers.origin || '';
  const origin = ORIGINS.length === 0 ? '*' : (ORIGINS.includes(reqOrigin) ? reqOrigin : '');

  if (req.method === 'OPTIONS') {
    res.writeHead(origin ? 204 : 403, origin ? {
      'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-access-code',
      'Access-Control-Max-Age': '3600',
    } : {});
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, model: MODEL, auth: API_KEY ? 'gemini-api' : 'vertex' }, origin);
  if (req.method !== 'POST' || req.url !== '/api/stylize') return send(res, 404, { error: 'not found' }, origin);
  if (ORIGINS.length && !origin) return send(res, 403, { error: '這個網站沒有使用權限。' }, '');
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: '存取碼不正確。' }, origin);

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rateLimited(ip)) return send(res, 429, { error: `每小時最多 ${RATE_PER_HOUR} 次，請稍後再試。` }, origin);

  try {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { error: '圖片太大，請換一張較小的照片。' }, origin); chunks.push(c); }
    const { image, mime = 'image/jpeg', style = 'classic', desc = '' } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof image !== 'string' || !image) return send(res, 400, { error: '缺少圖片。' }, origin);
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return send(res, 400, { error: '只接受 JPG、PNG、WebP。' }, origin);

    const out = await callModel({
      contents: [{ role: 'user', parts: [
        { text: buildPrompt(String(style), String(desc).slice(0, 300)) },
        { inline_data: { mime_type: mime, data: image } },
      ] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } },
    });
    send(res, 200, out, origin);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : '伺服器發生錯誤，請稍後再試。' }, origin);
  }
}).listen(PORT, () => console.log(`skin proxy on :${PORT} model=${MODEL} auth=${API_KEY ? 'gemini-api' : 'vertex'}`));
