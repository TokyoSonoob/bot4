// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const puppeteerExtra = require('puppeteer-extra');
const Stealth = require('puppeteer-extra-plugin-stealth');
const puppeteerCore = require('puppeteer-core'); // connect() ไม่ต้องมี Chrome ในเครื่อง
const cron = require('node-cron');

puppeteerExtra.use(Stealth());

/* ---------- tiny health server (no express) ---------- */
const http = require('http');
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    if (req.url === '/' || req.url === '/healthz') { res.writeHead(200); res.end('ok'); }
    else { res.writeHead(404); res.end('not found'); }
  })
  .listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

/* ---------- ENV ---------- */
// ✅ ใช้สองตัวแปรเท่านั้น
const COOKIES_ENV = process.env.cookies || '';   // JSON array หรือ Base64(JSON array)
const BROWSER_WS  = process.env.api || '';       // <<<< ใส่ wss://... จาก Browserless/remote

if (!BROWSER_WS) {
  console.error('❌ ไม่พบ ENV "api" (WebSocket URL ของ Browserless/Remote Chrome).');
}

// ช่วยกรณี Node < 18
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

/* ---------- config ---------- */
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

          𝑴𝒖𝒙 - 𝑺𝒌𝒚 - 𝑯𝒊𝒌𝒆𝒓𝒊 - 𝑵𝑱 - 𝑲𝒊𝒎
       ราคาเป็นกันเอง - ตามงานได้ตลอด

   ✦• ประมูลทุกวัน จันทร์ • พุธ • ศุกร์ ✦•
             สามารถฝากประมูลได้

    𓆩♡𓆪 สนใจให้กดที่ด้านล่างเยยย
    https://discord.gg/jHhQETebMm
`;

/* ---------- utils ---------- */
const delay  = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function parseCookies(raw) {
  if (!raw) return null;
  try { const a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch {}
  try { const txt = Buffer.from(raw, 'base64').toString('utf8'); const a = JSON.parse(txt); if (Array.isArray(a)) return a; } catch {}
  return null;
}

async function loadCookies(page) {
  const arr = parseCookies(COOKIES_ENV);
  if (!arr) { console.log('ℹ️ ENV cookies ว่างหรือรูปแบบผิด'); return false; }
  try { await page.setCookie(...arr); console.log(`✅ โหลด cookies จาก ENV (${arr.length})`); return true; }
  catch (e) { console.log('❌ setCookie ล้มเหลว:', e.message); return false; }
}

// block resource หนัก ๆ (อนุญาตโดเมน facebook และ blob/data)
function shouldBlock(url, type) {
  const allowFB   = /^(https?:\/\/)?([a-z0-9-]+\.)?(facebook\.com|fbcdn\.net)\b/i.test(url);
  const allowBD   = url.startsWith('blob:') || url.startsWith('data:');
  if (allowFB || allowBD) return false;
  if (['image','media','font'].includes(type)) return true;
  if (/doubleclick\.net|googlesyndication\.com|googletagservices\.com/.test(url)) return true;
  return false;
}
async function enableBlocking(page) {
  await page.setRequestInterception(true);
  const handler = (req) => shouldBlock(req.url(), req.resourceType()) ? req.abort() : req.continue();
  page.on('request', handler);
  page._blocker = handler;
}
async function disableBlocking(page) {
  if (page._blocker) { page.off('request', page._blocker); page._blocker = null; }
  try { await page.setRequestInterception(false); } catch {}
}

async function findButtonByText(page, keywords, { role='button', exclude=['ความคิดเห็น'] } = {}) {
  const handles = await page.$$(`div[role="${role}"], span[role="${role}"], a[role="${role}"], button`);
  for (const h of handles) {
    const text = (await page.evaluate(el => el.innerText || el.getAttribute('aria-label') || '', h)).trim();
    if (!text) continue;
    if (exclude.some(ex => text.includes(ex))) continue;
    if (keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))) return h;
  }
  return null;
}

async function getComposerTextbox(page) {
  const sels = [
    'div[role="dialog"] div[role="textbox"]',
    'div[role="dialog"] [contenteditable="true"][role="textbox"]',
    'div[aria-label][role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    'div[role="textbox"]',
  ];
  for (const sel of sels) { const el = await page.$(sel); if (el) return { el, sel }; }
  return null;
}

async function gotoWithRetry(page, url, opt = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000, ...opt }); return true; }
    catch (e) { lastErr = e; console.log(`⚠️ goto retry ${i+1}/${retries+1} failed: ${e.message}`); await delay(1500+i*500); }
  }
  throw lastErr;
}

async function clickComposer(page) {
  const KW = ['เขียน','เขียนโพสต์','โพสต์บางอย่าง','โพสต์','Write something','Create post',"What's on your mind"];
  let btn = await findButtonByText(page, KW, { role: 'button', exclude: ['ความคิดเห็น'] });
  if (!btn) {
    const xps = [
      `//div[@role="button" and (contains(., "เขียน") or contains(., "โพสต์บางอย่าง") or contains(., "โพสต์")) and not(contains(., "ความคิดเห็น"))]`,
      `//div[@role="button" and (contains(., "Write something") or contains(., "Create post") or contains(., "What's on your mind"))]`,
      `//span[(contains(., "เขียน") or contains(., "โพสต์")) and not(contains(., "ความคิดเห็น"))]/ancestor::div[@role="button"]`,
    ];
    for (const xp of xps) { const [h] = await page.$x(xp); if (h) { btn = h; break; } }
  }
  if (!btn) return false;
  await btn.click();
  return true;
}

