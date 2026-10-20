/**
 * Round 7 acceptance — 一位成员加入多个开发组 / 跨团队的合并身份。
 *
 * 本脚本是自包含的：用一次性 TEAMSTUDIO_DATA_DIR 在独立端口（默认 8014）启动后端，
 * 结束后清理后端进程与临时数据目录；使用系统 Edge（Playwright channel=msedge）驱动真实 UI。
 *
 * 前置条件：
 *   1. `npm run build --prefix web`（后端托管 web/dist，脚本会检查产物是否存在）。
 *   2. `.venv\Scripts\python.exe` 存在（可用 TEAMSTUDIO_PYTHON 覆盖）。
 *   3. 系统安装 Microsoft Edge（Playwright 用 channel=msedge，不下载浏览器）。
 *
 * 用法（在仓库根目录或 web/ 目录下）：
 *   node web/e2e/round7-membership.mjs
 *   QA_PORT=8015 node web/e2e/round7-membership.mjs          # 换端口
 *   QA_URL=http://127.0.0.1:8014 node web/e2e/round7-membership.mjs   # 复用已启动实例（不启停、不删数据）
 *
 * 环境变量：
 *   QA_PORT / QA_URL       后端端口或完整 URL（默认 http://127.0.0.1:8014）
 *   TEAMSTUDIO_DATA_DIR    显式指定数据目录（默认 artifacts/round7-data-<ts>，成功时删除）
 *   KEEP_DATA=1            无论成败都保留一次性数据目录（便于复现）
 *   HEADFUL=1              有头运行 Edge
 *   TEAMSTUDIO_PYTHON      覆盖 Python 解释器路径
 *   EDGE_PATH              覆盖 Edge 可执行文件路径（仅沙箱回退启动时使用）
 *
 * 沙箱说明：受限沙箱会禁止 Node 以 piped stdio 创建子进程（Playwright 启动 Chromium 报
 * spawn EPERM）。脚本会回退为「手动启动系统 Edge + connectOverCDP」；若运行环境连
 * Edge 自身的命名管道都被拒绝（mojo platform_channel 0x5），浏览器无法启动，需要在
 * 允许启动浏览器的终端/会话中运行本脚本。
 *
 * 覆盖的契约（docs/ROUND7_CONTRACT.md）：
 *   - 同一账号在多个开发组 / 团队拥有 members 档案时，聚合视角（scope=team|all）按 personKey
 *     去重成一张成员卡，卡片展示多个开发组（超出折叠为 +N）；
 *   - bootstrap 的 me.linkedMemberId 跟随激活开发组变化，me.linkedMemberIds 覆盖全部档案；
 *   - 右上角「我的成员卡片」在切换开发组后仍能打开当前组档案；聚合视角中任一档案 id 的深链都打开合并卡；
 *   - 成员抽屉展示后端 memberships；个人主页展示该账号全部档案（不重复、不丢失）。
 *
 * 口径说明（Lead 已裁决）：docs/ROUND7_CONTRACT.md §2.1 规定 group scope 下成员
 * `memberships` 只含当前 scope（长度 1），所以场景 A（group 视角）只断言抽屉打开 +
 * 当前组「前端体验组」+ 入口存在；多组同时展示放到 team / all 视角（C/D）与个人主页（E）。
 * B/C 验证切换激活开发组后「我的成员卡片」打开当前组档案（前端体验组 / 服务端平台组）。
 *
 * 说明：Round 7 DOM 由前端实现决定；所有选择器集中在 SEL 对象里，联调时只需改那里。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

/* ------------------------------------------------------------------ */
/* 常量与输出                                                          */
/* ------------------------------------------------------------------ */

