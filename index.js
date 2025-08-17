require('dotenv').config();
const fs = require('fs');
const path = require('path');

const puppeteer = require('puppeteer-extra');
const Stealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const COOKIES_PATH = process.env.cookies;
const GROUP_URLS = [
  'https://web.facebook.com/groups/communitycraft',
  'https://web.facebook.com/groups/506463258587188'
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

          𝑴𝒖𝒚 - 𝑺𝒌𝒚 - 𝑯𝒊𝒌𝒆𝒓𝒊 - 𝑵𝑱 - 𝑲𝒊𝒎
       ราคาเป็นกันเอง - ตามงานได้ตลอด

   ✦• ประมูลทุกวัน จันทร์ • พุธ • ศุกร์ ✦•
             สามารถฝากประมูลได้

    𓆩♡𓆪 สนใจให้กดที่ด้านล่างเยยย
    https://discord.gg/jHhQETebMm
    
    `;


const COMPOSER_KEYWORDS = [
  'เขียน',
  'เขียนโพสต์',
  'Write something',
  'Create post',
  'โพสต์'
];


const POST_BUTTON_ARIA = [
  'โพสต์', 'Post', 'แชร์', 'Share'
];

const delay = ms => new Promise(r => setTimeout(r, ms));

async function loadCookies(page) {
  try {
    if (!fs.existsSync(COOKIES_PATH)) return false;
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    await page.setCookie(...cookies);
    console.log('✅ โหลด cookies สำเร็จ');
    return true;
  } catch (e) {
    console.log('❌ โหลด cookies ไม่สำเร็จ:', e.message);
    return false;
  }
}

async function saveCookies(page) {
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('✅ บันทึก cookies สำเร็จ');
}

// หาปุ่ม/องค์ประกอบที่ “มีข้อความนี้” และไม่ใช่คอมเมนต์
async function findButtonByText(page, keywords, { role = 'button', exclude = ['ความคิดเห็น'] } = {}) {
  const handles = await page.$$(`div[role="${role}"], span[role="${role}"], a[role="${role}"]`);
  for (const h of handles) {
    const text = (await page.evaluate(el => el.innerText || '', h)).trim();
    if (!text) continue;
    if (exclude.some(ex => text.includes(ex))) continue;
    if (keywords.some(k => text.includes(k))) return h;
  }
  return null;
}

// หา textbox ที่ใช้พิมพ์โพสต์ (หลากหลาย selector)
async function getComposerTextbox(page) {
  const selectors = [
    'div[role="dialog"] div[role="textbox"]', // กล่องในไดอะล็อก
    'div[aria-label][role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    'div[role="textbox"]'
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return { el, sel };
  }
  return null;
}

async function ensureLoggedIn(page) {
  // ถ้าเข้าไปแล้วเจอ login page ให้ลองล็อกอินด้วย EMAIL/PASSWORD
  if (!(page.url().includes('facebook.com/login') || page.url().includes('checkpoint'))) return true;
  const email = process.env.FB_EMAIL;
  const pass = process.env.FB_PASSWORD;

  if (!email || !pass) {
    console.log('❌ ยังไม่ login และไม่มี FB_EMAIL/FB_PASSWORD ใน .env');
    return false;
  }

  console.log('🔐 พยายามล็อกอินด้วยบัญชีจาก .env ...');
  try {
    await page.waitForSelector('#email', { timeout: 15000 });
    await page.type('#email', email, { delay: 40 });
    await page.type('#pass', pass, { delay: 40 });
    const loginBtn = await page.$('button[name="login"], #loginbutton');
    if (loginBtn) await loginBtn.click(); else await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });
    // ถ้ายังติด checkpoint ก็ถือว่าไม่สำเร็จ
    if (page.url().includes('checkpoint')) {
      console.log('⚠️ ติด checkpoint (2FA/verify). ต้องยืนยันด้วยตัวเองครั้งแรกในเบราว์เซอร์จริง');
      return false;
    }
    console.log('✅ ล็อกอินสำเร็จ');
    return true;
  } catch (e) {
    console.log('❌ ล็อกอินล้มเหลว:', e.message);
    return false;
  }
}

async function clickComposer(page) {
  let btn = await findButtonByText(page, COMPOSER_KEYWORDS, { role: 'button', exclude: ['ความคิดเห็น'] });
  if (!btn) {
    const xpathCandidates = [
      `//div[@role="button" and contains(., "เขียน") and not(contains(., "ความคิดเห็น"))]`,
      `//div[@role="button" and (contains(., "Write") or contains(., "Create post"))]`,
      `//span[contains(., "เขียน") and not(contains(., "ความคิดเห็น"))]/ancestor::div[@role="button"]`
    ];
    for (const xp of xpathCandidates) {
      const [handle] = await page.$x(xp);
      if (handle) { btn = handle; break; }
    }
  }
  if (!btn) return false;
  await btn.click();
  return true;
}