async function clickPostButton(page) {
  const labels = ['โพสต์','Post','แชร์','Share'];
  for (const label of labels) {
    const el = await page.$(`div[role="dialog"] [aria-label="${label}"], [aria-label="${label}"]`);
    if (el) { await el.click(); return true; }
  }
  const [fallback] = await page.$x(
    `//div[@role="dialog"]//div[@role="button"][not(@aria-disabled="true") and (contains(., "โพสต์") or contains(., "Post") or contains(., "แชร์") or contains(., "Share"))]`
  );
  if (fallback) { await fallback.click(); return true; }
  return false;
}

async function waitForMediaPreviewInDialog(page, timeout=25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]'); if (!dlg) return false;
      const hasImg = dlg.querySelector('img[src^="blob:"]') ||
        dlg.querySelector('img[alt*="รูป"], img[alt*="photo"], img[alt*="image"], img[alt*="ภาพ"]');
      const hasVideo = dlg.querySelector('video') ||
        dlg.querySelector('div[aria-label*="วิดีโอ"], div[aria-label*="Video"]');
      return !!(hasImg || hasVideo);
    });
    if (ok) return true;
    await delay(400);
  }
  return false;
}

async function uploadMediaToComposer(page, absolutePaths=[]) {
  if (!absolutePaths.length) return true;
  const addBtns = [
    'div[role="dialog"] div[aria-label="รูปภาพ/วิดีโอ"]',
    'div[role="dialog"] div[aria-label="เพิ่มรูปภาพ/วิดีโอ"]',
    'div[role="dialog"] div[aria-label="รูปภาพ"]',
    'div[role="dialog"] div[aria-label="วิดีโอ"]',
    'div[role="dialog"] div[aria-label="Photo/Video"]',
    'div[role="dialog"] div[aria-label="Add photo/video"]',
  ];
  for (const sel of addBtns) { const b = await page.$(sel); if (b) { await b.click(); break; } }

  const inputSels = [
    'div[role="dialog"] input[type="file"][accept*="image"], div[role="dialog"] input[type="file"][accept*="video"]',
    'div[role="dialog"] input[type="file"][multiple]',
    'div[role="dialog"] input[type="file"]',
  ];
  let inputs = [];
  for (const sel of inputSels) { const hs = await page.$$(sel); if (hs.length) { inputs = hs; break; } }
  if (!inputs.length) {
    await delay(1200);
    for (const sel of inputSels) { const hs = await page.$$(sel); if (hs.length) { inputs = hs; break; } }
  }
  if (!inputs.length) { console.log('❌ ไม่พบ input[type=file] ใน dialog'); return false; }

  let uploaded = false;
  for (const h of inputs) {
    try {
      if (typeof h.setInputFiles === 'function') await h.setInputFiles(absolutePaths);
      else { for (const p of absolutePaths) await h.uploadFile(p); }
      uploaded = true; break;
    } catch {}
  }
  if (!uploaded) { console.log('❌ ส่งไฟล์เข้า input ไม่สำเร็จ'); return false; }

  const ok = await waitForMediaPreviewInDialog(page, 25000);
  console.log(ok ? '📸/🎬 พรีวิวสื่อขึ้นแล้ว' : '⚠️ ส่งไฟล์แล้วแต่ยังไม่เห็นพรีวิว');
  if (!ok) await delay(3000);
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
    await delay(700);
  } catch {}
}

