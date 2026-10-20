/**
 * Round 3 independent QA — six user-requested optimizations (R1-R6).
 *
 * Usage (from `web/`):
 *   node e2e/round3-features.mjs
 *   QA_URL=http://127.0.0.1:5173 node e2e/round3-features.mjs
 *
 * Covers:
 *   R1 工作区管理中创建/删除团队与开发组（逐字名称确认、Escape 只关最上层弹窗）
 *   R2 默认主题跟随系统（无 localStorage 显式选择时）+ 设置页“跟随系统”预览联动
 *   R3 责任田多备份成员（UI 创建/编辑 + API 语义与校验）
 *   R4 责任田描述列与描述持久化
 *   R5 亮色主题更白、更中性（令牌/背景/表面）与暗色令牌不变
 *   R6 成员负载卡片打开逐任务负载详情（点击/键盘/在台账中筛选）
 *
 * 脚本只做验证，不改动产品源码；测试数据（QA-* 团队/开发组/责任田）在结束时自动清理。
 * 截图写入 ../artifacts/qa-r3-*.png；存在失败时进程退出码为 1。
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const SHOT = (name) => `../artifacts/qa-r3-${name}.png`;
const VIEWPORT = { width: 1440, height: 1000 };

/* ------------------------------------------------------------------ */
/* Result reporting                                                    */
/* ------------------------------------------------------------------ */

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const text = detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${text ? ` :: ${text}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* HTTP helpers (backend is same-origin device-admin from this host)   */
/* ------------------------------------------------------------------ */

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

/* ------------------------------------------------------------------ */
/* Browser helpers                                                     */
/* ------------------------------------------------------------------ */

async function newPage(browser, { theme = null } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  if (theme) {
    await context.addInitScript((value) => localStorage.setItem("teamstudio.theme", value), theme);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return { context, page, errors };
}

/* ------------------------------------------------------------------ */
/* Color maths for R5                                                  */
/* ------------------------------------------------------------------ */

function parseColor(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (text.startsWith("#")) {
    let hex = text.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length !== 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const nums = (text.match(/[\d.]+/g) || []).map(Number);
  return nums.length >= 3 ? nums.slice(0, 3) : null;
}
const luminance = (rgb) => (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
const channelSpread = (rgb) => Math.max(...rgb) - Math.min(...rgb);

/* ------------------------------------------------------------------ */
/* Test data                                                           */
/* ------------------------------------------------------------------ */

const STAMP = String(Date.now()).slice(-8);
const teamName = `QA-测试团队-${STAMP}`;
const teamDescription = `Round3 QA 临时团队 ${STAMP}（脚本自动清理）`;
const groupName = `QA-测试组-${STAMP}`;
const groupDescription = `Round3 QA 临时开发组 ${STAMP}`;
const areaName = `QA-责任田-${STAMP}`;
const areaDescription = `QA 多备份验证责任田 ${STAMP}`;
const apiAreaName = `QA-API-责任田-${STAMP}`;
const isMine = (value) => typeof value === "string" && value.includes(STAMP);

/* ------------------------------------------------------------------ */
/* Server precondition + ids of the default team/group                 */
/* ------------------------------------------------------------------ */

let bootTeamId = "";
let bootGroupId = "";
let matrixTeamId = "";
let matrixGroupId = "";

try {
  const boot = await api("/api/bootstrap");
  bootTeamId = boot.payload?.data?.active?.team?.id ?? "";
  bootGroupId = boot.payload?.data?.active?.group?.id ?? "";
  matrixTeamId = bootTeamId;
  matrixGroupId = bootGroupId;
  record(
    "R0 backend reachable and seeded workspace exposed",
    boot.status === 200 && Boolean(bootTeamId && bootGroupId),
    { status: boot.status, teamId: bootTeamId, groupId: bootGroupId },
  );
} catch (error) {
  record("R0 backend reachable and seeded workspace exposed", false, String(error));
}

const matrixPath = () =>
  `/api/teams/${encodeURIComponent(matrixTeamId)}/groups/${encodeURIComponent(matrixGroupId)}/matrix`;
const groupPath = (groupId) =>
  `/api/teams/${encodeURIComponent(matrixTeamId)}/groups/${encodeURIComponent(groupId)}`;

/* ------------------------------------------------------------------ */
/* Cleanup: remove every QA-* row created by this run                  */
/* ------------------------------------------------------------------ */

async function cleanup() {
  const report = { areas: [], groups: [], teams: [], errors: [] };
  try {
    const matrix = await api(matrixPath());
    for (const area of matrix.payload?.data?.areas ?? []) {
      if (isMine(area.area)) {
        const deleted = await api(`${matrixPath()}/${encodeURIComponent(area.id)}`, { method: "DELETE" });
        report.areas.push(`${area.area}:${deleted.status}`);
      }
    }
  } catch (error) {
    report.errors.push(`matrix cleanup: ${error.message}`);
  }
  try {
    const manage = await api("/api/workspace/manage");
    for (const team of manage.payload?.data?.teams ?? []) {
      for (const group of team.groups ?? []) {
        if (isMine(group.name)) {
          const deleted = await api(
            `/api/workspace/teams/${encodeURIComponent(team.id)}/groups/${encodeURIComponent(group.id)}`,
            { method: "DELETE", body: { confirmName: group.name } },
          );
          report.groups.push(`${group.name}:${deleted.status}`);
        }
      }
      if (isMine(team.name)) {
        const deleted = await api(`/api/workspace/teams/${encodeURIComponent(team.id)}`, {
          method: "DELETE",
          body: { confirmName: team.name },
        });
        report.teams.push(`${team.name}:${deleted.status}`);
      }
    }
  } catch (error) {
    report.errors.push(`workspace cleanup: ${error.message}`);
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const browser = await chromium.launch({ channel: "msedge", headless: true });
let createdGroupId = "";
let createdTeamId = "";

try {
  /* ================================================================ */
  /* R1 — workspace administration                                    */
  /* ================================================================ */
  {
    const { context, page, errors } = await newPage(browser, { theme: "light" });
    await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
    await sleep(1000);

    const manager = page.getByRole("dialog", { name: "工作区管理" });

    // user chip -> 工作区管理
    await page.locator(".user-chip").click();
    await page.locator(".user-popover").waitFor({ timeout: 6000 });
    const entryCount = await page.getByRole("button", { name: /工作区管理/ }).count();
    await page.getByRole("button", { name: /工作区管理/ }).click();
    await manager.waitFor({ timeout: 8000 });
    await page.locator(".wm-team").first().waitFor({ timeout: 12000 });
    await sleep(500);

    const initialTeamCount = await page.locator(".wm-team").count();
    const initialGroupCount = await page.locator(".wm-group").count();
    const scopeNote = await page.locator(".wm-scope-note").innerText().catch(() => "");
    record(
      "R1 user menu opens 工作区管理 and lists seeded workspace",
      entryCount === 1 && initialTeamCount === 2 && initialGroupCount === 5 && scopeNote.includes("系统内置管理员"),
      { entryCount, initialTeamCount, initialGroupCount, scopeNote: scopeNote.slice(0, 40) },
    );

    // create team
    await manager.getByRole("button", { name: /新建团队/ }).click();
    await manager.getByLabel("团队名称").fill(teamName);
    await manager.getByLabel("团队简介").fill(teamDescription);
    await manager.getByRole("button", { name: "创建团队", exact: true }).click();
    const teamSection = page.locator(".wm-team").filter({ has: page.locator("h3", { hasText: teamName }) });
    await teamSection.waitFor({ timeout: 12000 });
    await sleep(400);
    const createdTeam = await api("/api/workspace/manage");
    const createdTeamApi = (createdTeam.payload?.data?.teams ?? []).find((item) => item.name === teamName);
    createdTeamId = createdTeamApi?.id ?? "";
    const shortName = await teamSection.locator(".wm-team-title .badge").innerText().catch(() => "");
    const teamText = await teamSection.innerText();
    record(
      "R1 create team via UI (manager + short name default + description)",
      Boolean(createdTeamApi) &&
        teamText.includes(teamDescription) &&
        shortName.trim() === teamName.slice(0, 4) &&
        (await teamSection.getByRole("button", { name: /新建开发组/ }).count()) === 1,
      { teamId: createdTeamId, shortName, expectedShortName: teamName.slice(0, 4) },
    );

    // create dev group inside the new team
    await teamSection.getByRole("button", { name: /新建开发组/ }).click();
    await manager.getByLabel("开发组名称").fill(groupName);
    await manager.getByLabel("开发组简介").fill(groupDescription);
    await manager.getByRole("button", { name: "创建开发组", exact: true }).click();
    const groupRow = teamSection.locator(".wm-group").filter({ hasText: groupName });
    await groupRow.waitFor({ timeout: 12000 });
    await sleep(400);
    const teamAfterGroup = await teamSection.innerText();
    const manageAfterGroup = await api("/api/workspace/manage");
    const teamAfterGroupApi = (manageAfterGroup.payload?.data?.teams ?? []).find((item) => item.name === teamName);
    const groupApi = (teamAfterGroupApi?.groups ?? []).find((item) => item.name === groupName);
    createdGroupId = groupApi?.id ?? "";
    record(
      "R1 create dev group inside team (manager + counts)",
      Boolean(groupApi) &&
        teamAfterGroup.includes(groupDescription) &&
        teamAfterGroup.includes("1 个开发组") &&
        teamAfterGroupApi.groupCount === 1,
      { groupId: createdGroupId, groupCount: teamAfterGroupApi?.groupCount },
    );
    await page.screenshot({ path: SHOT("workspace-created") });

    // close manager -> sidebar team list contains the new team
    await manager.locator(".modal-footer").getByRole("button", { name: "关闭" }).click();
    await manager.waitFor({ state: "detached", timeout: 8000 });
    await sleep(700);
    await page.locator(".team-switcher-button").click();
    await page.locator(".team-popover").waitFor({ timeout: 6000 });
    const sidebarTeams = await page.locator(".team-popover .team-option strong").allInnerTexts();
    record("R1 new team appears in sidebar team list after closing", sidebarTeams.includes(teamName), sidebarTeams);
    await page.locator(".sidebar-brand .brand-copy").click();
    await sleep(300);

    // reopen manager for deletion
    await page.locator(".user-chip").click();
    await page.locator(".user-popover").waitFor({ timeout: 6000 });
    await page.getByRole("button", { name: /工作区管理/ }).click();
    await manager.waitFor({ timeout: 8000 });
    await page.locator(".wm-team").first().waitFor({ timeout: 12000 });
    await sleep(600);
    const teamSection2 = page.locator(".wm-team").filter({ has: page.locator("h3", { hasText: teamName }) });
    await teamSection2.waitFor({ timeout: 8000 });

    // typed confirm: group deletion
    await teamSection2.locator(".wm-group-delete").click();
    let confirm = page.getByRole("dialog", { name: /删除开发组/ });
    await confirm.waitFor({ timeout: 6000 });
    const groupLabelTexts = await confirm.locator("label").allInnerTexts();
    let submit = confirm.locator('button[type="submit"]');
    const initiallyDisabled = await submit.isDisabled();
    await confirm.locator(".confirm-input input").fill("QA-不匹配名称");
    await sleep(350);
    const mismatchHint = await confirm.locator(".field-hint").innerText();
    const mismatchDisabled = await submit.isDisabled();
    record(
      "R1 typed confirm for group locks delete until exact name is typed",
      groupLabelTexts.some((text) => text.includes("开发组名称")) &&
        initiallyDisabled &&
        mismatchDisabled &&
        mismatchHint.includes("名称不匹配"),
      { groupLabelTexts, initiallyDisabled, mismatchDisabled, mismatchHint },
    );
    await page.screenshot({ path: SHOT("workspace-confirm-mismatch") });

    // Escape must close only the topmost dialog
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached", timeout: 6000 });
    await sleep(300);
    const dialogCountAfterEscape = await page.locator(".modal-panel").count();
    const managerStillOpen = await page.getByRole("dialog", { name: "工作区管理" }).count();
    record(
      "R1 Escape closes only the topmost dialog (confirm closed, manager stays)",
      dialogCountAfterEscape === 1 && managerStillOpen === 1,
      { dialogCountAfterEscape, managerStillOpen },
    );

    // re-open and delete the group with the exact name
    await teamSection2.locator(".wm-group-delete").click();
    confirm = page.getByRole("dialog", { name: /删除开发组/ });
    await confirm.waitFor({ timeout: 6000 });
    submit = confirm.locator('button[type="submit"]');
    await confirm.locator(".confirm-input input").fill(groupName);
    await sleep(350);
    const matchedHint = await confirm.locator(".field-hint").innerText();
    const enabledAtExact = await submit.isEnabled();
    await page.screenshot({ path: SHOT("workspace-confirm-ready") });
    await submit.click();
    await confirm.waitFor({ state: "detached", timeout: 12000 });
    await sleep(1400);
    const groupGoneInManager = (await page.locator(".wm-group").filter({ hasText: groupName }).count()) === 0;
    const manageAfterGroupDelete = await api("/api/workspace/manage");
    const teamAfterGroupDelete = (manageAfterGroupDelete.payload?.data?.teams ?? []).find(
      (item) => item.name === teamName,
    );
    record(
      "R1 delete group: exact name enables confirm and group disappears",
      matchedHint.includes("名称已匹配") &&
        enabledAtExact &&
        groupGoneInManager &&
        Boolean(teamAfterGroupDelete) &&
        !teamAfterGroupDelete.groups.some((group) => group.name === groupName),
      { matchedHint, enabledAtExact, groupGoneInManager },
    );

    // typed confirm: team deletion
    const teamSection3 = page.locator(".wm-team").filter({ has: page.locator("h3", { hasText: teamName }) });
    await teamSection3.waitFor({ timeout: 8000 });
    await teamSection3.getByRole("button", { name: "删除团队", exact: true }).click();
    const teamConfirm = page.getByRole("dialog", { name: /删除团队/ });
    await teamConfirm.waitFor({ timeout: 6000 });
    const teamLabelTexts = await teamConfirm.locator("label").allInnerTexts();
    const teamInput = teamConfirm.locator(".confirm-input input");
    await teamInput.fill("QA-错误团队名");
    await sleep(300);
    const teamDisabledOnMismatch = await teamConfirm.locator('button[type="submit"]').isDisabled();
    await teamInput.fill(teamName);
    await sleep(350);
    const teamEnabledOnMatch = await teamConfirm.locator('button[type="submit"]').isEnabled();
    await page.screenshot({ path: SHOT("workspace-confirm-team") });
    await teamConfirm.locator('button[type="submit"]').click();
    await teamConfirm.waitFor({ state: "detached", timeout: 12000 });
    await sleep(1600);
    const teamGoneInManager = (await page.locator(".wm-team h3").filter({ hasText: teamName }).count()) === 0;
    const footerAfterTeamDelete = await page.locator(".wm-modal .modal-footer").innerText();
    record(
      "R1 delete team: typed confirm, manager back to seeded footer",
      teamLabelTexts.some((text) => text.includes("团队名称")) &&
        teamDisabledOnMismatch &&
        teamEnabledOnMatch &&
        teamGoneInManager &&
        footerAfterTeamDelete.includes("共 2 个团队 · 5 个开发组"),
      { teamLabelTexts, teamDisabledOnMismatch, teamEnabledOnMatch, teamGoneInManager, footerAfterTeamDelete },
    );

    // sidebar team list no longer shows the deleted team
    await page.locator(".wm-modal .modal-footer").getByRole("button", { name: "关闭" }).click();
    await manager.waitFor({ state: "detached", timeout: 8000 });
    await sleep(800);
    await page.locator(".team-switcher-button").click();
    await page.locator(".team-popover").waitFor({ timeout: 6000 });
    const sidebarAfterDelete = await page.locator(".team-popover .team-option strong").allInnerTexts();
    record(
      "R1 deleted team removed from sidebar team list",
      !sidebarAfterDelete.includes(teamName) &&
        sidebarAfterDelete.includes("极光产品团队") &&
        sidebarAfterDelete.includes("远航数据团队"),
      sidebarAfterDelete,
    );
    await page.locator(".sidebar-brand .brand-copy").click();
    await sleep(300);

    // API state after R1 cleanup
    const manageFinal = await api("/api/workspace/manage");
    const teamsFinal = manageFinal.payload?.data?.teams ?? [];
    const teamIds = teamsFinal.map((team) => team.id).sort();
    const groupTotal = teamsFinal.reduce((total, team) => total + team.groups.length, 0);
    record(
      "R1 workspace API after cleanup: exactly seeded 2 teams / 5 groups",
      manageFinal.status === 200 &&
        teamsFinal.length === 2 &&
        teamIds.join(",") === "team-aurora,team-voyage" &&
        groupTotal === 5 &&
        teamsFinal.every((team) => !isMine(team.name)),
      { teamIds, groupTotal },
    );
    record("R1 no console/page errors", errors.length === 0, errors.slice(0, 5));
    await context.close();
  }

  /* ================================================================ */
  /* R2 — default theme follows system                               */
  /* ================================================================ */
  {
    const { context, page, errors } = await newPage(browser); // intentionally no teamstudio.theme
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
    await sleep(1200);
    const bootState = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem("teamstudio.theme"),
    }));
    record(
      "R2 fresh visitor follows system dark (no explicit choice stored)",
      bootState.theme === "dark" && bootState.stored === null,
      bootState,
    );

    await page.emulateMedia({ colorScheme: "light" });
    await sleep(800);
    const liveState = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem("teamstudio.theme"),
    }));
    record(
      "R2 live system switch to light flips theme immediately",
      liveState.theme === "light" && liveState.stored === null,
      liveState,
    );

    // topbar manual toggle persists an explicit choice
    await page.locator('button[aria-label="切换主题"]').click();
    await sleep(500);
    const toggled = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem("teamstudio.theme"),
    }));
    record(
      "R2 topbar toggle stores an explicit theme choice",
      toggled.theme === "dark" && toggled.stored === "dark",
      toggled,
    );

    await page.reload({ waitUntil: "networkidle" });
    await sleep(1200);
    const persisted = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem("teamstudio.theme"),
    }));
    record(
      "R2 explicit choice survives reload even when system prefers light",
      persisted.theme === "dark" && persisted.stored === "dark",
      persisted,
    );
    await page.screenshot({ path: SHOT("theme-system") });
    record("R2 no console/page errors", errors.length === 0, errors.slice(0, 5));
    await context.close();
  }

  // settings appearance section
  {
    const { context, page, errors } = await newPage(browser);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${BASE}/#/settings?tab=appearance`, { waitUntil: "networkidle" });
    await page.waitForSelector(".settings-mode-switch button", { timeout: 12000 });
    await sleep(900);
    const modeButtons = await page.locator(".settings-mode-switch button").allInnerTexts();
    const activeModes = await page.locator(".settings-mode-switch button.active").allInnerTexts();
    record(
      "R2 settings lists 跟随系统 first, recommended and active by default",
      modeButtons.length === 3 &&
        modeButtons[0].includes("跟随系统") &&
        modeButtons[0].includes("推荐") &&
        activeModes.length === 1 &&
        activeModes[0].includes("跟随系统"),
      { modeButtons, activeModes },
    );

    const previewBefore = await page.locator(".settings-preview").getAttribute("data-preview-mode");
    await page.emulateMedia({ colorScheme: "dark" });
    await sleep(800);
    const previewDark = await page.locator(".settings-preview").getAttribute("data-preview-mode");
    await page.emulateMedia({ colorScheme: "light" });
    await sleep(800);
    const previewLight = await page.locator(".settings-preview").getAttribute("data-preview-mode");
    record(
      "R2 settings auto preview follows live system theme",
      previewBefore === "light" && previewDark === "dark" && previewLight === "light",
      { previewBefore, previewDark, previewLight },
    );
    await page.screenshot({ path: SHOT("appearance-auto") });
    record("R2 settings no console/page errors", errors.length === 0, errors.slice(0, 5));
    await context.close();
  }

  /* ================================================================ */
  /* R5 — whiter, more neutral light theme                            */
  /* ================================================================ */
  {
    const { context, page, errors } = await newPage(browser, { theme: "light" });
    await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
    await sleep(1000);
    const lightTokens = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        theme: document.documentElement.dataset.theme,
        bg: styles.getPropertyValue("--bg").trim(),
        paper: styles.getPropertyValue("--paper").trim(),
        surface: styles.getPropertyValue("--surface").trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    const bg = parseColor(lightTokens.bg);
    const paper = parseColor(lightTokens.paper);
    const surface = parseColor(lightTokens.surface);
    const bodyBg = parseColor(lightTokens.bodyBg);

    record(
      "R5 light --bg/--paper are whiter neutral paper (~#f7f7f5)",
      lightTokens.theme === "light" &&
        Boolean(bg && paper) &&
        luminance(bg) > 235 &&
        luminance(paper) > 235 &&
        channelSpread(bg) <= 4 &&
        channelSpread(paper) <= 4,
      { ...lightTokens, bgLum: bg ? luminance(bg) : null, paperLum: paper ? luminance(paper) : null },
    );
    record(
      "R5 light body background is near-neutral (|R-B| <= 3)",
      Boolean(bodyBg) && Math.abs(bodyBg[0] - bodyBg[2]) <= 3 && luminance(bodyBg) > 240,
      { bodyBg: lightTokens.bodyBg, parsed: bodyBg, diffRB: bodyBg ? Math.abs(bodyBg[0] - bodyBg[2]) : null },
    );
    record(
      "R5 light surface stays near-white (luminance >= 250, neutral)",
      Boolean(surface) && luminance(surface) >= 250 && channelSpread(surface) <= 4,
      { surface: lightTokens.surface, surfaceLum: surface ? luminance(surface) : null },
    );
    await page.screenshot({ path: SHOT("light-theme") });
    await context.close();

    const darkPage = await newPage(browser, { theme: "dark" });
    await darkPage.page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
    await sleep(1000);
    const darkTokens = await darkPage.page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        theme: document.documentElement.dataset.theme,
        bg: styles.getPropertyValue("--bg").trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    const darkBg = parseColor(darkTokens.bg);
    record(
      "R5 dark --bg token unchanged (~#09090b)",
      darkTokens.theme === "dark" &&
        Boolean(darkBg) &&
        luminance(darkBg) < 20 &&
        Math.abs(darkBg[0] - 9) <= 2 &&
        Math.abs(darkBg[1] - 9) <= 2 &&
        Math.abs(darkBg[2] - 11) <= 2,
      { ...darkTokens, darkLum: darkBg ? luminance(darkBg) : null },
    );
    await darkPage.page.screenshot({ path: SHOT("dark-theme") });
    record(
      "R5 no console/page errors (light + dark)",
      errors.length === 0 && darkPage.errors.length === 0,
      [...errors, ...darkPage.errors].slice(0, 5),
    );
    await darkPage.context.close();
  }

  /* ================================================================ */
  /* R6 — member workload detail dialog                               */
  /* ================================================================ */
  {
    const { context, page, errors } = await newPage(browser, { theme: "light" });
    await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
    await sleep(1800);

    const cards = page.locator(".tasks-wl");
    const cardCount = await cards.count();
    const first = cards.first();
    const aria = await first.getAttribute("aria-label");
    const role = await first.getAttribute("role");
    const memberName = (await first.locator(".tasks-wl-title strong").innerText()).trim();
    record(
      "R6 workload rail cards are clickable buttons",
      cardCount > 0 && role === "button" && /查看 .* 的详细负载/.test(aria ?? ""),
      { cardCount, role, aria },
    );

    // click -> detail dialog
    await first.click();
    const detail = page.getByRole("dialog", { name: /负载详情/ });
    await detail.waitFor({ timeout: 8000 });
    const detailTitle = (await detail.locator("h2").innerText()).trim();
    record(
      "R6 clicking a workload card opens that member's detail dialog",
      detailTitle.includes("负载详情") && detailTitle.includes(memberName),
      { detailTitle, memberName },
    );

    const barHead = (await detail.locator(".wl-detail-bar-head").first().innerText()).replace(/\n/g, " ");
    const heroText = await detail.locator(".wl-detail-hero").innerText();
    const statCount = await detail.locator(".wl-detail-stat").count();
    const capacity = await page.evaluate(() => {
      const match = document.body.innerText.match(/容量\s*([\d.]+)\s*\/\s*周/);
      return match ? match[1] : null;
    });
    record(
      "R6 detail shows points/capacity summary and task counters",
      /\d+(\.\d+)?\s*分\s*\/\s*\d+(\.\d+)?\s*分/.test(barHead) &&
        barHead.includes("15") &&
        heroText.includes("未完成") &&
        statCount >= 4,
      { barHead, statCount, capacity },
    );

    const formulas = await detail.locator(".wl-detail-task-points small").allInnerTexts();
    record(
      "R6 at least one task row shows 基础/优先级/难度 point formula",
      formulas.some((text) => /基础\s*\d+\s*\+\s*优先级\s*\d+\s*\+\s*难度\s*\d+/.test(text)),
      formulas.slice(0, 4),
    );
    await page.screenshot({ path: SHOT("workload-detail") });

    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "detached", timeout: 6000 });
    record("R6 Escape closes the workload detail dialog", (await page.locator(".modal-panel").count()) === 0, {});

    // keyboard Enter opens the same dialog
    await first.focus();
    await page.keyboard.press("Enter");
    const detailByKeyboard = page.getByRole("dialog", { name: /负载详情/ });
    await detailByKeyboard.waitFor({ timeout: 8000 });
    record(
      "R6 keyboard Enter opens the workload detail dialog",
      (await detailByKeyboard.locator("h2").innerText()).includes("负载详情"),
      {},
    );
    await page.keyboard.press("Escape");
    await detailByKeyboard.waitFor({ state: "detached", timeout: 6000 });

    // "在台账中筛选该成员" -> member filter applied + dialog closes
    await first.click();
    const detailForFilter = page.getByRole("dialog", { name: /负载详情/ });
    await detailForFilter.waitFor({ timeout: 8000 });
    await detailForFilter.getByRole("button", { name: /在台账中筛选该成员/ }).click();
    await detailForFilter.waitFor({ state: "detached", timeout: 8000 });
    await sleep(600);
    const filterValue = (
      await page.locator('[role=combobox][aria-label="按成员筛选"] .ts-select-value-label').innerText()
    ).trim();
    record(
      "R6 在台账中筛选该成员 sets the member filter and closes the dialog",
      filterValue === memberName,
      { filterValue, memberName },
    );
    record("R6 no console/page errors", errors.length === 0, errors.slice(0, 5));
    await context.close();
  }

  /* ================================================================ */
  /* R3 + R4 — responsibility matrix: multiple backups + description  */
  /* ================================================================ */
  {
    const { context, page, errors } = await newPage(browser, { theme: "light" });
    await page.goto(`${BASE}/#/matrix`, { waitUntil: "networkidle" });
    await sleep(1800);

    const ids = await page.evaluate(() => ({
      team: localStorage.getItem("teamstudio.team"),
      group: localStorage.getItem("teamstudio.group"),
    }));
    if (ids.team) matrixTeamId = ids.team;
    if (ids.group) matrixGroupId = ids.group;
    const mPath = matrixPath();

    // seeded matrix sanity + R4 header/description
    const headers = await page.locator(".mx-table thead th").allInnerTexts();
    const seededDescriptions = (await page.locator(".mx-desc").allInnerTexts()).map((text) => text.trim());
    record(
      "R4 table has 责任田描述 column and seeded descriptions are visible",
      headers.includes("责任田描述") && seededDescriptions.some(Boolean),
      { headers, seededDescriptions: seededDescriptions.slice(0, 3) },
    );

    // pick a valid owner and two other members of this group from the API
    const matrixBefore = await api(mPath);
    const areasBefore = matrixBefore.payload?.data?.areas ?? [];
    const memberNameById = new Map();
    for (const area of areasBefore) {
      if (area.ownerMemberId && area.ownerName) memberNameById.set(area.ownerMemberId, area.ownerName);
      for (const backup of area.backups ?? []) memberNameById.set(backup.id, backup.name);
    }
    const ownerSource = areasBefore.find(
      (area) => area.ownerMemberId && (area.backups ?? []).some((backup) => backup.id !== area.ownerMemberId),
    );
    const ownerId = ownerSource?.ownerMemberId;
    const ownerName = ownerSource?.ownerName;
    const otherMembers = [...memberNameById.entries()].filter(([id]) => id !== ownerId);
    const backup1Id = otherMembers[0]?.[0];
    const backup1Name = otherMembers[0]?.[1];
    const backup2Id = otherMembers[1]?.[0];
    const backup2Name = otherMembers[1]?.[1];

    if (!ownerId || !backup1Id || !backup2Id) {
      record("R3 test member selection available", false, { ownerId, backup1Id, backup2Id });
    } else {
      record("R3 test member selection available", true, { ownerName, backup1Name, backup2Name });
    }

    // create area via UI: description + one owner + two backups
    await page.getByRole("button", { name: /新增责任田/ }).click();
    const createModal = page.getByRole("dialog", { name: "新增责任田" });
    await createModal.waitFor({ timeout: 8000 });
    await createModal.getByPlaceholder("例如：前端架构 / 数据看板 / 客户对接").fill(areaName);
    await createModal.getByLabel("责任田描述（选填）").fill(areaDescription);

    await createModal.locator('[role=combobox][aria-label="负责人"]').click();
    const ownerPanel = page.locator(".ts-select-panel");
    await ownerPanel.waitFor({ timeout: 6000 });
    await ownerPanel.locator(".ts-select-option").filter({ hasText: ownerName }).first().click();
    await ownerPanel.waitFor({ state: "detached", timeout: 6000 });

    const msTrigger = createModal.locator('[role=combobox][aria-label="备份成员（可多选）"]');
    await msTrigger.click();
    const msPanel = page.locator(".ts-multiselect-panel");
    await msPanel.waitFor({ timeout: 6000 });
    const msSearch = msPanel.locator(".ts-multiselect-search-input");
    await msSearch.fill(backup1Name);
    await sleep(300);
    await msPanel.locator(".ts-multiselect-option").filter({ hasText: backup1Name }).first().click();
    await sleep(250);
    await msSearch.fill(backup2Name);
    await sleep(300);
    await msPanel.locator(".ts-multiselect-option").filter({ hasText: backup2Name }).first().click();
    await sleep(250);
    const msFooter = (await msPanel.locator(".ts-multiselect-footer").innerText()).replace(/\n/g, " ");
    await page.screenshot({ path: SHOT("matrix-multiselect") });
    await msPanel.locator(".ts-multiselect-done").click();
    await msPanel.waitFor({ state: "detached", timeout: 6000 });
    const triggerChips = (await msTrigger.locator(".ts-multiselect-chip-label").allInnerTexts()).map((text) =>
      text.trim(),
    );

    await createModal.getByRole("button", { name: "创建责任田" }).click();
    await createModal.waitFor({ state: "detached", timeout: 12000 });
    await sleep(1400);

    const areaRow = page.locator(".mx-table tbody tr").filter({ hasText: areaName }).first();
    await areaRow.waitFor({ timeout: 8000 });
    const backupChips = (await areaRow.locator(".mx-backup-chip").allInnerTexts()).map((text) => text.trim());
    const ownerCell = (await areaRow.locator(".mx-member").innerText()).trim();
    const descCell = (await areaRow.locator(".mx-desc").innerText()).trim();
    // Avatar initials render as an extra leading line (e.g. "知夏\n林知夏"); the name is the last line.
    const lastLine = (text) =>
      text
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean)
        .pop();
    const backupChipNames = backupChips.map(lastLine);
    const ownerCellName = lastLine(ownerCell);
    record(
      "R3 UI create area with owner + two backups succeeds",
      triggerChips.length === 2 && msFooter.includes("已选 2") && backupChips.length === 2,
      { triggerChips, msFooter, backupChips },
    );
    record(
      "R3 table row shows both backup member chips",
      backupChipNames.includes(backup1Name) && backupChipNames.includes(backup2Name) && ownerCellName === ownerName,
      { backupChipNames, ownerCellName },
    );
    record("R4 new area row shows the entered description in the column", descCell === areaDescription, {
      descCell,
      expected: areaDescription,
    });
    await page.screenshot({ path: SHOT("matrix-created") });

    // API persistence for the created area
    const matrixAfterCreate = await api(mPath);
    const areaFromApi = (matrixAfterCreate.payload?.data?.areas ?? []).find((area) => area.area === areaName);
    const apiBackupIds = areaFromApi?.backupMemberIds ?? [];
    record(
      "R3 API persists single owner and both backupMemberIds",
      areaFromApi?.ownerMemberId === ownerId &&
        Array.isArray(apiBackupIds) &&
        apiBackupIds.length === 2 &&
        apiBackupIds.includes(backup1Id) &&
        apiBackupIds.includes(backup2Id) &&
        (areaFromApi?.backups ?? []).length === 2,
      {
        ownerMemberId: areaFromApi?.ownerMemberId,
        ownerId,
        apiBackupIds,
        expected: [backup1Id, backup2Id],
      },
    );

    // reopen editor: description + both backups prefilled, then edit description
    await areaRow.locator('button[aria-label^="编辑 "]').click();
    const editModal = page.getByRole("dialog", { name: "编辑责任田" });
    await editModal.waitFor({ timeout: 8000 });
    const prefilledDescription = await editModal.getByLabel("责任田描述（选填）").inputValue();
    const prefilledBackups = (await editModal.locator(".ts-multiselect-chip-label").allInnerTexts()).map((text) =>
      text.trim(),
    );
    const prefilledOwner = (await editModal.locator('[role=combobox][aria-label="负责人"]').innerText()).trim();
    record(
      "R3 reopened editor preselects both backups + owner and prefills description",
      prefilledDescription === areaDescription &&
        prefilledBackups.length === 2 &&
        prefilledBackups.includes(backup1Name) &&
        prefilledBackups.includes(backup2Name) &&
        prefilledOwner.includes(ownerName),
      { prefilledDescription, prefilledBackups, prefilledOwner },
    );

    const updatedDescription = `${areaDescription}（已更新）`;
    await editModal.getByLabel("责任田描述（选填）").fill(updatedDescription);
    await editModal.getByRole("button", { name: "保存修改" }).click();
    await editModal.waitFor({ state: "detached", timeout: 12000 });
    await sleep(1000);
    const descAfterEdit = (await areaRow.locator(".mx-desc").innerText()).trim();
    const matrixAfterEdit = await api(mPath);
    const areaAfterEdit = (matrixAfterEdit.payload?.data?.areas ?? []).find((area) => area.area === areaName);
    record(
      "R4 edited description persisted (UI cell + API round-trip)",
      descAfterEdit === updatedDescription &&
        areaAfterEdit?.description === updatedDescription &&
        (areaAfterEdit?.backupMemberIds ?? []).length === 2,
      { descAfterEdit, apiDescription: areaAfterEdit?.description },
    );

    // a member can be a backup on 2+ areas
    const backupUse = new Map();
    for (const area of matrixAfterEdit.payload?.data?.areas ?? []) {
      for (const id of area.backupMemberIds ?? []) {
        backupUse.set(id, (backupUse.get(id) ?? 0) + 1);
      }
    }
    const multiBackupMembers = [...backupUse.entries()]
      .filter(([, count]) => count >= 2)
      .map(([id, count]) => ({ id, name: memberNameById.get(id) ?? id, count }));
    record(
      "R3 same member can back up multiple responsibility areas (API)",
      multiBackupMembers.length >= 1,
      multiBackupMembers.slice(0, 3),
    );

    // each area: exactly one owner (string or null), backup array, owner never a backup
    const allAreas = matrixAfterEdit.payload?.data?.areas ?? [];
    const malformed = allAreas.filter(
      (area) =>
        !(area.ownerMemberId === null || typeof area.ownerMemberId === "string") ||
        !Array.isArray(area.backupMemberIds),
    );
    const ownerAlsoBackup = allAreas.filter(
      (area) => area.ownerMemberId && (area.backupMemberIds ?? []).includes(area.ownerMemberId),
    );
    record(
      "R3 owner uniqueness: one owner per area, backups are arrays, owner not a backup",
      allAreas.length > 0 && malformed.length === 0 && ownerAlsoBackup.length === 0,
      { areaCount: allAreas.length, malformed: malformed.length, ownerAlsoBackup: ownerAlsoBackup.length },
    );

    // API validation: owner among backups -> 422 owner_is_backup
    const ownerAsBackup = await api(mPath, {
      method: "POST",
      body: {
        area: `${apiAreaName}-owner-backup`,
        description: "should fail",
        ownerMemberId: ownerId,
        backupMemberIds: [ownerId],
      },
    });
    record(
      "R3 API rejects owner listed as backup (422 owner_is_backup)",
      ownerAsBackup.status === 422 && ownerAsBackup.payload?.error?.code === "owner_is_backup",
      { status: ownerAsBackup.status, error: ownerAsBackup.payload?.error },
    );

    // API validation: unknown backup id -> 422
    const unknownBackup = await api(mPath, {
      method: "POST",
      body: {
        area: `${apiAreaName}-unknown`,
        description: "should fail",
        ownerMemberId: ownerId,
        backupMemberIds: ["member-qa-does-not-exist"],
      },
    });
    record(
      "R3 API rejects unknown backup member id (422)",
      unknownBackup.status === 422,
      { status: unknownBackup.status, error: unknownBackup.payload?.error },
    );

    // API PATCH: two backups round-trip + description preserved across unrelated PATCH
    const tempDescription = `QA 临时责任田描述 ${STAMP}`;
    const tempCreated = await api(mPath, {
      method: "POST",
      body: {
        area: apiAreaName,
        description: tempDescription,
        ownerMemberId: ownerId,
        backupMemberIds: [backup1Id],
      },
    });
    const tempId = tempCreated.payload?.data?.area?.id;
    record(
      "R3 API creates an area with a backup array",
      tempCreated.status === 200 && tempCreated.payload?.data?.area?.backupMemberIds?.length === 1,
      { status: tempCreated.status, tempId },
    );
    if (tempId) {
      const patchedBackups = await api(`${mPath}/${encodeURIComponent(tempId)}`, {
        method: "PATCH",
        body: { backupMemberIds: [backup1Id, backup2Id] },
      });
      const patchedIds = patchedBackups.payload?.data?.area?.backupMemberIds ?? [];
      record(
        "R3 API PATCH to two backups is reflected in the response",
        patchedBackups.status === 200 &&
          Array.isArray(patchedIds) &&
          patchedIds.length === 2 &&
          patchedIds.includes(backup1Id) &&
          patchedIds.includes(backup2Id),
        { status: patchedBackups.status, patchedIds },
      );

      const patchedDescription = await api(`${mPath}/${encodeURIComponent(tempId)}`, {
        method: "PATCH",
        body: { description: `${tempDescription}（改）` },
      });
      const descriptionAfterPatch = patchedDescription.payload?.data?.area?.description;
      const patchedOtherField = await api(`${mPath}/${encodeURIComponent(tempId)}`, {
        method: "PATCH",
        body: { backupMemberIds: [backup1Id] },
      });
      const descriptionPreserved = patchedOtherField.payload?.data?.area?.description;
      record(
        "R4 description is returned unchanged when PATCHing other fields",
        descriptionAfterPatch === `${tempDescription}（改）` && descriptionPreserved === `${tempDescription}（改）`,
        { descriptionAfterPatch, descriptionPreserved },
      );

      // a member can own several areas too: the same owner on a second area is accepted
      const secondArea = await api(mPath, {
        method: "POST",
        body: { area: `${apiAreaName}-two`, description: "", ownerMemberId: ownerId, backupMemberIds: [] },
      });
      const secondAreaId = secondArea.payload?.data?.area?.id;
      const matrixSameOwner = await api(mPath);
      const sameOwnerAreas = (matrixSameOwner.payload?.data?.areas ?? []).filter(
        (area) => area.ownerMemberId === ownerId,
      );
      record(
        "R3 same member can own multiple responsibility areas (API)",
        secondArea.status === 200 && sameOwnerAreas.length >= 2,
        {
          status: secondArea.status,
          sameOwnerCount: sameOwnerAreas.length,
          areaNames: sameOwnerAreas.map((area) => area.area),
        },
      );
      if (secondAreaId) {
        await api(`${mPath}/${encodeURIComponent(secondAreaId)}`, { method: "DELETE" });
      }

      const deletedTemp = await api(`${mPath}/${encodeURIComponent(tempId)}`, { method: "DELETE" });
      if (deletedTemp.status !== 200) {
        record("R3 API temp area deleted", false, { status: deletedTemp.status });
      }
    }

    // delete the UI-created area through the UI
    await areaRow.locator('button[aria-label^="删除 "]').click();
    const deleteDialog = page.getByRole("dialog", { name: "删除责任田" });
    await deleteDialog.waitFor({ timeout: 6000 });
    await deleteDialog.getByRole("button", { name: "删除责任田" }).click();
    await deleteDialog.waitFor({ state: "detached", timeout: 10000 });
    await sleep(1000);
    const rowGone = (await page.locator(".mx-table tbody tr").filter({ hasText: areaName }).count()) === 0;
    const matrixAfterDelete = await api(mPath);
    const qaAreasLeft = (matrixAfterDelete.payload?.data?.areas ?? []).filter((area) => isMine(area.area));
    record(
      "R3 UI-created test area deleted via UI (API confirms)",
      rowGone && qaAreasLeft.length === 0,
      { rowGone, qaAreasLeft: qaAreasLeft.map((area) => area.area) },
    );
    record("R3/R4 no console/page errors", errors.length === 0, errors.slice(0, 5));
    await page.screenshot({ path: SHOT("matrix-after-cleanup") });
    await context.close();
  }
} catch (error) {
  record(
    "script completed without uncaught exception",
    false,
    error && error.stack ? String(error.stack).split("\n").slice(0, 4).join(" | ") : String(error),
  );
} finally {
  /* -------------------------------------------------------------- */
  /* Final cleanup + verification                                    */
  /* -------------------------------------------------------------- */
  let cleanupReport = { areas: [], groups: [], teams: [], errors: [] };
  try {
    cleanupReport = await cleanup();
    const manage = await api("/api/workspace/manage");
    const teams = manage.payload?.data?.teams ?? [];
    const groups = teams.reduce((total, team) => total + (team.groups?.length ?? 0), 0);
    let qaAreas = [];
    try {
      const matrix = await api(matrixPath());
      qaAreas = (matrix.payload?.data?.areas ?? []).filter((area) => isMine(area.area));
    } catch {
      qaAreas = [];
    }
    record(
      "cleanup: seeded workspace restored (2 teams / 5 groups, no QA data left)",
      manage.status === 200 &&
        teams.length === 2 &&
        groups === 5 &&
        teams.every((team) => !isMine(team.name)) &&
        qaAreas.length === 0,
      { teams: teams.map((team) => team.id), groups, qaAreas: qaAreas.map((area) => area.area), cleanupReport },
    );
  } catch (error) {
    record("cleanup: seeded workspace restored (2 teams / 5 groups, no QA data left)", false, String(error));
  }
  await browser.close();
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

const failed = results.filter((item) => !item.ok);
const passed = results.length - failed.length;
console.log(`\n==== ${passed}/${results.length} checks passed ====`);
if (failed.length) {
  console.log("FAILED CHECKS:");
  for (const item of failed) {
    console.log(`  - ${item.name} :: ${typeof item.detail === "string" ? item.detail : JSON.stringify(item.detail)}`);
  }
  process.exitCode = 1;
} else {
  console.log("All round-3 checks passed.");
}