async function clickPostButton(page) {
  for (const label of POST_BUTTON_ARIA) {
    const sel = `div[aria-label="${label}"], span[aria-label="${label}"]`;
    const el = await page.$(sel);
    if (el) { await el.click(); return true; }
  }
  const [fallback] = await page.$x(
    `//div[@role="dialog"]//div[@role="button" and (contains(., "โพสต์") or contains(., "Post") or contains(., "แชร์") or contains(., "Share"))]`
  );
  if (fallback) { await fallback.click(); return true; }

  return false;
}


async function waitForMediaPreviewInDialog(page, timeout = 20000) {
  // รอให้มีรูป/วิดีโอพรีวิวใน dialog
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      if (!dlg) return false;
      const hasImg =
        dlg.querySelector('img[src^="blob:"]') ||
        dlg.querySelector('img[alt*="รูป"], img[alt*="photo"], img[alt*="image"]');
      const hasVideo =
        dlg.querySelector('video') ||
        dlg.querySelector('div[aria-label*="วิดีโอ"], div[aria-label*="Video"]');
      return !!(hasImg || hasVideo);
    });
    if (ok) return true;
    await delay(500);
  }
  return false;
}

async function uploadMediaToComposer(page, absolutePaths = []) {
  // 1) พยายามกดปุ่มเพิ่มรูป/วิดีโอก่อน (รองรับหลายข้อความ)
  const addMediaSelectors = [
    'div[aria-label="รูปภาพ/วิดีโอ"]',
    'div[aria-label="เพิ่มรูปภาพ/วิดีโอ"]',
    'div[aria-label="รูปภาพ"]',
    'div[aria-label="วิดีโอ"]',
    'div[aria-label="Photo/Video"]',
    'div[aria-label="Add photo/video"]',
  ];
  let clicked = false;
  for (const sel of addMediaSelectors) {
    const btn = await page.$(`div[role="dialog"] ${sel}, ${sel}`);
    if (btn) { await btn.click(); clicked = true; break; }
  }
  if (!clicked) console.log('⚠️ ไม่เจอปุ่มเพิ่มรูป/วิดีโอ จะลองหาช่องไฟล์โดยตรง');

  // 2) หา input[type=file] ภายใน dialog (รองรับทั้งรูป/วิดีโอ)
  const inputSelectors = [
    'div[role="dialog"] input[type="file"][accept*="image"], div[role="dialog"] input[type="file"][accept*="video"]',
    'div[role="dialog"] input[type="file"][multiple]',
    'div[role="dialog"] input[type="file"]',
  ];
  let inputs = [];
  for (const sel of inputSelectors) {
    const hs = await page.$$(sel);
    if (hs.length) { inputs = hs; break; }
  }
  if (!inputs.length) {
    await delay(1500);
    for (const sel of inputSelectors) {
      const hs = await page.$$(sel);
      if (hs.length) { inputs = hs; break; }
    }
  }
  if (!inputs.length) {
    console.log('❌ ไม่พบ input[type=file] ใน dialog');
    return false;
  }

  console.log(`🔎 พบ input[type=file] ${inputs.length} ช่อง กำลังอัปโหลดไฟล์ ${absolutePaths.length} ไฟล์...`);

  // 3) set ไฟล์ (หลายไฟล์พร้อมกัน ถ้ารองรับ multiple; ไม่งั้นยิงทีละไฟล์)
  let uploaded = false;
  for (const h of inputs) {
    try {
      if (typeof h.setInputFiles === 'function') {
        await h.setInputFiles(absolutePaths);
      } else {
        // fallback ทีละไฟล์
        for (const p of absolutePaths) await h.uploadFile(p);
      }
      uploaded = true;
      break;
    } catch (_) { /* ลองตัวถัดไป */ }
  }
  if (!uploaded) {
    console.log('❌ ส่งไฟล์เข้า input ไม่สำเร็จ');
    return false;
  }

  // 4) รอให้ preview ขึ้น
  const ok = await waitForMediaPreviewInDialog(page, 20000);
  if (ok) {
    console.log('📸/🎬 พรีวิวสื่อขึ้นแล้ว');
    return true;
  }
  console.log('⚠️ ส่งไฟล์แล้วแต่ยังไม่เห็นพรีวิว');
  return false;
}



