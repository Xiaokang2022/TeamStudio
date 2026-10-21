/**
 * Responsive + console audit for every route at mobile/tablet widths.
 * Usage: node e2e/lead-responsive.mjs   (QA_URL defaults to http://127.0.0.1:8000)
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const routes = [
  "overview",
  "tasks",
  "insights",
  "calendar",
  "redblack",
  "links",
  "matrix",
  "announcements",
  "settings?tab=appearance",
  "settings?tab=modules",
  "settings?tab=email",
  "settings?tab=json",
  "login",
];
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
];
const problems = [];

const browser = await chromium.launch({ channel: "msedge", headless: true });

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  await context.addInitScript(() => {
    localStorage.setItem("teamstudio.theme.preference", "light");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  for (const route of routes) {
    errors.length = 0;
    await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(650);
    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflowing = [...document.querySelectorAll("body *")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.right > window.innerWidth + 2;
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")}`);
      return {
        scrollWidth: doc.scrollWidth,
        innerWidth: window.innerWidth,
        overflow: doc.scrollWidth > window.innerWidth + 2,
        offenders: overflowing,
      };
    });
    if (metrics.overflow) {
      problems.push({ viewport: viewport.name, route, kind: "horizontal-overflow", ...metrics });
    }
    if (errors.length) {
      problems.push({ viewport: viewport.name, route, kind: "console-error", errors: errors.slice(0, 3) });
    }
  }
  await context.close();
}

/* dark theme pass on the data-heavy routes */
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem("teamstudio.theme.preference", "dark");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const route of ["overview", "tasks", "insights", "redblack", "links", "matrix", "announcements"]) {
    errors.length = 0;
    await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    if (errors.length) problems.push({ viewport: "desktop-dark", route, kind: "console-error", errors: errors.slice(0, 3) });
  }
  await context.close();
}

await browser.close();
console.log(JSON.stringify({ problems }, null, 1));
if (problems.length) process.exitCode = 1;
