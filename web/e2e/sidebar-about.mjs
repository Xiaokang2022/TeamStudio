import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Team-only sidebar + about-dialog acceptance (round 8).
 *
 * Round 8 removes both the development-group switcher and the browsing-scope switcher:
 * the sidebar keeps a single team switcher (with member counts) and the breadcrumb shows
 * 「团队名 / 页面名」. The collapse state and the About dialog are regression-checked.
 *
 * Usage: node web/e2e/sidebar-about.mjs   (TEAMSTUDIO_URL defaults to http://127.0.0.1:8000)
 */
const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
const OUT = path.resolve(process.cwd(), "..", "artifacts");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
  locale: "zh-CN",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

async function atTop() {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(400);
}

async function assertNoOverflow(label) {
  const overflow = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    return sidebar ? sidebar.scrollWidth - sidebar.clientWidth : 0;
  });
  assert.ok(overflow <= 1, `${label} should not overflow the sidebar, got ${overflow}`);
}

await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await page.locator(".ov-hero").waitFor();
await atTop();

// The development-group and browsing-scope switchers are gone in round 8.
const sidebarText = await page.locator(".sidebar").innerText();
assert.ok(!sidebarText.includes("开发组"), "sidebar has no 开发组 copy");
assert.ok(!sidebarText.includes("浏览视角"), "sidebar has no 浏览视角 copy");
assert.equal(await page.locator(".group-switcher, .scope-switcher, .group-option").count(), 0);

// Single team switcher (bottom-left) with the member count.
await page.locator(".sidebar-team-switcher .team-switcher-button").click();
await page.locator(".team-popover-up").waitFor();
await page.waitForTimeout(350);
await assertNoOverflow("team popover");
await page.screenshot({ path: path.join(OUT, "sidebar-team-switch.png") });
await page.locator(".team-popover .team-option").filter({ hasText: "远航数据团队" }).click();
await page.waitForFunction(
  () => document.querySelector(".breadcrumb span")?.textContent?.includes("远航数据团队") ?? false,
);
await page.waitForFunction(
  () => document.querySelector(".team-member-count")?.textContent?.includes("6 位成员") ?? false,
);
await atTop();
await page.screenshot({ path: path.join(OUT, "sidebar-team-voyage.png") });

// Back to the primary team for the remaining screenshots.
await page.locator(".sidebar-team-switcher .team-switcher-button").click();
await page.locator(".team-popover .team-option").filter({ hasText: "极光产品团队" }).click();
await page.waitForFunction(
  () => document.querySelector(".breadcrumb span")?.textContent?.includes("极光产品团队") ?? false,
);
await page.waitForFunction(
  () => document.querySelector(".team-member-count")?.textContent?.includes("12 位成员") ?? false,
);
await atTop();

// Collapse / expand.
await page.locator(".collapse-toggle").click();
await page.waitForTimeout(500);
assert.ok((await page.locator(".app-shell").getAttribute("class"))?.includes("sidebar-collapsed"));
const collapsedWidth = await page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width);
assert.ok(collapsedWidth < 100, `collapsed width ${collapsedWidth}`);
const labelDisplay = await page.locator(".nav-item span").first().evaluate((el) => getComputedStyle(el).display);
assert.equal(labelDisplay, "none");
await atTop();
await page.screenshot({ path: path.join(OUT, "sidebar-collapsed.png") });
await page.reload({ waitUntil: "networkidle" });
await page.locator(".ov-hero").waitFor();
assert.ok(
  (await page.locator(".app-shell").getAttribute("class"))?.includes("sidebar-collapsed"),
  "collapsed state persists",
);
await atTop();
await page.locator(".collapse-toggle").click();
await page.waitForTimeout(450);

// About dialog from the user menu.
await page.locator(".user-chip").click();
await page.locator(".user-popover .menu-row").filter({ hasText: "关于团队工作室" }).click();
await page.locator(".about-dialog").waitFor();
await page.waitForTimeout(500);
assert.ok((await page.locator(".about-creator").innerText()).includes("deepseek-flash"));
assert.ok((await page.locator(".about-creator").innerText()).includes("DeepSeek Harness"));
await page.screenshot({ path: path.join(OUT, "about-dialog.png") });
await page.locator(".modal-footer").getByRole("button", { name: "知道了" }).click();

assert.deepEqual(errors, [], errors.join(" | "));
console.log("SIDEBAR_ABOUT_E2E_PASS");
await browser.close();
