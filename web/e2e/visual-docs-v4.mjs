import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8000";
const OUT = path.resolve(process.cwd(), "..", "artifacts", "docs-v4");
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

async function go(route, theme = "light") {
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
  await page.evaluate((mode) => localStorage.setItem("teamstudio.theme", mode), theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(750);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(250);
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, name) });
  console.log(name);
}

await go("overview", "light");
await shot("overview.png");
await go("overview", "dark");
await shot("overview-dark.png");
await go("tasks", "light");
await shot("tasks.png");
await go("tasks", "dark");
await shot("tasks-dark.png");

await go("tasks", "light");
await page.getByRole("button", { name: /新建任务/ }).first().click();
await page.locator(".modal-panel").waitFor();
await page.waitForTimeout(450);
await shot("task-dialog.png");
await page.keyboard.press("Escape");

await go("overview", "light");
await page.getByRole("button", { name: /查看 林知夏 的成员档案/ }).click();
await page.locator("#md-title").waitFor();
await page.waitForTimeout(450);
await shot("member-drawer.png");
await page.keyboard.press("Escape");

await go("calendar", "light");
await page.locator(".cal-cell").filter({ hasText: "20" }).first().click();
await page.waitForTimeout(350);
await shot("calendar.png");

await go("matrix", "light");
await shot("matrix.png");
await page.getByRole("button", { name: /网络视图/ }).click();
await page.waitForTimeout(600);
await shot("matrix-network.png");
await page.locator("select.mx-member-filter").selectOption("m-lin");
await page.waitForTimeout(400);
await shot("matrix-network-member.png");

await go("settings", "light");
await shot("settings.png");

await go("overview", "light");
await page.locator(".user-chip").click();
await page.locator(".user-popover .menu-row").filter({ hasText: "关于团队工作室" }).click();
await page.locator(".about-dialog").waitFor();
await page.waitForTimeout(450);
await shot("about-dialog.png");
await page.keyboard.press("Escape");

await go("login", "light");
await shot("login.png");

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
});
const mp = await mobile.newPage();
await mp.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await mp.waitForTimeout(700);
await mp.screenshot({ path: path.join(OUT, "overview-mobile.png") });
await mp.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
await mp.waitForTimeout(700);
await mp.screenshot({ path: path.join(OUT, "tasks-mobile.png") });

await browser.close();
console.log(errors.length ? `ERRORS ${errors.join(" | ")}` : "NO_CONSOLE_ERRORS");
