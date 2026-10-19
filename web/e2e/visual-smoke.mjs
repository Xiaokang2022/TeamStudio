import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
const OUT = path.resolve(process.cwd(), "..", "artifacts");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
  deviceScaleFactor: 1,
  locale: "zh-CN",
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

async function open(route, name, { dark = false, fullPage = true } = {}) {
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
  await page.evaluate((isDark) => {
    localStorage.setItem("teamstudio.theme", isDark ? "dark" : "light");
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  }, dark);
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    fullPage,
  });
  console.log(`captured ${name} (${route})`);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await open("overview", "overview-full");
await open("calendar", "calendar-full");
await open("redblack", "redblack-full");
await open("links", "links-full");
await open("matrix", "matrix-full");
await open("announcements", "announcements-full");
await open("settings", "settings-full");
await open("overview", "overview-dark", { dark: true });
await open("login", "login", { dark: false });

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
});
const mobilePage = await mobile.newPage();
mobilePage.on("console", (message) => {
  if (message.type() === "error") errors.push(`mobile console: ${message.text()}`);
});
mobilePage.on("pageerror", (error) => errors.push(`mobile pageerror: ${error.message}`));
await mobilePage.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await mobilePage.waitForTimeout(800);
await mobilePage.screenshot({ path: path.join(OUT, "overview-mobile.png"), fullPage: true });
await mobilePage.goto(`${BASE}/#/calendar`, { waitUntil: "networkidle" });
await mobilePage.waitForTimeout(600);
await mobilePage.screenshot({ path: path.join(OUT, "calendar-mobile.png"), fullPage: true });

await browser.close();
if (errors.length) {
  console.error("BROWSER_ERRORS");
  errors.forEach((error) => console.error(error));
  process.exitCode = 1;
} else {
  console.log("NO_BROWSER_ERRORS");
}
