// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ให้ runtime ใช้ cache เดียวกับตอน build (อยู่ในโปรเจกต์)
const LOCAL_PUP_CACHE = path.join(__dirname, '.puppeteer');
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || LOCAL_PUP_CACHE;

const puppeteerExtra = require('puppeteer-extra');
const Stealth = require('puppeteer-extra-plugin-stealth');
const cron = require('node-cron');
const vanillaPuppeteer = require('puppeteer');
puppeteerExtra.use(Stealth());

// fetch polyfill (Node < 18)
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

/* ------------------- global error guards ------------------- */
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));

/* ------------------- tiny health server (no express) ------------------- */
let externalServerLoaded = false;
try { require('./server'); externalServerLoaded = true; } catch {}
const PORT = process.env.PORT || 10000;
if (!externalServerLoaded) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/healthz') { res.writeHead(200); res.end('ok'); }
    else { res.writeHead(404); res.end('not found'); }
  });
  server.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
}

/* ------------------- runtime switches ------------------- */
const ON_RENDER = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const HEADLESS = ON_RENDER ? 'new' : false;
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL || '').replace(/\/$/, '');
if (ON_RENDER && SELF_URL) {
  setInterval(async () => {
    try { const r = await fetch(SELF_URL + '/healthz', { cache: 'no-store' }); console.log(`♻️ keep-alive ${r.status}`); }
    catch (e) { console.log('♻️ keep-alive failed:', e.message); }
  }, 9 * 60 * 1000);
}

const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || vanillaPuppeteer.executablePath();
console.log('🧭 Chrome path =', EXECUTABLE_PATH);

/* ------------------- ENV ------------------- */
const COOKIES_ENV = process.env.cookies || '';  // JSON array หรือ Base64(JSON array)
const EMAIL = process.env.email || '';
const PASSWORD = process.env.password || '';

/* ------------------- config ------------------- */
const GROUP_URLS = [
  'https://web.facebook.com/groups/communitycraft',
  'https://web.facebook.com/groups/506463258587188',
];

const POST_MESSAGE = `✿･ﾟ: ✧･ﾟ: 𝗦𝗲𝗮 𝗠𝘂𝘄𝘄 :･ﾟ✧:･ﾟ✿

┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
   รับทำ 𝑨𝒅𝒅-𝒐𝒏 • 𝑺𝒌𝒊𝒏 • 𝑪𝒐𝒎𝒎𝒊𝒔𝒔𝒊𝒐𝒏
                  ราคากันเอง ♡
┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈

              𝑨𝒅𝒅𝒐𝒏 𝑺𝒌𝒊𝒏
        ₊ ˚⊹♡ 𝑶𝒑𝒕𝒊𝒐𝒏𝒔 ♡⊹˚₊
          • ผมขยับ 30.-
          • ตากระพริบ 20.-
          • ตากระพริบใหม่ 35.-
          • หน้าอก 25.-
          • ปอยผม & จุกผม จุดละ 10.-
          • ตาเรืองแสง 35.-
          • ตาขยับ 100.-

  ⋆˙⟡♡⟡˙⋆ ✧ 𝑺𝒌𝒊𝒏 5 ลายเส้น ✧ ⋆˙⟡♡⟡˙⋆

          𝑴𝒖𝒙 - 𝑺𝒌𝒙 - 𝑯𝒊𝒌𝒆𝒓𝒊 - 𝑵𝑱 - 𝑲𝒊𝒎
       ราคาเป็นกันเอง - ตามงานได้ตลอด

   ✦• ประมูลทุกวัน จันทร์ • พุธ • ศุกร์ ✦•
             สามารถฝากประมูลได้

    𓆩♡𓆪 สนใจให้กดที่ด้านล่างเยยย
    https://discord.gg/jHhQETebMm
`;

const COMPOSER_KEYWORDS = [
  'เขียน', 'เขียนโพสต์', 'โพสต์บางอย่าง', 'โพสต์',
  'Write something', 'Create post', "What's on your mind"
];
const POST_BUTTON_ARIA = ['โพสต์', 'Post', 'แชร์', 'Share'];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (minMs, maxMs) => Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

/* ------------------- cookies loader (ENV only) ------------------- */
function parseCookies(raw) {
  if (!raw) return null;
  try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; } catch {}
  try { const txt = Buffer.from(raw, 'base64').toString('utf8'); const arr = JSON.parse(txt); if (Array.isArray(arr)) return arr; } catch {}
  return null;
}
async function loadCookies(page) {
  const arr = parseCookies(COOKIES_ENV);
  if (!arr) { console.log('ℹ️ ENV cookies ว่างหรือรูปแบบผิด'); return false; }
  try { await page.setCookie(...arr); console.log(`✅ โหลด cookies จาก ENV (${arr.length})`); return true; }
  catch (e) { console.log('❌ setCookie ล้มเหลว:', e.message); return false; }
}
async function exportCookies() { /* no-op ตามที่ขอ */ }

