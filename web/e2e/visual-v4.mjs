import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8000";
const OUT = path.resolve(process.cwd(), "..", "artifacts", "final-v4");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
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
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(OUT, `${route}-${theme}${full ? "-full" : ""}.png`),
    fullPage: full,
  });
}

await go("overview", "light");
await go("overview", "dark");
await go("tasks", "light");
await go("tasks", "dark");
await go("calendar", "light");
await go("matrix", "light");
await page.getByRole("button", { name: /网络视图/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, "matrix-network-light.png"), fullPage: true });
await go("matrix", "dark");
await page.getByRole("button", { name: /网络视图/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, "matrix-network-dark.png"), fullPage: true });
await go("matrix", "light");
await page.locator("select.mx-member-filter").selectOption("m-lin");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, "matrix-member-filter-light.png"), fullPage: true });

await go("announcements", "light", false);
const navCountBox = await page.locator(".nav-item").filter({ hasText: "公告栏" }).locator(".nav-count").boundingBox();
console.log("nav-count-size", navCountBox);

await go("calendar", "light", false);
const checkBox = await page.locator(".cal-check").first().boundingBox().catch(() => null);
const titleBox = await page.locator(".cal-todo-title").first().boundingBox().catch(() => null);
console.log("check-center", checkBox ? checkBox.y + checkBox.height / 2 : null);
console.log("title-center", titleBox ? titleBox.y + titleBox.height / 2 : null);

await go("tasks", "dark", false);
const selectStyle = await page.locator(".tasks-filter-select select").first().evaluate((el) => {
  const s = getComputedStyle(el);
  const opt = el.querySelector("option");
  const os = opt ? getComputedStyle(opt) : null;
  return {
    color: s.color,
    background: s.backgroundColor,
    optionColor: os?.color,
    optionBackground: os?.backgroundColor,
  };
});
console.log("task-select-style", selectStyle);
await page.screenshot({ path: path.join(OUT, "tasks-filter-dark.png") });

await go("tasks", "light", false);
await page.getByRole("button", { name: /新建任务/ }).first().click();
await page.locator(".modal-panel").waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, "task-dialog-light.png") });
await page.keyboard.press("Escape");

await go("overview", "light", false);
await page.getByRole("button", { name: /查看 林知夏 的成员档案/ }).click();
await page.locator("#md-title").waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, "member-drawer-light.png") });

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
await mp.waitForTimeout(700);
await mp.screenshot({ path: path.join(OUT, "overview-mobile.png"), fullPage: true });
await mp.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
await mp.waitForTimeout(700);
await mp.screenshot({ path: path.join(OUT, "tasks-mobile.png"), fullPage: true });

await browser.close();
console.log(errors.length ? `ERRORS ${errors.join(" | ")}` : "NO_CONSOLE_ERRORS");