const stamp = Date.now();
const VIEWPORT = { width: 1440, height: 1000 };
const PORT = Number(process.env.QA_PORT || 8014);
const BASE = (process.env.QA_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const ORIGIN = new URL(BASE);
const COOKIE_DOMAIN = ORIGIN.hostname;
const HEADLESS = process.env.HEADFUL !== "1";
const KEEP_DATA = process.env.KEEP_DATA === "1";
const EXTERNAL_SERVER = Boolean(process.env.QA_URL);

/** Round 7 DOM 选择器；前端联调后如类名变化，只改这里。 */
const SEL = {
  appShell: ".app-shell",
  overviewTitle: ".ov-hero-title",
  memberGrid: ".ov-member-grid",
  memberCard: ".ov-member-card",
  memberSkeleton: ".ov-member-skeleton",
  memberGroupBadges: ".ov-member-groups",
  memberGroupBadge: ".ov-member-group:not(.ov-member-group-more)",
  memberGroupMore: ".ov-member-group-more",
  userChip: ".user-chip",
  userPopover: ".user-popover",
  menuRow: ".menu-row",
  drawer: ".md-drawer",
  drawerTitle: "#md-title",
  drawerMembership: ".md-membership",
  drawerMembershipGroup: ".md-membership-group",
  drawerMembershipTeam: ".md-membership-team",
  groupSwitcher: ".group-switcher-button",
  groupPopover: ".group-popover",
  groupOption: ".group-option",
  scopeOption: ".scope-option",
  scopeOptionActive: ".scope-option.is-active",
  profilePage: ".profile-page",
  profileChipRow: ".profile-chip-row",
  profileMembersSection: ".profile-members",
  profileMemberList: ".profile-member-list",
  profileMemberRow: ".profile-member-row",
};

const TEAM_AURORA = { id: "team-aurora", name: "星港产品团队" };
const TEAM_VOYAGE = { id: "team-voyage", name: "远航数据团队" };
const GROUP_FRONTEND = { id: "grp-frontend", name: "前端体验组" };
const GROUP_PLATFORM = { id: "grp-platform", name: "服务端平台组" };
const GROUP_DATA = { id: "grp-data", name: "数据智能组" };

const ACCOUNT_NAME = "多组测试成员";
const ACCOUNT_EMAIL = `round7.member.${stamp}@corp.example`;
/** 测试账号在星港产品团队内的档案行数（前端体验组 + 服务端平台组）。 */
const NEW_PERSON_TEAM_ROWS = 2;
/** 测试账号全部档案行数（再加数据智能组）。 */
const NEW_PERSON_ALL_ROWS = 3;

const results = [];
function record(name, ok, detail = "") {
  const passed = Boolean(ok);
  results.push({ name, ok: passed, detail });
  const suffix = detail
    ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
    : "";
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${suffix}`);
  return passed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function excerpt(text, length = 320) {
  return normalizeText(text).slice(0, length);
}

async function waitFor(predicate, timeout = 10000, label = "", interval = 150) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  if (label) {
    console.log(
      `WAIT  ${label} timed out after ${timeout}ms${lastError ? ` (${lastError.message})` : ""}`,
    );
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 项目根目录 / 产物 / 一次性数据目录                                    */
/* ------------------------------------------------------------------ */

function findRepoRoot(start) {
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, "backend", "app", "main.py"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`无法从 ${start} 定位项目根目录（找不到 backend/app/main.py）`);
}

const REPO_ROOT = findRepoRoot(process.cwd());
const PYTHON = process.env.TEAMSTUDIO_PYTHON || path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
const ARTIFACTS = path.join(REPO_ROOT, "artifacts", "round7");
fs.mkdirSync(ARTIFACTS, { recursive: true });

const DATA_DIR = process.env.TEAMSTUDIO_DATA_DIR || path.join(REPO_ROOT, "artifacts", `round7-data-${stamp}`);
if (!EXTERNAL_SERVER) fs.mkdirSync(DATA_DIR, { recursive: true });
const SERVER_LOG = path.join(ARTIFACTS, `server-${stamp}.log`);

/* ------------------------------------------------------------------ */
/* 后端进程管理（一次性实例，除非显式 QA_URL 复用）                       */
/* ------------------------------------------------------------------ */

let server = null;
let serverExit = null;
let serverOwned = false;
let logFd = null;
const trackedContexts = new Set();
let shotCount = 0;

async function healthReachable() {
  try {
    const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (EXTERNAL_SERVER) {
    if (!(await healthReachable())) {
      throw new Error(`QA_URL 指定的服务不可达：${BASE}`);
    }
    return;
  }
  if (await healthReachable()) {
    throw new Error(`${BASE} 已有服务在运行；round7 E2E 需要独占的一次性实例（可换 QA_PORT 或先停止旧服务）`);
  }
  logFd = fs.openSync(SERVER_LOG, "a");
  // stdio 用文件 fd（不是管道）：既保留诊断日志，又避开 Windows 受限沙箱下管道 EPERM 的问题。
  server = spawn(
    PYTHON,
    ["-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TEAMSTUDIO_DATA_DIR: DATA_DIR },
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    },
  );
  serverOwned = true;
  server.once("exit", (code, signal) => {
    serverExit = { code, signal };
  });
  server.once("error", (error) => {
    serverExit = { error: error.message };
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (serverExit) {
      throw new Error(`后端进程提前退出: ${JSON.stringify(serverExit)}（日志：${SERVER_LOG}）`);
    }
    if (await healthReachable()) return;
    await sleep(400);
  }
  throw new Error(`后端 30 秒内未就绪：${BASE}（日志：${SERVER_LOG}）`);
}

async function stopServer() {
  if (!serverOwned || !server) return;
  if (!serverExit) {
    server.kill();
    const startedAt = Date.now();
    while (!serverExit && Date.now() - startedAt < 4000) await sleep(100);
    if (!serverExit) {
      spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      const forcedAt = Date.now();
      while (!serverExit && Date.now() - forcedAt < 2000) await sleep(100);
    }
  }
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      // already closed
    }
    logFd = null;
  }
  server = null;
  serverOwned = false;
}

function tailServerLog(lines = 50) {
  try {
    const text = fs.readFileSync(SERVER_LOG, "utf8").trimEnd().split(/\r?\n/);
    return text.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* API helpers（Node 直连回环 => 系统内置管理员）                         */
/* ------------------------------------------------------------------ */

async function api(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(
      `${method} ${pathname} -> ${response.status}: ${payload?.error?.message ?? "request failed"}`,
    );
  }
  return payload.data;
}

async function createPrecreatedAccount() {
  const data = await api("/api/users", {
    method: "POST",
    body: { email: ACCOUNT_EMAIL, name: ACCOUNT_NAME, role: "member" },
  });
  if (!data?.user?.id) throw new Error(`预创建账号失败：${ACCOUNT_EMAIL}`);
  if (!data?.activation?.url) throw new Error(`预创建账号未返回激活链接：${ACCOUNT_EMAIL}`);
  return { id: data.user.id, activation: data.activation };
}

async function addMemberToGroup(teamId, groupId, userId) {
  const data = await api(`/api/teams/${teamId}/groups/${groupId}/members`, {
    method: "POST",
    body: { userId },
  });
  if (!data?.member?.id) throw new Error(`加入开发组失败：${teamId}/${groupId}`);
  return data.member;
}

/* ------------------------------------------------------------------ */
/* 浏览器 helpers                                                      */
/* ------------------------------------------------------------------ */

const pageErrors = [];
const consoleErrors = [];

function attachErrorCapture(page, label) {
  page.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${label}: ${message.text()}`);
  });
}

async function newContext(browser, label, { deviceLogout = false, pinWorkspace = false } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
  if (deviceLogout) {
    // 让回环访问不再自动成为系统内置管理员，从而以邮箱账号身份浏览。
    await context.addCookies([
      { name: "teamstudio_device_logout", value: "1", domain: COOKIE_DOMAIN, path: "/" },
    ]);
  }
  if (pinWorkspace) {
    // 首次加载固定到 team-aurora / grp-frontend / scope=group；后续 SPA 内的切换（会写回
    // localStorage）不能被导航初始化脚本覆盖，所以只在 sessionStorage 未打标时固定一次。
    await context.addInitScript(() => {
      try {
        if (sessionStorage.getItem("round7.qa.pinned") === "1") return;
        localStorage.setItem("teamstudio.team", "team-aurora");
        localStorage.setItem("teamstudio.group", "grp-frontend");
        localStorage.setItem("teamstudio.scope", "group");
        sessionStorage.setItem("round7.qa.pinned", "1");
      } catch {
        // about:blank 等没有 storage 的文档忽略
      }
    });
  }
  trackedContexts.add(context);
  return context;
}

async function pageApi(page, pathname) {
  const result = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url);
      const payload = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, payload };
    } catch (error) {
      return { status: 0, ok: false, error: String(error?.message ?? error) };
    }
  }, pathname);
  if (!result.ok || !result.payload?.ok) {
    throw new Error(
      `页面内 GET ${pathname} -> ${result.status}: ${result.payload?.error?.message ?? result.error ?? "request failed"}`,
    );
  }
  return result.payload.data;
}

/**
 * 页内 GET /api/bootstrap —— 必须带上 localStorage 里当前选中的 team / group，
 * 否则后端会默认解析到第一个团队的第一个开发组，me.linkedMemberId 就不是当前激活组了。
 */
async function bootstrapPayload(page) {
  return page.evaluate(async () => {
    const params = new URLSearchParams();
    const teamId = localStorage.getItem("teamstudio.team");
    const groupId = localStorage.getItem("teamstudio.group");
    if (teamId) params.set("teamId", teamId);
    if (groupId) params.set("groupId", groupId);
    const query = params.toString();
    const response = await fetch(`/api/bootstrap${query ? `?${query}` : ""}`);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(
        `GET /api/bootstrap -> ${response.status}: ${payload?.error?.message ?? "request failed"}`,
      );
    }
    return payload.data;
  });
}

async function bootstrapMe(page) {
  const data = await bootstrapPayload(page);
  return data?.me ?? null;
}

