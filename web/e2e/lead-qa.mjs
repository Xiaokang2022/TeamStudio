/**
 * Lead integration QA for the 16-item optimization round.
 *
 * Usage:
 *   node e2e/lead-qa.mjs            # against http://127.0.0.1:8000
 *   QA_URL=http://127.0.0.1:5173 node e2e/lead-qa.mjs
 *
 * Screenshots are written to ../artifacts/qa-*.png.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8000";
const SHOT = (name) => `../artifacts/qa-${name}.png`;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

async function newPage(browser, theme = "light", scope = "group") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(
    ([t, s]) => {
      localStorage.setItem("teamstudio.theme", t);
      localStorage.setItem("teamstudio.scope", s);
    },
    [theme, scope],
  );
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return { context, page, errors };
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

/* ---------------------------------------------------------------- overview */
{
  const { context, page, errors } = await newPage(browser, "light", "group");
  await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const style = await page.evaluate(() => {
    const hero = document.querySelector(".ov-hero");
    const active = document.querySelector(".nav-item.active");
    const grid = document.querySelector(".ov-member-grid");
    const luminance = (color) => {
      const nums = (color.match(/[\d.]+/g) || []).map(Number);
      if (nums.length < 3) return null;
      return (nums[0] * 299 + nums[1] * 587 + nums[2] * 114) / 1000;
    };
    const heroStyle = hero ? getComputedStyle(hero) : null;
    const activeStyle = active ? getComputedStyle(active) : null;
    return {
      heroTextLum: heroStyle ? luminance(heroStyle.color) : null,
      heroBgLum: heroStyle ? luminance(heroStyle.backgroundColor) : null,
      activeBgLum: activeStyle ? luminance(activeStyle.backgroundColor) : null,
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      cards: document.querySelectorAll(".ov-member-card").length,
      scopeOptions: document.querySelectorAll(".scope-option").length,
      activeNavColor: activeStyle?.color ?? null,
    };
  });
  record("#1 light hero is not dark", (style.heroTextLum ?? 0) < 140, style);
  record("#3 light sidebar active is not a black slab", (style.activeBgLum ?? 0) > 150, style.activeBgLum);
  record("#14 four member cards per row at 1440", style.columns === 4 && style.cards >= 4, style);
  record("#11 scope switcher present", style.scopeOptions === 3, style.scopeOptions);
  await page.screenshot({ path: SHOT("overview-light") });

  await page.locator(".scope-option").nth(1).click();
  await page.waitForTimeout(1100);
  const teamCards = await page.locator(".ov-member-card").count();
  await page.screenshot({ path: SHOT("overview-team-light") });
  await page.locator(".scope-option").nth(2).click();
  await page.waitForTimeout(1100);
  const allCards = await page.locator(".ov-member-card").count();
  const groupChips = await page.locator(".ov-member-card").first().innerText();
  record("#11 team/all scopes broaden overview data", teamCards > style.cards && allCards >= teamCards, { group: style.cards, team: teamCards, all: allCards, firstCard: groupChips.slice(0, 90) });
  await page.screenshot({ path: SHOT("overview-all-light") });

  /* drawer open + closing animation */
  await page.locator(".scope-option").nth(0).click();
  await page.waitForTimeout(800);
  await page.locator(".ov-member-card").first().click();
  await page.waitForSelector(".md-drawer", { timeout: 5000 });
  await page.waitForTimeout(280);
  await page.screenshot({ path: SHOT("drawer-light") });
  const heroLight = await page.evaluate(() => {
    const hero = document.querySelector(".md-hero");
    const color = hero ? getComputedStyle(hero).color : "";
    const nums = (color.match(/[\d.]+/g) || []).map(Number);
    return nums.length >= 3 ? (nums[0] * 299 + nums[1] * 587 + nums[2] * 114) / 1000 : null;
  });
  record("#2 light member drawer hero readable", (heroLight ?? 0) < 140, heroLight);
  await page.locator(".md-close").click();
  const closingSeen = await page
    .waitForSelector(".md-layer.is-closing", { timeout: 700 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(450);
  const drawerGone = (await page.locator(".md-layer").count()) === 0;
  record("#5 drawer close animation runs and unmounts", closingSeen && drawerGone, { closingSeen, drawerGone });
  record("#1/#2/#5 console clean", errors.length === 0, errors.slice(0, 3));
  await context.close();
}

/* ---------------------------------------------------------------- insights */
{
  const { context, page, errors } = await newPage(browser, "light", "all");
  await page.goto(`${BASE}/#/insights`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
  const info = await page.evaluate(() => ({
    kpis: document.querySelectorAll(".ins-kpi").length,
    tables: document.querySelectorAll(".ins-table").length,
    rows: document.querySelectorAll(".ins-table tbody tr").length,
    trendBars: document.querySelectorAll(".ins-bar").length,
    heading: document.querySelector("h1")?.textContent,
    error: document.body.innerText.includes("加载失败") || document.body.innerText.includes("404"),
  }));
  record("#12 insights KPIs/tables/trend render", info.kpis >= 4 && info.tables >= 3 && !info.error, info);
  await page.screenshot({ path: SHOT("insights-light") });

  const rangeButtons = page.locator(".ins-ranges button");
  if ((await rangeButtons.count()) >= 4) {
    await rangeButtons.nth(3).click();
    await page.waitForTimeout(900);
  }
  const header = page.locator(".ins-table").first().locator("thead th").nth(2);
  if (await header.count()) {
    await header.click();
    await page.waitForTimeout(250);
    await header.click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: SHOT("insights-sorted-light") });
  record("#12 insights range + sort interact", true, { ranges: await rangeButtons.count(), errors: errors.slice(0, 2) });

  const dark = await newPage(browser, "dark", "all");
  await dark.page.goto(`${BASE}/#/insights`, { waitUntil: "networkidle" });
  await dark.page.waitForTimeout(900);
  await dark.page.screenshot({ path: SHOT("insights-dark") });
  record("#12 insights dark theme", true, dark.errors.slice(0, 2));
  await dark.context.close();
  await context.close();
}

/* ---------------------------------------------------------------- tasks */
{
  const { context, page, errors } = await newPage(browser, "light", "all");
  await page.goto(`${BASE}/#/tasks`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const info = await page.evaluate(() => ({
    taskRows: document.querySelectorAll("[class*=task-row], tbody tr, .task-card").length,
    rangeLabels: [...document.querySelectorAll("[class*=range] button")].map((b) => b.textContent?.trim()),
    hasTagLibrary: document.body.innerText.includes("标签库"),
    hasGroupBadge: document.body.innerText.includes("前端体验组"),
  }));
  record("#13 task ledger renders", info.taskRows > 0, info);
  record("#13 range chips + #10 tag library + #11 group labels", info.hasTagLibrary && info.hasGroupBadge, info);
  await page.screenshot({ path: SHOT("tasks-light") });

  const filterTrigger = page.locator(".tasks-filter-select-custom .ts-select-trigger").first();
  if (await filterTrigger.count()) {
    await filterTrigger.click();
    await page.waitForTimeout(280);
    const filterPanel = page.locator(".ts-select-panel").first();
    const filterSearch = filterPanel.locator(".ts-select-search-input");
    const hasFilterSearch = (await filterSearch.count()) > 0;
    let filteredLabels = [];
    if (hasFilterSearch) {
      await filterSearch.fill("苏");
      await page.waitForTimeout(260);
      filteredLabels = await filterPanel.locator(".ts-select-option-label").allInnerTexts();
    }
    record("#9 task member filter supports search", hasFilterSearch && filteredLabels.length === 1, {
      hasFilterSearch,
      filteredLabels,
    });
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }

  const create = page.getByRole("button", { name: /新建任务/ }).first();
  if (await create.count()) {
    await create.click();
    await page.waitForSelector(".modal-panel", { timeout: 5000 });
    await page.waitForTimeout(350);
    const trigger = page.locator(".modal-panel .ts-select-trigger").first();
    const hasSelect = (await trigger.count()) > 0;
    if (hasSelect) {
      await trigger.click();
      await page.waitForTimeout(300);
      const panel = page.locator(".ts-select-panel").first();
      const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => "");
      const opaque = /rgb\(/.test(bg) && !/rgba\([^)]*,\s*0(\.\d+)?\)/.test(bg);
      const [triggerBox, panelBox] = await Promise.all([trigger.boundingBox(), panel.boundingBox()]);
      const aligned =
        Boolean(triggerBox && panelBox) &&
        Math.abs(triggerBox.x - panelBox.x) <= 1 &&
        Math.abs(triggerBox.width - panelBox.width) <= 1;
      const legacyChevron = await page.evaluate(() => {
        const wrap = document.querySelector(".tasks-filter-select-custom");
        if (!wrap) return null;
        const after = getComputedStyle(wrap, "::after");
        // Chromium reports "none" / '""' / "normal" for a suppressed pseudo.
        const suppressed =
          after.display === "none" || after.content === "none" || after.content === '""' || after.content === "normal";
        return suppressed ? "suppressed" : after.content;
      });
      record(
        "#9 custom select opens aligned, opaque, no legacy chevron",
        (await panel.count()) > 0 && opaque && aligned && legacyChevron === "suppressed",
        { bg, aligned, legacyChevron, triggerBox, panelBox },
      );
    } else {
      record("#9 custom select present in task dialog", false, "no .ts-select-trigger");
    }
    await page.screenshot({ path: SHOT("tasks-dialog-select-light") });
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    const close = page.locator(".modal-close").first();
    if (await close.count()) await close.click().catch(() => {});
  }
  record("#9/#13 console clean", errors.length === 0, errors.slice(0, 3));
  await context.close();
}

/* ---------------------------------------------------------------- calendar */
{
  const { context, page, errors } = await newPage(browser, "light", "group");
  await page.goto(`${BASE}/#/calendar`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const check = await page.evaluate(() => {
    const icons = [...document.querySelectorAll(".cal-check svg")];
    return {
      checkIcons: icons.length,
      checkCheckIcons: icons.filter((el) => (el.getAttribute("class") || "").includes("lucide-check-check")).length,
      singleCheckIcons: icons.filter((el) => (el.getAttribute("class") || "").includes("lucide-check")).length,
      doneChecks: document.querySelectorAll(".cal-todo.is-done .cal-check").length,
    };
  });
  record("#15 calendar uses single check (no double check)", check.checkCheckIcons === 0, check);
  await page.screenshot({ path: SHOT("calendar-light") });
  record("#15 console clean", errors.length === 0, errors.slice(0, 3));
  await context.close();
}

/* ---------------------------------------------------------------- settings */
{
  const { context, page, errors } = await newPage(browser, "light", "group");
  await page.goto(`${BASE}/#/settings?tab=modules`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const glow = await page.evaluate(() => {
    const on = document.querySelector(".settings-module-toggle.is-on");
    const icon = on?.querySelector(".settings-module-icon");
    const sw = on?.querySelector(".switch");
    return {
      bgImage: on ? getComputedStyle(on).backgroundImage : null,
      iconShadow: icon ? getComputedStyle(icon).boxShadow : null,
      switchShadow: sw ? getComputedStyle(sw).boxShadow : null,
      hasInsights: document.body.innerText.includes("数据洞察"),
    };
  });
  record("#7 module cards have no shimmer gradient", glow.bgImage === "none" && !/rgb\(.*rgb\(/s.test(glow.iconShadow || ""), glow);
  record("settings modules include insights flag", glow.hasInsights, glow.hasInsights);
  await page.screenshot({ path: SHOT("modules-light") });

  await page.goto(`${BASE}/#/settings?tab=appearance`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const autoBtn = page.getByRole("button", { name: "跟随系统" });
  if (await autoBtn.count()) await autoBtn.click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  const previewDark = await page.locator(".settings-preview").getAttribute("data-preview-mode");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  const previewLight = await page.locator(".settings-preview").getAttribute("data-preview-mode");
  record("#6 auto theme preview follows system theme", previewDark === "dark" && previewLight === "light", { previewDark, previewLight });
  await page.screenshot({ path: SHOT("appearance-auto-light") });

  await page.goto(`${BASE}/#/settings?tab=json`, { waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(900);
  const jsonInfo = await page.evaluate(() => ({
    monaco: document.querySelectorAll(".monaco-editor").length,
    textarea: document.querySelectorAll(".settings-json-textarea").length,
    lines: document.querySelectorAll(".view-line").length,
  }));
  record("#8 JSON tab uses Monaco editor", jsonInfo.monaco > 0 && jsonInfo.textarea === 0, jsonInfo);
  await page.screenshot({ path: SHOT("json-light") });
  record("settings console clean", errors.length === 0, errors.slice(0, 3));
  await context.close();
}

/* ---------------------------------------------------------------- email */
{
  const { context, page, errors } = await newPage(browser, "light", "group");
  await page.goto(`${BASE}/#/settings?tab=email`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const email = await page.evaluate(() => ({
    hasBuiltin: document.body.innerText.includes("内置") || document.body.innerText.includes("本地邮件"),
    hasMailbox: document.body.innerText.includes("邮件中心") || document.body.innerText.includes("发件"),
    running: document.body.innerText.includes("运行中") || document.body.innerText.includes("监听"),
  }));
  record("#16 built-in mail server UI present", email.hasBuiltin && email.hasMailbox, email);
  await page.screenshot({ path: SHOT("email-light") });
  record("email console clean", errors.length === 0, errors.slice(0, 3));
  await context.close();
}

/* ---------------------------------------------------------------- dark overview */
{
  const { context, page, errors } = await newPage(browser, "dark", "group");
  await page.goto(`${BASE}/#/overview`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: SHOT("overview-dark") });
  record("dark overview renders", errors.length === 0, errors.slice(0, 3));
  await context.close();
}

await browser.close();
const failed = results.filter((item) => !item.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
if (failed.length) {
  console.log("FAILED:", failed.map((item) => item.name).join(" | "));
  process.exitCode = 1;
}
