/**
 * Regression: the sidebar 「所有」 (all-teams) browsing scope must stick for EVERY
 * identity — guests and signed-in non-admin members included.
 *
 * Root cause guarded here: a leftover round-5 permission gate in
 * `web/src/store.tsx` `setScope()` rewrote `all` to `team` unless the current
 * identity was a super / device admin. Browsing scope is a view preference, not a
 * permission boundary (backend `app/scope.py` / `app/auth.py::can_view_all_scope`
 * allow every identity), so the option must always be accepted.
 *
 * Usage (from web/):
 *   node e2e/scope-all.mjs                                  # expects backend :8000 serving dist
 *   QA_URL=http://127.0.0.1:5173 node e2e/scope-all.mjs     # Vite dev server (already-fixed source)
 *
 * The test is self-cleaning: it pre-creates a throwaway member account with a
 * unique e-mail, deletes it again and restores the deployment-device Admin with
 * POST /api/auth/device/login before exiting. It never touches the servers
 * themselves; it only drives the UI through Playwright.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const BASE_URL = new URL(BASE);
const VIEWPORT = { width: 1440, height: 1000 };
const COOKIE_DOMAIN = BASE_URL.hostname;

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const suffix =
    detail === "" || detail === undefined
      ? ""
      : ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${suffix}`);
}

const stamp = Date.now();
const MEMBER_EMAIL = `scope.all.member.${stamp}@example.com`;

let createdUserId = null;
let memberActivationUrl = null;
let cleanupDone = false;

async function waitForShell(page) {
  await page.waitForSelector(".scope-switcher .scope-option", { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".scope-switcher .scope-option").length === 3,
    undefined,
    { timeout: 20000 },
  );
}

/** Current session identity straight from the API (not from the DOM). */
async function identity(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/bootstrap");
    const payload = await response.json();
    const me = payload?.data?.me ?? {};
    return {
      id: me.id,
      authenticated: me.authenticated,
      source: me.source,
      userRole: me.userRole,
      isSuperAdmin: me.isSuperAdmin,
      isDeviceAdmin: me.isDeviceAdmin,
      canViewAllScope: me.permissions?.canViewAllScope,
    };
  });
}

async function readScopeState(page) {
  return page.evaluate(() => {
    const options = Array.from(document.querySelectorAll(".scope-switcher .scope-option"));
    return {
      scopeStorage: localStorage.getItem("teamstudio.scope"),
      pressed: options.map((el) => ({
        label: (el.textContent || "").trim(),
        pressed: el.getAttribute("aria-pressed"),
      })),
      hint: (document.querySelector(".scope-switcher-hint")?.textContent || "").trim(),
      eyebrow: (document.querySelector(".ov-hero-eyebrow")?.textContent || "").trim(),
    };
  });
}

function allScopeOption(page) {
  return page.locator(".scope-switcher .scope-option").filter({ hasText: "所有" }).first();
}

async function clickAllScope(page) {
  const option = allScopeOption(page);
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
}

/**
 * Assert the click on 「所有」 was honoured: pressed state, hint, localStorage and
 * the page's follow-up data request all carry the `all` scope.
 */
