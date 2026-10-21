import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Shell acceptance for round 9: sidebar team switcher + permission-gated settings entry.
 *
 * Round 9 keeps the team switcher in the sidebar footer (bottom-left), restores the
 * permission-gated settings entry in the sidebar's 管理 group (super admins read
 * 「工作室设置」, team admins 「团队设置」) and keeps it out of the avatar dropdown.
 * The collapsed sidebar, the About dialog, personal settings and the team switch are
 * regression-checked.
 *
 * Usage: npm run e2e:sidebar --prefix web   (TEAMSTUDIO_URL defaults to http://127.0.0.1:8000)
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

await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await page.locator(".ov-hero").waitFor();
await atTop();

// Legacy round-8 UI is gone. Round 9 keeps the settings entry in the sidebar's 管理 group
// (permission-gated) and the team switcher in the sidebar footer (bottom-left).
const sidebarText = await page.locator(".sidebar").innerText();
assert.ok(!sidebarText.includes("开发组"), "sidebar has no 开发组 copy");
assert.ok(!sidebarText.includes("浏览视角"), "sidebar has no 浏览视角 copy");
assert.ok(!sidebarText.includes("系统设置"), "sidebar has no legacy 系统设置 copy");
assert.equal(await page.locator(".group-switcher, .scope-switcher, .group-option").count(), 0);
const settingsNav = page.locator(".sidebar .nav-item").filter({ hasText: /工作室设置|团队设置/ });
assert.equal(await settingsNav.count(), 1, "sidebar exposes one permission-gated settings entry");
assert.equal((await settingsNav.innerText()).trim(), "工作室设置", "device admin sees 工作室设置");
const sidebarLabels = (await page.locator(".sidebar .sidebar-label").allInnerTexts()).map((value) =>
  value.trim(),
);
assert.ok(sidebarLabels.includes("管理"), `sidebar exposes the 管理 group, got ${sidebarLabels.join("/")}`);
assert.equal(await page.locator(".topbar-team-switcher, .topbar-team-button").count(), 0, "topbar has no team switcher");
assert.equal(
  await page.locator(".sidebar-team-switcher .team-switcher-button").count(),
  1,
  "sidebar footer keeps the team switcher",
);
assert.ok(await page.locator(".sidebar .identity-mini").isVisible(), "sidebar keeps the identity block");
assert.ok(await page.locator(".sidebar .about-trigger").isVisible(), "sidebar keeps the About button");
assert.ok((await page.locator(".sidebar-footer p").innerText()).trim().length > 0, "sidebar keeps its footer copy");

// Sidebar team switcher (bottom-left) with the member count and an upward popover.
const teamButton = page.locator(".sidebar-team-switcher .team-switcher-button");
await teamButton.scrollIntoViewIfNeeded();
await teamButton.click();
const teamPopover = page.locator(".popover.team-popover.team-popover-up");
await teamPopover.waitFor();
await page.waitForTimeout(350);
const teamButtonBox = await teamButton.boundingBox();
const popoverBox = await teamPopover.boundingBox();
const viewport = page.viewportSize();
assert.ok(teamButtonBox && popoverBox, "sidebar team button and popover are measurable");
assert.ok(
  teamButtonBox.x < viewport.width / 2 && teamButtonBox.y > viewport.height / 2,
  `team switcher sits in the bottom-left sidebar, got x=${teamButtonBox.x} y=${teamButtonBox.y}`,
);
assert.ok(
  popoverBox.x >= -1 && popoverBox.x + popoverBox.width <= viewport.width + 1,
  `team popover stays inside the viewport, got x=${popoverBox.x} width=${popoverBox.width}`,
);
assert.ok(
  popoverBox.y + popoverBox.height <= teamButtonBox.y + 8,
  "team popover opens upwards",
);
const currentTeamName = (await page.locator(".sidebar-team-switcher .team-copy strong").innerText()).trim();
assert.equal(
  await teamPopover
    .locator(".team-option")
    .filter({ hasText: currentTeamName })
    .locator(".team-current")
    .count(),
  1,
  "the current team is marked",
);
assert.ok(
  (await teamPopover.locator(".popover-note").innerText()).includes("数据按团队隔离"),
  "team popover carries the isolation note",
);
await page.screenshot({ path: path.join(OUT, "sidebar-team-switch.png") });

await teamPopover.locator(".team-option").filter({ hasText: "远航数据团队" }).click();
await page.waitForFunction(
  () => document.querySelector(".sidebar-team-switcher .team-copy strong")?.textContent?.includes("远航数据团队") ?? false,
);
await page.waitForFunction(
  () => document.querySelector(".team-member-count")?.textContent?.includes("6 位成员") ?? false,
);
// The breadcrumb keeps 「团队名 / 页面名」.
const breadcrumbText = (await page.locator(".breadcrumb").innerText()).replace(/\s+/g, " ").trim();
assert.ok(breadcrumbText.includes("远航数据团队"), `breadcrumb shows the team name, got "${breadcrumbText}"`);
assert.ok(breadcrumbText.includes("团队概览"), `breadcrumb shows the page name, got "${breadcrumbText}"`);
await atTop();
await page.screenshot({ path: path.join(OUT, "sidebar-team-voyage.png") });

// Back to the primary team for the remaining screenshots.
await teamButton.click();
await teamPopover.locator(".team-option").filter({ hasText: "极光产品团队" }).click();
await page.waitForFunction(
  () => document.querySelector(".sidebar-team-switcher .team-copy strong")?.textContent?.includes("极光产品团队") ?? false,
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

// Settings entry: in the sidebar's 管理 group, absent from the avatar dropdown.
await page.locator(".user-chip").click();
await page.locator(".user-popover").waitFor();
assert.equal(
  await page.locator(".user-popover .menu-row").filter({ hasText: /工作室设置|团队设置|系统设置/ }).count(),
  0,
  "avatar menu no longer exposes the studio/team settings entry",
);

// About dialog from the user menu (fallback: the sidebar About button).
const aboutRow = page.locator(".user-popover .menu-row").filter({ hasText: "关于团队工作室" });
if (await aboutRow.count()) {
  await aboutRow.click();
} else {
  await page.locator(".user-chip").click();
  await page.locator(".about-trigger").click();
}
await page.locator(".about-dialog").waitFor();
await page.waitForTimeout(500);
assert.ok((await page.locator(".about-creator").innerText()).includes("deepseek-flash"));
assert.ok((await page.locator(".about-creator").innerText()).includes("DeepSeek Harness"));
await page.screenshot({ path: path.join(OUT, "about-dialog.png") });
await page.locator(".modal-footer").getByRole("button", { name: "知道了" }).click();

// The sidebar entry opens the settings page (admins only).
await settingsNav.click();
await page.locator(".settings-tabs").waitFor();

// Settings cannot be hidden by module switches: 「模块展示」 only lists the 8 regular modules.
await page.evaluate(() => {
  window.location.hash = "#/settings?tab=modules";
});
const moduleCard = page.locator("section.settings-card").filter({ hasText: "模块展示" }).first();
await moduleCard.waitFor();
const moduleToggles = moduleCard.locator(".settings-module-toggle");
assert.equal(await moduleToggles.count(), 8, "模块展示 card lists exactly the 8 regular modules");
const moduleToggleCopy = (await moduleToggles.allInnerTexts()).join(" ");
assert.ok(!moduleToggleCopy.includes("工作室设置"), "模块展示 card has no 工作室设置 toggle");
assert.ok(!moduleToggleCopy.includes("系统设置"), "模块展示 card has no 系统设置 toggle");
const guestCard = page.locator("section.settings-card").filter({ hasText: "访客可访问模块" }).first();
await guestCard.waitFor();
assert.equal(
  await guestCard.locator(".settings-module-toggle").count(),
  8,
  "访客可访问模块 card keeps the 8 regular modules",
);
assert.ok(
  !(await guestCard.locator(".settings-module-toggle").allInnerTexts()).join(" ").includes("工作室设置"),
  "访客可访问模块 card never offers the settings module",
);

assert.deepEqual(errors, [], errors.join(" | "));
console.log("SIDEBAR_ABOUT_E2E_PASS");
await browser.close();
