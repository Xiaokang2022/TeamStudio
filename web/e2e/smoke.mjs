import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
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

async function text(selector) {
  return (await page.locator(selector).first().innerText()).trim();
}

async function waitForFunctionText(selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) =>
      document.querySelector(selector)?.textContent?.includes(expected) ?? false,
    { selector, expected },
    { timeout: 10_000 },
  );
}

async function cleanup() {
  try {
    const todoResponse = await fetch(`${BASE}/api/teams/team-aurora/groups/grp-frontend/todos?month=2026-10`);
    const todoData = await todoResponse.json();
    for (const todo of todoData.data?.todos ?? []) {
      if (todo.title === TODO_TITLE) {
        await fetch(`${BASE}/api/teams/team-aurora/groups/grp-frontend/todos/${todo.id}`, {
          method: "DELETE",
        });
      }
    }
    const annResponse = await fetch(`${BASE}/api/teams/team-aurora/groups/grp-frontend/announcements`);
    const annData = await annResponse.json();
    for (const item of annData.data?.announcements ?? []) {
      if (item.title === ANN_TITLE) {
        await fetch(
          `${BASE}/api/teams/team-aurora/groups/grp-frontend/announcements/${item.id}`,
          { method: "DELETE" },
        );
      }
    }
  } catch (error) {
    console.warn("cleanup warning:", error.message);
  }
}

try {
  await cleanup();

  // 1. Overview loads and member drawer works
  await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await page.locator(".ov-hero").waitFor();
  assert.equal(await page.locator(".ov-member-card").count(), 5, "overview renders 5 member cards");
  await page.getByRole("button", { name: /查看 林知夏 的成员档案/ }).click();
  await page.locator("#md-title").waitFor();
  assert.equal(await text("#md-title"), "林知夏");
  await page.locator(".md-close").click();
  await page.locator(".md-scrim").waitFor({ state: "detached" });

  // 2. Team and group switching
  await page.locator(".sidebar-team-switcher .team-switcher-button").click();
  await page.locator(".team-option").filter({ hasText: "远航数据团队" }).click();
  await waitForFunctionText(".group-copy strong", "数据智能组");
  await page.locator(".sidebar-team-switcher .team-switcher-button").click();
  await page.locator(".team-option").filter({ hasText: "星港产品团队" }).click();
  await waitForFunctionText(".group-copy strong", "前端体验组");
  await page.locator(".group-switcher-button").click();
  await page.locator(".group-popover .group-option").filter({ hasText: "服务端平台组" }).click();
  await waitForFunctionText(".group-copy strong", "服务端平台组");
  await page.waitForFunction(
    () => document.querySelector(".breadcrumb strong")?.textContent?.includes("服务端平台组") ?? false,
  );
  await page.locator(".group-switcher-button").click();
  await page.locator(".group-popover .group-option").filter({ hasText: "前端体验组" }).click();
  await waitForFunctionText(".group-copy strong", "前端体验组");

  // 3. Calendar create + delete a todo
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
  assert.equal(await page.getByText(TODO_TITLE).count(), 0, "todo removed from calendar");

  // 4. Announcement create + delete
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

  // 5. Settings tabs and JSON dual-mode validation
  await page.locator(".nav-item").filter({ hasText: "工作室设置" }).click();
  await page.locator(".settings-tabs").waitFor();
  assert.ok((await text(".page-title")).includes("工作室设置"));
  for (const tab of ["模块与展示", "团队与权限", "企业 SSO", "邮件提醒", "高级 JSON"]) {
    await page.locator(".settings-tabs button").filter({ hasText: tab }).click();
    await page.waitForTimeout(300);
  }
  // Since the optimization round the raw editor is a Monaco editor (VS Code engine),
  // so DOM/textarea reads are replaced by: server-side settings assertions + real
  // editor interactions (invalid JSON markers, restore, format).
  await page.locator(".monaco-editor").first().waitFor({ timeout: 20_000 });
  const settingsResponse = await (await fetch(`${BASE}/api/settings`)).json();
  const serverJson = settingsResponse.data.settings;
  assert.equal(serverJson.announcements.maxPinned, 3, "settings endpoint contains full settings");
  assert.ok(Array.isArray(serverJson.auth.adminWhitelist.ids), "whitelist present in settings");
  assert.ok(!JSON.stringify(serverJson).includes("device-admin"), "built-in admin is absent from config");
  assert.ok((await page.locator(".monaco-editor").count()) > 0, "JSON tab renders Monaco editor");
  assert.equal(await page.locator(".settings-json-textarea").count(), 0, "legacy textarea removed");

  await page.getByRole("button", { name: "校验配置" }).click();
  await page.getByText("校验通过").waitFor();

  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type('{ "announcements": { "maxPinned": 9 } }');
  await page.getByRole("button", { name: "校验配置" }).click();
  await page.getByText(/maxPinned|JSON 语法/).first().waitFor();

  await page.getByRole("button", { name: /恢复服务器版本/ }).click();
  await page.locator(".modal-panel").getByRole("button", { name: "恢复服务器版本" }).click();
  await page.waitForTimeout(500);

  await page.getByRole("button", { name: "格式化" }).click();
  await page.waitForTimeout(300);

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".monaco-editor").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  assert.ok((await page.locator(".monaco-editor").count()) > 0, "Monaco survives reload");

  // 6. Theme switching
  await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await page.locator(".ov-hero").waitFor();
  const before = await page.locator("html").getAttribute("data-theme");
  await page.locator(".topbar .icon-button[aria-label='切换主题']").click();
  await page.waitForTimeout(200);
  const after = await page.locator("html").getAttribute("data-theme");
  assert.notEqual(before, after, "theme toggle applies");

  assert.deepEqual(
    errors.filter((error) => !error.includes("422 (Unprocessable Content)")),
    [],
    `browser errors: ${errors.join(" | ")}`,
  );
  console.log("E2E_SMOKE_PASS");
  console.log("checked: overview, member drawer, team/group switch, calendar CRUD, announcement CRUD, settings tabs, JSON validation, theme toggle");
} finally {
  await cleanup();
  await browser.close();
}
