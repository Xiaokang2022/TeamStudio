import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
const OUT = path.resolve(process.cwd(), "..", "artifacts", "final-v3");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(e.message));

async function go(route, theme = "light", full = true) {
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
  await page.evaluate((mode) => localStorage.setItem("teamstudio.theme", mode), theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${route}-${theme}${full ? "-full" : ""}.png`), fullPage: full });
  console.log(`captured ${route} ${theme}`);
}

await go("overview", "light");
await go("overview", "dark");
await go("tasks", "light");
await go("tasks", "dark");
await go("calendar", "light");
await go("matrix", "light");
await go("settings", "light");

// Task dialog light/dark
await go("tasks", "light", false);
await page.getByRole("button", { name: /新建任务/ }).first().click();
await page.locator(".modal-panel").waitFor();
await page.waitForTimeout(450);
await page.screenshot({ path: path.join(OUT, "task-dialog-light.png") });
await page.keyboard.press("Escape");

// Member drawer
await go("overview", "light", false);
await page.getByRole("button", { name: /查看 林知夏 的成员档案/ }).click();
await page.locator("#md-title").waitFor();
await page.waitForTimeout(450);
await page.screenshot({ path: path.join(OUT, "member-drawer-light.png") });
await page.keyboard.press("Escape");

// About light
await go("overview", "light", false);
await page.locator(".user-chip").click();
await page.locator(".user-popover .menu-row").filter({ hasText: "关于团队工作室" }).click();
await page.locator(".about-dialog").waitFor();
await page.waitForTimeout(450);
await page.screenshot({ path: path.join(OUT, "about-light.png") });
await page.keyboard.press("Escape");

// Login light
await go("login", "light", false);
await page.screenshot({ path: path.join(OUT, "login-light.png") });

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
});
const mp = await mobile.newPage();
mp.on("pageerror", (e) => errors.push(e.message));
await mp.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await mp.waitForTimeout(800);
await mp.screenshot({ path: path.join(OUT, "overview-mobile.png"), fullPage: true });
await mp.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
await mp.waitForTimeout(800);
await mp.screenshot({ path: path.join(OUT, "tasks-mobile.png"), fullPage: true });

await browser.close();
console.log(errors.length ? `ERRORS: ${errors.join(" | ")}` : "NO_CONSOLE_ERRORS");
