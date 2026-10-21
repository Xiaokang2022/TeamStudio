/**
 * Refresh the documentation screenshots that still showed the pre-optimization UI.
 * Writes straight into ../docs/screenshots (tracked assets), 1440x1000 or 390x844.
 *
 * Usage: node e2e/lead-docs-shots.mjs   (QA_URL defaults to http://127.0.0.1:8000)
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const OUT = "../docs/screenshots";

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function makePage({ width = 1440, height = 1000, theme = "light" } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(
    (t) => {
      localStorage.setItem("teamstudio.theme.preference", t);
    },
    theme,
  );
  const page = await context.newPage();
  return { context, page };
}

const shot = (page, name, fullPage = false) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage, animations: "disabled" });

/* ---------------- desktop light ---------------- */
{
  const { context, page } = await makePage();
  await page.goto(`${BASE}/#/settings?tab=appearance`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await shot(page, "settings");

  await page.goto(`${BASE}/#/redblack`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await shot(page, "redblack");

  await page.goto(`${BASE}/#/matrix`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await shot(page, "matrix");

  const networkToggle = page.getByRole("button", { name: /网络视图/ }).first();
  if (await networkToggle.count()) {
    await networkToggle.click();
    await page.waitForTimeout(800);
  }
  await shot(page, "matrix-network");

  // Member filter uses the custom Select now.
  const filterTrigger = page.locator(".ts-select-trigger").first();
  if (await filterTrigger.count()) {
    await filterTrigger.click();
    await page.waitForTimeout(350);
    const option = page.locator(".ts-select-option").filter({ hasText: "林知夏" }).first();
    if (await option.count()) await option.click();
    await page.waitForTimeout(900);
  }
  await shot(page, "matrix-network-member");

  await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.locator(".about-trigger").click();
  await page.waitForTimeout(500);
  await shot(page, "about-dialog");
  await page.keyboard.press("Escape").catch(() => {});

  await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await shot(page, "login");

  await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.locator(".team-switcher-button").click();
  await page.waitForTimeout(350);
  await shot(page, "sidebar-team-switch");
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(900, 500).catch(() => {});
  await page.waitForTimeout(250);

  await page.locator("[aria-label='折叠侧边栏']").click();
  await page.waitForTimeout(500);
  await shot(page, "sidebar-collapsed");

  await context.close();
}

/* ---------------- desktop dark ---------------- */
{
  const { context, page } = await makePage({ theme: "dark" });
  await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await shot(page, "tasks-dark");
  await context.close();
}

/* ---------------- mobile ---------------- */
{
  const { context, page } = await makePage({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await shot(page, "overview-mobile", true);
  await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await shot(page, "tasks-mobile", true);
  await context.close();
}

await browser.close();
console.log("docs screenshots refreshed");
