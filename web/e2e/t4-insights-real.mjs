/**
 * T4 insights-board REAL integration check (T5 `/insights` is live now).
 *
 * Verifies, without any route mock:
 *  - the page renders real InsightsData (no error state),
 *  - every range (1w/2w/1m/3m/all) requests the backend and re-renders trend buckets,
 *  - scope=group|team|all passes through and the scope badge + tables adapt,
 *  - member/group/team table sorting toggles aria-sort,
 *  - KPI values match the API payload (contract check),
 *  - light + dark screenshots for 1m/all.
 *
 * Usage (from web/): node e2e/t4-insights-real.mjs
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:8000";
const OUT = "../artifacts";
const shots = [];
const problems = [];
const requests = [];

const RANGE_EXPECTED_BUCKETS = { "1w": 7, "2w": 14, "1m": 5, "3m": 13, all: 26 };

async function fetchInsights(scope, range) {
  const response = await fetch(
    `${API}/api/teams/team-aurora/groups/grp-frontend/insights?scope=${scope}&range=${range}`,
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`insights ${scope}/${range} -> ${response.status}`);
  return payload.data;
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
});
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("request", (request) => {
  if (request.url().includes("/insights")) requests.push(request.url());
});

async function shot(name, fullPage = false) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage });
  shots.push(path);
  console.log("shot", path);
}

const RANGE_LABELS = {
  "1w": "近 1 周",
  "2w": "近 2 周",
  "1m": "近 1 个月",
  "3m": "近 3 个月",
  all: "全部时间",
};

async function openBoard(theme, scope, range = "1m") {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([nextTheme, nextScope]) => {
      localStorage.setItem("teamstudio.theme", nextTheme);
      localStorage.setItem("teamstudio.scope", nextScope);
    },
    [theme, scope],
  );
  await page.goto(`${BASE}/#/insights`, { waitUntil: "domcontentloaded" });
  // localStorage is only read when the app provider boots, so force a reload
  // after writing the theme/scope preferences.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".ins-kpis", { timeout: 15000 });
  await page.locator(".ins-range-btn", { hasText: RANGE_LABELS[range] }).click();
  await page.waitForTimeout(900);
}

async function kpiTexts() {
  const cards = page.locator(".ins-kpi");
  const count = await cards.count();
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    result.push({
      label: (await card.locator(".ins-kpi-label").innerText()).trim(),
      value: (await card.locator(".ins-kpi-value strong").innerText()).trim(),
    });
  }
  return result;
}

try {
  // ---------------- Contract-shaped API sanity ----------------
  const api1m = await fetchInsights("group", "1m");
  const summary = api1m.summary;
  console.log("api summary:", JSON.stringify(summary));
  console.log(
    "api rows -> members:",
    api1m.members.length,
    "groups:",
    api1m.groups.length,
    "teams:",
    api1m.teams.length,
    "buckets:",
    api1m.trend.buckets.length,
  );
  const required = [
    "teams",
    "groups",
    "members",
    "tasks",
    "openTasks",
    "completedTasks",
    "overdueTasks",
    "blockedTasks",
    "completionRate",
    "todos",
    "completedTodos",
    "todoCompletionRate",
    "loadPoints",
    "capacityPoints",
    "averageLoadPercent",
  ];
  required.forEach((key) => {
    if (typeof summary[key] !== "number") problems.push(`contract: summary.${key} 缺失或非数字`);
  });
  ["scope", "range", "summary", "members", "groups", "teams", "trend"].forEach((key) => {
    if (!(key in api1m)) problems.push(`contract: InsightsData.${key} 缺失`);
  });

  // ---------------- Light theme: 1m + KPI contract check ----------------
  await openBoard("light", "group", "1m");
  if (await page.locator("text=数据洞察接口尚未就绪").count()) problems.push("real: 仍显示 404 兜底状态");
  if (await page.locator(".ins-kpis").count() === 0) problems.push("real: KPI 未渲染");
  const kpi1m = await kpiTexts();
  console.log("kpi 1m:", JSON.stringify(kpi1m));
  const expected = {
    成员: String(summary.members),
    任务: String(summary.tasks),
    任务完成率: `${Math.round(summary.completionRate)}%`,
    逾期任务: String(summary.overdueTasks),
    阻塞任务: String(summary.blockedTasks),
    待办完成率: `${Math.round(summary.todoCompletionRate)}%`,
  };
  Object.entries(expected).forEach(([label, value]) => {
    const card = kpi1m.find((item) => item.label === label);
    if (!card) problems.push(`kpi: 缺少「${label}」卡片`);
    else if (card.value !== value) problems.push(`kpi: 「${label}」期望 ${value}，实际 ${card.value}`);
  });

  const scopeBadgeText = await page.locator(".ins-scope-badge").innerText();
  if (!scopeBadgeText.includes(api1m.scope.label)) {
    problems.push(`scope badge: 期望包含 ${api1m.scope.label}，实际 ${scopeBadgeText}`);
  }
  if ((await page.locator(".ins-table").count()) !== 3) problems.push("tables: 期望 3 张表");
  await shot("t4-insights-real-light-1m");
  await shot("t4-insights-real-light-1m-full", true);

  // ---------------- All ranges ----------------
  const rangeLabels = {
    "近 1 周": "1w",
    "近 2 周": "2w",
    "近 1 个月": "1m",
    "近 3 个月": "3m",
    全部时间: "all",
  };
  for (const [label, key] of Object.entries(rangeLabels)) {
    await page.locator(".ins-range-btn", { hasText: label }).click();
    await page.waitForTimeout(900);
    const bucketCount = await page.locator(".ins-chart-col").count();
    if (bucketCount !== RANGE_EXPECTED_BUCKETS[key]) {
      problems.push(`range ${key}: 期望 ${RANGE_EXPECTED_BUCKETS[key]} 个趋势桶，实际 ${bucketCount}`);
    }
    const rangeApi = await fetchInsights("group", key);
    const kpiTasks = await kpiTexts();
    const tasksCard = kpiTasks.find((item) => item.label === "任务");
    if (tasksCard && tasksCard.value !== String(rangeApi.summary.tasks)) {
      problems.push(`range ${key}: 任务 KPI ${tasksCard.value} != API ${rangeApi.summary.tasks}`);
    }
    console.log(`range ${key}: buckets=${bucketCount}, tasks=${rangeApi.summary.tasks}`);
    await shot(`t4-insights-real-light-${key}`);
  }

  // ---------------- Member table sorting (real data) ----------------
  const memberRateSort = page.locator('button[title="按完成率排序"]').first();
  await memberRateSort.click();
  await page.waitForTimeout(350);
  const descAria = await page
    .locator("th", { has: page.locator('button[title="按完成率排序"]').first() })
    .first()
    .getAttribute("aria-sort");
  await shot("t4-insights-real-member-sort-rate-desc");
  const firstDesc = await page.locator(".ins-table").first().locator("tbody tr").first().innerText();
  await memberRateSort.click();
  await page.waitForTimeout(350);
  const ascAria = await page
    .locator("th", { has: page.locator('button[title="按完成率排序"]').first() })
    .first()
    .getAttribute("aria-sort");
  const firstAsc = await page.locator(".ins-table").first().locator("tbody tr").first().innerText();
  await shot("t4-insights-real-member-sort-rate-asc");
  if (descAria !== "descending" || ascAria !== "ascending") {
    problems.push(`sort: 完成率 aria-sort 期望 descending/ascending，实际 ${descAria}/${ascAria}`);
  }
  if (firstDesc === firstAsc) problems.push("sort: 升降序首行未变化，排序可能未生效");

  // Sort groups/teams tables too
  const groupFirst = page.locator(".ins-table").nth(1);
  await groupFirst.locator('button[title="按任务排序"]').click();
  await page.waitForTimeout(350);
  await shot("t4-insights-real-group-sort-tasks");
  const teamFirst = page.locator(".ins-table").nth(2);
  await teamFirst.locator('button[title="按负载排序"]').click();
  await page.waitForTimeout(350);
  await shot("t4-insights-real-team-sort-load");

  // Trend tooltip
  const trendPanel = page.locator(".ins-trend-panel");
  await trendPanel.scrollIntoViewIfNeeded();
  await page.locator(".ins-chart-col").nth(2).hover();
  await page.waitForTimeout(350);
  const tipVisible = await page.locator(".ins-chart-col").nth(2).locator(".ins-chart-tip").isVisible();
  if (!tipVisible) problems.push("trend: 真实数据下悬停 tooltip 不可见");
  const tipPath = `${OUT}/t4-insights-real-trend-tooltip-panel.png`;
  await trendPanel.screenshot({ path: tipPath });
  shots.push(tipPath);
  console.log("shot", tipPath);
  await shot("t4-insights-real-trend-tooltip");

  // ---------------- Dark theme ----------------
  await page.evaluate(() => localStorage.setItem("teamstudio.theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".ins-kpis");
  await page.waitForTimeout(900);
  await shot("t4-insights-real-dark-1m");
  await page.locator(".ins-range-btn", { hasText: "全部时间" }).click();
  await page.waitForTimeout(900);
  await shot("t4-insights-real-dark-all");
  await shot("t4-insights-real-dark-all-full", true);

  // ---------------- Aggregate scopes: team + all ----------------
  await openBoard("light", "team", "1m");
  const teamApi = await fetchInsights("team", "1m");
  const teamKpis = await kpiTexts();
  const teamMembersCard = teamKpis.find((item) => item.label === "成员");
  if (teamMembersCard && teamMembersCard.value !== String(teamApi.summary.members)) {
    problems.push(`scope team: 成员 KPI ${teamMembersCard.value} != API ${teamApi.summary.members}`);
  }
  const teamGroupColumns = await page
    .locator(".ins-table")
    .first()
    .locator("th", { hasText: "开发组" })
    .count();
  if (!teamGroupColumns) problems.push("scope team: 成员表缺少开发组列");
  await shot("t4-insights-real-scope-team-light");

  await openBoard("light", "all", "1m");
  const allApi = await fetchInsights("all", "1m");
  const allKpis = await kpiTexts();
  const allMembersCard = allKpis.find((item) => item.label === "成员");
  if (allMembersCard && allMembersCard.value !== String(allApi.summary.members)) {
    problems.push(`scope all: 成员 KPI ${allMembersCard.value} != API ${allApi.summary.members}`);
  }
  const allTeamColumns = await page
    .locator(".ins-table")
    .first()
    .locator("th", { hasText: "团队" })
    .count();
  if (!allTeamColumns) problems.push("scope all: 成员表缺少团队列");
  await shot("t4-insights-real-scope-all-light");

  // Restore defaults for other reviewers.
  await page.evaluate(() => {
    localStorage.setItem("teamstudio.scope", "group");
    localStorage.setItem("teamstudio.theme", "light");
  });

  const scopes = new Set(
    requests.map((request) => new URL(request).searchParams.get("scope") || "group"),
  );
  const ranges = new Set(
    requests.map((request) => new URL(request).searchParams.get("range") || "1m"),
  );
  ["group", "team", "all"].forEach((scope) => {
    if (!scopes.has(scope)) problems.push(`requests: 未观察到 scope=${scope}`);
  });
  ["1w", "2w", "1m", "3m", "all"].forEach((range) => {
    if (!ranges.has(range)) problems.push(`requests: 未观察到 range=${range}`);
  });

  console.log("\n--- results ---");
  console.log("shots:", shots.length);
  console.log("scopes sent:", [...scopes].join(","), "| ranges sent:", [...ranges].join(","));
  console.log("problems:", problems.length ? JSON.stringify(problems, null, 2) : "none");
} catch (error) {
  problems.push(`script: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await shot("t4-insights-real-error-state").catch(() => {});
  console.log("problems:", JSON.stringify(problems, null, 2));
} finally {
  await browser.close();
  if (problems.length) process.exitCode = 1;
}
