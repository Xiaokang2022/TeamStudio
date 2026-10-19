import { chromium } from "playwright";

/** T6 收尾：实测「重启内置服务」「刷新状态」「刷新邮件」按钮。 */

const BASE = "http://127.0.0.1:5173";
const out = (name) => `../artifacts/${name}`;
const results = {};
const consoleIssues = [];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") consoleIssues.push(msg.text().slice(0, 400));
});
page.on("pageerror", (err) => consoleIssues.push(`pageerror: ${err.message}`.slice(0, 400)));

const card = (title) =>
  page
    .locator(".email-card")
    .filter({ has: page.locator(".settings-card-heading h2", { hasText: title }) })
    .first();

async function main() {
  await page.goto(`${BASE}/#/settings?tab=email`, { waitUntil: "networkidle" });
  await page.waitForSelector(".email-panel", { timeout: 20000 });
  await page.waitForTimeout(1200);

  const delivery = card("投递方式");
  await delivery.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  results.before = await delivery.locator(".email-builtin-status").innerText();

  // 重启内置服务
  await delivery.getByRole("button", { name: "重启内置服务" }).click();
  await page.waitForTimeout(3000);
  results.restartToast = await page
    .locator(".toast-message")
    .last()
    .innerText()
    .catch(() => null);
  results.afterRestart = await delivery.locator(".email-builtin-status").innerText();
  results.runDotOn = await delivery.locator(".email-run-dot.is-on").isVisible();
  await page.screenshot({ path: out("t6-email-restart-toast.png") });
  await delivery.screenshot({ path: out("t6-email-delivery-after-restart.png") });

  // 刷新状态
  const mailbox = card("本地邮件中心");
  const rowsBefore = await page.locator(".email-mailbox-table tbody tr").count();
  await page.getByRole("button", { name: "刷新状态" }).first().click();
  await page.waitForTimeout(1500);
  results.afterStatusRefresh = {
    rowsBefore,
    rowsAfter: await page.locator(".email-mailbox-table tbody tr").count(),
    overviewBadges: await page
      .locator(".email-card")
      .filter({ has: page.locator(".settings-card-heading h2", { hasText: "邮件提醒概览" }) })
      .locator(".email-head-actions .badge")
      .allInnerTexts()
      .catch(() => []),
  };

  // 刷新邮件
  await mailbox.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await mailbox.getByRole("button", { name: "刷新邮件" }).click();
  await page.waitForTimeout(1200);
  results.afterMailRefresh = { rows: await page.locator(".email-mailbox-table tbody tr").count() };
  await mailbox.screenshot({ path: out("t6-email-mailbox-after-refresh.png") });
}

try {
  await main();
} catch (error) {
  results.fatal = String(error?.stack ?? error).slice(0, 1200);
} finally {
  results.consoleIssues = consoleIssues;
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
