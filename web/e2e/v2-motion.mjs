import { chromium } from "playwright";
const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript(() => { localStorage.setItem("teamstudio.theme.preference", "light"); });
const page = await ctx.newPage();
const errors = []; page.on("console", m => m.type()==="error" && errors.push(m.text())); page.on("pageerror", e=>errors.push(String(e)));

// insights tooltip edges + animations
await page.goto(`${BASE}/#/insights`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const anim = await page.evaluate(() => {
  const bar = document.querySelector(".ins-bar");
  const kpi = document.querySelector(".ins-kpi");
  const range = document.querySelector(".ins-range-btn.active");
  return {
    bar: bar ? getComputedStyle(bar).animationName : null,
    kpi: kpi ? getComputedStyle(kpi).animationName : null,
    range: range ? getComputedStyle(range).animationName : null,
  };
});
const cols = page.locator(".ins-chart-col");
const n = await cols.count();
const tips = [];
for (const idx of [0, n - 1]) {
  await cols.nth(idx).hover();
  await page.waitForTimeout(280);
  tips.push(await page.evaluate(() => {
    const el = document.querySelector(".ins-chart-tip.is-floating");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), right: Math.round(r.right), inside: r.x >= 0 && r.right <= window.innerWidth && r.y >= 0 };
  }));
}
console.log("INSIGHTS", JSON.stringify({ anim, n, tips }));

// task page remount + animation
await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
const before = await page.evaluate(() => document.querySelectorAll(".tasks-table tbody tr").length);
const rangeButtons = page.locator(".tasks-range-btn");
await rangeButtons.nth(0).click();
await page.waitForTimeout(120);
const taskAnim = await page.evaluate(() => {
  const tr = document.querySelector(".tasks-table tbody tr");
  const active = document.querySelector(".tasks-range-btn.active");
  return { rows: document.querySelectorAll(".tasks-table tbody tr").length, rowAnim: tr ? getComputedStyle(tr).animationName : null, rangeAnim: active ? getComputedStyle(active).animationName : null };
});
await page.waitForTimeout(700);
console.log("TASKS", JSON.stringify({ before, ...taskAnim }));

// links list transition
await page.goto(`${BASE}/#/links`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const chips = page.locator(".links-chips button");
console.log("LINK_CHIPS", await chips.count());
if (await chips.count()) {
  await chips.nth(1).click();
  await page.waitForTimeout(150);
  const linkAnim = await page.evaluate(() => { const g = document.querySelector(".links-grid"); return { anim: g ? getComputedStyle(g).animationName : null, cards: document.querySelectorAll(".links-card").length }; });
  console.log("LINKS", JSON.stringify(linkAnim));
}

// matrix view transition
await page.goto(`${BASE}/#/matrix`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const netBtn = page.getByRole("button", { name: /网络视图/ }).first();
await netBtn.click();
await page.waitForTimeout(150);
const mxAnim = await page.evaluate(() => { const n = document.querySelector(".mx-network"); return n ? getComputedStyle(n).animationName : null; });
await page.waitForTimeout(500);
console.log("MATRIX", JSON.stringify({ mxAnim }));

console.log("ERRORS", JSON.stringify(errors.slice(0, 5)));
await browser.close();
