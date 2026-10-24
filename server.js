'use strict';
/**
 * שירות תרגום תמונות דרך גוגל תרגום (ללא API רשמי).
 * מקבל תמונה (POST /translate), פותח דפדפן Chromium headless, מעלה אותה לדף
 * "תרגום תמונות" של גוגל, ממתין לתמונה המתורגמת (עם הטקסט המושתל) ומחזיר אותה כ-PNG.
 *
 * ללא תלויות מלבד playwright.
 */
const http = require('http');
const crypto = require('crypto');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT) || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const TRANSLATE_URL = process.env.TRANSLATE_URL || 'https://translate.google.com/?sl=auto&tl=iw&op=images';
const MAX_BYTES = (Number(process.env.MAX_MB) || 15) * 1024 * 1024;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY) || 2;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 60000;
const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------- דפדפן משותף + הגבלת מקביליות ------------------------- */
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
      })
      .then((b) => {
        b.on('disconnected', () => { browserPromise = null; });
        return b;
      })
      .catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_CONCURRENCY) await new Promise((r) => waiting.push(r));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

/* ------------------------- עזרים ------------------------- */
function pngSize(buf) {
  // כותרת PNG: רוחב וגובה ב-bytes 16..23
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return null;
}

function sniffMime(buf) {
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

let lastDebug = null; // צילום מסך של הכשל האחרון, לאבחון (GET /debug/last.png)
async function saveDebug(page, note) {
  try {
    lastDebug = { png: await page.screenshot({ fullPage: false }), note, url: page.url(), ts: new Date().toISOString() };
  } catch (_) { /* ignore */ }
}

async function handleConsent(page) {
  const consentUrl = () => /consent\.(google|youtube)\./.test(page.url());
  if (!consentUrl()) return;
  log('consent page detected');
  const btn = page
    .getByRole('button', { name: /accept all|reject all|i agree|agree|קבל הכול|דחה הכול|אני מסכים|alle akzeptieren|tout accepter/i })
    .first();
  try {
    await btn.click({ timeout: 8000 });
    await page.waitForURL((u) => !/consent\./.test(u.toString()), { timeout: 15000 });
  } catch (e) {
    log('consent handling failed:', e.message);
  }
}

// מוצא את שדה ההעלאה של תמונות (בדף יש גם שדה למסמכים שאינו מקבל תמונות)
async function findImageInput(page, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const h of await page.$$('input[type="file"]')) {
      const accept = (await h.getAttribute('accept')) || '';
      if (!accept || /image|png|jpe?g|webp/i.test(accept)) return h;
    }
    await sleep(250);
  }
  return null;
}

async function uploadImage(page, file) {
  const input = await findImageInput(page, 12000);
  if (input) {
    await input.setInputFiles(file);
    return;
  }
  // גיבוי: לחיצה על כפתור העלאה ותפיסת חלון בחירת הקובץ
  log('no image input found, trying file chooser');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    page.getByRole('button', { name: /browse|upload|choose|עיון|בחר|העלא|file/i }).first().click({ timeout: 10000 })
  ]);
  await chooser.setFiles(file);
}

/* ------------------------- זיהוי התמונה המתורגמת (רץ בתוך הדף) ------------------------- */
function pageProbe() {
  return async ({ aspect, baseline, origDataUrl }) => {
    const SIG = 64;
    const sigOf = (src, w, h) => {
      const c = document.createElement('canvas');
      c.width = SIG;
      c.height = SIG;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, w, h, 0, 0, SIG, SIG);
      const d = g.getImageData(0, 0, SIG, SIG).data;
      const s = new Float32Array(SIG * SIG);
      for (let i = 0; i < s.length; i++) s[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      return s;
    };
    const diff = (a, b) => {
      let t = 0;
      for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
      return t / a.length;
    };

    if (!window.__ctcOrig) {
      const im = new Image();
      im.src = origDataUrl;
      await im.decode();
      window.__ctcOrig = sigOf(im, im.naturalWidth, im.naturalHeight);
    }

    document.querySelectorAll('[data-ctc]').forEach((n) => n.removeAttribute('data-ctc'));
    const found = [];
    let idx = 0;
    for (const el of document.querySelectorAll('img,canvas')) {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 50) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;

      const isCanvas = el.tagName === 'CANVAS';
      const nw = isCanvas ? el.width : el.naturalWidth;
      const nh = isCanvas ? el.height : el.naturalHeight;
      if (!nw || !nh) continue;
      if (!isCanvas && (!el.complete || !(el.currentSrc || el.src))) continue;
      if (Math.abs(nw / nh - aspect) / aspect > 0.12) continue;

      const key = isCanvas ? `canvas|${nw}x${nh}` : 'img|' + (el.currentSrc || el.src);
      if (!isCanvas && baseline.includes(key)) continue;

      let sig = null;
      let dataUrl = null;
      try {
        sig = sigOf(el, nw, nh);
        const c = document.createElement('canvas');
        c.width = nw;
        c.height = nh;
        c.getContext('2d').drawImage(el, 0, 0);
        dataUrl = c.toDataURL('image/png');
      } catch (_) { /* canvas מזוהם – נשתמש בצילום האלמנט */ }

      // תמונה זהה כמעט לחלוטין למקור = תצוגת המקור של גוגל, לא התרגום
      if (sig && diff(sig, window.__ctcOrig) < 0.8) continue;

      el.setAttribute('data-ctc', String(idx));
      found.push({ key: key + (sig ? '|' + Math.round(sig.reduce((a, b) => a + b, 0)) : ''), dataUrl, idx, top: r.top, left: r.left });
      idx += 1;
    }
    if (!found.length) return null;
    // בפריסה צדדית – הימני; בפריסה מוערמת – התחתון
    found.sort((a, b) => (Math.abs(a.top - b.top) > 20 ? b.top - a.top : b.left - a.left));
    return found[0];
  };
}