async function assertAllScopeSticks(page, identityLabel, requestLog) {
  // Give the store + the page data fetch a moment to settle (a broken store never
  // reaches this condition, which is exactly the failure we want to report).
  await page
    .waitForFunction(
      () =>
        localStorage.getItem("teamstudio.scope") === "all" &&
        (document.querySelector(".scope-switcher-hint")?.textContent || "").includes("所有团队"),
      undefined,
      { timeout: 6000 },
    )
    .catch(() => {});

  const state = await readScopeState(page);
  const allOption = state.pressed.find((item) => item.label.includes("所有"));
  const pressedLabels = state.pressed.filter((item) => item.pressed === "true").map((item) => item.label);

  record(
    `${identityLabel}: 「所有」 click stores localStorage teamstudio.scope=all`,
    state.scopeStorage === "all",
    { scopeStorage: state.scopeStorage, pressedLabels },
  );
  record(
    `${identityLabel}: 「所有」 option has aria-pressed=true`,
    allOption?.pressed === "true",
    state.pressed,
  );
  record(
    `${identityLabel}: scope switcher hint reads 所有团队`,
    state.hint.includes("所有团队"),
    state.hint,
  );
  record(
    `${identityLabel}: aggregated overview is visible (ALL TEAMS PULSE)`,
    state.eyebrow.includes("ALL TEAMS PULSE"),
    state.eyebrow,
  );

  const scopedRequest = requestLog.find(
    (url) => /\/overview\?/.test(url) && /[?&]scope=all(&|$)/.test(url),
  );
  record(
    `${identityLabel}: follow-up page data request carried scope=all`,
    Boolean(scopedRequest),
    scopedRequest ?? requestLog.slice(-6),
  );
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

/** Restore the device Admin and delete the throwaway account from a live page. */
async function cleanupInPage(page, identityLabel) {
  const restoreStatus = await page.evaluate(async () => {
    const response = await fetch("/api/auth/device/login", { method: "POST" });
    return response.status;
  });
  const restoredIdentity = await identity(page);
  record(
    `${identityLabel}: device admin restored via POST /api/auth/device/login`,
    restoreStatus === 200 && restoredIdentity.isDeviceAdmin === true,
    { status: restoreStatus, identity: restoredIdentity },
  );

  if (!createdUserId) {
    record(`${identityLabel}: throwaway member account deleted`, false, "no account was created");
    return;
  }
  const deletedStatus = await page.evaluate(async (userId) => {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
    return response.status;
  }, createdUserId);
  record(
    `${identityLabel}: throwaway member account deleted`,
    deletedStatus === 200,
    { status: deletedStatus, userId: createdUserId },
  );
}

/** Best-effort cleanup when an assertion/step above threw before the normal cleanup. */
async function fallbackCleanup() {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      await fetch("/api/auth/device/login", { method: "POST" });
    });
    if (createdUserId) {
      await page.evaluate(async (userId) => {
        await fetch(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      }, createdUserId);
    }
    console.log(`WARN fallback cleanup ran (device admin restored, account ${createdUserId ?? "none"} deleted)`);
  } finally {
    await context.close();
  }
}