/* ------------------- resource blocking (always-on) ------------------- */
// บล็อกหนัก ๆ แต่อนุญาตสิ่งจำเป็นของ Facebook + blob/data สำหรับพรีวิวไฟล์
function shouldBlock(url, type) {
  const allowBlobData = url.startsWith('blob:') || url.startsWith('data:');
  const fbAllow = /^(https?:\/\/)?([a-z0-9-]+\.)?(facebook\.com|fbcdn\.net)\b/i.test(url);
  if (allowBlobData || fbAllow) return false;

  if (['image', 'media', 'font'].includes(type)) return true;
  if (/doubleclick\.net|googlesyndication\.com|googletagservices\.com/.test(url)) return true;
  return false;
}
async function enableBlocking(page) {
  await page.setRequestInterception(true);
  const handler = (req) => {
    if (shouldBlock(req.url(), req.resourceType())) return req.abort();
    req.continue();
  };
  page.on('request', handler);
  page._blocker = handler;
}
async function disableBlocking(page) {
  if (page._blocker) {
    page.off('request', page._blocker);
    page._blocker = null;
  }
  try { await page.setRequestInterception(false); } catch {}
}

/* ------------------- helpers ------------------- */
async function findButtonByText(page, keywords, { role = 'button', exclude = ['ความคิดเห็น'] } = {}) {
  const handles = await page.$$(`div[role="${role}"], span[role="${role}"], a[role="${role}"], button`);
  for (const h of handles) {
    const text = (await page.evaluate((el) => el.innerText || el.getAttribute('aria-label') || '', h)).trim();
    if (!text) continue;
    if (exclude.some((ex) => text.includes(ex))) continue;
    if (keywords.some((k) => text.toLowerCase().includes(k.toLowerCase()))) return h;
  }
  return null;
}
async function getComposerTextbox(page) {
  const selectors = [
    'div[role="dialog"] div[role="textbox"]',
    'div[role="dialog"] [contenteditable="true"][role="textbox"]',
    'div[aria-label][role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    'div[role="textbox"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return { el, sel };
  }
  return null;
}

/* ------------------- navigation utils ------------------- */
async function gotoWithRetry(page, url, options = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000, ...options });
      return true;
    } catch (e) {
      lastErr = e;
      console.log(`⚠️ goto retry ${i + 1}/${retries + 1} failed: ${e.message}`);
      await delay(2000 + i * 1000);
    }
  }
  throw lastErr;
}

/* ------------------- login fallback (email/password) ------------------- */
async function ensureLoggedIn(page) {
  if (!(page.url().includes('facebook.com/login') || page.url().includes('checkpoint'))) return true;
  if (!EMAIL || !PASSWORD) { console.log('❌ หน้า login/checkpoint แต่ไม่มี email/password ใน ENV'); return false; }

  console.log('🔐 พยายามล็อกอินด้วย email/password ...');
  try {
    await page.waitForSelector('#email', { timeout: 15000 });
    await page.type('#email', EMAIL, { delay: 40 });
    await page.type('#pass', PASSWORD, { delay: 40 });
    const loginBtn = await page.$('button[name="login"], #loginbutton');
    if (loginBtn) await loginBtn.click(); else await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 });
    if (page.url().includes('checkpoint')) {
      console.log('⚠️ ติด checkpoint ต้องยืนยันในเบราว์เซอร์จริงก่อน');
      return false;
    }
    console.log('✅ ล็อกอินสำเร็จ');
    await exportCookies();
    return true;
  } catch (e) {
    console.log('❌ ล็อกอินล้มเหลว:', e.message);
    return false;
  }
}

