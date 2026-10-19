import { chromium } from "playwright";
const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript(() => { localStorage.setItem("teamstudio.theme", "light"); localStorage.setItem("teamstudio.scope", "group"); });
const page = await ctx.newPage();
const errors = []; page.on("console", m => m.type()==="error" && errors.push(m.text())); page.on("pageerror", e=>errors.push(String(e)));

await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "../artifacts/v2-overview-light.png", animations: "disabled" });
const ov = await page.evaluate(() => ({
  cols: getComputedStyle(document.querySelector(".ov-member-grid")).gridTemplateColumns,
  cards: document.querySelectorAll(".ov-member-card").length,
  side: !!document.querySelector(".ov-side .ov-activity-panel"),
  workloadPanel: !!document.querySelector(".ov-workload-panel"),
  railPos: (() => { const r = document.querySelector(".ov-side").getBoundingClientRect(); const m = document.querySelector(".ov-members").getBoundingClientRect(); return { sideLeft: Math.round(r.left), membersRight: Math.round(m.right), sideWidth: Math.round(r.width) }; })(),
}));
console.log("OVERVIEW", JSON.stringify(ov));

await page.locator(".about-trigger").click().catch(()=>{});
await page.keyboard.press("Escape").catch(()=>{});
await page.waitForTimeout(200);

// dark modules line
const dark = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await dark.addInitScript(() => localStorage.setItem("teamstudio.theme", "dark"));
const dp = await dark.newPage();
await dp.goto(`${BASE}/#/settings?tab=modules`, { waitUntil: "networkidle" });
await dp.waitForTimeout(1200);
await dp.locator(".settings-module-toggle").first().screenshot({ path: "../artifacts/v2-mod-line-dark.png", animations: "disabled" });
const shadow = await dp.evaluate(() => getComputedStyle(document.querySelector(".settings-module-toggle .settings-toggle-row")).boxShadow);
console.log("ROW_SHADOW", shadow);

// tasks select
const tp = await page;
await tp.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
await tp.waitForTimeout(1000);
await tp.screenshot({ path: "../artifacts/v2-tasks-filter-light.png", animations: "disabled" });
const trigger = tp.locator(".tasks-filter-select-custom .ts-select-trigger").first();
await trigger.click();
await tp.waitForTimeout(400);
await tp.screenshot({ path: "../artifacts/v2-tasks-select-open-light.png" });
const selCount = await tp.evaluate(() => ({ custom: document.querySelectorAll(".tasks-filter-select-custom .ts-select").length, natives: document.querySelectorAll(".tasks-filters select").length }));
console.log("TASKS_SELECT", JSON.stringify(selCount));
await tp.keyboard.press("Escape");

// insights tooltip
await tp.goto(`${BASE}/#/insights`, { waitUntil: "networkidle" });
await tp.waitForTimeout(1300);
const col = tp.locator(".ins-chart-col").nth(3);
await col.hover();
await tp.waitForTimeout(400);
await tp.screenshot({ path: "../artifacts/v2-insights-tooltip-light.png" });
const tip = await tp.evaluate(() => {
  const el = document.querySelector(".ins-chart-tip.is-floating");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const parent = el.parentElement?.tagName;
  return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], parent, z: getComputedStyle(el).zIndex, visible: getComputedStyle(el).visibility };
});
console.log("TOOLTIP", JSON.stringify(tip));
await tp.waitForTimeout(400);
await tp.screenshot({ path: "../artifacts/v2-insights-light.png", animations: "disabled" });

// mobile overview
const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
await mob.addInitScript(() => { localStorage.setItem("teamstudio.theme", "light"); localStorage.setItem("teamstudio.scope", "group"); });
const mp = await mob.newPage();
await mp.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await mp.waitForTimeout(1000);
const mobMetrics = await mp.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth + 2, cols: getComputedStyle(document.querySelector(".ov-member-grid")).gridTemplateColumns }));
console.log("MOBILE", JSON.stringify(mobMetrics));
await mp.screenshot({ path: "../artifacts/v2-overview-mobile.png", fullPage: false, animations: "disabled" });

console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await browser.close();
