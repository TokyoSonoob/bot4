// index.js
const puppeteer = require("puppeteer-core");
const fs = require("fs");

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: "/usr/bin/google-chrome", // Render ต้องติดตั้ง Chrome เอง
  });

  const page = await browser.newPage();
  const cookies = JSON.parse(fs.readFileSync("./cookies.json", "utf8"));
  await page.setCookie(...cookies);

  await page.goto("https://www.facebook.com/");
  await page.waitForTimeout(3000);

  console.log("✅ ล็อกอินด้วย cookies สำเร็จ");

  // 👇 เพิ่ม logic ตรวจโพสต์หรือคอมเมนต์ต่อได้ตรงนี้
  await browser.close();
})();