/* ------------------------- התרגום עצמו ------------------------- */
async function translateImage(buf) {
  const type = sniffMime(buf);
  if (!type) throw httpError(415, 'פורמט תמונה לא נתמך (PNG / JPEG / WEBP בלבד)');
  const size = pngSize(buf);
  const aspect = size ? size.w / size.h : 1;
  const origDataUrl = `data:${type.mime};base64,${buf.toString('base64')}`;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: process.env.LOCALE || 'en-US',
    userAgent: UA
  });
  const page = await context.newPage();
  const deadline = Date.now() + TIMEOUT_MS;

  try {
    await page.goto(TRANSLATE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await handleConsent(page);

    const baseline = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img')).map((i) => 'img|' + (i.currentSrc || i.src))
    );

    await uploadImage(page, { name: `capture.${type.ext}`, mimeType: type.mime, buffer: buf });

    let lastKey = null;
    let stable = 0;
    while (Date.now() < deadline) {
      await sleep(500);
      const hit = await page.evaluate(pageProbe(), { aspect, baseline, origDataUrl });
      if (!hit) { lastKey = null; stable = 0; continue; }
      if (hit.key === lastKey) stable += 1;
      else { lastKey = hit.key; stable = 1; }
      if (stable < 3) continue;

      if (hit.dataUrl) return Buffer.from(hit.dataUrl.split(',')[1], 'base64');
      // גיבוי: צילום האלמנט עצמו
      return await page.locator(`[data-ctc="${hit.idx}"]`).screenshot({ type: 'png' });
    }
    await saveDebug(page, 'timeout');
    throw httpError(504, 'לא התקבלה תמונה מתורגמת (ייתכן שלא זוהה טקסט בתמונה, או שהעמוד של גוגל השתנה)');
  } catch (e) {
    if (!e.status) {
      await saveDebug(page, e.message);
      e.status = 502;
    }
    throw e;
  } finally {
    await context.close().catch(() => {});
  }
}

/* ------------------------- שרת HTTP ------------------------- */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-auth-token'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BYTES * 1.4) { // base64 גדול ב-~33%
        reject(httpError(413, 'התמונה גדולה מדי'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
        'Access-Control-Max-Age': '86400'
      });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return sendJson(res, 200, { ok: true, running, queued: waiting.length });
    }
    if (req.method === 'GET' && url.pathname === '/debug/last.png') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      if (!lastDebug) return sendJson(res, 404, { error: 'אין כשל שמור' });
      return send(res, 200, lastDebug.png, {
        'Content-Type': 'image/png',
        'X-Debug-Note': encodeURIComponent(`${lastDebug.ts} ${lastDebug.url} ${lastDebug.note || ''}`.slice(0, 500))
      });
    }
    if (req.method === 'POST' && url.pathname === '/translate') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const raw = await readBody(req);
      let img = raw;
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        const j = JSON.parse(raw.toString('utf8') || '{}');
        const s = String(j.image || '');
        img = Buffer.from(s.replace(/^data:[^,]+,/, ''), 'base64');
      }
      if (!img.length) throw httpError(400, 'לא התקבלה תמונה');
      if (img.length > MAX_BYTES) throw httpError(413, 'התמונה גדולה מדי');

      const t0 = Date.now();
      const out = await withSlot(() => translateImage(img));
      log(`translated ${img.length}B -> ${out.length}B in ${Date.now() - t0}ms`);
      return send(res, 200, out, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Translate-Ms': String(Date.now() - t0) });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    log('error:', e.message);
    sendJson(res, e.status || 500, { error: e.message });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 30000;
server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    try { (await browserPromise)?.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  });
}
