const puppeteer = require('puppeteer-core');

(async () => {
  // ดึง cookies base64 จาก ENV
  const cookiesBase64 = process.env.FB_COOKIES_BASE64;
  if (!cookiesBase64) {
    console.error('❌ ไม่มีค่า FB_COOKIES_BASE64 ใน Environment');
    process.exit(1);
  }

  // แปลง Base64 เป็น JSON
  let cookies;
  try {
    const cookiesJson = Buffer.from(cookiesBase64, 'base64').toString('utf8');
    cookies = JSON.parse(cookiesJson);
  } catch (err) {
    console.error('❌ แปลง cookies base64 เป็น JSON ไม่สำเร็จ:', err);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: '/usr/bin/google-chrome', // ปรับ path ให้ตรงกับระบบที่ใช้บน Render
  });

  const page = await browser.newPage();

  // ตั้ง cookies ให้กับเพจ
  await page.setCookie(...cookies);

  // เข้า Facebook
  await page.goto('https://www.facebook.com/');
  await page.waitForTimeout(3000);

  console.log('✅ ล็อกอิน Facebook สำเร็จด้วย cookies');

  // ทำงานอื่น ๆ ตามต้องการที่นี่...

  await browser.close();
})();