try {
  /* ------------------------------------------------------------------ */
  /* 1. Device admin: create the throwaway member + super-admin regression */
  /* ------------------------------------------------------------------ */
  const adminContext = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await waitForShell(adminPage);

  const adminIdentity = await identity(adminPage);
  record(
    "device admin session available for account setup",
    adminIdentity.isDeviceAdmin === true && adminIdentity.authenticated === true,
    adminIdentity,
  );

  if (adminIdentity.isDeviceAdmin) {
    // Super admin must keep working (no regression): 「所有」 already worked before
    // the bug fix, so this check passes both before and after.
    const adminRequests = [];
    adminPage.on("request", (request) => adminRequests.push(request.url()));
    adminRequests.length = 0;
    await clickAllScope(adminPage);
    await assertAllScopeSticks(adminPage, "device admin (regression)", adminRequests);

    const created = await adminPage.evaluate(async (email) => {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: "Scope 回归成员", role: "member" }),
      });
      const payload = await response.json().catch(() => null);
      return { status: response.status, payload };
    }, MEMBER_EMAIL);

    const createdUser = created.payload?.data?.user ?? null;
    memberActivationUrl = created.payload?.data?.activation?.url ?? null;
    createdUserId = createdUser?.id ?? null;
    record(
      "device admin pre-created a non-admin member account with activation link",
      created.status >= 200 && created.status < 300 && Boolean(createdUserId) && Boolean(memberActivationUrl),
      { status: created.status, userId: createdUserId, activationUrl: memberActivationUrl },
    );
    if (!memberActivationUrl) throw new Error("cannot continue member flow without an activation URL");
  }
  await adminContext.close();

  /* ------------------------------------------------------------------ */
  /* 2. Guest: logout on the deployment device, hard reload, click 所有    */
  /* ------------------------------------------------------------------ */
  const guestContext = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
  const guestPage = await guestContext.newPage();
  const guestRequests = [];
  guestPage.on("request", (request) => guestRequests.push(request.url()));

  await guestPage.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await waitForShell(guestPage);
  const beforeLogout = await identity(guestPage);
  record(
    "guest flow: initial identity resolved",
    typeof beforeLogout.source === "string" && beforeLogout.source.length > 0,
    beforeLogout,
  );

  // POST /api/auth/logout writes the one-year HttpOnly teamstudio_device_logout
  // cookie on the deployment device; only a hard reload picks the new identity up
  // (a hash-only goto would not reload the app).
  const logoutStatus = await guestPage.evaluate(async () => {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    return response.status;
  });
  record("guest flow: POST /api/auth/logout", logoutStatus === 200, logoutStatus);
  await guestPage.reload({ waitUntil: "networkidle" });
  await waitForShell(guestPage);
  await guestPage.waitForTimeout(400);

  const guestIdentity = await identity(guestPage);
  record(
    "guest flow: reloaded page really is a guest",
    guestIdentity.authenticated === false && guestIdentity.source === "guest",
    guestIdentity,
  );
  record(
    "guest flow: backend reports canViewAllScope=true",
    guestIdentity.canViewAllScope === true,
    guestIdentity.canViewAllScope,
  );

  guestRequests.length = 0;
  await clickAllScope(guestPage);
  await assertAllScopeSticks(guestPage, "guest", guestRequests);
  await guestContext.close();

  /* ------------------------------------------------------------------ */
  /* 3. Signed-in non-admin member: open activation URL, click 所有        */
  /* ------------------------------------------------------------------ */
  const memberContext = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
  await memberContext.addCookies([
    // Simulate "the device owner signed out of device Admin" before opening the
    // activation link, so the account session is what identifies the browser.
    { name: "teamstudio_device_logout", value: "1", domain: COOKIE_DOMAIN, path: "/" },
  ]);
  const memberPage = await memberContext.newPage();
  const memberRequests = [];
  memberPage.on("request", (request) => memberRequests.push(request.url()));

  // Opening the one-time activation URL activates the pre-created account and
  // sets its e-mail session cookie (the device logout cookie is already present).
  if (!memberActivationUrl) throw new Error("missing activation URL for the member flow");
  await memberPage.goto(memberActivationUrl, { waitUntil: "networkidle" });
  await waitForShell(memberPage);
  await memberPage.waitForTimeout(500);

  const memberIdentity = await identity(memberPage);
  record(
    "member flow: activation link signs in a non-admin member",
    memberIdentity.authenticated === true &&
      memberIdentity.source === "email" &&
      memberIdentity.userRole === "member" &&
      memberIdentity.isSuperAdmin === false &&
      memberIdentity.isDeviceAdmin === false,
    memberIdentity,
  );

  memberRequests.length = 0;
  await clickAllScope(memberPage);
  await assertAllScopeSticks(memberPage, "member", memberRequests);

  /* ------------------------------------------------------------------ */
  /* 4. Cleanup + restore device admin                                   */
  /* ------------------------------------------------------------------ */
  await cleanupInPage(memberPage, "cleanup");
  cleanupDone = true;

  await memberContext.close();
} finally {
  if (!cleanupDone) {
    await fallbackCleanup().catch((error) => console.log(`WARN fallback cleanup failed: ${error}`));
  }
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
if (failed.length) {
  console.log("FAILED:", failed.map((item) => item.name).join(" | "));
  process.exitCode = 1;
}
