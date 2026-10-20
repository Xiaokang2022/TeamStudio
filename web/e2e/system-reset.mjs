/**
 * System reset acceptance — deployment-device Admin only.
 *
 * Verifies:
 *   1. the 「重置系统」 settings tab is rendered for the built-in device Admin;
 *   2. cancelling the first confirmation dialog changes nothing;
 *   3. after confirming, the exact full site name must be typed before the final
 *      destructive button unlocks, then the reset really wipes everything;
 *   4. stored `super` accounts never see the tab, the deep link falls back, and the
 *      API answers 403 `device_admin_required` for them;
 *   5. after the reset the device Admin survives, settings are back to defaults and
 *      the workspace / accounts / stats are empty.
 *
 * Prerequisites:
 *   1. Backend on QA_URL (default http://127.0.0.1:8011) with a THROWAWAY
 *      TEAMSTUDIO_DATA_DIR — this script performs a REAL factory reset.
 *   2. `npm run build --prefix web` so the backend serves the latest UI.
 *   3. Optional: `curl http://127.0.0.1:8011/api/health` before running.
 *
 * The restart-safety check (a reset database must not be re-seeded on the next
 * process start) is performed by the outer verification: stop the backend, start it
 * again with the same data dir and confirm GET /api/teams stays empty.
 *
 * Usage: node e2e/system-reset.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8011";
const SHOT_PATH = process.env.SHOT_PATH || "docs/screenshots/system-reset.png";
const SHOT_CONFIRM_PATH =
  process.env.SHOT_CONFIRM_PATH || SHOT_PATH.replace(/\.png$/i, "-confirm.png");
const CUSTOM_SITE_NAME = "星港重置验收站";
const EXTRA_TEAM_NAME = "待清除验收团队";
const SUPER_EMAIL = "stored.super.reset@corp.example";

/* ---------------------------------------------------------------- utils */

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}
function isOk(detail) {
  return results.every((item) => item.ok);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const headers = { "Content-Type": "application/json" };
async function apiGet(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { headers });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}
async function apiSend(method, pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
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

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));