/* ------------------- dialog/media/post ------------------- */
async function clickComposer(page) {
  let btn = await findButtonByText(page, COMPOSER_KEYWORDS, { role: 'button', exclude: ['ความคิดเห็น'] });
  if (!btn) {
    const xpathCandidates = [
      `//div[@role="button" and (contains(., "เขียน") or contains(., "โพสต์บางอย่าง") or contains(., "โพสต์")) and not(contains(., "ความคิดเห็น"))]`,
      `//div[@role="button" and (contains(., "Write something") or contains(., "Create post") or contains(., "What's on your mind"))]`,
      `//span[(contains(., "เขียน") or contains(., "โพสต์")) and not(contains(., "ความคิดเห็น"))]/ancestor::div[@role="button"]`,
    ];
    for (const xp of xpathCandidates) { const [h] = await page.$x(xp); if (h) { btn = h; break; } }
  }
  if (!btn) return false;
  await btn.click();
  return true;
}
async function clickPostButton(page) {
  for (const label of POST_BUTTON_ARIA) {
    const sel = `div[role="dialog"] [aria-label="${label}"], [aria-label="${label}"]`;
    const el = await page.$(sel);
    if (el) { await el.click(); return true; }
  }
  const [fallback] = await page.$x(
    `//div[@role="dialog"]//div[@role="button"][not(@aria-disabled="true") and (contains(., "โพสต์") or contains(., "Post") or contains(., "แชร์") or contains(., "Share"))]`
  );
  if (fallback) { await fallback.click(); return true; }
  return false;
}
async function waitForMediaPreviewInDialog(page, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      if (!dlg) return false;
      const hasImg = dlg.querySelector('img[src^="blob:"]') ||
                     dlg.querySelector('img[alt*="รูป"], img[alt*="photo"], img[alt*="image"], img[alt*="ภาพ"]');
      const hasVideo = dlg.querySelector('video') ||
                       dlg.querySelector('div[aria-label*="วิดีโอ"], div[aria-label*="Video"]');
      return !!(hasImg || hasVideo);
    });
    if (ok) return true;
    await delay(500);
  }
  return false;
}
async function uploadMediaToComposer(page, absolutePaths = []) {
  if (!absolutePaths.length) return true;

  const addMediaSelectors = [
    'div[role="dialog"] div[aria-label="รูปภาพ/วิดีโอ"]',
    'div[role="dialog"] div[aria-label="เพิ่มรูปภาพ/วิดีโอ"]',
    'div[role="dialog"] div[aria-label="รูปภาพ"]',
    'div[role="dialog"] div[aria-label="วิดีโอ"]',
    'div[role="dialog"] div[aria-label="Photo/Video"]',
    'div[role="dialog"] div[aria-label="Add photo/video"]',
  ];
  for (const sel of addMediaSelectors) { const btn = await page.$(sel); if (btn) { await btn.click(); break; } }

  const inputSelectors = [
    'div[role="dialog"] input[type="file"][accept*="image"], div[role="dialog"] input[type="file"][accept*="video"]',
    'div[role="dialog"] input[type="file"][multiple]',
    'div[role="dialog"] input[type="file"]',
  ];
  let inputs = [];
  for (const sel of inputSelectors) { const hs = await page.$$(sel); if (hs.length) { inputs = hs; break; } }
  if (!inputs.length) {
    await delay(1500);
    for (const sel of inputSelectors) { const hs = await page.$$(sel); if (hs.length) { inputs = hs; break; } }
  }
  if (!inputs.length) { console.log('❌ ไม่พบ input[type=file] ใน dialog'); return false; }

  console.log(`🔎 พบ input[type=file] ${inputs.length} ช่อง — อัปโหลด ${absolutePaths.length} ไฟล์...`);
  let uploaded = false;
  for (const h of inputs) {
    try {
      if (typeof h.setInputFiles === 'function') {
        await h.setInputFiles(absolutePaths);
      } else {
        for (const p of absolutePaths) await h.uploadFile(p);
      }
      uploaded = true; break;
    } catch {}
  }
  if (!uploaded) { console.log('❌ ส่งไฟล์เข้า input ไม่สำเร็จ'); return false; }

  const ok = await waitForMediaPreviewInDialog(page, 25000);
  console.log(ok ? '📸/🎬 พรีวิวสื่อขึ้นแล้ว' : '⚠️ ส่งไฟล์แล้วแต่ยังไม่เห็นพรีวิว');
  if (!ok) await delay(4000);
  return true;
}
async function closeAnyDialog(page) {
  try {
    await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      if (!dlg) return;
      const btns = Array.from(dlg.querySelectorAll('div[role="button"],button'));
      const closeBtn = btns.find(
        (b) =>
          /ปิด|Close|ยกเลิก|Cancel/i.test(b.innerText || '') ||
          (b.getAttribute('aria-label') || '').match(/ปิด|Close|ยกเลิก|Cancel/i)
      );
      closeBtn?.click();
    });
    await delay(800);
  } catch {}
}

