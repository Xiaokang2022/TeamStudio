import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
const OUT = path.resolve(process.cwd(), "..", "artifacts");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

async function atTop() {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(400);
}

await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await page.locator(".ov-hero").waitFor();
await atTop();

// Group dropdown at top-left
await page.locator(".group-switcher-button").click();
await page.locator(".group-popover").waitFor();
await page.waitForTimeout(350);
const groupOverflow = await page.evaluate(() => {
  const sidebar = document.querySelector(".sidebar");
  return sidebar ? sidebar.scrollWidth - sidebar.clientWidth : 0;
});
assert.ok(groupOverflow <= 1, `group popover should not overflow sidebar, got ${groupOverflow}`);
await page.screenshot({ path: path.join(OUT, "sidebar-group-switch.png") });
await page.locator(".group-popover .group-option").filter({ hasText: "服务端平台组" }).click();
await page.waitForFunction(
  () => document.querySelector(".group-copy strong")?.textContent?.includes("服务端平台组") ?? false,
);
await atTop();

// Team dropdown at bottom-left
await page.locator(".sidebar-team-switcher .team-switcher-button").click();
await page.locator(".team-popover-up").waitFor();
await page.waitForTimeout(350);
const teamOverflow = await page.evaluate(() => {
  const sidebar = document.querySelector(".sidebar");
  return sidebar ? sidebar.scrollWidth - sidebar.clientWidth : 0;
});
assert.ok(teamOverflow <= 1, `team popover should not overflow sidebar, got ${teamOverflow}`);
await page.screenshot({ path: path.join(OUT, "sidebar-team-switch.png") });
await page.locator(".team-popover .team-option").filter({ hasText: "远航数据团队" }).click();
await page.waitForFunction(
  () => document.querySelector(".group-copy strong")?.textContent?.includes("数据智能组") ?? false,
);
await atTop();
// Back to the primary team for screenshots.
await page.locator(".sidebar-team-switcher .team-switcher-button").click();
await page.locator(".team-popover .team-option").filter({ hasText: "星港产品团队" }).click();
await page.waitForFunction(
  () => document.querySelector(".group-copy strong")?.textContent?.includes("前端体验组") ?? false,
);
await atTop();

// Collapse / expand
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
assert.ok((await page.locator(".app-shell").getAttribute("class"))?.includes("sidebar-collapsed"), "collapsed state persists");
await atTop();
await page.locator(".collapse-toggle").click();
await page.waitForTimeout(450);

// About dialog from user menu
await page.locator(".user-chip").click();
await page.locator(".user-popover .menu-row").filter({ hasText: "关于团队工作室" }).click();
await page.locator(".about-dialog").waitFor();
await page.waitForTimeout(500);
assert.ok((await page.locator(".about-creator").innerText()).includes("deepseek-flash"));
assert.ok((await page.locator(".about-creator").innerText()).includes("DeepSeek Harness 0.2.1-rc.2"));
await page.screenshot({ path: path.join(OUT, "about-dialog.png") });
await page.locator(".modal-footer").getByRole("button", { name: "知道了" }).click();

assert.deepEqual(errors, [], errors.join(" | "));
console.log("SIDEBAR_ABOUT_E2E_PASS");
await browser.close();