async function waitForText(text, timeout = 20_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

async function resetTabButton() {
  return page.locator(".settings-tab", { hasText: "重置系统" }).first();
}

/* ---------------------------------------------------------------- main */

try {
  /* ---------- 0. live (device-admin) API sanity ---------- */

  const initialInfo = await apiGet("/api/system/reset");
  assert.equal(initialInfo.status, 200, `GET /api/system/reset -> ${initialInfo.status}`);
  const defaults = await apiGet("/api/settings/defaults");
  assert.equal(defaults.status, 200);
  const defaultSiteName = defaults.payload.data.site.name;
  const previousSiteName = initialInfo.payload.data.siteName;
  console.log(`device admin reset info ok (siteName=${previousSiteName}, default=${defaultSiteName})`);

  /* ---------- 1. seed some custom data + rename the site ---------- */

  const createdTeam = await apiSend("POST", "/api/workspace/teams", {
    name: EXTRA_TEAM_NAME,
    shortName: "验收",
    color: "#7c3aed",
  });
  assert.equal(createdTeam.status, 200, `create team -> ${createdTeam.status}`);
  const createdUser = await apiSend("POST", "/api/users", {
    email: "reset.member@corp.example",
    name: "重置验收账号",
    role: "member",
  });
  assert.equal(createdUser.status, 200, `create account -> ${createdUser.status}`);

  const settingsResponse = await apiGet("/api/settings");
  assert.equal(settingsResponse.status, 200);
  const customSettings = settingsResponse.payload.data.settings;
  customSettings.site.name = CUSTOM_SITE_NAME;
  const saved = await apiSend("PUT", "/api/settings", customSettings);
  assert.equal(saved.status, 200, `rename site -> ${saved.status}`);

  const teamsBefore = await apiGet("/api/teams");
  assert.ok(teamsBefore.payload.data.teams.length >= 2, "custom team created");

  /* ---------- 2. device Admin sees the reset tab ---------- */

  await page.goto(`${BASE}/#/settings?tab=reset`, { waitUntil: "domcontentloaded" });
  await waitForText("工作室设置");
  const tab = await resetTabButton();
  await tab.waitFor({ state: "visible", timeout: 20_000 });
  check("device Admin sees 重置系统 tab", true);

  await waitForText(CUSTOM_SITE_NAME);
  check("reset card shows the current site name", true);

  const statsBefore = await apiGet("/api/system/reset");
  const clearedPreview = statsBefore.payload.data.stats;
  check(
    "reset card data counts are exposed",
    typeof clearedPreview.teams === "number" && typeof clearedPreview.accounts === "number",
    JSON.stringify(clearedPreview),
  );

  fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
  await page.screenshot({ path: SHOT_PATH, fullPage: false });

  /* ---------- 3. first dialog: cancel keeps everything ---------- */

  await page.getByRole("button", { name: /重置整个系统/ }).first().click();
  const firstDialog = page.getByRole("dialog");
  await firstDialog.waitFor({ state: "visible", timeout: 10_000 });
  check("first confirmation dialog appears", (await firstDialog.innerText()).includes("重置"));
  await page.getByRole("button", { name: /^取消$/ }).first().click();
  await firstDialog.waitFor({ state: "hidden", timeout: 10_000 });
  const teamsAfterCancel = await apiGet("/api/teams");
  check(
    "cancelling the first dialog leaves data untouched",
    teamsAfterCancel.payload.data.teams.length === teamsBefore.payload.data.teams.length,
  );

  /* ---------- 4. two-step confirmation + typed site name gate ---------- */

  await page.getByRole("button", { name: /重置整个系统/ }).first().click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: /^确认重置$/ }).first().click();

  const verifyDialog = page.getByRole("dialog");
  await verifyDialog.waitFor({ state: "visible", timeout: 10_000 });
  const dialogText = await verifyDialog.innerText();
  check("second dialog asks for the full site name", dialogText.includes(CUSTOM_SITE_NAME));

  const confirmInput = verifyDialog.locator("input").first();
  const finalButton = verifyDialog.getByRole("button", { name: /重置并清除全部数据/ }).first();
  await confirmInput.waitFor({ state: "visible", timeout: 10_000 });
  check("final reset button is locked initially", await finalButton.isDisabled());

  await confirmInput.fill("错误站点名称");
  await sleep(120);
  check("final reset button stays locked for a wrong name", await finalButton.isDisabled());

  await confirmInput.fill(CUSTOM_SITE_NAME);
  await sleep(150);
  check("final reset button unlocks for the exact name", await finalButton.isEnabled());

  fs.mkdirSync(path.dirname(SHOT_CONFIRM_PATH), { recursive: true });
  await page.screenshot({ path: SHOT_CONFIRM_PATH, fullPage: false });

  await finalButton.click();
  await waitForText("重置完成", 30_000);
  check("success panel is shown after the reset", true);

  /* ---------- 5. backend state after the reset ---------- */

  const teamsAfter = await apiGet("/api/teams");
  check("all teams are gone after the reset", teamsAfter.payload.data.teams.length === 0);

  const bootstrap = await apiGet("/api/bootstrap");
  check(
    "bootstrap has no active workspace",
    bootstrap.payload.data.active.team === null && bootstrap.payload.data.teams.length === 0,
  );

  const settingsAfter = await apiGet("/api/settings");
  check(
    "settings are back to defaults",
    settingsAfter.payload.data.settings.site.name === defaultSiteName,
    `site.name=${settingsAfter.payload.data.settings.site.name}`,
  );

  const usersAfter = await apiGet("/api/users");
  const userRows = usersAfter.payload.data.users;
  check(
    "all stored accounts are gone (device Admin row only)",
    userRows.length === 1 && userRows[0].isDeviceAdmin === true,
    `rows=${userRows.length}`,
  );

  const infoAfter = await apiGet("/api/system/reset");
  const zeroStats = infoAfter.payload.data.stats;
  check(
    "reset info reports an empty system",
    zeroStats.teams === 0 &&
      zeroStats.groups === 0 &&
      zeroStats.members === 0 &&
      zeroStats.tasks === 0 &&
      zeroStats.todos === 0 &&
      zeroStats.accounts === 0,
    JSON.stringify(zeroStats),
  );
  check("lastResetAt is recorded", Boolean(infoAfter.payload.data.lastResetAt));

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForText("工作室设置");
  check(
    "device Admin still sees the tab after the reset",
    await (await resetTabButton()).isVisible(),
  );

  /* ---------- 6. a stored super account must never see or call the reset ---------- */

  const superAccount = await apiSend("POST", "/api/users", {
    email: SUPER_EMAIL,
    name: "在册验收超管",
    role: "super",
  });
  assert.equal(superAccount.status, 200, `create stored super -> ${superAccount.status}`);
  const activationUrl = superAccount.payload.data.activation?.url;
  assert.ok(activationUrl, "pre-created account returns an activation URL");

  // Explicitly leave device-admin mode, then activate the stored super account.
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST", credentials: "include" }));
  await page.goto(activationUrl, { waitUntil: "domcontentloaded" });
  await sleep(500);
  const superMe = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "include" })).json());
  const superIdentity = superMe.data;
  check(
    "activation link signs in as the stored super account",
    superIdentity.isSuperAdmin === true && superIdentity.isDeviceAdmin === false,
    `source=${superIdentity.source}`,
  );

  await page.goto(`${BASE}/#/settings`, { waitUntil: "domcontentloaded" });
  await waitForText("工作室设置");
  const superTabCount = await page.locator(".settings-tab", { hasText: "重置系统" }).count();
  check("stored super admin cannot see the 重置系统 tab", superTabCount === 0);

  await page.goto(`${BASE}/#/settings?tab=reset`, { waitUntil: "domcontentloaded" });
  await waitForText("工作室设置");
  await sleep(300);
  const dangerVisible = await page.getByRole("button", { name: /重置整个系统/ }).count();
  const superTabAfterDeepLink = await page.locator(".settings-tab", { hasText: "重置系统" }).count();
  check(
    "deep link falls back to a normal tab for the stored super admin",
    dangerVisible === 0 && superTabAfterDeepLink === 0,
  );

  const forbiddenGet = await page.evaluate(async () => {
    const response = await fetch("/api/system/reset", { credentials: "include" });
    const payload = await response.json();
    return { status: response.status, code: payload?.error?.code ?? "" };
  });
  check(
    "GET /api/system/reset is 403 for the stored super admin",
    forbiddenGet.status === 403 && forbiddenGet.code === "device_admin_required",
    JSON.stringify(forbiddenGet),
  );

  const forbiddenPost = await page.evaluate(async (siteName) => {
    const response = await fetch("/api/system/reset", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: siteName, acknowledge: true }),
    });
    const payload = await response.json();
    return { status: response.status, code: payload?.error?.code ?? "" };
  }, defaultSiteName);
  check(
    "POST /api/system/reset is 403 for the stored super admin",
    forbiddenPost.status === 403 && forbiddenPost.code === "device_admin_required",
    JSON.stringify(forbiddenPost),
  );

  // Restore the built-in device Admin so the page ends in a usable state.
  await page.evaluate(() => fetch("/api/auth/device/login", { method: "POST", credentials: "include" }));
  const restored = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "include" })).json());
  check("device Admin can be restored after the test", restored.data.isDeviceAdmin === true);

  /* ---------- 7. page errors ---------- */

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  check("script completed without exceptions", false, error?.stack || String(error));
} finally {
  await context.close();
  await browser.close();
}

console.log("");
const failed = results.filter((item) => !item.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  failed.forEach((item) => console.log(` - ${item.name}${item.detail ? ` :: ${item.detail}` : ""}`));
  process.exitCode = 1;
}
if (!isOk()) {
  console.log("system-reset acceptance: FAILED");
} else {
  console.log("system-reset acceptance: PASSED");
}
