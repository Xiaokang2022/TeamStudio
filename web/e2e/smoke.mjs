/**
 * Round-9 acceptance smoke test (sidebar team switcher + permission-only settings entry).
 *
 * Covers:
 *   1. the shell has no 「浏览视角」/「开发组切换」 and no `.scope-*` / `.group-*` UI;
 *   2. the sidebar team switcher changes the whole workspace (overview members/breadcrumb);
 *      the topbar has no team switcher;
 *   3. member cards are name-sorted, have no member status, and the drawer opens;
 *   4. theme preference: follows system by default, 3-way menu, persisted in
 *      `teamstudio.theme.preference`, legacy `teamstudio.theme` migrated away;
 *   5. calendar todo CRUD and announcement CRUD still work on team-scoped APIs;
 *   6. the login page explains the deployment-device Admin and no longer restricts
 *      unactivated accounts to activation links;
 *   7. the settings entry lives in the sidebar's 「管理」 group (permission-gated:
 *      「工作室设置」 for super admins / 「团队设置」 for team admins), is absent from the
 *      avatar menu, and cannot be hidden by module switches (「模块展示」only has the 8
 *      regular module toggles);
 *   8. the personal home page merges member archives into the hero card and shows the
 *      rest as a settings-style left rail (个人信息 / 个性化设置 / 责任田 / 当前任务 /
 *      历史任务 / 待办 / 红黑榜记录), without an extra 「个人设置」 card frame;
 *   9. settings expose per-module guest switches (`guestModules`) and persist them.
 *
 * Requirements: `npm run build --prefix web` and a running server
 * (`.\scripts\start.ps1 -NoBrowser`, backend serves web/dist), or a Vite dev server.
 * Usage:
 *   node web/e2e/smoke.mjs
 *   TEAMSTUDIO_URL=http://127.0.0.1:8011 node web/e2e/smoke.mjs
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
const TEAM_AURORA = "team-aurora";
const TODO_TITLE = "E2E 自动化验收待办";
const ANN_TITLE = "E2E 公告验收";
const errors = [];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function teamUrl(path, teamId = TEAM_AURORA) {
  return `${BASE}/api/teams/${encodeURIComponent(teamId)}${path}`;
}

async function waitForText(selector, expected, timeout = 12_000) {
  await page.waitForFunction(
    ({ selector, expected }) => {
      const node = document.querySelector(selector);
      return Boolean(node && node.textContent && node.textContent.includes(expected));
    },
    { selector, expected },
    { timeout },
  );
}

async function goto(route) {
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
}

async function cleanup() {
  try {
    const todoResponse = await fetch(teamUrl("/todos"));
    const todoData = await todoResponse.json();
    for (const todo of todoData.data?.todos ?? []) {
      if (todo.title === TODO_TITLE) {
        await fetch(teamUrl(`/todos/${todo.id}`), { method: "DELETE" });
      }
    }
    const annResponse = await fetch(teamUrl("/announcements"));
    const annData = await annResponse.json();
    for (const item of annData.data?.announcements ?? []) {
      if (item.title === ANN_TITLE) {
        await fetch(teamUrl(`/announcements/${item.id}`), { method: "DELETE" });
      }
    }
  } catch (error) {
    console.warn("cleanup warning:", error.message);
  }
}

try {
  // Legacy keys from pre-round-8 builds: the theme key must be migrated to the new
  // preference key and removed; the removed scope key must be ignored.
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem("teamstudio.theme.preference")) {
        localStorage.setItem("teamstudio.theme", "dark");
      }
      localStorage.setItem("teamstudio.scope", "all");
    } catch (error) {
      /* storage may be unavailable */
    }
  });

  await cleanup();

  // ---------------------------------------------------------------- 1. shell / team switch
  await goto("overview");
  await page.locator(".ov-hero").waitFor();

  const sidebarText = await page.locator(".sidebar").innerText();
  assert.ok(!sidebarText.includes("浏览视角"), "sidebar must not contain 浏览视角");
  assert.ok(!sidebarText.includes("开发组"), "sidebar must not contain 开发组");
  assert.equal(await page.locator(".scope-switcher, .group-switcher, .scope-option").count(), 0);
  // Round 9: the settings entry is permission-gated and lives in the sidebar's 「管理」 group.
  assert.ok(!sidebarText.includes("系统设置"), "sidebar must not use the legacy 系统设置 copy");
  const sidebarLabels = (await page.locator(".sidebar .sidebar-label").allInnerTexts()).map((value) =>
    value.trim(),
  );
  assert.ok(sidebarLabels.includes("管理"), `sidebar exposes the 管理 group, got ${sidebarLabels.join("/")}`);
  const settingsNav = page.locator(".sidebar .nav-item").filter({ hasText: /工作室设置|团队设置/ });
  assert.equal(await settingsNav.count(), 1, "sidebar exposes exactly one settings nav item for the admin");
  assert.equal((await settingsNav.innerText()).trim(), "工作室设置", "device admin sees 工作室设置");
  assert.equal(
    await settingsNav.locator(".nav-shield").count(),
    1,
    "super-admin settings nav item carries the shield mark",
  );
  // The team switcher stays in the sidebar footer (bottom-left); the topbar has none.
  assert.equal(
    await page.locator(".topbar-team-switcher, .topbar-team-button").count(),
    0,
    "topbar no longer holds a team switcher",
  );
  assert.equal(
    await page.locator(".sidebar-team-switcher .team-switcher-button").count(),
    1,
    "sidebar keeps the team switcher",
  );

  // Legacy theme key was migrated: preference stored, old key deleted, dark applied.
  const initialPreference = await page.evaluate(() =>
    localStorage.getItem("teamstudio.theme.preference"),
  );
  assert.equal(initialPreference, "dark", "legacy teamstudio.theme migrates to the preference");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("teamstudio.theme")),
    null,
    "legacy teamstudio.theme key is deleted",
  );
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");

  // Team switching stays in the sidebar footer (bottom-left) and opens an upward popover;
  // the breadcrumb keeps showing 「团队名 / 页面名」.
  const teamButton = page.locator(".sidebar-team-switcher .team-switcher-button");
  assert.equal(await teamButton.locator(".team-badge").count(), 1, "sidebar team button has a badge");
  await teamButton.click();
  const teamPopover = page.locator(".popover.team-popover.team-popover-up");
  await teamPopover.waitFor();
  const currentTeamName = (
    await page.locator(".sidebar-team-switcher .team-copy strong").innerText()
  ).trim();
  assert.equal(
    await teamPopover
      .locator(".team-option")
      .filter({ hasText: currentTeamName })
      .locator(".team-current")
      .count(),
    1,
    "the current team is marked in the sidebar popover",
  );
  assert.ok(
    (await teamPopover.locator(".popover-note").innerText()).includes("数据按团队隔离"),
    "sidebar team popover explains team data isolation",
  );
  await teamPopover.locator(".team-option").filter({ hasText: "远航数据团队" }).click();
  await waitForText(".sidebar-team-switcher .team-copy strong", "远航数据团队");
  await waitForText(".team-member-count", "6 位成员");
  const breadcrumbText = (await page.locator(".breadcrumb").innerText()).replace(/\s+/g, " ").trim();
  assert.ok(breadcrumbText.includes("远航数据团队"), `breadcrumb shows the team name, got "${breadcrumbText}"`);
  assert.ok(breadcrumbText.includes("团队概览"), `breadcrumb shows the page name, got "${breadcrumbText}"`);
  // The card list is pinyin-sorted (方觉/顾行/韩晓/贾宁/李沐/裴然), so wait for the count.
  await page.waitForFunction(() => document.querySelectorAll(".ov-member-card").length === 6);
  assert.equal(await page.locator(".ov-member-card").count(), 6, "voyage team has 6 members");

  await teamButton.click();
  await teamPopover.locator(".team-option").filter({ hasText: "极光产品团队" }).click();
  await waitForText(".sidebar-team-switcher .team-copy strong", "极光产品团队");
  await waitForText(".team-member-count", "12 位成员");
  await page.waitForFunction(() => document.querySelectorAll(".ov-member-card").length === 12);
  assert.equal(await page.locator(".ov-member-card").count(), 12, "aurora team has 12 members");

  // ---------------------------------------------------------------- 1b. settings entry
  // Round 9: the settings entry is permission-gated, lives in the sidebar's 管理 group and is
  // deliberately absent from the avatar dropdown (personal settings live on the profile page).
  await page.locator(".user-chip").click();
  await page.locator(".user-popover").waitFor();
  assert.equal(
    await page.locator(".user-popover .menu-row").filter({ hasText: /工作室设置|团队设置|系统设置/ }).count(),
    0,
    "avatar menu no longer exposes the studio/team settings entry",
  );
  await page.locator(".user-chip").click();
  await page.locator(".user-popover").waitFor({ state: "detached" });
  await settingsNav.click();
  await page.locator(".settings-tabs").waitFor();
  assert.equal(new URL(page.url()).hash, "#/settings", "sidebar settings entry opens the settings page");
  await goto("overview");
  await page.locator(".ov-hero").waitFor();

  // ---------------------------------------------------------------- 2. member cards / drawer
  const names = (await page.locator(".ov-member-card h3").allInnerTexts()).map((value) =>
    value.trim(),
  );
  const collator = new Intl.Collator("zh-Hans-CN");
  assert.deepEqual(
    names,
    [...names].sort((a, b) => collator.compare(a, b)),
    "member cards are sorted by name",
  );

  const firstCard = page.locator(".ov-member-card").first();
  const cardText = await firstCard.innerText();
  assert.ok(!cardText.includes("当前状态"), "member card has no member status");
  assert.ok(!cardText.includes("开发组"), "member card has no group label");
  assert.ok((await firstCard.locator(".avatar, img").count()) >= 1, "member card renders an avatar");

  await firstCard.click();
  await page.locator("#md-title").waitFor();
  const drawerText = await page.locator("[role='dialog']").first().innerText();
  assert.ok(!drawerText.includes("当前状态"), "member drawer has no member status");
  assert.ok(!drawerText.includes("开发组"), "member drawer has no group label");
  await page.locator(".md-close").click();
  await page.locator(".md-scrim").waitFor({ state: "detached" });

  // ---------------------------------------------------------------- 3. theme preference
  const themeBeforeToggle = await page.locator("html").getAttribute("data-theme");
  await page.locator(".quick-theme-toggle").click();
  await page.waitForFunction(
    (previous) => document.documentElement.dataset.theme !== previous,
    themeBeforeToggle,
  );

  await page.locator(".theme-menu-trigger").click();
  await page.locator(".theme-popover[role='menu']").waitFor();
  const themeOptions = (await page.locator(".theme-popover .theme-option").allInnerTexts()).map(
    (value) => value.trim(),
  );
  assert.deepEqual(themeOptions, ["跟随系统", "浅色", "深色"], "theme menu offers 3 choices");

  await page.locator(".theme-popover .theme-option").filter({ hasText: "深色" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("teamstudio.theme.preference")),
    "dark",
    "theme preference persisted",
  );

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".ov-hero").waitFor();
  assert.equal(
    await page.locator("html").getAttribute("data-theme"),
    "dark",
    "theme survives reload",
  );

  await page.locator(".theme-menu-trigger").click();
  await page.locator(".theme-popover .theme-option").filter({ hasText: "跟随系统" }).click();
  await page.waitForFunction(
    () => localStorage.getItem("teamstudio.theme.preference") === "auto",
  );

  // ---------------------------------------------------------------- 4. calendar CRUD
  await page.locator(".nav-item").filter({ hasText: "协作日历" }).click();
  await page.locator(".cal-month").waitFor();
  await page.locator(".page-actions").getByRole("button", { name: /新建待办/ }).click();
  await page.getByLabel(/待办标题/).fill(TODO_TITLE);
  await page.locator(".modal-panel").getByRole("button", { name: "创建待办" }).click();
  await page.getByText("待办已创建").waitFor();
  await page.getByRole("button", { name: `删除待办 ${TODO_TITLE}` }).waitFor();
  await page.getByRole("button", { name: `删除待办 ${TODO_TITLE}` }).click();
  await page.locator(".modal-panel").getByRole("button", { name: "删除待办", exact: true }).click();
  await page.getByText("待办已删除").waitFor();

  // ---------------------------------------------------------------- 5. announcement CRUD
  await page.locator(".nav-item").filter({ hasText: "公告栏" }).click();
  await page.getByRole("button", { name: /发布公告/ }).first().click();
  await page.locator(".modal-panel .input").first().fill(ANN_TITLE);
  await page.locator(".modal-panel textarea").first().fill("这是一条由 E2E 自动创建并清理的公告。");
  await page.locator(".modal-panel .btn-primary").click();
  await page.getByText("公告已发布").waitFor();
  await page.getByText(ANN_TITLE).first().waitFor();
  await page.getByRole("button", { name: `删除 ${ANN_TITLE}` }).first().click();
  await page.locator(".modal-panel").getByRole("button", { name: "删除公告", exact: true }).click();
  await page.getByText("公告已删除").waitFor();

  // ---------------------------------------------------------------- 6. profile personal settings
  await goto("profile");
  await page.locator(".profile-settings-tabs").waitFor();
  await page.waitForTimeout(300);
  const profileText = await page.locator(".profile-page").innerText();
  assert.ok(!profileText.includes("开发组"), "profile has no group concept");
  // Round 9: member archives are merged into the top hero card.
  assert.equal(await page.locator(".profile-members").count(), 0, "no standalone 成员档案 card");
  const heroArchives = page.locator(".profile-hero .profile-hero-archives");
  assert.equal(await heroArchives.count(), 1, "成员档案 is integrated into the top hero card");
  assert.ok((await heroArchives.innerText()).includes("成员档案"), "hero archives block is labelled");
  // Personal settings use a settings-style left rail: 个人信息, 个性化设置, then the records.
  const profileTabs = (await page.locator(".profile-settings-tab").allInnerTexts()).map((value) =>
    value.trim(),
  );
  assert.ok(profileTabs.length >= 7, `profile rail exposes personal + record panes, got ${profileTabs.length}`);
  assert.ok(profileTabs[0].includes("个人信息"), "first pane is 个人信息");
  assert.ok(profileTabs[1].includes("个性化设置"), "second pane is 个性化设置");
  for (const label of ["责任田", "当前任务", "历史任务", "待办", "红黑榜记录"]) {
    assert.ok(profileTabs.some((tab) => tab.includes(label)), `profile rail contains ${label}`);
  }
  assert.ok(await page.locator("#profile-name").isVisible(), "个人信息 pane shows the profile fields");
  assert.equal(
    await page.locator(".profile-settings-main > .card.profile-section").count(),
    1,
    "个人信息 content is wrapped in the same card frame as the record panes",
  );
  await page.locator(".profile-settings-tab").filter({ hasText: "个性化设置" }).click();
  await page.locator(".profile-personalization-body .profile-theme-switch").waitFor();
  assert.equal(
    await page.locator(".profile-settings-main > .card.profile-section").count(),
    1,
    "个性化设置 content is wrapped in the same card frame as the record panes",
  );
  // The personal theme control lives on the profile page (requirement #7).
  await page.locator(".profile-page").getByRole("button", { name: "深色", exact: true }).click();
  await page.waitForFunction(
    () => localStorage.getItem("teamstudio.theme.preference") === "dark",
  );
  await page
    .locator(".profile-page")
    .getByRole("button", { name: "跟随系统", exact: true })
    .click();
  await page.waitForFunction(
    () => localStorage.getItem("teamstudio.theme.preference") === "auto",
  );
  // Record panes switch in the same left rail.
  await page.locator(".profile-settings-tab").filter({ hasText: "责任田" }).click();
  await page.locator(".profile-record-pane:not([hidden]) .profile-section").first().waitFor();
  assert.ok(
    (await page.locator(".profile-record-pane:not([hidden])").innerText()).includes("责任田"),
    "record pane switches to 责任田",
  );

  // ---------------------------------------------------------------- 7. login page copy
  // Sign the browser context out (node-side fetch has its own cookie jar, so the logout
  // must run inside the page and hit the same session). A hash-only navigation would
  // keep the in-memory store, so force a real reload before asserting the login copy.
  await page.evaluate(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  });
  await goto("login");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".login-page").waitFor();
  const loginText = await page.locator(".login-page").innerText();
  assert.ok(loginText.includes("部署设备"), "login page mentions the deployment device");
  assert.ok(
    loginText.includes("以系统内置管理员身份登录"),
    "login page exposes the device-admin login",
  );
  assert.ok(!loginText.includes("浏览视角"), "login page has no browsing-scope copy");
  assert.ok(!loginText.includes("开发组"), "login page has no group copy");
  // Round 8 removes the "unactivated accounts can only use the activation link" hint.
  assert.ok(!loginText.includes("只能走激活链接"), "no unactivated-only activation hint");
  assert.ok(await page.locator(".login-device-entry").isVisible());

  // Round 9: the settings route itself stays permission-gated — a guest gets AccessDenied and
  // no module switch can open it.
  await goto("settings");
  await page.getByText("仅管理员可访问").first().waitFor();
  assert.ok(
    (await page.locator(".state-card").first().innerText()).includes("仅管理员可访问"),
    "guests cannot open the settings route",
  );

  // ---------------------------------------------------------------- 8. guest module switches
  await page.evaluate(async () => {
    await fetch("/api/auth/device/login", { method: "POST", credentials: "include" });
  });
  await goto("settings?tab=modules");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".settings-tabs").waitFor();
  await page.getByText("访客可访问模块").first().waitFor();

  async function waitForGuestTasks(expected, timeout = 10_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const response = await api("/api/bootstrap");
      if (response.body?.data?.config?.guestModules?.tasks === expected) return;
      await page.waitForTimeout(250);
    }
    throw new Error(`guestModules.tasks did not become ${expected}`);
  }

  async function saveSettings() {
    const saveButton = page.getByRole("button", { name: "保存设置" });
    await saveButton.waitFor({ state: "visible" });
    if (await saveButton.isDisabled()) {
      throw new Error("settings save button stayed disabled after a change");
    }
    await saveButton.click();
    await page.waitForTimeout(400);
  }

  // The "模块展示" card owns the global module switch; make sure 任务 is on first so the
  // guest switch is meaningful (earlier runs of this smoke may have toggled it).
  const moduleCard = page
    .locator("section.settings-card")
    .filter({ hasText: "模块展示" })
    .first();
  // Round 9: settings can no longer be hidden by a module switch, so the card lists only the
  // 8 regular modules and no 「工作室设置 / 系统设置」 toggle.
  const moduleToggles = moduleCard.locator(".settings-module-toggle");
  assert.equal(await moduleToggles.count(), 8, "模块展示 card lists exactly the 8 regular modules");
  const moduleToggleCopy = (await moduleToggles.allInnerTexts()).join(" ");
  assert.ok(!moduleToggleCopy.includes("工作室设置"), "模块展示 card has no 工作室设置 toggle");
  assert.ok(!moduleToggleCopy.includes("系统设置"), "模块展示 card has no 系统设置 toggle");
  const moduleRow = moduleCard
    .locator(".settings-module-toggle")
    .filter({ hasText: "任务总览" })
    .first();
  const moduleInput = moduleRow.locator("input[type='checkbox']");
  if (!(await moduleInput.isChecked())) {
    await moduleRow.locator(".settings-toggle-row").click();
    await saveSettings();
  }

  const guestCard = page
    .locator("section.settings-card")
    .filter({ hasText: "访客可访问模块" })
    .first();
  // The guest card never offered the settings module; round 9 keeps that and the 8 regular
  // modules stay individually switchable.
  assert.equal(
    await guestCard.locator(".settings-module-toggle").count(),
    8,
    "访客可访问模块 card keeps the 8 regular modules",
  );
  const guestRow = guestCard
    .locator(".settings-module-toggle")
    .filter({ hasText: "任务总览" })
    .first();
  const guestInput = guestRow.locator("input[type='checkbox']");
  const guestToggleRow = guestRow.locator(".settings-toggle-row");

  if (await guestInput.isChecked()) {
    await guestToggleRow.click();
  }
  assert.equal(await guestInput.isChecked(), false, "guest access to tasks can be switched off");
  await saveSettings();
  await waitForGuestTasks(false);

  // Switch it back on so the smoke test is idempotent.
  await guestToggleRow.click();
  assert.equal(await guestInput.isChecked(), true);
  await saveSettings();
  await waitForGuestTasks(true);

  assert.deepEqual(
    errors.filter((error) => !error.includes("422 (Unprocessable Content)")),
    [],
    `browser errors: ${errors.join(" | ")}`,
  );
  console.log("E2E_SMOKE_PASS");
  console.log(
    "checked: no scope/group UI, sidebar team switch (breadcrumb keeps team/page names), name-sorted " +
      "members, avatar+no-status cards/drawer, theme preference (auto/light/dark + legacy migration), " +
      "calendar todo CRUD, announcement CRUD, tabbed profile personal settings, login device-admin copy, " +
      "sidebar-only settings entry (not in the avatar menu, not a hideable module), guestModules roundtrip",
  );
} finally {
  await cleanup();
  await browser.close();
}
