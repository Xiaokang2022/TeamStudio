import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8000";
const OUT = "../docs/screenshots";
const browser = await chromium.launch({ channel: "msedge", headless: true });

async function capture({ width = 1440, height = 1000, theme = "light", scope = "group", route, name, fullPage = false }) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(([t, s]) => { localStorage.setItem("teamstudio.theme", t); localStorage.setItem("teamstudio.scope", s); }, [theme, scope]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage, animations: "disabled" });
  console.log("saved", name);
  await ctx.close();
}

await capture({ route: "overview", name: "overview" });
await capture({ route: "overview", name: "overview-dark", theme: "dark" });
await capture({ route: "overview", name: "overview-full", fullPage: true });
await capture({ route: "overview", name: "overview-scope-all", scope: "all" });
await capture({ route: "tasks", name: "tasks" });
await capture({ route: "tasks", name: "tasks-dark", theme: "dark" });
await capture({ route: "insights", name: "insights" });
await capture({ route: "insights", name: "insights-dark", theme: "dark" });
await capture({ route: "overview", name: "overview-mobile", width: 390, height: 844, fullPage: true });
await capture({ route: "tasks", name: "tasks-mobile", width: 390, height: 844, fullPage: true });

await browser.close();
