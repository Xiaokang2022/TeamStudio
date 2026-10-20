/**
 * Round 5 acceptance test — accounts / personal home page / layered settings /
 * e-mail code login / scope rules / red-black scope following.
 *
 * Prerequisites:
 *   1. Backend running on BASE (default http://127.0.0.1:8010) with
 *      TEAMSTUDIO_TRUST_PROXY=1 and a disposable TEAMSTUDIO_DATA_DIR.
 *   2. `npm run build --prefix web` so the backend serves the latest UI.
 *
 * The script starts its own local SMTP sink (127.0.0.1:2526), configures it through
 * the device-admin API, then drives real Edge/Chromium sessions. Non-local identities
 * are simulated with X-Forwarded-For (the server trusts it because TRUST_PROXY=1).
 *
 * Usage: node e2e/round5-acceptance.mjs
 */
import net from "node:net";
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8010";
const SMTP_PORT = Number(process.env.SMTP_SINK_PORT || 2526);
const VIEWPORT = { width: 1440, height: 1000 };
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Local SMTP sink                                                     */
/* ------------------------------------------------------------------ */

const mails = [];
const sink = net.createServer((socket) => {
  let buffer = "";
  let inData = false;
  let data = "";
  socket.write("220 localhost TeamStudio test sink\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          mails.push(data);
          data = "";
          socket.write("250 OK queued\r\n");
        } else {
          data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
        }
        continue;
      }
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO" || verb === "HELO") {
        socket.write("250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 OK\r\n");
      } else if (verb === "AUTH") {
        socket.write("235 Authentication successful\r\n");
      } else if (verb === "DATA") {
        inData = true;
        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (verb === "QUIT") {
        socket.write("221 Bye\r\n");
        socket.end();
      } else {
        socket.write("250 OK\r\n");
      }
    }
  });
  socket.on("error", () => {});
});
await new Promise((resolve, reject) => {
  sink.once("error", reject);
  sink.listen(SMTP_PORT, "127.0.0.1", resolve);
});
console.log(`SMTP sink listening on 127.0.0.1:${SMTP_PORT}`);

function codeFor(email, startIndex = 0) {
  for (let index = startIndex; index < mails.length; index += 1) {
    const raw = mails[index];
    if (!raw.toLowerCase().includes(`to: ${email}`.toLowerCase())) continue;
    const [headers, ...rest] = raw.split("\n\n");
    let body = rest.join("\n\n");
    if (/content-transfer-encoding:\s*base64/i.test(headers)) {
      body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } else if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
      body = body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    const match = body.match(/\b(\d{6})\b/);
    if (match) return { code: match[1], index };
  }
  return null;
}

async function waitForCode(email, startIndex, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = codeFor(email, startIndex);
    if (found) return found;
    await sleep(200);
  }
  throw new Error(`No verification code mail arrived for ${email}; last mail: ${JSON.stringify(mails[mails.length - 1] ?? "")}`);
}

/* ------------------------------------------------------------------ */
/* API helpers (loopback => built-in device Admin)                     */
/* ------------------------------------------------------------------ */

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload?.error?.message ?? "request failed"}`);
  }
  return payload.data;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Backend is not reachable at ${BASE}`);
}

