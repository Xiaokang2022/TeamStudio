import { chromium } from "playwright";

/**
 * T6 内建邮件服务验收脚本：
 *  - 设置 → 邮件提醒：投递方式 segmented / 内置服务器状态与配置 / 本地邮件中心
 *  - 测试发送（内置模式离线）→ 本地邮件中心新增记录
 *  - 邮件详情弹窗（正文、from/to、kind）
 *  - 外部 SMTP 模式的 SMTP 配置折叠/显示（仅草稿，不保存）
 *  - 亮 / 暗主题截图
 */

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

const mailCard = (title) =>
  page
    .locator(".email-card")
    .filter({ has: page.locator(".settings-card-heading h2", { hasText: title }) })
    .first();

async function setTheme(theme) {
  if (!page.url().startsWith(BASE)) {
    await page.goto(`${BASE}/#/settings?tab=email`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
  }
  await page.evaluate((value) => {
    if (value) localStorage.setItem("teamstudio.theme", value);
    else localStorage.removeItem("teamstudio.theme");
  }, theme);
  await page.goto(`${BASE}/#/settings?tab=email`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".email-panel", { timeout: 20000 });
  await page.waitForTimeout(1200);
}

const readPanelState = () =>
  page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    const cardByTitle = (title) =>
      [...document.querySelectorAll(".email-card")].find(
        (card) => card.querySelector(".settings-card-heading h2")?.textContent?.trim() === title,
      );
    const overviewCard = cardByTitle("邮件提醒概览");
    const deliveryCard = cardByTitle("投递方式");
    const mailboxCard = cardByTitle("本地邮件中心");
    const rows = [...document.querySelectorAll(".email-mailbox-table tbody tr")];
    return {
      rootTheme: document.documentElement.dataset.theme,
      modeButtons: [...document.querySelectorAll(".email-mode-segmented button")].map((el) => ({
        text: el.textContent?.trim(),
        active: el.classList.contains("active"),
      })),
      badges: [...(overviewCard?.querySelectorAll(".email-head-actions .badge") ?? [])].map((el) =>
        el.textContent?.trim(),
      ),
      builtinStatus: deliveryCard?.querySelector(".email-builtin-status")?.textContent?.trim() ?? null,
      builtinRunning: Boolean(deliveryCard?.querySelector(".email-builtin-status.is-on")),
      runDotOn: Boolean(deliveryCard?.querySelector(".email-run-dot.is-on")),
      builtinFieldLabels: deliveryCard
        ? [...deliveryCard.querySelectorAll(".form-grid .field > label")].map((el) =>
            el.textContent?.trim(),
          )
        : [],
      smtpCardVisible: Boolean(cardByTitle("SMTP 发件配置")),
      mailboxRows: rows.map((row) => ({
        subject: row.querySelector(".email-log-subject")?.textContent?.trim(),
        recipients: row.querySelector(".email-mailbox-recipient")?.textContent?.trim(),
        kind: row.querySelector(".chip")?.textContent?.trim(),
        unread: row.classList.contains("is-unread"),
      })),
      mailboxCountBadge: mailboxCard?.querySelector(".email-head-actions .badge")?.textContent?.trim(),
      mailboxVisible: Boolean(mailboxCard),
      statLabels: [...document.querySelectorAll(".email-stat small")].map((el) => el.textContent?.trim()),
    };
  });