async function activeWorkspace(page) {
  const data = await bootstrapPayload(page);
  return data?.active ?? null;
}

async function setHash(page, hash) {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  await page.evaluate((value) => {
    window.location.hash = value;
  }, target);
}

async function shot(page, name, { fullPage = false } = {}) {
  shotCount += 1;
  const file = path.join(ARTIFACTS, `${String(shotCount).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`SHOT  ${file}`);
  return file;
}

/* ------------------------------------------------------------------ */
/* 浏览器启动（Playwright 正常路径；沙箱下 stdio 管道 EPERM 时回退 CDP）   */
/* ------------------------------------------------------------------ */

let edgeProcess = null;
let edgeProfileDir = null;

function findEdgeExecutable() {
  const candidates = [
    process.env.EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 受限沙箱禁止 Node 以 piped stdio 创建子进程（Playwright 启动 Chromium 会 spawn EPERM）。
 * 回退方案：用 stdio:"ignore" 手动启动系统 Edge（--remote-debugging-port=0），
 * 读取 DevToolsActivePort 后通过 connectOverCDP 接管同一个真实浏览器。
 */
async function launchEdgeOverCdp() {
  const executable = findEdgeExecutable();
  if (!executable) {
    throw new Error("无法找到 Microsoft Edge 可执行文件（可用 EDGE_PATH 指定）");
  }
  edgeProfileDir = path.join(ARTIFACTS, `edge-profile-${stamp}`);
  fs.mkdirSync(edgeProfileDir, { recursive: true });
  const args = [
    `--user-data-dir=${edgeProfileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-sandbox",
  ];
  if (HEADLESS) args.push("--headless=new");
  args.push("about:blank");
  edgeProcess = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  edgeProcess.once("exit", () => {
    edgeProcess = null;
  });

  const portFile = path.join(edgeProfileDir, "DevToolsActivePort");
  const ready = await waitFor(() => fs.existsSync(portFile), 25000, "Edge DevToolsActivePort 出现", 200);
  if (!ready) {
    throw new Error(`手动启动 Edge 后未出现 DevToolsActivePort：${portFile}`);
  }
  let port = 0;
  for (let attempt = 0; attempt < 25 && !port; attempt += 1) {
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
    } catch {
      // 文件可能仍在写入
    }
    if (!port) await sleep(200);
  }
  if (!port) throw new Error(`无法解析 Edge DevToolsActivePort：${portFile}`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser.__manualEdge = true;
  console.log(`INFO  已接管手动启动的 Edge（CDP 127.0.0.1:${port}，profile=${edgeProfileDir}）`);
  return browser;
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "msedge", headless: HEADLESS });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/EPERM/.test(message)) throw error;
    console.log("INFO  Playwright 启动 Edge 被沙箱拒绝（spawn EPERM），回退到手动启动 + connectOverCDP");
    return launchEdgeOverCdp();
  }
}

/* ------------------------------------------------------------------ */
/* 概览 / 抽屉 / 切换 helpers                                           */
/* ------------------------------------------------------------------ */

function overviewPath(teamId, groupId, scope) {
  return `/api/teams/${encodeURIComponent(teamId)}/groups/${encodeURIComponent(groupId)}/overview?scope=${scope}`;
}

function personKeyOf(member) {
  const email = String(member?.email ?? "").trim().toLowerCase();
  if (email) return `email:${email}`;
  return `member:${member?.id ?? ""}`;
}

function uniquePersonCount(members) {
  return new Set((members ?? []).map(personKeyOf)).size;
}

function groupMemberCount(bootstrap, groupId) {
  for (const team of bootstrap?.teams ?? []) {
    for (const group of team.groups ?? []) {
      if (group.id === groupId) return Number(group.memberCount || 0);
    }
  }
  return 0;
}

function rawRowsForTeams(bootstrap, teamIds) {
  let total = 0;
  for (const team of bootstrap?.teams ?? []) {
    if (!teamIds.includes(team.id)) continue;
    for (const group of team.groups ?? []) total += Number(group.memberCount || 0);
  }
  return total;
}

async function waitOverviewReady(page, timeout = 20000) {
  return waitFor(
    async () => {
      if ((await page.locator(SEL.memberSkeleton).count()) > 0) return false;
      return (await page.locator(SEL.memberCard).count()) > 0;
    },
    timeout,
    "概览成员卡加载完成",
  );
}

async function waitCardCount(page, expected, timeout = 20000) {
  return waitFor(
    async () => (await page.locator(SEL.memberCard).count()) === expected,
    timeout,
    `成员卡数量达到 ${expected}`,
  );
}

async function cardsNamed(page, name) {
  return page.locator(SEL.memberCard).filter({ hasText: name }).count();
}

async function memberGroupBadgeInfo(card) {
  const visible = (await card.locator(SEL.memberGroupBadge).allInnerTexts())
    .map(normalizeText)
    .filter(Boolean);
  const more = card.locator(SEL.memberGroupMore);
  const moreCount = await more.count();
  const moreText = moreCount ? normalizeText(await more.first().innerText()) : "";
  const moreTitle = moreCount ? ((await more.first().getAttribute("title")) ?? "") : "";
  return { visible, moreCount, moreText, moreTitle };
}

async function openUserMenu(page) {
  const popover = page.locator(SEL.userPopover).first();
  const visible = await popover.isVisible().catch(() => false);
  if (!visible) {
    await page.locator(SEL.userChip).first().click();
  }
  await popover.waitFor({ state: "visible", timeout: 10000 });
  return popover;
}

async function myMemberCardMenuCount(page) {
  const popover = await openUserMenu(page);
  return popover.locator(SEL.menuRow).filter({ hasText: "我的成员卡片" }).count();
}

async function waitDrawerVisible(page, timeout = 15000) {
  return waitFor(
    async () => page.locator(SEL.drawer).isVisible().catch(() => false),
    timeout,
    "成员抽屉打开",
  );
}

/** @returns {Promise<number>} 菜单入口数量（0 表示入口缺失）。 */
async function clickMyMemberCard(page) {
  const popover = await openUserMenu(page);
  const item = popover.locator(SEL.menuRow).filter({ hasText: "我的成员卡片" });
  const count = await item.count();
  if (count === 0) return 0;
  await item.first().click();
  return count;
}

async function readDrawer(page) {
  const open = await page.locator(SEL.drawer).isVisible().catch(() => false);
  if (!open) return { open: false, title: "", text: "", membershipRows: 0 };
  const title = normalizeText(await page.locator(SEL.drawerTitle).innerText().catch(() => ""));
  const text = await page.locator(SEL.drawer).innerText().catch(() => "");
  const membershipRows = await page.locator(`${SEL.drawer} ${SEL.drawerMembership}`).count();
  return { open: true, title, text, membershipRows };
}