const jitter = (minMs, maxMs) => Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

async function closeAnyDialog(page) {
  // เผื่อ dialog ค้างจากโพสต์ก่อนหน้า
  try {
    await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      if (!dlg) return;
      // หา X close
      const btns = Array.from(dlg.querySelectorAll('div[role="button"],button'));
      const closeBtn = btns.find(b =>
        /ปิด|Close|ยกเลิก|Cancel/i.test(b.innerText || '') ||
        b.getAttribute('aria-label')?.match(/ปิด|Close|ยกเลิก|Cancel/i)
      );
      closeBtn?.click();
    });
    await delay(800);
  } catch {}
}

// โพสต์ให้ครบ 1 กลุ่ม (รีไซเคิลโค้ดจากที่คุณมีอยู่แล้ว)
async function postToGroup(page, groupUrl, POST_MESSAGE) {
  console.log(`\n➡️ ไปที่กลุ่ม: ${groupUrl}`);
  // ไปหน้ากลุ่ม
  await page.goto(groupUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // ถ้าหลุด login ให้เช็ค
  if (!(await ensureLoggedIn(page))) return false;

  // รอให้ timeline โหลด
  await delay(2500);

  // เปิด composer
  let opened = await clickComposer(page);
  if (!opened) {
    console.log('⚠️ หา “เขียนโพสต์” ไม่เจอ รอบที่ 1 ลองเลื่อนหน้าก่อน');
    await page.evaluate(() => window.scrollBy(0, 800));
    await delay(1400);
    opened = await clickComposer(page);
  }
  if (!opened) {
    console.log('❌ ไม่พบกล่องเริ่มเขียนโพสต์');
    return false;
  }

  // รอให้กล่องโพสต์เสถียร
  await delay(1800);

  // ====== อัปโหลดสื่อ (test.png + main.mp4 ถ้ามี) ======
  const imagePath = path.resolve('./test.png');
  const videoPath = path.resolve('./main.mp4');
  const mediaPaths = [imagePath, videoPath].filter(p => fs.existsSync(p));

  if (mediaPaths.length) {
    // คลิกปุ่มสื่อ (ไทย/อังกฤษ หลายแบบ)
    const addMediaSelectors = [
      'div[aria-label="รูปภาพ/วิดีโอ"]',
      'div[aria-label="เพิ่มรูปภาพ/วิดีโอ"]',
      'div[aria-label="รูปภาพ"]',
      'div[aria-label="วิดีโอ"]',
      'div[aria-label="Photo/Video"]',
      'div[aria-label="Add photo/video"]'
    ];
    let clicked = false;
    for (const sel of addMediaSelectors) {
      const btn = await page.$(`div[role="dialog"] ${sel}, ${sel}`);
      if (btn) { await btn.click(); clicked = true; break; }
    }
    if (!clicked) console.log('⚠️ ไม่พบปุ่มเพิ่มรูป/วิดีโอ จะลองหาช่องไฟล์โดยตรง');

    // หา input[type=file] ใน dialog
    let inputs = [];
    const inputSelectors = [
      'div[role="dialog"] input[type="file"][accept*="image"], div[role="dialog"] input[type="file"][accept*="video"]',
      'div[role="dialog"] input[type="file"][multiple]',
      'div[role="dialog"] input[type="file"]'
    ];
    for (const sel of inputSelectors) {
      const hs = await page.$$(sel);
      if (hs.length) { inputs = hs; break; }
    }
    if (!inputs.length) {
      await delay(1500);
      for (const sel of inputSelectors) {
        const hs = await page.$$(sel);
        if (hs.length) { inputs = hs; break; }
      }
    }
    if (!inputs.length) {
      console.log('❌ ไม่พบ input[type=file] ภายใน dialog');
    } else {
      console.log(`🔎 พบ input[type=file] ${inputs.length} ช่อง — กำลังอัปโหลด ${mediaPaths.length} ไฟล์...`);
      let uploaded = false;
      for (const h of inputs) {
        try {
          if (typeof h.setInputFiles === 'function') {
            await h.setInputFiles(mediaPaths);
          } else {
            for (const p of mediaPaths) await h.uploadFile(p);
          }
          uploaded = true;
          break;
        } catch {}
      }
      if (uploaded) {
        const previewOk = await page.waitForFunction(() => {
          const dlg = document.querySelector('div[role="dialog"]');
          if (!dlg) return false;
          const hasImg = dlg.querySelector('img[src^="blob:"]') ||
                         dlg.querySelector('img[alt*="รูป"], img[alt*="photo"], img[alt*="image"]');
          const hasVideo = dlg.querySelector('video') ||
                           dlg.querySelector('[aria-label*="วิดีโอ"], [aria-label*="Video"]');
          return !!(hasImg || hasVideo);
        }, { timeout: 25000 }).catch(() => false);
        console.log(previewOk ? '📸/🎬 พรีวิวสื่อขึ้นแล้ว' : '⚠️ ส่งไฟล์แล้วแต่ยังไม่เห็นพรีวิว');
        if (!previewOk) await delay(4000);
      } else {
        console.log('❌ ใส่ไฟล์เข้า input ไม่สำเร็จ');
      }
    }
  } else {
    console.log('ℹ️ ไม่พบ test.png/main.mp4 — โพสต์เฉพาะข้อความ');
  }

  // พิมพ์ข้อความ
  await page.waitForSelector('div[role="dialog"]', { timeout: 20000 });
  let textbox = await getComposerTextbox(page);
  if (!textbox) { await delay(900); textbox = await getComposerTextbox(page); }
  if (!textbox) { console.log('❌ ไม่พบพื้นที่พิมพ์ข้อความโพสต์'); return false; }
  await textbox.el.focus();
  await page.type(textbox.sel, POST_MESSAGE, { delay: 40 });
  await delay(800);

  // รอปุ่มโพสต์พร้อม (บางทีเทารอประมวลผลสื่อ)
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('div[role="button"]'));
    const btn = btns.find(el => /โพสต์|Post|แชร์|Share/i.test(el.innerText || ''));
    if (!btn) return true;
    const disabled = btn.getAttribute('aria-disabled') === 'true' || (btn.className||'').includes('disabled');
    return !disabled;
  }, { timeout: 30000 }).catch(() => {});

  // กดโพสต์
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


