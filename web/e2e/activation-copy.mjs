/**
 * Bug 2 regression: 预创建账号 / 重新生成激活链接后，激活 URL 必须真正写入剪贴板；
 * 复制失败时必须诚实报错（不能 toast 成功），并给出可手动复制的回退（选中链接输入框）。
 *
 * 运行（web/ 目录下）：
 *   node e2e/activation-copy.mjs                                  # 默认打 http://127.0.0.1:8000
 *   QA_URL=http://127.0.0.1:5174 node e2e/activation-copy.mjs     # 打 Vite dev server
 *
 * 前置条件：后端 :8000 运行中；本机回环请求自动获得设备 Admin 身份（可用于 #/settings?tab=accounts）。
 * 自动清理：结束时通过 DELETE /api/users/{id} 删除本次创建的全部账号。
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const HEADLESS = process.env.HEADFUL !== "1";
const stamp = Date.now();
const mainEmail = `actcopy.${stamp}@corp.example`;
const failEmail = `actcopyfail.${stamp}@corp.example`;
const SUCCESS_TOAST = "已创建并复制激活链接";
const PREFIX = "activation-copy";

const failures = [];

function pass(name, detail = "") {
  console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function readClipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** 轮询等待剪贴板内容变为期望值（真实落盘有微小延迟，轮询避免 flaky）。 */
async function expectClipboard(page, expected, label, timeout = 8000) {
  const started = Date.now();
  let actual = "<未读取>";
  while (Date.now() - started < timeout) {
    try {
      actual = await readClipboard(page);
    } catch (error) {
      actual = `<读取失败: ${error.message}>`;
    }
    if (actual === expected) {
      pass(label);
      return;
    }
    await page.waitForTimeout(100);
  }
  fail(label, `剪贴板为 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

async function setClipboard(page, value) {
  await page.evaluate((text) => navigator.clipboard.writeText(text), value);
}

async function toastTexts(page) {
  return page.locator(".toast-message").allInnerTexts();
}

async function waitForToast(page, needle, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const texts = await toastTexts(page).catch(() => []);
    if (texts.some((text) => text.includes(needle))) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function openAccountsTab(page) {
  await page.goto(`${BASE}/#/settings?tab=accounts`, { waitUntil: "networkidle" });
  await page.locator(".settings-page").waitFor({ timeout: 30000 });
  await page.locator(".settings-account-list").waitFor({ timeout: 30000 });
}

async function createPrecreatedAccount(page, email) {
  await page.getByPlaceholder("member@company.com").fill(email);
  await page.getByRole("button", { name: "预创建账号", exact: true }).click();
  const input = page.locator(".settings-activation-link input");
  await input.waitFor({ timeout: 15000 });
  return input;
}

async function cleanupAccounts(page) {
  const deleted = await page
    .evaluate(async (stampValue) => {
      const response = await fetch("/api/users", { credentials: "include" });
      const payload = await response.json();
      const users = payload?.data?.users ?? [];
      const removed = [];
      for (const user of users) {
        if (typeof user.email === "string" && user.email.includes(stampValue)) {
          const del = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
            method: "DELETE",
            credentials: "include",
          });
          const result = await del.json().catch(() => null);
          if (del.ok && result?.ok) removed.push(user.email);
        }
      }
      return removed;
    }, String(stamp))
    .catch((error) => [`<清理失败: ${error.message}>`]);
  if (deleted.length) console.log(`CLEAN  deleted ${deleted.length} account(s): ${deleted.join(", ")}`);
  else console.log("CLEAN  no test accounts needed cleanup");
}

