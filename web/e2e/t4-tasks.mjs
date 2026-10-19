/**
 * T4 task-ledger verification: time range, multi-column sorting, tag chips,
 * tag picker / library dialog and aggregate-scope group badges.
 *
 * Usage (from web/): node e2e/t4-tasks.mjs
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const OUT = "../artifacts";
const shots = [];
const problems = [];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
});
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

async function shot(name, fullPage = false) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage });
  shots.push(path);
  console.log("shot", path);
}

async function goto(theme = "light", scope = "group") {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([nextTheme, nextScope]) => {
      localStorage.setItem("teamstudio.theme", nextTheme);
      localStorage.setItem("teamstudio.scope", nextScope);
    },
    [theme, scope],
  );
  await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
  await page.waitForSelector(".tasks-table", { timeout: 15000 });
  await page.waitForTimeout(900);
}

try {
  // ---------------- Light theme, default 1m window ----------------
  await goto("light", "group");
  await shot("t4-tasks-light-1m");

  // Range switch: 1w then 3m
  await page.locator(".tasks-range-btn", { hasText: "近 1 周" }).click();
  await page.waitForTimeout(350);
  await shot("t4-tasks-light-1w");

  await page.locator(".tasks-range-btn", { hasText: "近 3 个月" }).click();
  await page.waitForTimeout(350);
  await shot("t4-tasks-light-3m");

  // Sorting indicators (click 优先级 twice => desc)
  const prioritySort = page.locator('button[title="按优先级排序"]');
  await prioritySort.click();
  await page.waitForTimeout(250);
  await shot("t4-tasks-light-sort-priority-asc");
  await prioritySort.click();
  await page.waitForTimeout(250);
  const priorityAria = await page
    .locator("th", { has: prioritySort })
    .getAttribute("aria-sort");
  await shot("t4-tasks-light-sort-priority-desc");

  // Sort by load points and by created time
  await page.locator('button[title="按负载点数排序（负载点数 = 1 分基础 + 优先级加成 + 难度加成）"]').click();
  await page.waitForTimeout(250);
  await shot("t4-tasks-light-sort-load");

  await page.locator('button[title="按创建时间排序"]').click();
  await page.waitForTimeout(250);
  const createdAria = await page
    .locator("th", { has: page.locator('button[title="按创建时间排序"]') })
    .getAttribute("aria-sort");
  await shot("t4-tasks-light-sort-created");

  // ---------------- Tag picker + library dialog ----------------
  await page.locator(".tasks-tag-library-btn").click();
  await page.waitForTimeout(500);
  await page.waitForSelector(".tag-library-dialog");
  const tagCount = await page.locator(".tag-library-dialog .tag-manager-row").count();
  await shot("t4-tags-library-dialog-light");
  await page.locator(".modal-close").click();
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "新建任务" }).click();
  await page.waitForSelector("#tasks-dialog-form");
  await page.locator(".tag-picker-toggle").click();
  await page.waitForTimeout(400);
  await shot("t4-tags-picker-dialog-light");

  // Create a temporary tag from inside the picker.
  const tagName = `验收标签${Date.now() % 1000}`;
  await page.locator(".tag-picker-panel .tag-manager-create input").fill(tagName);
  await page.locator(".tag-picker-panel .tag-manager-create-btn").click();
  await page.waitForTimeout(900);
  const createdInPicker = await page
    .locator(".tag-picker-panel .tag-manager-name", { hasText: tagName })
    .count();
  if (!createdInPicker) problems.push("picker: 新建标签后列表未出现该标签");
  const selectedChips = await page.locator(".tag-picker-chip").count();
  if (!selectedChips) problems.push("picker: 新建标签后未自动选中");
  await shot("t4-tags-picker-created-light");

  // Finish creating a temporary task carrying that tag.
  await page.locator("#tasks-title").fill("T4 验收临时任务");
  await page.locator('.modal-footer button[type="submit"]').click();
  await page.waitForTimeout(1400);
  const newRow = page.locator(".tasks-row", { hasText: "T4 验收临时任务" });
  if (!(await newRow.count())) problems.push("create: 新任务未出现在列表中");
  const rowChips = await newRow.locator(".tag-chip").count();
  if (!rowChips) problems.push("create: 任务行未显示标签 chips");
  const filterCount = await page.locator(".tasks-tag-filter").count();
  if (!filterCount) problems.push("tags: 标签筛选条未出现");
  await shot("t4-tags-task-with-tag-light");

  // Filter by the new tag.
  await page.locator(".tasks-tag-filter", { hasText: tagName }).click();
  await page.waitForTimeout(400);
  await shot("t4-tags-filtered-light");
  await page.locator(".tasks-tag-filter", { hasText: "全部" }).click();
  await page.waitForTimeout(200);

  // ---------------- Dark theme ----------------
  await page.evaluate(() => localStorage.setItem("teamstudio.theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".tasks-table");
  await page.waitForTimeout(800);
  await shot("t4-tasks-dark");

  // Dark tag library dialog
  await page.locator(".tasks-tag-library-btn").click();
  await page.waitForTimeout(600);
  await shot("t4-tags-library-dialog-dark");

  // Rename + recolor the temporary tag, then delete it (cleanup + CRUD check).
  await page.locator(".tag-library-dialog .tag-manager-row", { hasText: tagName }).locator('button[title="重命名 / 换色"]').click();
  await page.waitForTimeout(300);
  const editInput = page.locator(".tag-library-dialog .tag-manager-row.is-editing input.tag-manager-input");
  await editInput.fill(`${tagName}改`);
  await page.locator(".tag-library-dialog .tag-manager-row.is-editing .tag-swatch").nth(4).click();
  await page.locator('.tag-library-dialog .tag-manager-row.is-editing button[title="保存"]').click();
  await page.waitForTimeout(900);
  await shot("t4-tags-renamed-dark");

  const renamedRow = page.locator(".tag-library-dialog .tag-manager-row", { hasText: `${tagName}改` });
  if (!(await renamedRow.count())) problems.push("tags: 重命名标签失败");
  await renamedRow.locator('button[title="删除标签"]').click();
  await page.waitForTimeout(250);
  await page.locator(".tag-library-dialog .tag-manager-row.is-confirming .btn-danger").click();
  await page.waitForTimeout(900);
  const stillThere = await page.locator(".tag-library-dialog .tag-manager-row", { hasText: `${tagName}改` }).count();
  if (stillThere) problems.push("tags: 删除标签失败");
  await page.locator(".modal-close").click();
  await page.waitForTimeout(300);

  // Delete the temporary task (cleanup).
  const targetRow = page.locator(".tasks-row", { hasText: "T4 验收临时任务" });
  if (await targetRow.count()) {
    await targetRow.locator('button[title="删除任务"]').click();
    await page.waitForTimeout(400);
    await page.locator(".modal-footer .btn-danger").click();
    await page.waitForTimeout(900);
  }

  // ---------------- Aggregate scope (team) ----------------
  await page.evaluate(() => {
    localStorage.setItem("teamstudio.theme", "light");
    localStorage.setItem("teamstudio.scope", "team");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".tasks-table");
  await page.waitForTimeout(1000);
  const groupBadges = await page.locator(".tasks-group-badge").count();
  if (!groupBadges) problems.push("scope=team: 未显示任务所属开发组徽章");
  await shot("t4-tasks-aggregate-team-light");

  // Aggregate tag library dialog should offer a group selector.
  await page.locator(".tasks-tag-library-btn").click();
  await page.waitForTimeout(700);
  const groupSelector = await page.locator(".tag-library-dialog .tag-library-group").count();
  if (!groupSelector) problems.push("scope=team: 标签库弹窗缺少开发组选择器");
  await shot("t4-tags-library-aggregate-light");
  await page.locator(".modal-close").click();
  await page.waitForTimeout(200);

  await page.evaluate(() => localStorage.setItem("teamstudio.scope", "group"));

  console.log("\n--- results ---");
  console.log("shots:", shots.length);
  console.log("tagCount in library:", tagCount);
  console.log("priority aria-sort:", priorityAria, "created aria-sort:", createdAria);
  console.log("problems:", problems.length ? JSON.stringify(problems, null, 2) : "none");
} catch (error) {
  problems.push(`script: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await shot("t4-tasks-error-state").catch(() => {});
  console.log("problems:", JSON.stringify(problems, null, 2));
} finally {
  await browser.close();
  if (problems.length) process.exitCode = 1;
}
