/**
 * Refresh the README screenshots that changed in round 3 and capture the new
 * workspace-manager / workload-detail / multi-backup responsibility matrix views.
 *
 * Usage: node e2e/round3-docs-shots.mjs   (QA_URL defaults to http://127.0.0.1:8000)
 *
 * The script first makes the demo responsibility data show the new capabilities
 * (multiple backups per area) so the screenshots match the feature.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const OUT = "../docs/screenshots";

async function patchDemoBackups() {
  const matrixUrl = `${BASE}/api/teams/team-aurora/groups/grp-frontend/matrix`;
  const response = await fetch(matrixUrl);
  const payload = await response.json();
  const areas = payload?.data?.areas ?? [];
  // Idempotent: the first two seeded areas demonstrate multiple backup members.
  const patches = [
    [areas[0]?.id, ["m-chen", "m-he"]],
    [areas[1]?.id, ["m-su", "m-he"]],
    [areas[3]?.id, ["m-chen", "m-lin"]],
  ];
  for (const [areaId, backupMemberIds] of patches) {
    if (!areaId) continue;
    await fetch(`${matrixUrl}/${areaId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backupMemberIds }),
    });
  }
  console.log("demo multi-backup areas patched");
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function makePage(theme = "light", scope = "group") {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  await context.addInitScript(
    ([t, s]) => {
      localStorage.setItem("teamstudio.theme", t);
      localStorage.setItem("teamstudio.scope", s);
    },
    [theme, scope],
  );
  const page = await context.newPage();
  return { context, page };
}

const shot = (page, name, fullPage = false) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage, animations: "disabled" });

async function openRoute(page, route, waitSelector, timeout = 15000) {
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "networkidle" });
  if (waitSelector) await page.locator(waitSelector).first().waitFor({ timeout });
  await page.waitForTimeout(700);
}

await patchDemoBackups();

/* ---------------- light theme ---------------- */
{
  const { context, page } = await makePage("light", "group");

  await openRoute(page, "overview", ".ov-hero");
  await shot(page, "overview");

  // Workspace manager (new in round 3).
  await page.locator(".user-chip").click();
  await page.locator(".user-popover").waitFor();
  await page.locator(".user-popover .menu-row").filter({ hasText: "工作区管理" }).click();
  await page.locator(".modal-panel").filter({ hasText: "工作区管理" }).waitFor();
  await page.waitForTimeout(500);
  await shot(page, "workspace-manager");
  await page.locator(".modal-panel .modal-close").click();
  await page.locator(".modal-panel").waitFor({ state: "detached" });

  // Member drawer.
  await page.locator(".ov-member-card").first().click();
  await page.locator("#md-title").waitFor();
  await page.waitForTimeout(500);
  await shot(page, "member-drawer");
  await page.locator(".md-close").click();
  await page.locator(".md-scrim").waitFor({ state: "detached" });

  // Group switcher popover.
  await page.locator(".group-switcher-button").click();
  await page.locator(".group-popover").waitFor();
  await page.waitForTimeout(350);
  await shot(page, "sidebar-group-switch");
  await page.locator(".group-switcher-button").click();
  await page.waitForTimeout(250);

  // Task overview + workload detail dialog (new in round 3).
  await openRoute(page, "tasks", ".tasks-workload-rail");
  await shot(page, "tasks");

  await page.locator(".tasks-wl").first().click();
  await page.locator(".modal-panel").filter({ hasText: "负载详情" }).waitFor();
  await page.waitForTimeout(600);
  await shot(page, "workload-detail");
  await page.locator(".modal-panel .modal-close").click();
  await page.locator(".modal-panel").waitFor({ state: "detached" });

  // Task creation dialog with the member dropdown open.
  await page.getByRole("button", { name: /新建任务/ }).first().click();
  await page.locator(".modal-panel").waitFor();
  await page.waitForTimeout(400);
  const memberSelect = page.locator(".modal-panel .ts-select-trigger").first();
  await memberSelect.click();
  await page.locator(".ts-select-panel").waitFor();
  await page.waitForTimeout(300);
  await shot(page, "task-dialog");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // Tag picker expanded inside the same dialog.
  const tagToggle = page.locator(".tag-picker-toggle").first();
  if (await tagToggle.count()) {
    await tagToggle.click();
    await page.locator(".tag-picker-panel").waitFor();
    await page.waitForTimeout(400);
    await shot(page, "tags");
    await tagToggle.click();
  }
  await page.locator(".modal-panel .modal-close").click();
  await page.locator(".modal-panel").waitFor({ state: "detached" });

  // Tag library dialog.
  const tagLibrary = page.locator(".tasks-tag-library-btn");
  if (await tagLibrary.count()) {
    await tagLibrary.click();
    await page.locator(".modal-panel").waitFor();
    await page.waitForTimeout(600);
    await shot(page, "tag-library");
    await page.locator(".modal-panel .modal-close").click();
    await page.locator(".modal-panel").waitFor({ state: "detached" });
  }

  // Custom select open (member filter).
  const filterSelect = page.locator(".tasks-filters .ts-select-trigger").first();
  if (await filterSelect.count()) {
    await filterSelect.click();
    await page.locator(".ts-select-panel").waitFor();
    await page.waitForTimeout(300);
    await shot(page, "select-open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  await openRoute(page, "insights", ".insights-page");
  await shot(page, "insights");

  await openRoute(page, "calendar", ".cal-month");
  await shot(page, "calendar");

  // Responsibility matrix (description column + multiple backups).
  await openRoute(page, "matrix", ".mx-table");
  await shot(page, "matrix");
  const networkToggle = page.getByRole("button", { name: /网络视图/ }).first();
  if (await networkToggle.count()) {
    await networkToggle.click();
    await page.locator(".mx-network").waitFor();
    await page.waitForTimeout(700);
    await shot(page, "matrix-network");
  }

  // Aggregated browsing scope screenshots. Navigate to a different route first so
  // the matrix page remounts in table view (the local view toggle is component state).
  await page.locator(".scope-option").nth(2).click();
  await page.waitForTimeout(900);
  await openRoute(page, "overview", ".ov-hero");
  await shot(page, "overview-scope-all");
  await openRoute(page, "matrix", ".mx-table");
  await shot(page, "matrix-all");
  await openRoute(page, "links", ".links-page");
  await shot(page, "scope-all-links");

  // Appearance settings + JSON editor.
  await openRoute(page, "settings?tab=appearance", ".settings-tabs");
  await shot(page, "appearance");
  await shot(page, "settings");
  await page.locator(".settings-tabs button").filter({ hasText: "高级 JSON" }).click();
  await page.locator(".monaco-editor").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  await shot(page, "settings-json");

  // Bundled mail centre (mailbox list + one message detail).
  await openRoute(page, "settings?tab=email", ".email-panel");
  const mailbox = page.locator(".email-mailbox-table");
  if (await mailbox.count()) {
    await mailbox.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await shot(page, "mail");
    const mailRow = page.locator(".email-mailbox-row").first();
    if (await mailRow.count()) {
      await mailRow.click();
      await page.locator(".modal-panel").waitFor();
      await page.waitForTimeout(500);
      await shot(page, "mail-detail");
      await page.locator(".modal-panel .modal-close").click();
      await page.locator(".modal-panel").waitFor({ state: "detached" });
    }
  }

  await context.close();
}

/* ---------------- dark theme ---------------- */
{
  const { context, page } = await makePage("dark", "group");
  await openRoute(page, "overview", ".ov-hero");
  await shot(page, "overview-dark");
  await openRoute(page, "tasks", ".tasks-workload-rail");
  await shot(page, "tasks-dark");
  await openRoute(page, "calendar", ".cal-month");
  await shot(page, "calendar-dark");
  await openRoute(page, "redblack", ".rb-page");
  await shot(page, "redblack-dark");
  await openRoute(page, "insights", ".insights-page");
  await shot(page, "insights-dark");
  await context.close();
}

await browser.close();
console.log("round 3 docs screenshots refreshed");