async function closeDrawer(page) {
  if (!(await page.locator(SEL.drawer).isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await page
    .waitForSelector(SEL.drawer, { state: "hidden", timeout: 5000 })
    .catch(() => {});
}

/** @returns {Promise<boolean>} 是否找到并点击了目标开发组。 */
async function switchGroup(page, groupName) {
  const trigger = page.locator(SEL.groupSwitcher).first();
  await trigger.waitFor({ state: "visible", timeout: 10000 });
  await trigger.click();
  const popover = page.locator(SEL.groupPopover).first();
  await popover.waitFor({ state: "visible", timeout: 8000 });
  const options = popover.locator(SEL.groupOption).filter({ hasText: groupName });
  if ((await options.count()) === 0) return false;
  await options.first().click();
  await popover.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  return true;
}

/** 点击浏览视角（开发组 / 团队 / 所有），等待对应的 overview 请求返回。 */
async function switchScope(page, scopeLabel, scopeKind) {
  const buttons = page.locator(SEL.scopeOption).filter({ hasText: scopeLabel });
  if ((await buttons.count()) !== 1) return { clicked: false, response: null };
  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "GET" && response.url().includes(`/overview?scope=${scopeKind}`),
      { timeout: 20000 },
    )
    .catch(() => null);
  await buttons.first().click();
  const response = await responsePromise;
  await page.waitForTimeout(250);
  return { clicked: true, response };
}

async function activeScopeLabel(page) {
  const locator = page.locator(SEL.scopeOptionActive);
  if ((await locator.count()) === 0) return "";
  return normalizeText(await locator.first().innerText().catch(() => ""));
}

async function chipTexts(page, containerSelector) {
  const texts = await page.locator(`${containerSelector} .chip`).allInnerTexts();
  return texts.map(normalizeText).filter(Boolean);
}

function countExact(values, target) {
  return values.filter((value) => value === target).length;
}

function sameSet(actual, expected) {
  if (!Array.isArray(actual)) return false;
  const a = new Set(actual.map(String));
  const b = new Set(expected.map(String));
  if (a.size !== b.size) return false;
  for (const item of b) if (!a.has(item)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let browser = null;
let memberContext = null;
let page = null;
let failed = 1;

try {
  /* ---------------------------------------------------------------- */
  /* 0. 前置检查 + 一次性后端 + 测试数据                                 */
  /* ---------------------------------------------------------------- */
  const distIndex = path.join(REPO_ROOT, "web", "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    throw new Error(`前端尚未构建：缺少 ${distIndex}。请先运行 npm run build --prefix web`);
  }
  record("前端构建产物存在（web/dist/index.html）", true, distIndex);
  record("Python 解释器存在（.venv\\Scripts\\python.exe）", fs.existsSync(PYTHON), PYTHON);

  await startServer();
  record(
    EXTERNAL_SERVER ? "复用 QA_URL 指定的后端实例" : "一次性数据目录后端已启动",
    true,
    `${BASE} · data=${DATA_DIR}`,
  );

  // Node 直连回环 => 系统内置管理员；用它预创建账号并把同一账号加入 3 个开发组。
  const adminBootstrap = await api("/api/bootstrap");
  record(
    "Node 回环请求以系统内置管理员身份执行（测试数据准备权限）",
    adminBootstrap?.me?.isDeviceAdmin === true,
    JSON.stringify({
      isDeviceAdmin: adminBootstrap?.me?.isDeviceAdmin,
      source: adminBootstrap?.me?.source,
    }),
  );

  const account = await createPrecreatedAccount();
  record(
    "已预创建多组测试账号（member，返回 activation.url）",
    Boolean(account.activation?.url),
    JSON.stringify({ id: account.id, email: ACCOUNT_EMAIL, activation: account.activation?.url }),
  );

  const frontendMember = await addMemberToGroup(TEAM_AURORA.id, GROUP_FRONTEND.id, account.id);
  const platformMember = await addMemberToGroup(TEAM_AURORA.id, GROUP_PLATFORM.id, account.id);
  const dataMember = await addMemberToGroup(TEAM_VOYAGE.id, GROUP_DATA.id, account.id);
  const memberIds = [frontendMember.id, platformMember.id, dataMember.id];
  record(
    "同一账号已加入 3 个开发组（前端体验组 / 服务端平台组 / 数据智能组，返回 3 个不同 member id）",
    memberIds.every(Boolean) && new Set(memberIds).size === 3,
    JSON.stringify({ frontend: frontendMember.id, platform: platformMember.id, data: dataMember.id }),
  );

  /* ---------------------------------------------------------------- */
  /* 1. 成员通过激活链接登录（非系统内置管理员）                          */
  /* ---------------------------------------------------------------- */
  browser = await launchBrowser();
  record(
    browser.__manualEdge
      ? "系统 Edge 已启动（沙箱回退：手动启动 + Playwright connectOverCDP）"
      : "系统 Edge 已启动（Playwright channel=msedge）",
    true,
  );

  memberContext = await newContext(browser, "member", { deviceLogout: true, pinWorkspace: true });
  page = await memberContext.newPage();
  attachErrorCapture(page, "member");

  await page.goto(account.activation.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(SEL.userChip, { timeout: 30000 });
  await page.waitForSelector(SEL.appShell, { timeout: 20000 });
  await page.waitForSelector(SEL.overviewTitle, { timeout: 20000 });
  await waitOverviewReady(page);
  await sleep(300);

  const me = await bootstrapMe(page);
  record(
    "成员通过激活链接登录（已认证 / 来源邮箱 / 非系统内置管理员）",
    me?.authenticated === true && me?.source === "email" && me?.isDeviceAdmin !== true,
    JSON.stringify({
      authenticated: me?.authenticated,
      source: me?.source,
      isDeviceAdmin: me?.isDeviceAdmin,
      email: me?.email,
    }),
  );
  const linkedIds = Array.isArray(me?.linkedMemberIds) ? me.linkedMemberIds : [];
  record(
    "bootstrap me.linkedMemberIds 覆盖该账号全部 3 条成员档案",
    linkedIds.length === 3 && memberIds.every((id) => linkedIds.includes(id)),
    JSON.stringify(linkedIds),
  );
  record(
    "bootstrap me.linkedMemberId 指向当前激活开发组（grp-frontend）的档案",
    me?.linkedMemberId === frontendMember.id,
    JSON.stringify({ linkedMemberId: me?.linkedMemberId, expected: frontendMember.id }),
  );

  const activeAtLogin = await activeWorkspace(page);
  record(
    "登录后落在固定的前端体验组 + 开发组视角（localStorage 预置生效）",
    activeAtLogin?.team?.id === TEAM_AURORA.id &&
      activeAtLogin?.group?.id === GROUP_FRONTEND.id &&
      normalizeText(await activeScopeLabel(page)) === "开发组",
    JSON.stringify({
      active: activeAtLogin,
      scopeLabel: normalizeText(await activeScopeLabel(page)),
    }),
  );

  /* ---------------------------------------------------------------- */
  /* A. group 视角：右上角「我的成员卡片」打开合并档案                    */
  /* ---------------------------------------------------------------- */
  const menuCountA = await myMemberCardMenuCount(page);
  record("A. 用户菜单出现「我的成员卡片」入口", menuCountA === 1, `count=${menuCountA}`);
  const clickedA = await clickMyMemberCard(page);
  const openedA = clickedA > 0 && (await waitDrawerVisible(page));
  const drawerA = await readDrawer(page);
  record("A. 点击「我的成员卡片」打开成员抽屉", openedA && drawerA.open);
  record(
    "A. 抽屉标题包含「多组测试成员」",
    drawerA.open && drawerA.title.includes(ACCOUNT_NAME),
    drawerA.title,
  );
  record(
    "A. 抽屉展示当前开发组「前端体验组」（后端 memberships）",
    drawerA.open && drawerA.text.includes(GROUP_FRONTEND.name),
    excerpt(drawerA.text),
  );
  record(
    "A. group 视角抽屉的 memberships 只含当前 scope（1 条，符合契约 §2.1）",
    drawerA.membershipRows === 1,
    JSON.stringify({ rows: drawerA.membershipRows, text: excerpt(drawerA.text) }),
  );
  await shot(page, "A-drawer-group-scope");

  /* ---------------------------------------------------------------- */
  /* B. 切换开发组后「我的成员卡片」定位当前组档案（修复前失败的场景）     */
  /* ---------------------------------------------------------------- */
  await closeDrawer(page);
  const switchedB = await switchGroup(page, GROUP_PLATFORM.name);
  const activeB = switchedB
    ? await waitFor(
        async () => (await activeWorkspace(page))?.group?.id === GROUP_PLATFORM.id,
        15000,
        "bootstrap active.group 切换到 grp-platform",
      ).then(() => activeWorkspace(page))
    : null;
  record(
    "B. 侧边栏切换到「服务端平台组」，bootstrap active.group.id === grp-platform",
    Boolean(switchedB) && activeB?.group?.id === GROUP_PLATFORM.id,
    JSON.stringify({ switched: switchedB, active: activeB }),
  );
  await waitFor(
    async () => (await activeWorkspace(page))?.group?.id === GROUP_PLATFORM.id,
    15000,
    "等待 bootstrap 刷新激活开发组",
  );
  const meB = await bootstrapMe(page);
  record(
    "B. 切换开发组后 me.linkedMemberId 指向当前组档案（服务端平台组；修复前仍为全局首个）",
    meB?.linkedMemberId === platformMember.id && linkedIds.includes(platformMember.id),
    JSON.stringify({ linkedMemberId: meB?.linkedMemberId, expected: platformMember.id }),
  );
  const bootstrapB = await bootstrapPayload(page);
  const platformGroupCount = groupMemberCount(bootstrapB, GROUP_PLATFORM.id);
  await waitCardCount(page, platformGroupCount, 20000);
  record(
    "B. 服务端平台组概览卡片数 = 该组档案行数（含新成员，证明 group 视角已切换）",
    platformGroupCount > 0 && (await page.locator(SEL.memberCard).count()) === platformGroupCount,
    `dom=${await page.locator(SEL.memberCard).count()} expected=${platformGroupCount}`,
  );
  await waitFor(
    async () => (await cardsNamed(page, ACCOUNT_NAME)) === 1,
    20000,
    "服务端平台组概览出现该成员卡",
  );
  record(
    "B. 服务端平台组概览（group 视角）只出现 1 张该成员卡",
    (await cardsNamed(page, ACCOUNT_NAME)) === 1,
    `count=${await cardsNamed(page, ACCOUNT_NAME)}`,
  );
  const menuCountB = await myMemberCardMenuCount(page);
  record("B. 切换开发组后「我的成员卡片」入口仍在", menuCountB === 1, `count=${menuCountB}`);
  const clickedB = await clickMyMemberCard(page);
  const openedB = clickedB > 0 && (await waitDrawerVisible(page));
  const drawerB = await readDrawer(page);
  record("B. 切换开发组后点击「我的成员卡片」打开成员抽屉", openedB && drawerB.open);
  record(
    "B. 抽屉标题包含「多组测试成员」",
    drawerB.open && drawerB.title.includes(ACCOUNT_NAME),
    drawerB.title,
  );
  record(
    "B. 切换开发组后抽屉展示当前组档案（文本含「服务端平台组」）",
    drawerB.open && drawerB.text.includes(GROUP_PLATFORM.name),
    excerpt(drawerB.text),
  );
  await shot(page, "B-group-platform-drawer");

  /* ---------------------------------------------------------------- */
  /* C. 团队视角：跨组合并成 1 张卡 + 多组徽章 + 任一档案 id 深链          */
  /* ---------------------------------------------------------------- */
  await closeDrawer(page);
  await setHash(page, "/overview");
  await sleep(150);
  const workspaceC = await activeWorkspace(page);
  const activeTeamIdC = workspaceC?.team?.id ?? TEAM_AURORA.id;
  const activeGroupIdC = workspaceC?.group?.id ?? GROUP_PLATFORM.id;
  const bootstrapC = await bootstrapPayload(page);
  const rawTeamRows = rawRowsForTeams(bootstrapC, [activeTeamIdC]);
  const expectedTeamMembers = rawTeamRows - (NEW_PERSON_TEAM_ROWS - 1);
  record(
    "C. 团队视角期望值来自原始档案行数（bootstrap 各开发组 memberCount 求和 - 跨组重复）",
    rawTeamRows > expectedTeamMembers && expectedTeamMembers > 0,
    JSON.stringify({ rawTeamRows, expectedTeamMembers }),
  );

  const scopeTeam = await switchScope(page, "团队", "team");
  record(
    "C. 已切换到团队视角（scope=team，overview 请求成功返回）",
    scopeTeam.clicked && Boolean(scopeTeam.response) && normalizeText(await activeScopeLabel(page)).includes("团队"),
    JSON.stringify({
      clicked: scopeTeam.clicked,
      status: scopeTeam.response?.status?.() ?? null,
      activeScope: normalizeText(await activeScopeLabel(page)),
    }),
  );

  const teamData = await pageApi(page, overviewPath(activeTeamIdC, activeGroupIdC, "team"));
  const teamMembers = teamData.members ?? [];
  record(
    "C. 团队视角接口返回 scope.kind=team",
    teamData.scope?.kind === "team",
    JSON.stringify({ kind: teamData.scope?.kind, groups: teamData.scope?.groupIds }),
  );
  record(
    "C. 团队视角 members 已按人员去重（条数 = 原始档案行数 - 重复行数）",
    teamMembers.length === expectedTeamMembers &&
      uniquePersonCount(teamMembers) === expectedTeamMembers &&
      teamData.stats?.members === expectedTeamMembers,
    JSON.stringify({
      apiMembers: teamMembers.length,
      unique: uniquePersonCount(teamMembers),
      expected: expectedTeamMembers,
      rawRows: rawTeamRows,
      statsMembers: teamData.stats?.members,
    }),
  );

  await waitCardCount(page, expectedTeamMembers, 20000);
  const pageCardCountC = await page.locator(SEL.memberCard).count();
  record(
    "C. 页面 .ov-member-card 数量与去重后人员数一致（无重复卡）",
    pageCardCountC === expectedTeamMembers,
    `dom=${pageCardCountC} expected=${expectedTeamMembers}`,
  );
  const nameCardCountC = await cardsNamed(page, ACCOUNT_NAME);
  record("C. 多组测试成员在团队视角只出现 1 张成员卡", nameCardCountC === 1, `count=${nameCardCountC}`);

  const cardC = page.locator(SEL.memberCard).filter({ hasText: ACCOUNT_NAME }).first();
  const badgeC = await memberGroupBadgeInfo(cardC);
  record(
    "C. 合并卡展示两个开发组徽章（前端体验组 + 服务端平台组）",
    sameSet(badgeC.visible, [GROUP_FRONTEND.name, GROUP_PLATFORM.name]),
    JSON.stringify(badgeC),
  );

  const mergedC = teamMembers.find(
    (member) => String(member.email ?? "").toLowerCase() === ACCOUNT_EMAIL.toLowerCase(),
  );
  record(
    "C. 合并卡 id 为本次请求的主档案（前端体验组档案 id）",
    mergedC?.id === frontendMember.id,
    JSON.stringify({ id: mergedC?.id, memberIds: mergedC?.memberIds }),
  );
  record(
    "C. 合并卡 memberIds / memberships 覆盖两个开发组档案",
    Array.isArray(mergedC?.memberIds) &&
      sameSet(mergedC.memberIds, [frontendMember.id, platformMember.id]) &&
      Array.isArray(mergedC?.memberships) &&
      mergedC.memberships.length === 2 &&
      sameSet(mergedC.memberships.map((item) => item.groupId), [GROUP_FRONTEND.id, GROUP_PLATFORM.id]),
    JSON.stringify({
      memberIds: mergedC?.memberIds,
      memberships: (mergedC?.memberships ?? []).map((item) => item.groupId),
    }),
  );
  record(
    "C. 合并卡 groupIds / groupNames / teamNames 去重后覆盖两个组与星港产品团队",
    sameSet(mergedC?.groupIds, [GROUP_FRONTEND.id, GROUP_PLATFORM.id]) &&
      sameSet(mergedC?.groupNames, [GROUP_FRONTEND.name, GROUP_PLATFORM.name]) &&
      sameSet(mergedC?.teamNames, [TEAM_AURORA.name]),
    JSON.stringify({
      groupIds: mergedC?.groupIds,
      groupNames: mergedC?.groupNames,
      teamNames: mergedC?.teamNames,
    }),
  );
  await shot(page, "C-team-scope-merged-cards", { fullPage: false });

  // C1. 深链 #/overview?member=<主档案 id> 打开合并卡
  await setHash(page, "/overview");
  await sleep(150);
  await setHash(page, `/overview?member=${encodeURIComponent(frontendMember.id)}`);
  const openedDeepPrimary = await waitDrawerVisible(page, 15000);
  const drawerDeepPrimary = await readDrawer(page);
  record(
    "C. 深链 #/overview?member=<前端档案 id> 打开合并成员卡",
    openedDeepPrimary && drawerDeepPrimary.open && drawerDeepPrimary.title.includes(ACCOUNT_NAME),
    JSON.stringify({ opened: openedDeepPrimary, title: drawerDeepPrimary.title }),
  );
  record(
    "C. 深链打开的合并卡包含两条 memberships（前端体验组 + 服务端平台组）",
    drawerDeepPrimary.membershipRows === 2 &&
      drawerDeepPrimary.text.includes(GROUP_FRONTEND.name) &&
      drawerDeepPrimary.text.includes(GROUP_PLATFORM.name),
    JSON.stringify({ rows: drawerDeepPrimary.membershipRows, text: excerpt(drawerDeepPrimary.text) }),
  );
  await shot(page, "C-team-deeplink-primary-drawer");
  await closeDrawer(page);

  // C2. 深链指向非主档案 id（grp-platform 档案）——整页重新加载后仍应打开同一张合并卡。
  // 注意：仅改 hash 不会触发文档重载，这里换成不同的 search 再 reload，模拟真实深链进入。
  await page.evaluate((memberId) => {
    window.history.replaceState(
      {},
      "",
      `/?round7=${Date.now()}#/overview?member=${encodeURIComponent(memberId)}`,
    );
  }, platformMember.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(SEL.appShell, { timeout: 20000 });
  const openedDeepArchive = await waitDrawerVisible(page, 25000);
  const drawerDeepArchive = await readDrawer(page);
  record(
    "C. 深链 #/overview?member=<服务端平台组档案 id>（非主档案，整页加载）打开同一合并卡",
    openedDeepArchive &&
      drawerDeepArchive.open &&
      drawerDeepArchive.title.includes(ACCOUNT_NAME) &&
      drawerDeepArchive.membershipRows === 2,
    JSON.stringify({
      opened: openedDeepArchive,
      title: drawerDeepArchive.title,
      rows: drawerDeepArchive.membershipRows,
    }),
  );
  await closeDrawer(page);
  await waitCardCount(page, expectedTeamMembers, 20000);

  /* ---------------------------------------------------------------- */
  /* D. 所有团队视角：同样去重，无重复成员卡                              */
  /* ---------------------------------------------------------------- */
  const bootstrapD = await bootstrapPayload(page);
  const rawAllRows = rawRowsForTeams(bootstrapD, [TEAM_AURORA.id, TEAM_VOYAGE.id]);
  const expectedAllMembers = rawAllRows - (NEW_PERSON_ALL_ROWS - 1);
  record(
    "D. 所有团队视角期望值来自原始档案行数（全部开发组 memberCount 求和 - 跨组重复）",
    rawAllRows > expectedAllMembers && expectedAllMembers > 0,
    JSON.stringify({ rawAllRows, expectedAllMembers }),
  );

  const scopeAll = await switchScope(page, "所有", "all");
  record(
    "D. 已切换到所有团队视角（scope=all，overview 请求成功返回）",
    scopeAll.clicked && Boolean(scopeAll.response) && normalizeText(await activeScopeLabel(page)).includes("所有"),
    JSON.stringify({
      clicked: scopeAll.clicked,
      status: scopeAll.response?.status?.() ?? null,
      activeScope: normalizeText(await activeScopeLabel(page)),
    }),
  );

  const allData = await pageApi(page, overviewPath(activeTeamIdC, activeGroupIdC, "all"));
  const allMembers = allData.members ?? [];
  record(
    "D. 所有团队视角接口返回 scope.kind=all",
    allData.scope?.kind === "all",
    JSON.stringify({ kind: allData.scope?.kind, teamIds: allData.scope?.teamIds }),
  );
  record(
    "D. 所有团队视角 members 已按人员去重（条数 = 原始档案行数 - 重复行数）",
    allMembers.length === expectedAllMembers &&
      uniquePersonCount(allMembers) === expectedAllMembers &&
      allData.stats?.members === expectedAllMembers,
    JSON.stringify({
      apiMembers: allMembers.length,
      unique: uniquePersonCount(allMembers),
      expected: expectedAllMembers,
      rawRows: rawAllRows,
      statsMembers: allData.stats?.members,
    }),
  );

  await waitCardCount(page, expectedAllMembers, 20000);
  const pageCardCountD = await page.locator(SEL.memberCard).count();
  record(
    "D. 页面 .ov-member-card 数量与去重后人员数一致（无重复卡）",
    pageCardCountD === expectedAllMembers,
    `dom=${pageCardCountD} expected=${expectedAllMembers}`,
  );
  const nameCardCountD = await cardsNamed(page, ACCOUNT_NAME);
  record("D. 多组测试成员在所有团队视角只出现 1 张成员卡", nameCardCountD === 1, `count=${nameCardCountD}`);

  const cardD = page.locator(SEL.memberCard).filter({ hasText: ACCOUNT_NAME }).first();
  const badgeD = await memberGroupBadgeInfo(cardD);
  const allGroupNamesD = [GROUP_FRONTEND.name, GROUP_PLATFORM.name, GROUP_DATA.name];
  const badgeUnion = [badgeD.moreTitle, ...badgeD.visible].join(" ");
  const hiddenMatch = badgeD.moreText.match(/\+(\d+)/);
  const hiddenCountD = hiddenMatch ? Number(hiddenMatch[1]) : 0;
  const showsAllGroupsD = allGroupNamesD.every(
    (name) => badgeD.visible.includes(name) || (badgeD.moreCount === 1 && badgeD.moreTitle.includes(name)),
  );
  record(
    "D. 合并卡展示多个开发组徽章（超出折叠为 +N，折叠徽章标题覆盖全部 3 个开发组 / 2 个团队）",
    badgeD.visible.length >= 2 &&
      showsAllGroupsD &&
      (badgeD.moreCount === 0 ||
        (badgeD.moreCount === 1 &&
          hiddenCountD >= 1 &&
          badgeD.visible.length + hiddenCountD === allGroupNamesD.length &&
          badgeD.moreTitle.includes(TEAM_AURORA.name) &&
          badgeD.moreTitle.includes(TEAM_VOYAGE.name))),
    JSON.stringify({ ...badgeD, hiddenCount: hiddenCountD, union: excerpt(badgeUnion) }),
  );

  const mergedD = allMembers.find(
    (member) => String(member.email ?? "").toLowerCase() === ACCOUNT_EMAIL.toLowerCase(),
  );
  record(
    "D. 合并卡 memberIds / memberships 覆盖 3 个开发组档案（跨两个团队）",
    Array.isArray(mergedD?.memberIds) &&
      sameSet(mergedD.memberIds, memberIds) &&
      Array.isArray(mergedD?.memberships) &&
      mergedD.memberships.length === 3 &&
      sameSet(
        mergedD.memberships.map((item) => item.groupId),
        [GROUP_FRONTEND.id, GROUP_PLATFORM.id, GROUP_DATA.id],
      ) &&
      sameSet(mergedD?.teamIds, [TEAM_AURORA.id, TEAM_VOYAGE.id]),
    JSON.stringify({
      memberIds: mergedD?.memberIds,
      groupIds: mergedD?.groupIds,
      teamIds: mergedD?.teamIds,
    }),
  );
  await shot(page, "D-all-scope-merged-cards");

  /* ---------------------------------------------------------------- */
  /* E. 个人主页：展示全部档案，不重复                                    */
  /* ---------------------------------------------------------------- */
  await setHash(page, "/profile");
  await page.waitForSelector(SEL.profilePage, { timeout: 20000 });
  await page.waitForSelector(SEL.profileChipRow, { timeout: 20000 });
  await page.waitForSelector(SEL.profileMembersSection, { timeout: 20000 });
  await waitFor(
    async () => (await page.locator(SEL.profileMemberRow).count()) === 3,
    20000,
    "个人主页成员档案区展示 3 条",
  );
  await sleep(300);

  const profileData = await pageApi(page, "/api/profile");
  const profileMembers = profileData.members ?? [];
  record(
    "E. GET /api/profile 返回该账号全部 3 条成员档案（id 覆盖三个开发组）",
    profileMembers.length === 3 && sameSet(profileMembers.map((item) => item.id), memberIds),
    JSON.stringify(profileMembers.map((item) => ({ id: item.id, groupId: item.groupId }))),
  );
  record(
    "E. 3 条档案分属 3 个开发组 / 2 个团队（无重复档案行）",
    sameSet(profileMembers.map((item) => item.groupId), [GROUP_FRONTEND.id, GROUP_PLATFORM.id, GROUP_DATA.id]) &&
      new Set(profileMembers.map((item) => item.groupId)).size === 3 &&
      sameSet(profileMembers.map((item) => item.teamName), [TEAM_AURORA.name, TEAM_VOYAGE.name]),
    JSON.stringify(profileMembers.map((item) => ({ groupId: item.groupId, teamName: item.teamName }))),
  );

  const profileText = await page.locator(SEL.profilePage).innerText();
  record(
    "E. 个人主页文本包含「前端体验组」「服务端平台组」「星港产品团队」",
    profileText.includes(GROUP_FRONTEND.name) &&
      profileText.includes(GROUP_PLATFORM.name) &&
      profileText.includes(TEAM_AURORA.name),
    excerpt(profileText, 400),
  );
  record(
    "E. 个人主页统计该账号全部档案（关联 3 个成员档案）",
    /关联\s*3\s*个成员档案/.test(profileText) && profileText.includes(ACCOUNT_NAME),
    excerpt(profileText, 400),
  );

  // 顶部「所属团队 / 开发组」汇总 chip：合并展示且同名开发组 / 团队只出现一次。
  const profileChips = await chipTexts(page, SEL.profileChipRow);
  const chipOccurrences = (name) => profileChips.filter((text) => text.includes(name)).length;
  const groupChipCounts = {
    [GROUP_FRONTEND.name]: chipOccurrences(GROUP_FRONTEND.name),
    [GROUP_PLATFORM.name]: chipOccurrences(GROUP_PLATFORM.name),
    [GROUP_DATA.name]: chipOccurrences(GROUP_DATA.name),
  };
  record(
    "E. 同一开发组在个人主页只出现一次（汇总 chip 中每组仅 1 次）",
    Object.values(groupChipCounts).every((count) => count === 1),
    JSON.stringify({ counts: groupChipCounts, chips: profileChips }),
  );
  const teamChipCounts = {
    [TEAM_AURORA.name]: chipOccurrences(TEAM_AURORA.name),
    [TEAM_VOYAGE.name]: chipOccurrences(TEAM_VOYAGE.name),
  };
  record(
    "E. 个人主页汇总 2 个所属团队（每个团队仅 1 次）",
    Object.values(teamChipCounts).every((count) => count === 1),
    JSON.stringify({ counts: teamChipCounts, chips: profileChips }),
  );

  // 「成员档案」区逐条展示每条档案（同一开发组只展示一次）。
  const archiveRowTexts = (await page.locator(SEL.profileMemberRow).allInnerTexts()).map(normalizeText);
  record(
    "E. 个人主页按成员档案逐条展示 3 条（每条都含成员姓名与所属团队 / 开发组）",
    archiveRowTexts.length === 3 &&
      archiveRowTexts.every((text) => text.includes(ACCOUNT_NAME)) &&
      [GROUP_FRONTEND.name, GROUP_PLATFORM.name, GROUP_DATA.name].every((name) =>
        archiveRowTexts.some((text) => text.includes(name)),
      ),
    JSON.stringify(archiveRowTexts.map((text) => excerpt(text, 120))),
  );
  const archiveBadgeTexts = (await page.locator(`${SEL.profileMemberRow} .badge`).allInnerTexts()).map(
    normalizeText,
  );
  const groupBadgeCounts = {
    [GROUP_FRONTEND.name]: countExact(archiveBadgeTexts, GROUP_FRONTEND.name),
    [GROUP_PLATFORM.name]: countExact(archiveBadgeTexts, GROUP_PLATFORM.name),
    [GROUP_DATA.name]: countExact(archiveBadgeTexts, GROUP_DATA.name),
  };
  const teamBadgeCounts = {
    [TEAM_AURORA.name]: countExact(archiveBadgeTexts, TEAM_AURORA.name),
    [TEAM_VOYAGE.name]: countExact(archiveBadgeTexts, TEAM_VOYAGE.name),
  };
  record(
    "E. 档案列表里同一开发组只出现一次（3 条档案各带 1 个开发组徽章；团队标签齐全）",
    archiveRowTexts.length === 3 &&
      Object.values(groupBadgeCounts).every((count) => count === 1) &&
      Object.values(teamBadgeCounts).every((count) => count >= 1) &&
      Object.values(teamBadgeCounts).reduce((sum, count) => sum + count, 0) === 3,
    JSON.stringify({ groupBadgeCounts, teamBadgeCounts, badges: archiveBadgeTexts }),
  );
  await shot(page, "E-profile-all-memberships", { fullPage: true });

  /* ---------------------------------------------------------------- */
  /* F. 回到 grp-frontend 组后「我的成员卡片」仍可打开（幂等回归）        */
  /* ---------------------------------------------------------------- */
  await setHash(page, "/overview");
  await page.waitForSelector(SEL.overviewTitle, { timeout: 20000 });
  await waitCardCount(page, expectedAllMembers, 20000);

  const switchedF = await switchGroup(page, GROUP_FRONTEND.name);
  const activeF = switchedF
    ? await waitFor(
        async () => (await activeWorkspace(page))?.group?.id === GROUP_FRONTEND.id,
        15000,
        "bootstrap active.group 切回 grp-frontend",
      ).then(() => activeWorkspace(page))
    : null;
  record(
    "F. 切回「前端体验组」，bootstrap active.group.id === grp-frontend",
    Boolean(switchedF) && activeF?.group?.id === GROUP_FRONTEND.id,
    JSON.stringify({ switched: switchedF, active: activeF }),
  );
  const meF = await bootstrapMe(page);
  record(
    "F. 切回后 me.linkedMemberId 指向前端体验组档案",
    meF?.linkedMemberId === frontendMember.id,
    JSON.stringify({ linkedMemberId: meF?.linkedMemberId, expected: frontendMember.id }),
  );
  const menuCountF = await myMemberCardMenuCount(page);
  const clickedF = await clickMyMemberCard(page);
  const openedF = clickedF > 0 && (await waitDrawerVisible(page));
  const drawerF = await readDrawer(page);
  record(
    "F. 回到前端体验组后「我的成员卡片」仍可打开（幂等回归，未出现死链）",
    menuCountF === 1 && openedF && drawerF.open && drawerF.title.includes(ACCOUNT_NAME),
    JSON.stringify({ menuCount: menuCountF, opened: openedF, title: drawerF.title }),
  );
  record(
    "F. 所有团队视角下仍展示全部 3 条 memberships 与 3 个开发组",
    drawerF.membershipRows === 3 &&
      [GROUP_FRONTEND.name, GROUP_PLATFORM.name, GROUP_DATA.name].every((name) =>
        drawerF.text.includes(name),
      ),
    JSON.stringify({ rows: drawerF.membershipRows, text: excerpt(drawerF.text) }),
  );
  await shot(page, "F-back-frontend-drawer");
  await closeDrawer(page);

  /* ---------------------------------------------------------------- */
  /* G. 浏览器健康检查                                                  */
  /* ---------------------------------------------------------------- */
  record("G. 浏览器无 pageerror", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
  const noisyConsole = consoleErrors.filter((entry) => !/favicon/i.test(entry));
  record("G. 浏览器控制台无 error", noisyConsole.length === 0, noisyConsole.slice(0, 5).join(" | "));

  failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
} catch (error) {
  console.error("ACCEPTANCE ERROR:", error?.stack ?? error);
  const logTail = tailServerLog();
  if (logTail) console.error(`\n--- backend log (tail) ---\n${logTail}\n--------------------------`);
  record("E2E 流程未中断", false, String(error?.message ?? error));
  failed = results.filter((item) => !item.ok).length;
  try {
    if (page) await shot(page, "error-state");
  } catch {
    // 截图失败不影响退出码
  }
} finally {
  for (const context of trackedContexts) {
    await context.close().catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (edgeProcess) {
    try {
      edgeProcess.kill();
    } catch {
      // already gone
    }
    edgeProcess = null;
  }
  if (edgeProfileDir) {
    await sleep(400);
    try {
      fs.rmSync(edgeProfileDir, { recursive: true, force: true });
      console.log(`CLEAN  removed manual Edge profile: ${edgeProfileDir}`);
    } catch (error) {
      console.log(`CLEAN  skip manual Edge profile removal: ${error.message}`);
    }
  }
  await stopServer();
  if (!KEEP_DATA && !EXTERNAL_SERVER && failed === 0) {
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(`CLEAN  removed disposable data dir: ${DATA_DIR}`);
    } catch (error) {
      console.log(`CLEAN  skip data dir removal: ${error.message}`);
    }
  } else {
    console.log(`KEEP   data dir for debugging: ${DATA_DIR}`);
    console.log(`KEEP   backend log: ${SERVER_LOG}`);
  }
}

process.exitCode = failed > 0 ? 1 : 0;
