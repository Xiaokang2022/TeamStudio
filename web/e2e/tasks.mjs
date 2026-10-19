import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
const GROUP = "team-aurora/groups/grp-frontend";
const TASK_TITLE = "E2E 任务总览验收任务";
const OUT_DIR = path.resolve(process.cwd(), "..", "artifacts", "tasks-e2e");
fs.mkdirSync(OUT_DIR, { recursive: true });

const errors = [];

async function cleanup() {
  try {
    const res = await fetch(`${BASE}/api/teams/${GROUP}/tasks`);
    const data = await res.json();
    for (const task of data.data?.tasks ?? []) {
      if (task.title === TASK_TITLE) {
        await fetch(`${BASE}/api/teams/${GROUP}/tasks/${task.id}`, { method: "DELETE" });
      }
    }
  } catch (error) {
    console.warn("cleanup warning:", error.message);
  }
}

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

try {
  await cleanup();

  await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
  await page.locator(".tasks-page").waitFor({ timeout: 15000 });

  const title = (await page.locator(".page-title").first().innerText()).trim();
  assert.equal(title, "团队任务总览", "page title");
  assert.ok(
    (await page.locator(".eyebrow").first().innerText()).includes("TASK LEDGER"),
    "eyebrow",
  );
  assert.equal(await page.locator(".tasks-kpi").count(), 5, "5 KPI cards");
  const workloadCount = await page.locator(".tasks-workload-rail .workload").count();
  assert.equal(workloadCount, 5, "one workload card per member");
  const railText = await page.locator(".tasks-workload-rail").first().innerText();
  assert.ok(railText.includes("当前负载"), "workload rail shows current load");
  assert.ok(/近 4 周|平均/.test(railText), "workload rail shows average");

  const rowCount = await page.locator(".tasks-table tbody tr").count();
  assert.ok(rowCount > 0, "task table renders rows");
  assert.ok(await page.locator(".tasks-table-wrap").isVisible(), "desktop table visible");
  assert.ok(!(await page.locator(".tasks-card-list").isVisible()), "mobile list hidden on desktop");

  // Search + empty state + reset
  await page.getByLabel("搜索任务").fill("__no_such_task__");
  await page.getByRole("button", { name: /重置筛选/ }).first().waitFor();
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".tasks-table tbody tr").count(), 0, "search filters all rows out");
  await page.getByRole("button", { name: /重置筛选/ }).first().click();
  await page.waitForTimeout(200);
  assert.ok((await page.locator(".tasks-table tbody tr").count()) > 0, "reset restores rows");

  // Health filter: blocked only
  await page.locator(".tasks-health-chip.is-blocked").click();
  await page.waitForTimeout(200);
  const blockedRows = await page.locator(".tasks-table tbody tr").count();
  assert.ok(blockedRows >= 1, "blocked filter keeps blocked rows");
  const blockedBadges = await page.locator(".tasks-row .tasks-health-badge.is-blocked").count();
  assert.equal(blockedRows, blockedBadges, "blocked filter shows only blocked tasks");
  await page.getByRole("button", { name: /重置筛选/ }).first().click();

  // Show-completed toggle
  const beforeCompleted = await page.locator(".tasks-row.is-completed").count();
  assert.ok(beforeCompleted >= 1, "completed rows exist by default");
  await page.locator(".tasks-completed-switch .switch-track").click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".tasks-row.is-completed").count(), 0, "hide completed works");
  await page.locator(".tasks-completed-switch .switch-track").click();
  await page.waitForTimeout(200);

  // Create via dialog
  await page.locator(".page-actions").getByRole("button", { name: /新建任务/ }).click();
  await page.locator("#tasks-title").waitFor();
  assert.equal(
    (await page.locator(".modal-panel h2").first().innerText()).trim(),
    "新建任务",
    "create dialog title",
  );
  await page.locator("#tasks-title").fill(TASK_TITLE);
  await page.locator("#tasks-description").fill("由前端 E2E 自动创建并清理的任务。");
  await page.locator(".tasks-dialog-level.is-priority-urgent").click();
  await page.locator(".tasks-dialog-level.is-difficulty-hard").click();
  await page.locator(".tasks-dialog-health-option.is-delayed").click();
  await page.locator(".tasks-dialog-choice.is-in_progress").click();
  await page.locator("#tasks-date").fill("2026-12-01");
  await page.locator(".modal-panel").getByRole("button", { name: "创建任务" }).click();
  await page.getByText("任务已创建").waitFor({ timeout: 10000 });
  const createdRow = page.locator(".tasks-row").filter({ hasText: TASK_TITLE });
  await createdRow.waitFor();
  await createdRow.getByText("6 分").first().waitFor();

  // Edit via row action
  await page.getByRole("button", { name: `编辑任务 ${TASK_TITLE}` }).click();
  await page.locator("#tasks-title").waitFor();
  assert.equal(
    (await page.locator(".modal-panel h2").first().innerText()).trim(),
    "编辑任务",
    "edit dialog title",
  );
  await page.locator(".tasks-dialog-level.is-priority-low").click();
  await page.locator(".tasks-dialog-level.is-difficulty-easy").click();
  await page.locator(".modal-panel").getByRole("button", { name: "保存任务" }).click();
  await page.getByText("任务已更新").waitFor({ timeout: 10000 });
  await page.locator(".tasks-row").filter({ hasText: TASK_TITLE }).getByText("1 分").first().waitFor();

  // Delete via row action
  await page.getByRole("button", { name: `删除任务 ${TASK_TITLE}` }).click();
  await page.locator(".modal-panel").getByRole("button", { name: "删除任务", exact: true }).click();
  await page.getByText("任务已删除").waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  assert.equal(
    await page.locator(".tasks-row").filter({ hasText: TASK_TITLE }).count(),
    0,
    "created task removed",
  );

  await page.screenshot({ path: path.join(OUT_DIR, "tasks-light.png"), fullPage: true });

  // Dark theme screenshot
  await page.locator(".topbar .icon-button[aria-label='切换主题']").click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: path.join(OUT_DIR, "tasks-dark.png"), fullPage: true });

  // Mobile layout
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(300);
  assert.ok(await page.locator(".tasks-card-list").isVisible(), "mobile cards visible");
  assert.ok(!(await page.locator(".tasks-table-wrap").isVisible()), "table hidden on mobile");
  await page.screenshot({ path: path.join(OUT_DIR, "tasks-mobile-dark.png"), fullPage: true });

  await page.locator(".topbar .icon-button[aria-label='切换主题']").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, "tasks-mobile-light.png"), fullPage: true });

  const meaningfulErrors = errors.filter(
    (error) => !error.includes("422 (Unprocessable Content)"),
  );
  assert.deepEqual(meaningfulErrors, [], `browser errors: ${meaningfulErrors.join(" | ")}`);
  console.log("TASKS_E2E_PASS");
  console.log(
    `checked: KPIs=${await page.locator(".tasks-kpi").count()}, members=${workloadCount}, filters, dialog create/edit/delete, light/dark, mobile`,
  );
} finally {
  await cleanup();
  await browser.close();
}