async function main() {
  /* ---------------- 1) 亮色：内置模式面板 ---------------- */
  await setTheme(null);
  results.light = await readPanelState();

  await page.screenshot({ path: out("t6-email-builtin-light.png") });
  const deliveryCard = mailCard("投递方式");
  await deliveryCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await deliveryCard.screenshot({ path: out("t6-email-delivery-light.png") });

  const mailboxCard = mailCard("本地邮件中心");
  await mailboxCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await mailboxCard.screenshot({ path: out("t6-email-mailbox-light.png") });

  /* ---------------- 2) 测试发送（离线）---------------- */
  const beforeRows = (await readPanelState()).mailboxRows.length;
  await page.getByRole("button", { name: "发送测试邮件" }).first().click();
  await page.waitForSelector(".modal-panel", { timeout: 10000 });
  await page.waitForTimeout(400);
  const testModal = page.locator(".modal-panel").last();
  results.testModal = {
    title: testModal.locator(".modal-header h2").innerText(),
    description: testModal.locator(".modal-header p").innerText().catch(() => null),
    recipient: await testModal.locator('input[type="email"]').inputValue(),
  };
  await testModal.locator(".modal-footer .btn-primary").click();
  await page.waitForTimeout(2500);
  results.testToast = await page
    .locator(".toast-message")
    .last()
    .innerText()
    .catch(() => null);
  await page.waitForTimeout(800);
  const afterSend = await readPanelState();
  results.afterSend = {
    beforeRows,
    afterRows: afterSend.mailboxRows.length,
    firstRow: afterSend.mailboxRows[0] ?? null,
    mailboxCountBadge: afterSend.mailboxCountBadge,
  };
  await page.screenshot({ path: out("t6-email-after-test-send.png") });
  await mailboxCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await mailboxCard.screenshot({ path: out("t6-email-mailbox-after-send.png") });

  /* ---------------- 3) 邮件详情弹窗 ---------------- */
  const firstRow = page.locator(".email-mailbox-table tbody tr").first();
  await firstRow.click();
  await page.waitForTimeout(1200);
  const detailModal = page.locator(".modal-panel").last();
  results.detail = {
    title: await detailModal.locator(".modal-header h2").innerText(),
    subject: await detailModal
      .locator(".email-message-subject strong")
      .innerText()
      .catch(() => null),
    meta: await detailModal
      .locator(".email-message-meta > div")
      .allInnerTexts()
      .catch(() => []),
    bodyHead: await detailModal
      .locator(".email-preview-body pre")
      .innerText()
      .then((text) => text.slice(0, 120))
      .catch(() => null),
  };
  await page.screenshot({ path: out("t6-email-detail-light.png") });
  await detailModal.screenshot({ path: out("t6-email-detail-modal-light.png") });
  await detailModal.locator(".modal-footer .btn-primary").click();
  await page.waitForTimeout(500);

  /* ---------------- 4) 外部 SMTP 模式（仅草稿，不保存）---------------- */
  const modeGroup = page.locator(".email-mode-segmented");
  await modeGroup.getByRole("button", { name: "外部 SMTP" }).click();
  await page.waitForTimeout(600);
  results.smtpMode = await readPanelState();
  await mailCard("投递方式").scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await page.screenshot({ path: out("t6-email-smtp-mode-light.png") });
  // 恢复内置模式（仍是草稿，不保存）
  await modeGroup.getByRole("button", { name: "内置邮件服务器" }).click();
  await page.waitForTimeout(600);

  /* ---------------- 5) 暗色主题 ---------------- */
  await setTheme("dark");
  results.dark = await readPanelState();
  await page.screenshot({ path: out("t6-email-builtin-dark.png") });
  const deliveryCardDark = mailCard("投递方式");
  await deliveryCardDark.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await deliveryCardDark.screenshot({ path: out("t6-email-delivery-dark.png") });
  const mailboxCardDark = mailCard("本地邮件中心");
  await mailboxCardDark.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await mailboxCardDark.screenshot({ path: out("t6-email-mailbox-dark.png") });

  // 暗色详情
  await page.locator(".email-mailbox-table tbody tr").first().click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: out("t6-email-detail-dark.png") });
  await page.locator(".modal-panel").last().locator(".modal-footer .btn-primary").click();
  await page.waitForTimeout(300);

  // 清理主题覆盖
  await page.evaluate(() => localStorage.removeItem("teamstudio.theme"));
}

try {
  await main();
} catch (error) {
  results.fatal = String(error?.stack ?? error).slice(0, 1500);
} finally {
  results.consoleIssues = consoleIssues;
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
