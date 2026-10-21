// Cloud Run proxy: holds the Google credentials and calls a Nano Banana image model for the skin page.
// Auth: GEMINI_API_KEY (AI Studio key) if set, otherwise Vertex AI with the Cloud Run service account.
import http from 'node:http';

const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || 'gemini-3.1-flash-image';
const REVIEW_MODEL = process.env.REVIEW_MODEL || 'gemini-2.5-flash';
const LOCATE_MODEL = process.env.LOCATE_MODEL || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY || '';
const LOCATION = process.env.VERTEX_LOCATION || 'global';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const RATE_PER_HOUR = Number(process.env.RATE_PER_HOUR || 40);
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

// subject 'animal': a pet photo becomes an upright blocky humanoid covered in its own fur
const ANIMAL_CLASSIC = "no clothes: the whole body shows only the animal's own fur colors and markings";

function buildPrompt(style, desc, fix, subject) {
  const animal = subject === 'animal';
  const styleText = animal && (style === 'classic' || !STYLE_TEXT[style]) ? ANIMAL_CLASSIC : (STYLE_TEXT[style] || STYLE_TEXT.classic);
  return [
    animal
      ? 'Turn the animal in this photo into one Minecraft player character (an upright blocky humanoid standing on two legs) and draw a character reference sheet with exactly two full-body views of that same character side by side:'
      : 'Turn the person in this photo into one Minecraft player character and draw a character reference sheet with exactly two full-body views of that same character side by side:',
    'LEFT half: FRONT view, facing the camera. RIGHT half: BACK view, seen from directly behind. Same size and same height in both views, feet on the same baseline, each figure centered in its half, nothing else on the canvas.',
    'In both views the character stands straight with arms straight down at the sides and legs together, full body from the top of the head to the feet visible.',
    // In Minecraft a held item is rendered separately, so it must not end up baked into the skin
    'Empty hands: leave out anything the character holds or carries in the photo (weapons, staffs, swords, shields, bags, phones, toys); do not draw it anywhere, and draw the hands and arms that it covered.',
    animal
      ? 'Whatever pose the animal is in, draw the character facing the camera directly, and invent any fur pattern the photo does not show so it matches the visible markings.'
      : 'If the photo is taken at an angle, in profile, from above or below, or shows only part of the body, rotate the person to face the camera directly, reconstruct the hidden side of the face symmetrically, and invent the missing body parts to match their outfit.',
    animal
      ? 'The photo may not show the back, so invent a back view that matches: the back of the head with the ears, and the fur colors and markings of the back.'
      : 'The photo never shows the back, so invent a back view that matches: the back of the hairstyle, the back of the same clothes, the back of the shoes.',
    'Exact Minecraft proportions: a cube head, a rectangular torso, straight block arms and legs (head 8, torso 12, legs 12 units tall).',
    'Draw it at the exact resolution of a 64x64 Minecraft skin, using big square texels of one equal size everywhere: the head front is exactly 8x8 texels, the torso 8x12, each arm 4x12 and each leg 4x12. If the subject has a slim, slender build, use the slim Minecraft model instead: each arm only 3 texels wide (3x12), everything else unchanged. Every texel is one flat colour; no detail finer than one texel (eyes, eyebrows and mouth are whole texels), like a real Minecraft player model seen in game.',
    'Flat pixel-art texture with clearly visible square pixels, no anti-aliasing, no gradients, no outlines, no text, no logo.',
    animal
      ? 'Keep the animal recognizable: its face (eye color, nose, muzzle, whisker marks) on the front of the cube head, its ears painted flat as pixels inside the head cube (nothing sticking out of the cubes), and its exact fur colors and markings on the torso, arms and legs, with paws at the ends of the arms and legs.'
      : 'Keep the person recognizable on the front of the cube head: hairstyle and hair color, skin tone, eye color, glasses or facial hair if present. Keep their clothing colors on the torso, arms and legs.',
    `Style: ${styleText}.`,
    desc ? `Extra request from the user: ${desc}` : '',
    fix ? `A quality check of the previous attempt asked for this correction: ${fix}` : '',
    // Animals are often grey or white, so they get a background colour no fur has
    animal
      ? 'Plain flat magenta background (#ff00ff), no shadow, no scenery, landscape 3:2 canvas. Do not write any text, letters or words anywhere (no \"FRONT\" or \"BACK\" labels).'
      : 'Plain flat light grey background (#d9d9d9), no shadow, no scenery, landscape 3:2 canvas. Do not write any text, letters or words anywhere (no \"FRONT\" or \"BACK\" labels).',
  ].filter(Boolean).join('\n');
}

