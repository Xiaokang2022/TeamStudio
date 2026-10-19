import { chromium } from "playwright";
const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await context.addInitScript(() => localStorage.setItem("teamstudio.theme", "dark"));
const page = await context.newPage();
await page.goto(`${BASE}/#/settings?tab=modules`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const info = await page.evaluate(() => {
  const row = document.querySelector(".settings-module-toggle.is-on");
  const box = row.getBoundingClientRect();
  const nodes = [];
  const walk = (el, depth) => {
    if (depth > 6) return;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const paints = s.borderTopWidth !== "0px" || s.borderBottomWidth !== "0px" || s.boxShadow !== "none" || (s.backgroundImage !== "none") || (s.backgroundColor !== "rgba(0, 0, 0, 0)" && depth > 0);
    if (paints) nodes.push({
      tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 70), depth,
      rect: [Math.round(r.x - box.x), Math.round(r.y - box.y), Math.round(r.width), Math.round(r.height)],
      border: `${s.borderTopWidth}/${s.borderBottomWidth}`, shadow: s.boxShadow.slice(0, 90),
      bg: s.backgroundColor, bgImg: s.backgroundImage.slice(0, 60), opacity: s.opacity,
    });
    [...el.children].forEach((c) => walk(c, depth + 1));
  };
  walk(row, 0);
  return { box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], nodes };
});
console.log(JSON.stringify(info, null, 1));
await page.locator(".settings-module-toggle").first().screenshot({ path: "../artifacts/mod-line-dark.png", animations: "disabled" });
await browser.close();