/** 兜底清理：即使页面崩溃/被关闭，也从 Node 直接按回环设备 Admin 身份删除本次账号。 */
async function cleanupViaFetch() {
  try {
    const response = await fetch(`${BASE}/api/users`);
    const payload = await response.json();
    const users = payload?.data?.users ?? [];
    const removed = [];
    for (const user of users) {
      if (typeof user.email === "string" && user.email.includes(String(stamp))) {
        const del = await fetch(`${BASE}/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
        if (del.ok) removed.push(user.email);
      }
    }
    if (removed.length) console.log(`CLEAN  fallback deleted ${removed.length} account(s): ${removed.join(", ")}`);
  } catch (error) {
    console.log(`CLEAN  fallback cleanup skipped: ${error.message}`);
  }
}

const browser = await chromium.launch({ channel: "msedge", headless: HEADLESS });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
  permissions: ["clipboard-read", "clipboard-write"],
});
let page = null;

try {
  page = await context.newPage();
  page.on("pageerror", (error) => console.log(`PAGEERROR ${error.message}`));

  await openAccountsTab(page);

  /* ---------------- 1) 预创建账号后自动复制 ---------------- */
  await setClipboard(page, "sentinel-before-create");
  let input = await createPrecreatedAccount(page, mainEmail);
  const createdUrl = await input.inputValue();
  console.log(`INFO  activation url: ${createdUrl}`);

  const clipboardAvailable = await page
    .evaluate(() => typeof navigator.clipboard?.readText === "function")
    .catch(() => false);
  if (!clipboardAvailable) {
    fail("navigator.clipboard.readText 可用", "当前上下文无法读取剪贴板（需要安全上下文 + clipboard 权限）");
    throw new Error("clipboard API unavailable, cannot verify");
  }
  pass("navigator.clipboard.readText 可用");

  await expectClipboard(page, createdUrl, "创建预创建账号后自动复制激活链接");
  if (await waitForToast(page, SUCCESS_TOAST)) pass("创建后展示复制成功提示");
  else fail("创建后展示复制成功提示", `toasts=${JSON.stringify(await toastTexts(page))}`);

  /* ---------------- 2) 点击链接输入框复制 ---------------- */
  await setClipboard(page, "sentinel-before-click");
  await input.click();
  await expectClipboard(page, createdUrl, "点击激活链接输入框后复制");
  if (await waitForToast(page, "激活链接已复制")) pass("点击输入框后展示复制成功提示");
  else fail("点击输入框后展示复制成功提示", `toasts=${JSON.stringify(await toastTexts(page))}`);

  /* ---------------- 3) 账号行「激活链接」重新生成后自动复制 ---------------- */
  await setClipboard(page, "sentinel-before-regenerate");
  const row = page.locator(".settings-account-row", { hasText: mainEmail });
  const regenerate = row.getByRole("button", { name: "激活链接" });
  if (!(await regenerate.count())) {
    fail("账号行存在「激活链接」按钮", `row for ${mainEmail} not found`);
  } else {
    await regenerate.click();
    const started = Date.now();
    let regeneratedUrl = createdUrl;
    while (Date.now() - started < 15000) {
      regeneratedUrl = await input.inputValue();
      if (regeneratedUrl && regeneratedUrl !== createdUrl) break;
      await page.waitForTimeout(100);
    }
    if (regeneratedUrl !== createdUrl) {
      pass("重新生成激活链接", "URL 已更新");
      await expectClipboard(page, regeneratedUrl, "重新生成激活链接后自动复制");
    } else {
      fail("重新生成激活链接", "URL 未变化");
    }
  }

  /* ---------------- 4) 「复制链接」按钮仍然可用 ---------------- */
  const currentUrl = await input.inputValue();
  await setClipboard(page, "sentinel-before-button");
  await page.getByRole("button", { name: "复制链接" }).click();
  await expectClipboard(page, currentUrl, "「复制链接」按钮复制激活链接");
  if (await waitForToast(page, "激活链接已复制")) pass("「复制链接」按钮展示复制成功提示");
  else fail("「复制链接」按钮展示复制成功提示", `toasts=${JSON.stringify(await toastTexts(page))}`);

  /* ---------------- 5) 复制失败时必须诚实报错（模拟非安全上下文） ---------------- */
  // 模拟 plain-http LAN：navigator.clipboard 不可用 + legacy execCommand 失败。
  // 旧实现会在这条路径上返回 true 并 toast 成功；修复后必须 toast 失败并选中输入框。
  const failPage = await context.newPage();
  await failPage.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => undefined,
    });
    document.execCommand = () => false;
  });
  try {
    await openAccountsTab(failPage);
    const failInput = await createPrecreatedAccount(failPage, failEmail);
    const failUrl = await failInput.inputValue();
    if (await waitForToast(failPage, "复制失败")) {
      pass("复制失败时展示失败提示（不谎报成功）");
    } else {
      fail("复制失败时展示失败提示（不谎报成功）", `toasts=${JSON.stringify(await toastTexts(failPage))}`);
    }
    const toastsAfterFailure = await toastTexts(failPage);
    if (toastsAfterFailure.some((text) => text.includes(SUCCESS_TOAST))) {
      fail("复制失败时不得 toast 成功", `toasts=${JSON.stringify(toastsAfterFailure)}`);
    } else {
      pass("复制失败时不得 toast 成功");
    }
    const selection = await failPage
      .waitForFunction(
        () => {
          const active = document.activeElement;
          if (!active || !active.matches?.(".settings-activation-link input")) return false;
          const field = /** @type {HTMLInputElement} */ (active);
          return field.selectionStart === 0 && field.selectionEnd === field.value.length;
        },
        undefined,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    if (selection) pass("复制失败后选中链接输入框（Ctrl+C 可手动复制）");
    else {
      const active = await failPage
        .evaluate(() => ({
          tag: document.activeElement?.tagName ?? null,
          cls: document.activeElement?.className ?? null,
        }))
        .catch(() => null);
      fail("复制失败后选中链接输入框（Ctrl+C 可手动复制）", `activeElement=${JSON.stringify(active)} url=${failUrl}`);
    }
  } finally {
    await failPage.close().catch(() => {});
  }
} catch (error) {
  fail("测试执行未中断", String(error?.stack ?? error).split("\n").slice(0, 4).join(" | "));
} finally {
  if (page) await cleanupAccounts(page).catch(() => {});
  await cleanupViaFetch();
  await browser.close().catch(() => {});
}

console.log("");
if (failures.length) {
  console.log(`RESULT FAIL (${PREFIX}: ${failures.length} failed assertion(s))`);
  process.exitCode = 1;
} else {
  console.log(`RESULT PASS (${PREFIX}: all assertions passed)`);
}
