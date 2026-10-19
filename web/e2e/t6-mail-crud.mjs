import { chromium } from "playwright";

/** T6 本地邮件中心 CRUD：刷新 / 删除 / 详情打开关闭。 */

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

const mailboxCard = () =>
  page
    .locator(".email-card")
    .filter({ has: page.locator(".settings-card-heading h2", { hasText: "本地邮件中心" }) })
    .first();

async function main() {
  await page.goto(`${BASE}/#/settings?tab=email`, { waitUntil: "networkidle" });
  await page.waitForSelector(".email-panel", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const card = mailboxCard();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const countRows = () => page.locator(".email-mailbox-table tbody tr").count();
  const firstSubject = () =>
    page
      .locator(".email-mailbox-table tbody tr .email-log-subject")
      .first()
      .innerText()
      .catch(() => null);

  results.before = { rows: await countRows(), firstSubject: await firstSubject() };

  // 刷新
  await card.getByRole("button", { name: "刷新邮件" }).click();
  await page.waitForTimeout(1200);
  results.afterRefresh = { rows: await countRows(), firstSubject: await firstSubject() };

  // 删除第一封
  const deleteButtons = page.locator(".email-mailbox-actions .icon-button.is-danger");
  const deleteCount = await deleteButtons.count();
  results.deleteButtonCount = deleteCount;
  await deleteButtons.first().click();
  await page.waitForTimeout(1500);
  results.deleteToast = await page
    .locator(".toast-message")
    .last()
    .innerText()
    .catch(() => null);
  results.afterDelete = { rows: await countRows(), firstSubject: await firstSubject() };
  await page.screenshot({ path: out("t6-email-mailbox-after-delete.png") });

  // 详情弹窗打开 & 关闭
  const detailRows = page.locator(".email-mailbox-table tbody tr");
  if ((await detailRows.count()) > 0) {
    await detailRows.first().click();
    await page.waitForTimeout(900);
    results.detailOpened = await page.locator(".modal-panel .email-message").isVisible().catch(() => false);
    await page.locator(".modal-panel").last().locator(".modal-footer .btn-primary").click();
    await page.waitForTimeout(500);
  }
  results.detailClosed = (await page.locator(".modal-panel").count()) === 0;

  // 刷新后行数恢复（内存状态与服务端一致）
  await card.getByRole("button", { name: "刷新邮件" }).click();
  await page.waitForTimeout(1000);
  results.afterFinalRefresh = { rows: await countRows() };
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await card.screenshot({ path: out("t6-email-mailbox-final.png") });
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