const cron = require('node-cron');

// กันงานชนกัน ถ้ายังโพสต์รอบก่อนอยู่ ให้ข้ามรอบนี้
let isRunning = false;
async function safeRun() {
  if (isRunning) {
    console.log('⏳ งานก่อนหน้ายังไม่จบ ข้ามรอบนี้ไปก่อน');
    return;
  }
  isRunning = true;
  try {
    await run();
  } catch (e) {
    console.error('❌ run() ล้มเหลว:', e);
  } finally {
    isRunning = false;
  }
}



// ⏰ ตั้งเวลาตามโซนไทย Asia/Bangkok
// 12:00 น. ทุกวัน
cron.schedule('0 12 * * *', () => {
  console.log('🕛 ถึงเวลา 12:00 Asia/Bangkok → เริ่มโพสต์');
  safeRun();
}, { timezone: 'Asia/Bangkok' });

// 00:00 น. ทุกวัน
cron.schedule('0 0 * * *', () => {
  console.log('🕛 ถึงเวลา 00:00 Asia/Bangkok → เริ่มโพสต์');
  safeRun();
}, { timezone: 'Asia/Bangkok' });



async function run() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--lang=th-TH,th,en-US,en',
      '--disable-blink-features=AutomationControlled'
    ],
    defaultViewport: { width: 1366, height: 768 }
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  await loadCookies(page);

  for (let i = 0; i < GROUP_URLS.length; i++) {
    const url = GROUP_URLS[i];
    try {
      // กัน dialog ค้างจากรอบก่อน
      await closeAnyDialog(page);

      // โพสต์กลุ่มนี้
      const ok = await postToGroup(page, url, POST_MESSAGE);

      // เซฟคุกกี้ทุกครั้งที่จบ 1 กลุ่ม
      await saveCookies(page);

      // ดีเลย์ระหว่างสลับกลุ่ม (สุ่ม 5–9 วิ)
      if (i < GROUP_URLS.length - 1) {
        const waitMs = jitter(5000, 9000);
        console.log(`🕒 รอ ${Math.round(waitMs/1000)} วิ ก่อนสลับไปกลุ่มถัดไป...`);
        await delay(waitMs);
      }

      if (!ok) console.log('⚠️ กลุ่มนี้โพสต์ไม่สำเร็จ (ดู log ด้านบน)');

    } catch (err) {
      console.error(`❌ เกิดข้อผิดพลาดกับกลุ่ม ${url}:`, err.message);
      // เว้นระยะก่อนลองกลุ่มถัดไป
      await delay(jitter(4000, 8000));
    }
  }

  await browser.close();
}
