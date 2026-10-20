/**
 * Round 6 acceptance — 成员档案只能从已注册账号中选择 / 个人主页管理员范围 / 设备管理员可见性。
 *
 * 本脚本是自包含的：它用一次性 TEAMSTUDIO_DATA_DIR 在独立端口（默认 8012）启动后端，
 * 结束后清理后端进程与临时数据目录；使用系统 Edge（Playwright channel=msedge）驱动真实 UI。
 *
 * 前置条件：
 *   1. `npm run build --prefix web`（后端托管 web/dist，脚本会检查产物是否存在）。
 *   2. `.venv\Scripts\python.exe` 存在（可用 TEAMSTUDIO_PYTHON 覆盖）。
 *   3. 系统安装 Microsoft Edge（Playwright 用 channel=msedge，不下载浏览器）。
 *
 * 用法（web/ 目录下）：
 *   npm run e2e:round6 --prefix web
 *   QA_PORT=8013 npm run e2e:round6 --prefix web        # 换端口
 *   QA_URL=http://127.0.0.1:8012 HEADFUL=1 ...          # 复用已启动的一次性实例 / 有头模式
 *
 * 环境变量：
 *   QA_PORT / QA_URL       后端端口或完整 URL（默认 http://127.0.0.1:8012）
 *   TEAMSTUDIO_DATA_DIR    显式指定数据目录（默认 artifacts/round6-data-<ts>，成功时删除）
 *   KEEP_DATA=1            无论成败都保留一次性数据目录（便于复现）
 *   HEADFUL=1              有头运行 Edge
 *
 * 覆盖的契约（docs/ROUND6_CONTRACT.md）：
 *   1. 概览页「添加成员」只能搜索选择已注册账号（含预创建未激活账号，标注「待激活」），
 *      不再有姓名 / 邮箱 / 成员 ID 等自定义输入；已在本组的账号不出现在候选中；选中后可创建成功。
 *   2. 团队管理员 / 开发组管理员个人主页展示管理范围；超级管理员只显示「超级管理员」。
 *   3. 设备管理员不出现在存储在册超级管理员的账号列表（只有设备管理员自己能看到该行）。
 *
 * 说明：round 6 前端可能微调 DOM。所有选择器集中在本文件的 SEL 对象里，联调时只需改那里。
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
const PORT = Number(process.env.QA_PORT || 8012);
const BASE = (process.env.QA_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const ORIGIN = new URL(BASE);
const COOKIE_DOMAIN = ORIGIN.hostname;
const HEADLESS = process.env.HEADFUL !== "1";
const KEEP_DATA = process.env.KEEP_DATA === "1";

/** Round 6 DOM 选择器；前端联调后如类名变化，只改这里。 */
const SEL = {
  appShell: ".app-shell",
  overviewTitle: ".ov-hero-title",
  addMemberButton: /添加成员/,
  dialog: '[role="dialog"]',
  modalFooterPrimary: ".modal-footer button.btn-primary",
  select: ".ts-select",
  selectTrigger: ".ts-select-trigger",
  selectPanel: ".ts-select-panel",
  selectSearch: ".ts-select-search-input",
  selectOption: ".ts-select-option",
  selectEmpty: ".ts-select-empty",
  memberCard: ".ov-member-card",
  profilePage: ".profile-page",
  profileHero: ".profile-hero",
  toast: ".toast-message",
  settingsPage: ".settings-page",
  accountList: ".settings-account-list",
  deviceAccountRow: ".settings-account-row.is-device",
};

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const suffix = detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "";
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${suffix}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 8000, label = "", interval = 120) {
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
  if (label) console.log(`WAIT  ${label} timed out after ${timeout}ms${lastError ? ` (${lastError.message})` : ""}`);
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
const ARTIFACTS = path.join(REPO_ROOT, "artifacts", "round6");
fs.mkdirSync(ARTIFACTS, { recursive: true });

const ownsDataDir = !process.env.TEAMSTUDIO_DATA_DIR;
const DATA_DIR = process.env.TEAMSTUDIO_DATA_DIR || path.join(REPO_ROOT, "artifacts", `round6-data-${stamp}`);
fs.mkdirSync(DATA_DIR, { recursive: true });
const SERVER_LOG = path.join(ARTIFACTS, `server-${stamp}.log`);

const GROUP = { teamId: "team-aurora", groupId: "grp-frontend", teamName: "极光产品团队", groupName: "前端体验组" };
const CANDIDATES_PATH = `/api/teams/${GROUP.teamId}/groups/${GROUP.groupId}/member-candidates`;

const ACCOUNTS = {
  super: { email: `round6.super.${stamp}@corp.example`, name: "Round6 超级管理员", role: "super" },
  team: {
    email: `round6.team.${stamp}@corp.example`,
    name: "Round6 团队管理员",
    role: "team_admin",
    teamIds: [GROUP.teamId],
  },
  group: {
    email: `round6.group.${stamp}@corp.example`,
    name: "Round6 开发组管理员",
    role: "group_admin",
    groupIds: [GROUP.groupId],
  },
  candidate: { email: `round6.pending.${stamp}@corp.example`, name: "陆时雨", role: "member" },
};

/* ------------------------------------------------------------------ */
/* 后端进程管理（一次性实例）                                           */
/* ------------------------------------------------------------------ */

let server = null;
let serverExit = null;
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
  if (await healthReachable()) {
    throw new Error(`${BASE} 已有服务在运行；round6 E2E 需要独占的一次性实例（可换 QA_PORT 或先停止旧服务）`);
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
  if (!server) return;
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
}

function tailServerLog(lines = 40) {
  try {
    const text = fs.readFileSync(SERVER_LOG, "utf8").trimEnd().split(/\r?\n/);
    return text.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* API helpers（Node 直连回环 => 设备管理员）                            */
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

async function createPrecreatedAccount(definition) {
  const data = await api("/api/users", { method: "POST", body: definition });
  if (!data?.user?.id) throw new Error(`创建账号失败：${JSON.stringify(definition)}`);
  if (!data?.activation?.url) throw new Error(`预创建账号未返回激活链接：${definition.email}`);
  return { ...definition, id: data.user.id, activation: data.activation };
}

/* ------------------------------------------------------------------ */
/* 浏览器 helpers                                                      */
/* ------------------------------------------------------------------ */

const browserErrors = [];

function attachErrorCapture(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`${label}: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`${label}: ${error.message}`));
}

async function newContext(browser, label, { deviceLogout = false, pinWorkspace = false } = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "zh-CN",
  });
  if (deviceLogout) {
    // 让回环访问不再自动成为设备管理员，从而以邮箱账号身份浏览。
    await context.addCookies([
      { name: "teamstudio_device_logout", value: "1", domain: COOKIE_DOMAIN, path: "/" },
    ]);
  }
  if (pinWorkspace) {
    // 固定当前团队 / 开发组与浏览视角，确保「添加成员」落在 grp-frontend。
    await context.addInitScript(() => {
      try {
        localStorage.setItem("teamstudio.team", "team-aurora");
        localStorage.setItem("teamstudio.group", "grp-frontend");
        localStorage.setItem("teamstudio.scope", "group");
      } catch {
        // about:blank 等无 storage 的页面忽略
      }
    });
  }
  trackedContexts.add(context);
  return context;
}

async function activeWorkspace(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/bootstrap");
    const payload = await response.json().catch(() => null);
    return payload?.data?.active ?? null;
  });
}

async function openHash(page, hash) {
  await page.goto(`${BASE}/#${hash.replace(/^\//, "")}`, { waitUntil: "domcontentloaded" });
}

async function activeHash(page) {
  return page.evaluate(() => window.location.hash);
}

async function pageIdentity(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/bootstrap");
    const payload = await response.json().catch(() => null);
    const me = payload?.data?.me ?? {};
    return {
      id: me.id,
      authenticated: me.authenticated,
      source: me.source,
      userRole: me.userRole,
      isSuperAdmin: me.isSuperAdmin,
      isDeviceAdmin: me.isDeviceAdmin,
    };
  });
}

async function shot(page, name, { fullPage = false } = {}) {
  shotCount += 1;
  const file = path.join(ARTIFACTS, `${String(shotCount).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`SHOT  ${file}`);
  return file;
}

/** 切换明暗主题后截图（用于人工核对管理员范围 / 选人弹窗在暗色下的可读性）。 */
async function shotTheme(page, name, theme = "dark") {
  await page.evaluate((value) => {
    localStorage.setItem("teamstudio.theme", value);
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.waitForTimeout(500);
  return shot(page, `${name}-${theme}`);
}

/** 用一次性激活链接在「非设备管理员」上下文里登录并把页面带到 profile。 */
async function loginViaActivation(browser, activationUrl, label) {
  const context = await newContext(browser, label, { deviceLogout: true });
  const page = await context.newPage();
  attachErrorCapture(page, label);
  await page.goto(activationUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".user-chip", { timeout: 25000 });
  await page.waitForTimeout(400);
  const identity = await pageIdentity(page);
  if (identity.isDeviceAdmin) {
    throw new Error(`${label}: 激活登录后仍是设备管理员（teamstudio_device_logout 未生效）`);
  }
  return { context, page, identity };
}

async function openProfile(page) {
  await openHash(page, "/profile");
  await page.waitForSelector(SEL.profilePage, { timeout: 20000 });
  await page.waitForTimeout(700);
  return page.locator(SEL.profilePage).innerText();
}

async function profileAdminScope(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/profile");
    const payload = await response.json().catch(() => null);
    return payload?.data?.adminScope ?? null;
  });
}

function excerpt(text, length = 260) {
  return text.replace(/\s+/g, " ").trim().slice(0, length);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let browser = null;
let failed = 1;

try {
  const distIndex = path.join(REPO_ROOT, "web", "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    throw new Error(`前端尚未构建：缺少 ${distIndex}。请先运行 npm run build --prefix web`);
  }
  record("前端构建产物存在（web/dist/index.html）", true, distIndex);

  await startServer();
  record("一次性数据目录后端已启动", true, `${BASE} · data=${DATA_DIR}`);

  browser = await chromium.launch({ channel: "msedge", headless: HEADLESS });
  record("系统 Edge 已启动（Playwright channel=msedge）", true);

  /* ---------------------------------------------------------------- */
  /* A. 设备管理员进入概览页，准备账号                                   */
  /* ---------------------------------------------------------------- */
  const adminContext = await newContext(browser, "device-admin", { pinWorkspace: true });
  const adminPage = await adminContext.newPage();
  attachErrorCapture(adminPage, "device-admin");
  await openHash(adminPage, "/overview");
  await adminPage.waitForSelector(SEL.appShell, { timeout: 20000 });
  await adminPage.waitForSelector(SEL.overviewTitle, { timeout: 20000 });
  await adminPage.waitForTimeout(500);

  const adminIdentity = await pageIdentity(adminPage);
  record(
    "设备管理员进入概览页（未被跳转登录）",
    adminIdentity.isDeviceAdmin === true && !(await activeHash(adminPage)).includes("login"),
    JSON.stringify(adminIdentity),
  );
  const adminActive = await activeWorkspace(adminPage);
  record(
    "概览页当前开发组为前端体验组（grp-frontend）",
    adminActive?.group?.id === GROUP.groupId && adminActive?.team?.id === GROUP.teamId,
    JSON.stringify(adminActive),
  );
  await shot(adminPage, "overview-device-admin");

  /* 通过设备管理员 API 预创建：存储超管 / 团队管理员 / 开发组管理员 / 待激活候选成员。 */
  const superAccount = await createPrecreatedAccount(ACCOUNTS.super);
  const teamAccount = await createPrecreatedAccount(ACCOUNTS.team);
  const groupAccount = await createPrecreatedAccount(ACCOUNTS.group);
  const pendingAccount = await createPrecreatedAccount(ACCOUNTS.candidate);
  record(
    "已预创建存储超管 / 团队管理员 / 开发组管理员 / 待激活候选账号",
    Boolean(superAccount.activation?.url && teamAccount.activation?.url && groupAccount.activation?.url && pendingAccount.activation?.url),
    JSON.stringify({
      super: superAccount.id,
      team: teamAccount.id,
      group: groupAccount.id,
      pending: pendingAccount.id,
      pendingVerified: false,
    }),
  );

  /* ---------------------------------------------------------------- */
  /* B. 候选接口（契约 1.2）                                            */
  /* ---------------------------------------------------------------- */
  const candidateData = await api(CANDIDATES_PATH);
  const candidates = candidateData.candidates ?? [];
  record(
    "候选接口返回 { candidates, total }",
    Array.isArray(candidateData.candidates) && candidateData.total === candidates.length,
    `total=${candidateData.total}`,
  );
  record(
    "候选包含已注册且不在本组的账号（顾行 / 数据智能组）",
    candidates.some((item) => item.email === "gu.xing@corp.example"),
    JSON.stringify(candidates.slice(0, 3)),
  );
  record(
    "候选包含预创建未激活账号（emailVerified=false）",
    candidates.some((item) => item.id === pendingAccount.id && item.emailVerified === false),
    `pending=${pendingAccount.id}`,
  );
  record(
    "候选排除已在本组的账号（林知夏）",
    candidates.every((item) => item.email !== "lin.zhixia@corp.example"),
    `members=${candidates.length}`,
  );
  record(
    "候选不含内置设备管理员（device-admin）",
    candidates.every((item) => item.id !== "device-admin"),
    `members=${candidates.length}`,
  );
  const searched = await api(`${CANDIDATES_PATH}?search=${encodeURIComponent("GU.XING")}`);
  record(
    "候选 search 大小写不敏感（GU.XING → gu.xing）",
    (searched.candidates ?? []).some((item) => item.email === "gu.xing@corp.example"),
    JSON.stringify((searched.candidates ?? []).map((item) => item.email)),
  );
  const searchedExisting = await api(`${CANDIDATES_PATH}?search=${encodeURIComponent("林知夏")}`);
  record(
    "候选 search 命中已在本组账号时返回空",
    (searchedExisting.candidates ?? []).length === 0,
    JSON.stringify(searchedExisting),
  );

  /* ---------------------------------------------------------------- */
  /* C. 概览页「添加成员」：只能搜索选择已注册账号（契约 1.3 / 1.4）      */
  /* ---------------------------------------------------------------- */
  const addTrigger = adminPage.getByRole("button", { name: SEL.addMemberButton }).first();
  await addTrigger.waitFor({ state: "visible", timeout: 15000 });
  await addTrigger.click();

  const dialog = adminPage.locator(SEL.dialog).first();
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  // 等弹窗入场动画结束再截图，避免半透明/位移中的画面。
  await adminPage.waitForTimeout(650);
  record("添加成员弹窗可打开", true);
  await shot(adminPage, "add-member-dialog");

  const dialogTitle = (await dialog.locator(".modal-header h2").innerText().catch(() => "")).trim();
  record("弹窗标题为「添加成员」相关", /添加.*成员/.test(dialogTitle), dialogTitle);

  /* C1. 不再存在自定义身份字段 */
  const legacyFieldSelector = [
    "#ov-add-name",
    "#ov-add-email",
    "#ov-add-id",
    "#ov-add-bio",
    "#ov-add-tags",
    'input[placeholder*="林知夏"]',
    'input[placeholder*="留空自动生成"]',
    'input[placeholder*="name@corp.example"]',
  ].join(",");
  record(
    "弹窗不含姓名 / 邮箱 / 成员 ID / 简介 / 标签等自定义输入框",
    (await dialog.locator(legacyFieldSelector).count()) === 0,
  );
  record(
    "弹窗不含 email 类型输入框",
    (await dialog.locator('input[type="email"]').count()) === 0,
  );
  const labelTexts = (await dialog.locator("label").allInnerTexts())
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const forbiddenLabels = ["姓名", "邮箱", "成员 ID", "成员ID", "个人简介", "标签"];
  const offendingLabels = labelTexts.filter((text) => forbiddenLabels.some((word) => text.startsWith(word)));
  record(
    "弹窗不再出现身份字段标签",
    offendingLabels.length === 0,
    `labels=${JSON.stringify(labelTexts)}`,
  );

  /* C2. 使用 searchable 下拉框（候选列表异步加载，先等 Select 出现） */
  const candidatesLoaded = await waitFor(
    async () => (await dialog.locator(SEL.select).count()) > 0,
    10000,
    "候选列表加载完成",
  );
  record("候选列表加载完成（Select 已渲染）", candidatesLoaded);
  const select = dialog.locator(SEL.select).first();
  record("弹窗使用自绘下拉框（components/Select）", (await select.count()) > 0);
  let submitButton = dialog.locator(SEL.modalFooterPrimary).first();
  if ((await submitButton.count()) === 0) {
    // 兜底：按文案找提交按钮（前端若调整 footer 结构仍可工作）。
    submitButton = dialog.getByRole("button", { name: /创建成员|添加成员|确认添加/ }).last();
  }
  record("未选择账号时创建按钮禁用", await submitButton.isDisabled().catch(() => false));

  const selectTrigger = select.locator(SEL.selectTrigger);
  await selectTrigger.waitFor({ state: "visible", timeout: 8000 });
  await waitFor(async () => !(await selectTrigger.isDisabled()), 10000, "候选下拉可用");
  await selectTrigger.click();
  const panel = adminPage.locator(SEL.selectPanel).first();
  await panel.waitFor({ state: "visible", timeout: 8000 });
  const searchInput = panel.locator(SEL.selectSearch);
  record("成员选择下拉框可展开且带搜索输入框", (await searchInput.count()) === 1);
  record(
    "候选选项异步加载完成",
    await waitFor(async () => (await panel.locator(SEL.selectOption).count()) > 0, 10000, "候选选项加载"),
  );
  const optionTexts = await panel.locator(SEL.selectOption).allInnerTexts();
  record(
    "候选下拉包含其他开发组已注册账号（顾行）",
    optionTexts.some((text) => text.includes("顾行")),
    `options=${optionTexts.length}`,
  );
  record(
    "候选下拉标注预创建账号为「待激活」",
    optionTexts.some((text) => text.includes("陆时雨") && text.includes("待激活")),
    JSON.stringify(optionTexts.filter((text) => text.includes("陆时雨"))),
  );
  record(
    "候选下拉排除已在本组的账号（林知夏）",
    optionTexts.every((text) => !text.includes("林知夏")),
  );
  // Select 面板有 ~140ms 入场动画，等动画完成再截图（否则面板呈半透明）。
  await adminPage.waitForTimeout(320);
  await shot(adminPage, "add-member-candidates");

  /* C3. 搜索：已在本组账号查不到，候选账号查得到 */
  await searchInput.fill("lin.zhixia");
  await adminPage.waitForTimeout(300);
  const existingOptions = await panel.locator(SEL.selectOption).allInnerTexts();
  const existingEmpty = await panel.locator(SEL.selectEmpty).count();
  record(
    "搜索已在本组账号（lin.zhixia）时无候选（空态）",
    existingOptions.length === 0 && existingEmpty === 1,
    `options=${JSON.stringify(existingOptions)} empty=${existingEmpty}`,
  );

  await searchInput.fill("陆时雨");
  const pendingOptionReady = await waitFor(
    async () => (await panel.locator(SEL.selectOption).count()) > 0,
    6000,
    "搜索候选账号",
  );
  record("搜索候选账号（陆时雨）命中", pendingOptionReady);
  const pendingOption = panel
    .locator(SEL.selectOption)
    .filter({ hasText: "陆时雨" })
    .first();
  await pendingOption.waitFor({ state: "visible", timeout: 6000 });
  record("候选选项带邮箱描述", (await pendingOption.innerText()).includes(pendingAccount.email));
  await pendingOption.click();
  await panel.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  // 等选中预览/徽章渲染稳定后再截图。
  await adminPage.waitForTimeout(350);

  const dialogTextAfterSelect = await dialog.innerText();
  record("选择后展示账号姓名", dialogTextAfterSelect.includes("陆时雨"));
  record("选择后展示账号邮箱", dialogTextAfterSelect.includes(pendingAccount.email));
  record("选择后展示「待激活」徽章", dialogTextAfterSelect.includes("待激活"));
  record("选择账号后创建按钮可用", !(await submitButton.isDisabled()));
  await shot(adminPage, "add-member-selected");
  await shotTheme(adminPage, "add-member-selected", "dark");
  await shotTheme(adminPage, "add-member-selected", "light");

  /* C4. 提交并验证成员由账号派生 */
  await submitButton.click();
  const dialogClosed = await waitFor(
    async () => (await dialog.isVisible().catch(() => false)) === false,
    15000,
    "创建后弹窗关闭",
  );
  record("提交后弹窗关闭（创建成功）", dialogClosed);
  const toastShown = await waitFor(
    async () => {
      const texts = await adminPage.locator(SEL.toast).allInnerTexts().catch(() => []);
      return texts.some((text) => text.includes("陆时雨") || text.includes("已添加"));
    },
    6000,
    "创建成功提示",
  );
  record("创建成功提示可见", toastShown);

  const groupData = await api(`/api/teams/${GROUP.teamId}/groups/${GROUP.groupId}/overview`);
  const groupMembers = groupData.members ?? [];
  const createdMember = groupMembers.find((item) => item.email === pendingAccount.email);
  record(
    "新成员档案已创建且身份由账号派生（name/email）",
    Boolean(createdMember) && createdMember.name === "陆时雨",
    JSON.stringify(createdMember ?? null),
  );
  record(
    "成员档案 id 为新生成（不复用账号 id）",
    Boolean(createdMember) && createdMember.id !== pendingAccount.id,
    createdMember?.id ?? "",
  );
  const memberCardVisible = await waitFor(
    async () => (await adminPage.locator(SEL.memberCard).filter({ hasText: "陆时雨" }).count()) > 0,
    10000,
    "概览成员卡出现新成员",
  );
  record("概览成员档案出现新成员", memberCardVisible);
  await shot(adminPage, "overview-after-add-member");

  const candidatesAfter = await api(CANDIDATES_PATH);
  record(
    "已加入本组的账号从候选中消失",
    (candidatesAfter.candidates ?? []).every((item) => item.id !== pendingAccount.id),
    `total=${candidatesAfter.total}`,
  );

  /* ---------------------------------------------------------------- */
  /* D. 个人主页管理员范围（契约 2.2 / 2.4）                             */
  /* ---------------------------------------------------------------- */
  const teamLogin = await loginViaActivation(browser, teamAccount.activation.url, "team-admin");
  record(
    "团队管理员通过激活链接登录（非设备管理员）",
    teamLogin.identity.userRole === "team_admin" && teamLogin.identity.isDeviceAdmin === false,
    JSON.stringify(teamLogin.identity),
  );
  await openProfile(teamLogin.page);
  await waitFor(
    async () => (await teamLogin.page.locator(".profile-admin-scope").count()) > 0,
    8000,
    "团队管理员管理范围 chip",
  );
  const teamText = await teamLogin.page.locator(SEL.profilePage).innerText();
  const teamScope = await profileAdminScope(teamLogin.page);
  record(
    "团队管理员个人主页展示管理团队",
    teamText.includes(GROUP.teamName) && teamText.includes("团队管理员"),
    excerpt(teamText),
  );
  record(
    "团队管理员 adminScope：role=team_admin 且解析出团队名称",
    teamScope?.role === "team_admin" &&
      Array.isArray(teamScope.teams) &&
      teamScope.teams.some((item) => item.id === GROUP.teamId && item.name === GROUP.teamName),
    JSON.stringify(teamScope),
  );
  record(
    "团队管理员 adminScope.summary 说明团队名 + 团队管理员",
    typeof teamScope?.summary === "string" &&
      teamScope.summary.includes(GROUP.teamName) &&
      teamScope.summary.includes("团队管理员"),
    teamScope?.summary ?? "",
  );
  await shot(teamLogin.page, "profile-team-admin");
  await shotTheme(teamLogin.page, "profile-team-admin", "dark");
  await shotTheme(teamLogin.page, "profile-team-admin", "light");

  const groupLogin = await loginViaActivation(browser, groupAccount.activation.url, "group-admin");
  record(
    "开发组管理员通过激活链接登录（非设备管理员）",
    groupLogin.identity.userRole === "group_admin" && groupLogin.identity.isDeviceAdmin === false,
    JSON.stringify(groupLogin.identity),
  );
  await openProfile(groupLogin.page);
  await waitFor(
    async () => (await groupLogin.page.locator(".profile-admin-scope").count()) > 0,
    8000,
    "开发组管理员管理范围 chip",
  );
  const groupText = await groupLogin.page.locator(SEL.profilePage).innerText();
  const groupScope = await profileAdminScope(groupLogin.page);
  record(
    "开发组管理员个人主页展示管理开发组（含所属团队）",
    groupText.includes(GROUP.groupName) &&
      groupText.includes("开发组管理员") &&
      groupText.includes(GROUP.teamName),
    excerpt(groupText),
  );
  record(
    "开发组管理员 adminScope：role=group_admin 且解析出开发组与所属团队",
    groupScope?.role === "group_admin" &&
      Array.isArray(groupScope.groups) &&
      groupScope.groups.some(
        (item) =>
          item.id === GROUP.groupId &&
          item.name === GROUP.groupName &&
          item.teamId === GROUP.teamId &&
          item.teamName === GROUP.teamName,
      ),
    JSON.stringify(groupScope),
  );
  record(
    "开发组管理员 adminScope.summary 说明开发组名 + 开发组管理员",
    typeof groupScope?.summary === "string" &&
      groupScope.summary.includes(GROUP.groupName) &&
      groupScope.summary.includes("开发组管理员"),
    groupScope?.summary ?? "",
  );
  await shot(groupLogin.page, "profile-group-admin");

  const superLogin = await loginViaActivation(browser, superAccount.activation.url, "super-admin");
  record(
    "存储超级管理员通过激活链接登录（非设备管理员）",
    superLogin.identity.userRole === "super" && superLogin.identity.isDeviceAdmin === false,
    JSON.stringify(superLogin.identity),
  );
  const superText = await openProfile(superLogin.page);
  const superScope = await profileAdminScope(superLogin.page);
  record(
    "超级管理员个人主页只显示「超级管理员」",
    superText.includes("超级管理员") &&
      !superText.includes("团队管理员") &&
      !superText.includes("开发组管理员"),
    excerpt(superText),
  );
  record(
    "超级管理员 adminScope：role=super、summary=超级管理员、teams/groups 为空",
    superScope?.role === "super" &&
      superScope.summary === "超级管理员" &&
      Array.isArray(superScope.teams) &&
      superScope.teams.length === 0 &&
      Array.isArray(superScope.groups) &&
      superScope.groups.length === 0,
    JSON.stringify(superScope),
  );
  await shot(superLogin.page, "profile-super-admin");

  const deviceProfileText = await openProfile(adminPage);
  const deviceScope = await profileAdminScope(adminPage);
  record(
    "设备管理员主页只显示超级管理员（保留系统内置徽章）",
    deviceProfileText.includes("超级管理员") &&
      deviceProfileText.includes("系统内置") &&
      !deviceProfileText.includes("超级管理员（") &&
      !deviceProfileText.includes("团队管理员") &&
      !deviceProfileText.includes("开发组管理员"),
    excerpt(deviceProfileText),
  );
  record(
    "设备管理员 adminScope：role=super、isDeviceAdmin=true",
    deviceScope?.role === "super" && deviceScope?.isDeviceAdmin === true,
    JSON.stringify(deviceScope),
  );
  await shot(adminPage, "profile-device-admin");

  /* ---------------------------------------------------------------- */
  /* E. 设备管理员可见性（契约 2.3）                                     */
  /* ---------------------------------------------------------------- */
  await openHash(superLogin.page, "/settings?tab=accounts");
  await superLogin.page.waitForSelector(SEL.settingsPage, { timeout: 20000 });
  await superLogin.page.waitForSelector(SEL.accountList, { timeout: 20000 });
  await superLogin.page.waitForTimeout(600);
  const superAccountsText = await superLogin.page.locator(SEL.settingsPage).innerText();
  const superAccountListText = await superLogin.page.locator(SEL.accountList).innerText();
  const superDeviceRows = await superLogin.page.locator(SEL.deviceAccountRow).count();
  const superUsers = await superLogin.page.evaluate(async () => {
    const response = await fetch("/api/users");
    const payload = await response.json().catch(() => null);
    return payload?.data?.users ?? [];
  });
  record(
    "存储在册超级管理员的账号列表不含系统内置管理员行",
    superDeviceRows === 0 && !superAccountListText.includes("系统内置管理员"),
    `deviceRows=${superDeviceRows}`,
  );
  record(
    "存储超管调用 GET /api/users 不返回设备管理员合成行",
    superUsers.length > 0 && superUsers.every((item) => !item.isDeviceAdmin),
    JSON.stringify(superUsers.filter((item) => item.isDeviceAdmin)),
  );
  record(
    "存储超管账号列表仍包含自己",
    superUsers.some((item) => item.id === superAccount.id),
    `users=${superUsers.length}`,
  );
  await shot(superLogin.page, "accounts-super-admin-no-device-row");

  await openHash(adminPage, "/settings?tab=accounts");
  await adminPage.waitForSelector(SEL.accountList, { timeout: 20000 });
  await adminPage.waitForTimeout(600);
  const deviceAdminRows = await adminPage.locator(SEL.deviceAccountRow).count();
  record(
    "设备管理员本人的账号列表仍显示系统内置管理员行（仅自己可见）",
    deviceAdminRows === 1,
    `deviceRows=${deviceAdminRows}`,
  );
  await shot(adminPage, "accounts-device-admin");

  /* ---------------------------------------------------------------- */
  /* F. 浏览器控制台健康检查                                            */
  /* ---------------------------------------------------------------- */
  const noisyErrors = browserErrors.filter((entry) => !entry.toLowerCase().includes("favicon"));
  record(
    "浏览器控制台无错误",
    noisyErrors.length === 0,
    noisyErrors.slice(0, 5).join(" | "),
  );

  failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
} catch (error) {
  console.error("ACCEPTANCE ERROR:", error?.stack ?? error);
  const logTail = tailServerLog();
  if (logTail) console.error(`\n--- backend log (tail) ---\n${logTail}\n--------------------------`);
  record("E2E 流程未中断", false, String(error?.message ?? error));
  failed = results.filter((item) => !item.ok).length;
} finally {
  for (const context of trackedContexts) {
    await context.close().catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  if (!KEEP_DATA && failed === 0) {
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