/* ---------- main flow ---------- */
async function postToGroup(page, groupUrl, message) {
  console.log(`\n➡️ ไปที่กลุ่ม: ${groupUrl}`);
  await gotoWithRetry(page, groupUrl, {}, 2);
  await delay(1200);

  let opened = await clickComposer(page);
  if (!opened) {
    console.log('⚠️ หา “เขียนโพสต์” ไม่เจอ → เลื่อนหน้า');
    await page.evaluate(() => window.scrollBy(0, 900));
    await delay(1000);
    opened = await clickComposer(page);
  }
  if (!opened) { console.log('❌ ไม่พบกล่องเริ่มเขียนโพสต์'); return false; }

  await delay(1000);

  const imagePath = path.resolve('./test.png');
  const videoPath = path.resolve('./main.mp4');
  const mediaPaths = [imagePath, videoPath].filter(p => fs.existsSync(p));
  if (mediaPaths.length) await uploadMediaToComposer(page, mediaPaths);
  else console.log('ℹ️ ไม่พบ test.png/main.mp4 — โพสต์เฉพาะข้อความ');

  await page.waitForSelector('div[role="dialog"]', { timeout: 20000 });
  let textbox = await getComposerTextbox(page);
  if (!textbox) { await delay(700); textbox = await getComposerTextbox(page); }
  if (!textbox) { console.log('❌ ไม่พบพื้นที่พิมพ์ข้อความ'); return false; }

  await textbox.el.focus();
  await page.type(textbox.sel, message, { delay: 35 });
  await delay(500);

  await page.waitForFunction(() => {
    const dlg = document.querySelector('div[role="dialog"]'); if (!dlg) return false;
    const btns = Array.from(dlg.querySelectorAll('div[role="button"],button'));
    const btn = btns.find(el => /โพสต์|Post|แชร์|Share/i.test(el.innerText || el.getAttribute('aria-label') || ''));
    if (!btn) return false;
    const disabled = btn.getAttribute('aria-disabled') === 'true' || (btn.className || '').includes('disabled');
    return !disabled;
  }, { timeout: 30000 }).catch(() => {});

  const posted = await clickPostButton(page);
  if (!posted) {
    console.log('❌ ไม่พบปุ่ม “โพสต์”/Post');
    try { await page.screenshot({ path: `cannot_find_post_button_${Date.now()}.png` }); } catch {}
    return false;
  }

  console.log('⏳ กำลังโพสต์...');
  await page.waitForFunction(() => !document.querySelector('div[role="dialog"]'), { timeout: 45000 }).catch(() => {});
  console.log('✅ โพสต์สำเร็จ (คาดว่า)');
  return true;
}

/* ---------- runner & cron ---------- */
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
  if (!BROWSER_WS) { console.error('⛔ ไม่มี ENV "api" → ยกเลิก run'); return; }

  // ต่อไปยัง Remote Chrome (เช่น Browserless)
  const browser = await puppeteerExtra.connect({
    browserWSEndpoint: BROWSER_WS,
    protocolTimeout: 120000,
  });

  const graceful = async () => { try { await browser.disconnect(); } catch {} process.exit(0); };
  process.on('SIGTERM', graceful);
  process.on('SIGINT', graceful);

  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);
  await page.setDefaultTimeout(45000);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7' });
  await page.setBypassCSP(true);

  await enableBlocking(page);     // ลดการโหลดที่ไม่จำเป็น
  await loadCookies(page);        // ใส่คุกกี้จาก ENV

  try { await page.goto('https://web.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {}

  for (let i = 0; i < GROUP_URLS.length; i++) {
    const url = GROUP_URLS[i];
    try {
      await closeAnyDialog(page);
      const ok = await postToGroup(page, url, POST_MESSAGE);

      if (i < GROUP_URLS.length - 1) {
        const waitMs = jitter(5000, 9000);
        console.log(`🕒 รอ ${Math.round(waitMs / 1000)} วิ ก่อนสลับไปกลุ่มถัดไป...`);
        await delay(waitMs);
      }

      if (!ok) console.log('⚠️ กลุ่มนี้โพสต์ไม่สำเร็จ');
    } catch (err) {
      console.error(`❌ เกิดข้อผิดพลาดกับกลุ่ม ${url}:`, err.message);
      await delay(jitter(3000, 7000));
    }
  }

  await browser.disconnect();
}

// รันทันทีเมื่อ start
if (require.main === module) { safeRun(); }
module.exports = { run: safeRun };