async function configureSmtpAndAccounts() {
  const { settings } = await api("/api/settings");
  settings.email.enabled = true;
  // Keep repeated QA runs fast; production default stays 60 s.
  settings.auth.emailLogin.resendSeconds = 30;
  settings.email.smtp = {
    ...settings.email.smtp,
    host: "127.0.0.1",
    port: SMTP_PORT,
    username: "noreply@test.local",
    password: "test-password",
    fromEmail: "noreply@test.local",
    fromName: "TeamStudio 验证中心",
    useStartTls: false,
    useSsl: false,
    timeoutSeconds: 10,
  };
  await api("/api/settings", { method: "PUT", body: settings });

  const existing = await api("/api/users");
  const emails = new Set(existing.users.map((user) => user.email));
  const accounts = [
    {
      email: "super.one@corp.example",
      name: "超级管理员一号",
      role: "super",
      emailVerified: true,
    },
    {
      email: "team.lead@corp.example",
      name: "团队负责人",
      role: "team_admin",
      teamIds: ["team-aurora"],
      emailVerified: true,
    },
    {
      email: "group.lead@corp.example",
      name: "开发组负责人",
      role: "group_admin",
      groupIds: ["grp-frontend"],
      emailVerified: true,
    },
  ];
  for (const account of accounts) {
    if (!emails.has(account.email)) {
      await api("/api/users", { method: "POST", body: account });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Browser helpers                                                     */
/* ------------------------------------------------------------------ */

const consoleErrors = [];
function attachErrorCapture(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`${label}: ${error.message}`));
}

function remoteContext(browser, ip) {
  return browser.newContext({
    viewport: VIEWPORT,
    locale: "zh-CN",
    extraHTTPHeaders: { "X-Forwarded-For": ip },
  });
}

async function openApp(context, hash = "/overview") {
  const page = await context.newPage();
  attachErrorCapture(page, hash);
  await page.goto(`${BASE}/#${hash.replace(/^\//, "")}`, { waitUntil: "domcontentloaded" });
  return page;
}

async function loginWithCode(context, email, label) {
  const page = await openApp(context, "/login");
  attachErrorCapture(page, label);
  await page.waitForSelector("#login-email", { timeout: 20000 });
  const mailStart = mails.length;
  await page.fill("#login-email", email);
  const submit = page.locator(".login-form button[type='submit']");
  await submit.click();
  await page.waitForSelector("#login-code", { timeout: 20000 });
  const found = await waitForCode(email, mailStart);
  await page.fill("#login-code", found.code);
  await submit.click();
  await page.waitForSelector(".user-chip", { timeout: 25000 });
  await page.waitForTimeout(400);
  return page;
}

async function logout(page) {
  await page.locator(".user-chip").click();
  await page.locator(".user-popover .menu-row", { hasText: /退出登录|切换账号/ }).first().click();
  await page.waitForTimeout(800);
}

async function setScope(page, label) {
  await page.locator(".scope-option", { hasText: label }).first().click();
  await page.waitForTimeout(900);
}

function scopeLabels(page) {
  return page.locator(".scope-option").allInnerTexts();
}

function activeHash(page) {
  return page.evaluate(() => window.location.hash);
}

/* ------------------------------------------------------------------ */
/* Test run                                                           */
/* ------------------------------------------------------------------ */

let browser;
let failed = 0;
try {
  await waitForServer();
  await configureSmtpAndAccounts();

  browser = await chromium.launch({ channel: "msedge", headless: true });

  /* ---------------------------------------------------------------- */
  /* A. Guest is not redirected; e-mail code login; personal page      */
  /* ---------------------------------------------------------------- */
  const guest = await remoteContext(browser, "10.99.0.11");
  let page = await openApp(guest, "/overview");
  await page.waitForSelector(".app-shell", { timeout: 20000 });
  await page.waitForSelector(".ov-hero-title", { timeout: 20000 });
  await page.waitForTimeout(600);
  record("访客打开默认不跳转登录页", !(await activeHash(page)).includes("login"), await activeHash(page));
  record("访客可浏览概览", await page.locator(".ov-hero-title").first().isVisible());
  record("访客顶部显示登录入口", await page.locator(".login-button", { hasText: "登录" }).isVisible());
  record("访客看到访客横幅", await page.locator(".guest-banner").isVisible());
  record(
    "访客可使用所有团队视角",
    (await scopeLabels(page)).length === 3 &&
      (await scopeLabels(page)).some((text) => text.includes("所有")),
  );

  await page.locator(".login-button").click();
  await page.waitForSelector("#login-email", { timeout: 15000 });
  record("点击右上角进入登录页", (await activeHash(page)).includes("login"));
  await page.close();

  page = await loginWithCode(guest, "lin.zhixia@corp.example", "lin-login");
  record("邮箱验证码登录成功", (await page.locator(".user-chip").innerText()).includes("林知夏"));
  record(
    "成员没有系统设置入口",
    (await page.locator(".main-nav .nav-item", { hasText: "系统设置" }).count()) === 0,
  );
  record(
    "成员可使用所有团队视角",
    (await scopeLabels(page)).length === 3 &&
      (await scopeLabels(page)).some((text) => text.includes("所有")),
  );

  const cookies = await guest.cookies(BASE);
  const session = cookies.find((cookie) => cookie.name === "teamstudio_session");
  const remainingDays = session ? (session.expires - Date.now() / 1000) / 86400 : 0;
  record("会话有效期约 7 天", remainingDays > 6 && remainingDays <= 7.01, `${remainingDays.toFixed(2)} 天`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".user-chip", { timeout: 15000 });
  record("刷新后保持登录状态", (await page.locator(".user-chip").innerText()).includes("林知夏"));

  await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".profile-page", { timeout: 20000 });
  record("个人主页可打开", (await page.locator("h1.page-title").innerText()).includes("个人主页"));
  for (const section of ["责任田", "当前任务", "历史任务", "红黑榜记录"]) {
    record(`个人主页包含${section}`, (await page.locator(".profile-section h2", { hasText: section }).count()) > 0);
  }
  record("个人主页无“伙伴”旧文案", (await page.locator("body").innerText()).includes("伙伴") === false);
  record("个人设置区可见", await page.locator("#profile-settings").isVisible());

  const suffix = String(Date.now()).slice(-6);
  await page.fill("#profile-name", `林知夏 · 验收${suffix}`);
  await page.fill("#profile-bio", `负责前端体验与设计系统，关注可访问性与性能。${suffix}`);
  const skillInput = page.locator(".profile-skill-input input");
  await skillInput.fill(`前端体验${suffix}`);
  await page.locator(".profile-skill-input button", { hasText: "添加" }).click();
  const saveButton = page.locator(".profile-settings-actions button", { hasText: "保存修改" });
  await saveButton.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => {
      const button = Array.from(document.querySelectorAll(".profile-settings-actions button")).find(
        (item) => item.textContent?.includes("保存修改"),
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 10000 },
  );
  await saveButton.click();
  await page.waitForSelector(".toast, .toast-item", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#profile-settings", { timeout: 20000 });
  record("个人资料保存并同步", (await page.inputValue("#profile-name")).includes("林知夏 · 验收"));

  await page.locator("input[type='file']").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await page.waitForTimeout(1200);
  

  await logout(page);
  await page.waitForTimeout(700);
  record("退出后可切换账号/访客", !(await page.locator(".user-chip").count()));
  await page.close();
  await guest.close();

  /* ---------------------------------------------------------------- */
  /* B. Open registration creates a new member account                 */
  /* ---------------------------------------------------------------- */
  const registrar = await remoteContext(browser, "10.99.0.12");
  const newEmail = `new.member.${Date.now()}@corp.example`;
  page = await loginWithCode(registrar, newEmail, "register");
  record("开放注册自动创建账号", (await page.locator(".user-chip").innerText()).includes(newEmail.split("@")[0]));
  await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".profile-page", { timeout: 20000 });
  record("新账号个人主页正常渲染", (await page.locator(".profile-section").count()) >= 4);
  await registrar.close();

  /* ---------------------------------------------------------------- */
  /* C. Super administrator: site settings, accounts, all scope        */
  /* ---------------------------------------------------------------- */
  const superCtx = await remoteContext(browser, "10.99.0.13");
  page = await loginWithCode(superCtx, "super.one@corp.example", "super");
  record("超级管理员登录", (await page.locator(".user-chip").innerText()).includes("超级管理员"));
  record(
    "超级管理员可访问所有团队视角",
    (await scopeLabels(page)).some((text) => text.includes("所有")),
  );
  await page.locator(".main-nav .nav-item", { hasText: "系统设置" }).click();
  await page.waitForSelector(".settings-tabs", { timeout: 20000 });
  const tabs = await page.locator(".settings-tabs .settings-tab").allInnerTexts();
  for (const label of ["工作区设置", "外观与站点", "账号与角色", "邮件服务", "高级 JSON"]) {
    record(`超级管理员设置含${label}`, tabs.some((text) => text.includes(label)));
  }
  await page.locator(".settings-tabs .settings-tab", { hasText: "账号与角色" }).click();
  await page.waitForTimeout(900);
  const accountText = await page.locator(".settings-page").innerText();
  record("账号列表含预创建超管", accountText.includes("super.one@corp.example"));
  record("设备管理员行不可管理", accountText.includes("部署设备内置管理员"));

  // Pre-created accounts receive a one-time activation URL at creation time.
  const inviteEmail = `invited.${Date.now()}@corp.example`;
  const invited = await api("/api/users", {
    method: "POST",
    body: { email: inviteEmail, name: "受邀成员", role: "member" },
  });
  record(
    "预创建账号同步返回激活链接",
    Boolean(invited.activation?.url) && invited.activation.url.includes("/api/auth/activate?token="),
  );
  const inviteCtx = await remoteContext(browser, "10.99.0.88");
  const invitePage = await inviteCtx.newPage();
  attachErrorCapture(invitePage, "activation-link");
  await invitePage.goto(invited.activation.url, { waitUntil: "domcontentloaded" });
  await invitePage.waitForSelector(".user-chip", { timeout: 25000 });
  record(
    "打开激活链接自动激活并登录",
    (await invitePage.locator(".user-chip").innerText()).includes("受邀成员"),
  );
  record(
    "激活账号不附带管理员权限",
    (await invitePage.locator(".main-nav .nav-item", { hasText: "系统设置" }).count()) === 0,
  );
  await inviteCtx.close();

  await page.locator(".settings-tabs .settings-tab", { hasText: "邮件服务" }).click();
  await page.waitForTimeout(900);
  const emailText = await page.locator(".settings-page").innerText();
  record("邮件服务显示 SMTP 状态", emailText.includes("SMTP 中继") || emailText.includes("smtp"));
  record("邮件服务不再包含提醒模板", !emailText.includes("提醒模板") && !emailText.includes("邮件提醒"));

  await page.goto(`${BASE}/#/redblack`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rb-page", { timeout: 20000 });
  await setScope(page, "团队");
  await page.waitForTimeout(800);
  const teamCrumb = (await page.locator(".breadcrumb").innerText()).replace(/\s+/g, " ");
  record(
    "团队视角面包屑使用团队名称且不重复",
    (teamCrumb.match(/星港产品团队/g) || []).length === 1 &&
      !teamCrumb.includes("全团队"),
    teamCrumb,
  );
  record("红黑榜随团队视角刷新", (await page.locator(".rb-scope-hint").count()) > 0);
  record("团队视角红黑榜显示开发组徽章", (await page.locator(".rb-group-badge").count()) > 0);
  record(
    "聚合视角红黑榜只读",
    (await page.locator("button", { hasText: "编辑榜单" }).count()) === 0,
  );
  await setScope(page, "开发组");
  const groupEdit = page.locator("button", { hasText: "编辑榜单" });
  await groupEdit.waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  record("开发组视角红黑榜可编辑", (await groupEdit.count()) > 0);
  await superCtx.close();

  /* ---------------------------------------------------------------- */
  /* D. Team administrator: domain-only settings, no all scope         */
  /* ---------------------------------------------------------------- */
  const teamCtx = await remoteContext(browser, "10.99.0.14");
  page = await loginWithCode(teamCtx, "team.lead@corp.example", "team-admin");
  record("团队管理员登录", (await page.locator(".user-chip").innerText()).includes("团队管理员"));
  record(
    "团队管理员可使用所有团队视角",
    (await scopeLabels(page)).some((text) => text.includes("所有")),
  );
  await page.goto(`${BASE}/#/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".settings-page", { timeout: 20000 });
  await page.waitForSelector(".settings-domain-team", { timeout: 20000 });
  const teamSettingsText = await page.locator(".settings-page").innerText();
  record("团队管理员看到工作区设置", teamSettingsText.includes("工作区设置"));
  record(
    "团队管理员看不到站点级标签",
    !teamSettingsText.includes("账号与角色") && !teamSettingsText.includes("邮件服务"),
  );
  record("团队管理员可管理结构", teamSettingsText.includes("管理工作区结构"));

  await page.goto(`${BASE}/#/overview`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ov-member-card", { timeout: 20000 });
  await page.locator(".ov-member-card").first().click();
  await page.waitForSelector(".md-drawer", { timeout: 15000 });
  await page.locator(".md-drawer button", { hasText: "编辑资料" }).click();
  await page.waitForSelector("#md-profile-form", { timeout: 15000 });
  record("团队管理员编辑他人时个人信息禁用", await page.locator("#md-profile-name").isDisabled());
  record("团队管理员仍可编辑组织字段", !(await page.locator("#md-profile-title").isDisabled()));
  record(
    "个人信息受限提示可见",
    (await page.locator(".md-perm-note").first().innerText()).includes("个人信息"),
  );
  await teamCtx.close();

  /* ---------------------------------------------------------------- */
  /* E. Group administrator: only its group, no site settings          */
  /* ---------------------------------------------------------------- */
  const groupCtx = await remoteContext(browser, "10.99.0.15");
  page = await loginWithCode(groupCtx, "group.lead@corp.example", "group-admin");
  await page.goto(`${BASE}/#/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".settings-page", { timeout: 20000 });
  await page.waitForSelector(".settings-domain-team", { timeout: 20000 });
  const groupSettingsText = await page.locator(".settings-page").innerText();
  record("开发组管理员看到工作区设置", groupSettingsText.includes("工作区设置"));
  record("开发组管理员看不到站点级标签", !groupSettingsText.includes("账号与角色"));
  record(
    "开发组管理员范围仅 1 个开发组",
    groupSettingsText.includes("1 个开发组") || groupSettingsText.includes("前端体验组"),
  );
  record("开发组管理员无结构管理入口", !groupSettingsText.includes("管理工作区结构"));
  await groupCtx.close();

  /* ---------------------------------------------------------------- */
  /* F. Device Admin: calendar reminders removed, e-mail relay works    */
  /* ---------------------------------------------------------------- */
  const localCtx = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
  page = await openApp(localCtx, "/calendar");
  await page.waitForSelector(".cal-page", { timeout: 20000 });
  const calendarText = await page.locator(".cal-page").innerText();
  record("日历不再包含邮件提醒", !calendarText.includes("邮件提醒") && !calendarText.includes("提醒节奏"));
  await page.goto(`${BASE}/#/settings?tab=email`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".settings-tabs", { timeout: 20000 });
  await page.waitForTimeout(900);
  const smtpHost = page.locator("input").filter({ hasNot: page.locator("[type=password]") });
  record(
    "邮件服务显示已配置的 SMTP 主机",
    (await page.locator(".settings-page").innerText()).includes("127.0.0.1"),
  );
  const before = mails.length;
  const testTo = page.locator("input[placeholder*=\"测试收件邮箱\"]").first();
  if (await testTo.count()) {
    await testTo.fill("super.one@corp.example");
    await page.locator("button", { hasText: /发送测试|发送测试邮件/ }).first().click();
    await page.waitForTimeout(1500);
    record("SMTP 测试邮件可投递", mails.length > before);
  } else {
    record("SMTP 测试邮件可投递", false, "test input not found");
  }

  /* Device Admin can sign out and restore the built-in identity. */
  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".login-card", { timeout: 20000 });
  const signOut = page.locator(".login-switch", { hasText: /退出登录/ });
  record("设备管理员登录页可退出", (await signOut.count()) > 0);
  await signOut.click();
  await page.waitForSelector("#login-email", { timeout: 20000 });
  record("退出后回到普通登录页", await page.locator("#login-email").isVisible());
  const deviceButton = page.locator(".login-device-entry button", {
    hasText: "以设备管理员身份登录",
  });
  record("检测到部署设备时显示设备管理员登录按钮", await deviceButton.isVisible());
  await deviceButton.click();
  await page.waitForSelector(".user-chip", { timeout: 25000 });
  record(
    "设备管理员身份可恢复",
    (await page.locator(".user-chip").innerText()).includes("Admin"),
  );

  await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".profile-page", { timeout: 20000 });
  const deviceHero = await page.locator(".profile-hero").innerText();
  record(
    "部署设备个人主页不在角色中重复设备说明",
    deviceHero.includes("超级管理员") &&
      !deviceHero.includes("超级管理员（部署设备）") &&
      deviceHero.includes("部署设备"),
  );

  await page.locator(".scope-option", { hasText: "所有" }).first().click();
  await page.waitForTimeout(900);
  const breadcrumb = await page.locator(".breadcrumb").innerText();
  record(
    "所有团队视角面包屑不重复",
    (breadcrumb.match(/所有团队/g) || []).length === 1,
    breadcrumb.replace(/\s+/g, " "),
  );
  await page.close();

  const localErrors = consoleErrors.filter((entry) => !entry.includes("favicon"));
  record("浏览器控制台无错误", localErrors.length === 0, localErrors.slice(0, 3).join(" | "));

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  failed = results.length - passed;
} catch (error) {
  console.error("ACCEPTANCE ERROR:", error.message);
  failed += 1;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => sink.close(resolve));
}

process.exitCode = failed > 0 ? 1 : 0;