// Kept in sync with reviewPrompt() in src/page.html
function reviewPrompt(colors, isAi, hasPhoto, style, subject) {
  const animal = subject === 'animal';
  return [
    'You are the quality checker for an automatic Minecraft skin generator.',
    animal
      ? `Image 1: the source picture the skin was sampled from${isAi ? ' (an AI-drawn Minecraft-style figure based on an animal)' : " (the user's photo)"}. The yellow box marks where the 8x8 face texture was sampled; it should cover the front of the character's cube head, ears included.`
      : `Image 1: the source picture the skin was sampled from${isAi ? ' (an AI-drawn Minecraft-style figure)' : " (the user's photo)"}. The yellow square marks where the 8x8 face texture was sampled; it should tightly cover the character's face from the top of the forehead (including a hair fringe) to the chin, centered on the face.`,
    'Image 2: the generated result on a grey background: front view, back view, and the raw 64x64 skin texture.',
    hasPhoto ? `Image 3: the ${animal ? "animal's" : "person's"} original photo, for identity reference.` : '',
    `Selected style: ${style}. Current colors: ${JSON.stringify(colors)}.`,
    animal
      ? 'Check: (1) is the yellow box on the head; (2) do the fur colors and markings in the skin match the source; (3) is the face readable (eyes visible, not a smear) and does it resemble the animal; (4) is image 1 a clean front-facing blocky figure (not turned to the side, not cropped, not a pasted photo).'
      : 'Check: (1) is the yellow square on the face; (2) are the skin, hair, shirt, pants and shoes colors right compared with the source; (3) is the face readable (eyes visible, not a smear) and does it resemble the person; (4) is image 1 a clean front-facing figure (not turned to the side, not in profile, not cropped).',
    // In Minecraft held items are rendered separately, so one drawn into the AI figure must not reach the skin
    isAi ? 'Also check (5): does the figure in image 1 hold or carry anything (weapon, staff, sword, shield, bag, phone, toy)? A held item must not be part of a skin; parts of the costume itself (armor, claws, a cape) are not held items.' : '',
    `Reply with only JSON: {"score": integer 1-10, "issues": [up to 5 short sentences in Traditional Chinese], "face_box": [ymin, xmin, ymax, xmax] of the ${animal ? 'head front' : 'face'} in image 1 on a 0-1000 scale, "colors": ${animal ? '{} (always empty for animals)' : '{only the keys among skin, hair, shirt, pants, shoes whose color is clearly wrong, as "#rrggbb"}'}, ${isAi ? '"held_item": "short name in Traditional Chinese of the item the figure holds, or an empty string if it holds nothing, never a word such as 空 or none", ' : ''}"regenerate": true only if image 1 itself is unusable (angled or profile view, cropped, wrong proportions, face unrecognizable${animal ? ', a pasted photo instead of pixel art' : ''}), "regenerate_hint": "short English instruction for the image model to fix it, or empty"}`,
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

async function gemini(model, body) {
  let url, headers = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    headers['x-goog-api-key'] = API_KEY;
  } else {
    const project = process.env.GOOGLE_CLOUD_PROJECT || await metadata('project/project-id');
    const { access_token } = JSON.parse(await metadata('instance/service-accounts/default/token'));
    const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
    url = `https://${host}/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;
    headers.Authorization = `Bearer ${access_token}`;
  }
  // 429/503 on the preview image models is shared-capacity pressure, not our quota, and usually clears in a few
  // seconds: retry up to twice with a short, jittered wait (Retry-After if given, capped) before giving up
  let r, j;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(150e3) });
    j = await r.json().catch(() => ({}));
    if (r.ok || (r.status !== 429 && r.status !== 503) || attempt >= 2) break;
    const ra = Number(r.headers.get('retry-after'));
    const wait = Math.min(8000, (ra > 0 ? ra * 1000 : 2500 * (attempt + 1)) + Math.random() * 700);
    console.error('model busy, retrying', model, r.status, `attempt ${attempt + 1}`, `wait ${Math.round(wait)}ms`);
    await new Promise(res => setTimeout(res, wait));
  }
  if (!r.ok) {
    console.error('model error', model, r.status, JSON.stringify(j).slice(0, 800));
    throw Object.assign(new Error(r.status === 429 ? 'AI 用量已達上限，請稍後再試。' : `模型呼叫失敗（${r.status}）`), { status: 502 });
  }
  return j;
}

async function review(body) {
  const parts = [
    { text: reviewPrompt(body.colors || {}, !!body.ai, !!body.photo, String(body.style || 'classic'), body.subject === 'animal' ? 'animal' : 'person') },
    { inline_data: { mime_type: 'image/jpeg', data: body.source } },
    { inline_data: { mime_type: 'image/png', data: body.result } },
  ];
  if (body.photo) parts.push({ inline_data: { mime_type: 'image/jpeg', data: body.photo } });
  const j = await gemini(REVIEW_MODEL, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  try { return JSON.parse(text); }
  catch { console.error('review not json', text.slice(0, 300)); throw Object.assign(new Error('審查結果格式不正確，請再試一次。'), { status: 502 }); }
}

// Bounding box of the photo's subject, so the page can crop busy backgrounds away before stylizing.
// Box only: on Vertex AI, Gemini's segmentation masks come back as undecodable <seg_N> tokens.
async function locate(image, mime, subject) {
  const what = subject === 'animal'
    ? 'the main animal (the whole animal, including tail, ears and paws)'
    : 'the main person (everything of them that is visible, including hair)';
  const j = await gemini(LOCATE_MODEL, {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: image } },
      { text: `Find ${what} in this image. Reply with only JSON: {"box_2d": [ymin, xmin, ymax, xmax] on a 0-1000 scale, or null if there is none}` },
    ] }],
    generationConfig: {
      responseMimeType: 'application/json', temperature: 0,
      ...(/flash/.test(LOCATE_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  let b = null;
  try { const r = JSON.parse(text); b = (Array.isArray(r) ? r[0] : r)?.box_2d; } catch { console.error('locate not json', text.slice(0, 300)); }
  const ok = Array.isArray(b) && b.length === 4 && b.every(v => Number.isFinite(v) && v >= 0 && v <= 1000) && b[2] > b[0] && b[3] > b[1];
  return { box: ok ? b.map(Math.round) : null };
}

async function stylize(body) {
  const j = await gemini(MODEL, body);
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

// Cape layering: the same reference sheet with the cape (or cloak / robe) taken off, so the page can tell cape
// texels (second layer) from the body underneath (first layer) by comparing the two, in both views
function decapePrompt(hasPhoto) {
  return [
    'Image 1 is a character reference sheet of a blocky Minecraft player character: FRONT view on the left half, BACK view on the right half. The character wears a cape, cloak or robe.',
    hasPhoto ? 'Image 2 is a photo of the same character without the cape, cloak or robe: use it for what the body underneath looks like.' : '',
    'Redraw image 1 exactly, but with the cape, cloak or robe removed in BOTH views: show the torso, arms and legs as they look underneath, continuing the clothes, armor and colors that are visible.',
    'Keep everything that is not the cape identical to image 1: canvas size, background color, each figure\'s position, size and proportions, the heads, and the same texel grid and pixel-art style.',
    'If the character has no cape, return image 1 unchanged. No text, no labels.',
  ].filter(Boolean).join('\n');
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
  if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, model: MODEL, auth: API_KEY ? 'gemini-api' : 'vertex' }, origin);
  if (req.method !== 'POST' || !['/api/stylize', '/api/review', '/api/locate', '/api/decape'].includes(req.url)) return send(res, 404, { error: 'not found' }, origin);
  if (ORIGINS.length && !origin) return send(res, 403, { error: '這個網站沒有使用權限。' }, '');
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: '存取碼不正確。' }, origin);

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rateLimited(ip)) return send(res, 429, { error: `每小時最多 ${RATE_PER_HOUR} 次，請稍後再試。` }, origin);

  try {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { error: '圖片太大，請換一張較小的照片。' }, origin); chunks.push(c); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/api/review') {
      if (typeof body.source !== 'string' || typeof body.result !== 'string' || !body.source || !body.result) return send(res, 400, { error: '缺少審查圖片。' }, origin);
      if (body.photo != null && typeof body.photo !== 'string') return send(res, 400, { error: '照片格式不正確。' }, origin);
      return send(res, 200, await review(body), origin);
    }
    const { image, mime = 'image/jpeg', style = 'classic', desc = '', fix = '', subject = 'person' } = body;
    if (typeof image !== 'string' || !image) return send(res, 400, { error: '缺少圖片。' }, origin);
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return send(res, 400, { error: '只接受 JPG、PNG、WebP。' }, origin);
    if (req.url === '/api/locate') return send(res, 200, await locate(image, mime, subject === 'animal' ? 'animal' : 'person'), origin);
    if (req.url === '/api/decape') {
      // image = the AI front+back sheet; photo (optional) = the user's photo of the character without the cape
      if (body.photo != null && typeof body.photo !== 'string') return send(res, 400, { error: '參考照片格式不正確。' }, origin);
      return send(res, 200, await stylize({
        contents: [{ role: 'user', parts: [
          { text: decapePrompt(!!body.photo) },
          { inline_data: { mime_type: mime, data: image } },
          ...(body.photo ? [{ inline_data: { mime_type: 'image/jpeg', data: body.photo } }] : []),
        ] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:2' } },
      }), origin);
    }

    const out = await stylize({
      contents: [{ role: 'user', parts: [
        { text: buildPrompt(String(style), String(desc).slice(0, 300), String(fix).slice(0, 300), subject === 'animal' ? 'animal' : 'person') },
        { inline_data: { mime_type: mime, data: image } },
      ] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:2' } },
    });
    send(res, 200, out, origin);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : '伺服器發生錯誤，請稍後再試。' }, origin);
  }
}).listen(PORT, () => console.log(`skin proxy on :${PORT} model=${MODEL} auth=${API_KEY ? 'gemini-api' : 'vertex'}`));
