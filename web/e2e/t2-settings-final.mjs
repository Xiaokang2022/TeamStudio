import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const out = (name) => `../artifacts/${name}`;
const results = {};
const consoleIssues = [];
const workerRequests = [];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  colorScheme: "light",
});
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") consoleIssues.push(msg.text().slice(0, 500));
});
page.on("pageerror", (err) => consoleIssues.push(`pageerror: ${err.message}`.slice(0, 500)));
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("worker")) workerRequests.push(url);
});

async function gotoSettings(tab) {
  await page.goto(`${BASE}/#/settings?tab=${tab}`, { waitUntil: "networkidle" });
  // 只有 hash 变化时浏览器不会重新加载文档，显式 reload 确保按当前 localStorage / 配置重新初始化主题
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".settings-page", { timeout: 20000 });
  await page.waitForTimeout(800);
}

const readPreview = () =>
  page.evaluate(() => {
    const el = document.querySelector(".settings-preview");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      previewMode: el.getAttribute("data-preview-mode"),
      badge: el.querySelector(".settings-preview-mode")?.textContent?.trim() ?? null,
      background: cs.backgroundColor,
      rootTheme: document.documentElement.dataset.theme,
    };
  });

const readEditorState = () =>
  page.evaluate(() => {
    const wrapper = document.querySelector(".code-editor .monaco-editor");
    const classes = wrapper?.className ?? "";
    const bg = document.querySelector(".monaco-editor .monaco-editor-background");
    return {
      monacoPresent: Boolean(wrapper),
      theme: classes.includes("vs-dark") ? "vs-dark" : classes.includes("vs") ? "vs" : classes,
      editorClasses: classes,
      editorBackground: bg ? getComputedStyle(bg).backgroundColor : null,
      lineNumbers: document.querySelectorAll(".monaco-editor .line-numbers").length,
      legacyTextareaGone: !document.querySelector(".settings-json-textarea"),
      legacyGutterGone: !document.querySelector(".settings-json-gutter"),
      syntaxPill: document.querySelector(".settings-json-live")?.textContent?.trim() ?? null,
      stats: [...document.querySelectorAll(".settings-json-stat")].map((el) => el.textContent?.trim()).slice(0, 3),
      squiggles: document.querySelectorAll(".monaco-editor .squiggly-error").length,
      headerSaveDisabled: document.querySelector(".settings-header-actions .btn-primary")?.disabled ?? null,
    };
  });

