import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEAMSTUDIO_URL || "http://127.0.0.1:8000";
const OUT = path.resolve(process.cwd(), "..", "artifacts");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("403")) errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

async function shot(name, fullPage = false) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
  console.log(`captured ${name}`);
}

await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /查看 林知夏 的成员档案/ }).click();
await page.locator("#md-title").waitFor();
await shot("member-drawer");

await page.goto(`${BASE}/#/calendar`, { waitUntil: "networkidle" });
await page.locator(".page-actions").getByRole("button", { name: /新建待办/ }).click();
await page.locator(".modal-panel").waitFor();
await shot("todo-dialog");
await page.locator(".modal-panel .modal-close").click();

await page.goto(`${BASE}/#/settings?tab=email`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await shot("settings-email");
await page.locator(".settings-tabs button").filter({ hasText: "企业 SSO" }).click();
await shot("settings-sso");
await page.locator(".settings-tabs button").filter({ hasText: "团队与权限" }).click();
await shot("settings-access");
await page.locator(".settings-tabs button").filter({ hasText: "高级 JSON" }).click();
await page.locator(".settings-json-textarea").waitFor();
await shot("settings-json");

await page.goto(`${BASE}/#/redblack`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /编辑榜单/ }).click();
await page.locator(".modal-panel").waitFor();
await shot("redblack-editor");
await page.locator(".modal-panel .modal-close").click();

// Simulate the unauthenticated guest experience for visual verification only.
const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: "zh-CN" });
const guestPage = await guestContext.newPage();
await guestPage.route("**/api/bootstrap*", async (route) => {
  const response = await route.fetch();
  const payload = await response.json();
  payload.data.me = {
    id: "guest",
    name: "访客",
    email: "",
    authenticated: false,
    source: "guest",
    isDeviceAdmin: false,
    admin: { role: null, teamIds: [], groupIds: [] },
    linkedMemberId: null,
    linkedMemberName: null,
    ssoConfigured: false,
    permissions: { canEditSettings: false, canEditAny: false, canEditSelf: false, canManageEmail: false },
  };
  payload.data.config.auth.sso = { enabled: false, configured: false, providerName: "企业 SSO" };
  await route.fulfill({ response, json: payload });
});
await guestPage.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
await guestPage.locator(".guest-banner").waitFor();
await guestPage.screenshot({ path: path.join(OUT, "guest-banner.png") });
await guestPage.locator(".guest-banner .badge").count().catch(() => 0);
await guestPage.goto(`${BASE}/#/login`, { waitUntil: "networkidle" });
await guestPage.waitForTimeout(500);
await guestPage.screenshot({ path: path.join(OUT, "guest-login.png") });
await guestContext.close();

await browser.close();
if (errors.length) console.error("ERRORS", errors);
else console.log("NO_UNEXPECTED_ERRORS");