/* ------------------- core flow ------------------- */
async function postToGroup(page, groupUrl, message) {
  console.log(`\n➡️ ไปที่กลุ่ม: ${groupUrl}`);
  await gotoWithRetry(page, groupUrl, {}, 2);

  if (!(await ensureLoggedIn(page))) return false;
  await delay(1500);

  let opened = await clickComposer(page);
  if (!opened) {
    console.log('⚠️ หา “เขียนโพสต์” ไม่เจอ รอบที่ 1 → เลื่อนหน้า');
    await page.evaluate(() => window.scrollBy(0, 900));
    await delay(1200);
    opened = await clickComposer(page);
  }
  if (!opened) { console.log('❌ ไม่พบกล่องเริ่มเขียนโพสต์'); return false; }

  await delay(1200);

  const imagePath = path.resolve('./test.png');
  const videoPath = path.resolve('./main.mp4');
  const mediaPaths = [imagePath, videoPath].filter((p) => fs.existsSync(p));
  if (mediaPaths.length) { await uploadMediaToComposer(page, mediaPaths); }
  else { console.log('ℹ️ ไม่พบ test.png/main.mp4 — โพสต์เฉพาะข้อความ'); }

  await page.waitForSelector('div[role="dialog"]', { timeout: 20000 });
  let textbox = await getComposerTextbox(page);
  if (!textbox) { await delay(900); textbox = await getComposerTextbox(page); }
  if (!textbox) { console.log('❌ ไม่พบพื้นที่พิมพ์ข้อความโพสต์'); return false; }

  await textbox.el.focus();
  await page.type(textbox.sel, message, { delay: 40 });
  await delay(600);

  await page.waitForFunction(() => {
    const dlg = document.querySelector('div[role="dialog"]'); if (!dlg) return false;
    const btns = Array.from(dlg.querySelectorAll('div[role="button"],button'));
    const btn = btns.find((el) => /โพสต์|Post|แชร์|Share/i.test(el.innerText || el.getAttribute('aria-label') || ''));
    if (!btn) return false;
    const disabled = btn.getAttribute('aria-disabled') === 'true' || (btn.className || '').includes('disabled');
    return !disabled;
  }, { timeout: 30000 }).catch(() => {});

  const posted = await clickPostButton(page);
  if (!posted) {
    console.log('❌ ไม่พบปุ่ม “โพสต์”/Post');
    await page.screenshot({ path: `cannot_find_post_button_${Date.now()}.png` });
    return false;
  }

  console.log('⏳ กำลังโพสต์...');
  await page.waitForFunction(() => !document.querySelector('div[role="dialog"]'), { timeout: 45000 }).catch(() => {});
  console.log('✅ โพสต์สำเร็จ (คาดว่า)');
  return true;
}

/* ------------------- runner / cron ------------------- */
let isRunning = false;
async function safeRun() {
  if (isRunning) { console.log('⏳ งานก่อนหน้ายังไม่จบ ข้ามรอบ'); return; }
  isRunning = true;
  try { await run(); }
  catch (e) { console.error('❌ run() ล้มเหลว:', e); }
  finally { isRunning = false; }
}

cron.schedule('0 12 * * *', () => { console.log('🕛 12:00 ICT → เริ่มโพสต์'); safeRun(); }, { timezone: 'Asia/Bangkok' });
cron.schedule('0 0 * * *',  () => { console.log('🕛 00:00 ICT → เริ่มโพสต์'); safeRun(); }, { timezone: 'Asia/Bangkok' });

async function run() {
  const browser = await puppeteerExtra.launch({
    headless: HEADLESS,
    executablePath: EXECUTABLE_PATH,
    protocolTimeout: 120000,
    defaultViewport: { width: 1280, height: 720 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=site-per-process,TranslateUI,BlinkGenPropertyTrees',
      '--metrics-recording-only',
      '--mute-audio',
      '--lang=th-TH,th,en-US,en',
      '--window-size=1280,720',
      '--js-flags=--max-old-space-size=256'
    ],
  });

  const gracefulShutdown = async () => { try { await browser.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);
  await page.setDefaultTimeout(45000);

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7' });
  await page.setBypassCSP(true);

  // เปิด resource blocking ถาวร
  await enableBlocking(page);

  await loadCookies(page);

  // โฮมเพจเพื่อ warm-up session
  try { await page.goto('https://web.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {}

  for (let i = 0; i < GROUP_URLS.length; i++) {
    const url = GROUP_URLS[i];
    try {
      if (i === 0 && (page.url().includes('login') || page.url().includes('checkpoint'))) {
        // ปิดบล็อคชั่วคราวเพื่อให้หน้า login โหลดครบ
        await disableBlocking(page);
        const okLogin = await ensureLoggedIn(page);
        await enableBlocking(page);
        if (!okLogin) { await browser.close(); return; }
      }

      await closeAnyDialog(page);
      const ok = await postToGroup(page, url, POST_MESSAGE);

      await exportCookies();

      if (i < GROUP_URLS.length - 1) {
        const waitMs = jitter(5000, 9000);
        console.log(`🕒 รอ ${Math.round(waitMs / 1000)} วิ ก่อนสลับไปกลุ่มถัดไป...`);
        await delay(waitMs);
      }

      if (!ok) console.log('⚠️ กลุ่มนี้โพสต์ไม่สำเร็จ');
    } catch (err) {
      console.error(`❌ เกิดข้อผิดพลาดกับกลุ่ม ${url}:`, err.message);
      await delay(jitter(4000, 8000));
    }
  }

  await browser.close();
}

// รันทันทีเมื่อ start (Local/Render)
if (require.main === module) { safeRun(); }
module.exports = { run: safeRun };