async function main() {
  /* ---------------- 1) appearance / #6 系统主题实时预览 ---------------- */
  await gotoSettings("appearance");
  await page.getByRole("button", { name: "跟随系统", exact: true }).click();
  await page.waitForTimeout(300);
  results.appearanceAutoLight = await readPreview();
  const previewEl = page.locator(".settings-preview");
  await previewEl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await previewEl.screenshot({ path: out("t2-preview-auto-light.png") });
  await page.screenshot({ path: out("t2-appearance-auto-light.png") });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  results.appearanceAutoDark = await readPreview();
  await previewEl.screenshot({ path: out("t2-preview-auto-dark.png") });
  await page.screenshot({ path: out("t2-appearance-auto-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(400);
  results.appearanceAutoBackToLight = await readPreview();

  // 本地手动主题覆盖（root=dark）时，预览仍只跟草稿 theme.mode
  await page.evaluate(() => localStorage.setItem("teamstudio.theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  results.appearanceManualOverride = await readPreview();
  await page.evaluate(() => localStorage.removeItem("teamstudio.theme"));

  /* ---------------- 2) modules / #7 微光 + insights ---------------- */
  await page.emulateMedia({ colorScheme: "light" });
  await gotoSettings("modules");
  results.modulesLight = await page.evaluate(() => {
    const toggles = [...document.querySelectorAll(".settings-module-toggle")];
    const on = toggles.find((el) => el.classList.contains("is-on"));
    const icon = on?.querySelector(".settings-module-icon");
    const track = on?.querySelector(".switch-track");
    const insights = toggles.find((el) => el.textContent?.includes("数据洞察"));
    const cs = on ? getComputedStyle(on) : null;
    return {
      rootTheme: document.documentElement.dataset.theme,
      isOnBackgroundColor: cs?.backgroundColor ?? null,
      isOnBackgroundImage: cs?.backgroundImage ?? null,
      isOnBorderColor: cs?.borderColor ?? null,
      leftAccentBar: on ? getComputedStyle(on, "::before").backgroundColor : null,
      iconBackground: icon ? getComputedStyle(icon).backgroundColor : null,
      iconShadow: icon ? getComputedStyle(icon).boxShadow : null,
      switchShadow: track ? getComputedStyle(track).boxShadow : null,
      switchBackgroundImage: track ? getComputedStyle(track).backgroundImage : null,
      insightsPresent: Boolean(insights),
      insightsToggledOn: insights ? insights.classList.contains("is-on") : null,
      moduleLabels: toggles.map((el) => el.querySelector("strong")?.textContent?.trim()),
    };
  });
  const moduleCard = page.locator(".settings-card").filter({ hasText: "模块展示" }).first();
  await moduleCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await moduleCard.screenshot({ path: out("t2-modules-card-light.png") });
  await page.screenshot({ path: out("t2-modules-light.png") });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => localStorage.setItem("teamstudio.theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  results.modulesDark = await page.evaluate(() => {
    const on = document.querySelector(".settings-module-toggle.is-on");
    const icon = on?.querySelector(".settings-module-icon");
    return {
      rootTheme: document.documentElement.dataset.theme,
      isOnBackgroundImage: on ? getComputedStyle(on).backgroundImage : null,
      isOnBackgroundColor: on ? getComputedStyle(on).backgroundColor : null,
      leftAccentBar: on ? getComputedStyle(on, "::before").backgroundColor : null,
      iconShadow: icon ? getComputedStyle(icon).boxShadow : null,
    };
  });
  await moduleCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await moduleCard.screenshot({ path: out("t2-modules-card-dark.png") });
  await page.screenshot({ path: out("t2-modules-dark.png") });

  // 模块开关交互：关掉再打开 insights（纯草稿，不保存）
  const insightsRow = page.locator(".settings-module-toggle").filter({ hasText: "数据洞察" });
  const insightsInput = insightsRow.locator('input[type="checkbox"]');
  const beforeToggle = await insightsInput.isChecked();
  await insightsRow.locator(".switch-track").click();
  await page.waitForTimeout(250);
  const afterOff = await insightsInput.isChecked();
  await insightsRow.locator(".switch-track").click();
  await page.waitForTimeout(250);
  results.insightsToggle = { beforeToggle, afterOff, restored: await insightsInput.isChecked() };

  /* ---------------- 3) JSON / #8 编辑器 ---------------- */
  await page.evaluate(() => localStorage.removeItem("teamstudio.theme"));
  await page.emulateMedia({ colorScheme: "light" });
  await gotoSettings("json");
  await page.waitForSelector(".monaco-editor", { timeout: 30000 });
  await page.waitForSelector(".monaco-editor .line-numbers", { timeout: 20000 });
  await page.waitForTimeout(1800);

  results.jsonLight = await readEditorState();
  await page.locator(".settings-json-editor").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("t2-json-light.png") });

  // 输入非法 JSON：monaco 标记 + 页面错误提示
  await page.locator(".code-editor .view-lines").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type('{"site": {"name": "T2" "tagline": } }');
  await page.waitForTimeout(900);
  results.jsonInvalid = await page.evaluate(() => ({
    squiggles: document.querySelectorAll(".monaco-editor .squiggly-error").length,
    syntaxPill: document.querySelector(".settings-json-live")?.textContent?.trim() ?? null,
    syntaxPillError: Boolean(document.querySelector(".settings-json-live.is-error")),
    pageErrorBlock: document.querySelector(".settings-json-result.is-error strong")?.textContent?.trim() ?? null,
    pageErrorText: document.querySelector(".settings-json-result-syntax")?.textContent?.trim() ?? null,
    dirtyBadge: Boolean(document.querySelector(".badge-orange")),
    headerSaveDisabled: document.querySelector(".settings-header-actions .btn-primary")?.disabled ?? null,
    stats: [...document.querySelectorAll(".settings-json-stat")].map((el) => el.textContent?.trim()).slice(0, 2),
  }));
  await page.locator(".settings-json-editor").screenshot({ path: out("t2-json-invalid-editor.png") });
  await page.screenshot({ path: out("t2-json-invalid.png") });

  // 格式化按钮（非法时给出错误 toast，并保持可用）
  await page.getByRole("button", { name: "格式化" }).first().click();
  await page.waitForTimeout(500);
  results.formatInvalidToast = await page
    .locator(".toast-message")
    .last()
    .innerText()
    .catch(() => null);

  // 恢复服务器版本：确认真实可用
  await page.getByRole("button", { name: "恢复服务器版本" }).click();
  await page.waitForTimeout(300);
  await page.locator(".modal-panel .modal-footer .btn-danger").click();
  await page.waitForTimeout(1200);
  results.jsonAfterReset = await page.evaluate(() => ({
    syntaxPill: document.querySelector(".settings-json-live")?.textContent?.trim() ?? null,
    squiggles: document.querySelectorAll(".monaco-editor .squiggly-error").length,
    dirtyBadge: Boolean(document.querySelector(".badge-orange")),
    headerSaveDisabled: document.querySelector(".settings-header-actions .btn-primary")?.disabled ?? null,
  }));
  await page.locator(".settings-json-editor").screenshot({ path: out("t2-json-reset-editor.png") });

  // 格式化按钮（合法时成功）
  await page.getByRole("button", { name: "格式化" }).first().click();
  await page.waitForTimeout(700);
  results.formatOkToast = await page
    .locator(".toast-message")
    .last()
    .innerText()
    .catch(() => null);

  // 校验配置按钮
  await page.getByRole("button", { name: "校验配置" }).first().click();
  await page.waitForTimeout(1500);
  results.validate = await page.evaluate(() => ({
    okBlockVisible: Boolean(document.querySelector(".settings-json-result.is-ok")),
    okText: document.querySelector(".settings-json-result.is-ok")?.textContent?.trim().slice(0, 60) ?? null,
    headerSaveDisabled: document.querySelector(".settings-header-actions .btn-primary")?.disabled ?? null,
  }));
  await page.screenshot({ path: out("t2-json-validated.png") });

  // 保存按钮：可用并点击一次（JSON 内容即服务器版本，仅验证链路）
  const saveBtn = page.getByRole("button", { name: "校验并保存" }).first();
  results.saveEnabled = await saveBtn.isEnabled();
  await saveBtn.click();
  await page.waitForTimeout(2500);
  results.saveToast = await page
    .locator(".toast-message")
    .last()
    .innerText()
    .catch(() => null);
  results.afterSave = await page.evaluate(() => ({
    dirtyBadge: Boolean(document.querySelector(".badge-orange")),
    syntaxPill: document.querySelector(".settings-json-live")?.textContent?.trim() ?? null,
  }));
  await page.screenshot({ path: out("t2-json-saved.png") });

  // 暗色 JSON
  await page.evaluate(() => localStorage.setItem("teamstudio.theme", "dark"));
  await page.goto(`${BASE}/#/settings?tab=json`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor .line-numbers", { timeout: 30000 });
  await page.waitForTimeout(1800);
  results.jsonDark = await readEditorState();
  await page.locator(".settings-json-editor").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.locator(".settings-json-editor").screenshot({ path: out("t2-json-dark-editor.png") });
  await page.screenshot({ path: out("t2-json-dark.png") });
}

try {
  await main();
} catch (error) {
  results.fatal = String(error?.stack ?? error).slice(0, 1200);
} finally {
  results.consoleIssues = consoleIssues;
  results.workerRequests = [...new Set(workerRequests)].slice(0, 8);
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
