/**
 * T3 verification: self-drawn Select (dropdown inside modals), calendar check
 * icon, and aggregate-scope badges on calendar/matrix/links/announcements.
 * Screenshots land in artifacts/.
 *
 * Run from web/: node e2e/t3-select-calendar.mjs
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const results = [];
const consoleErrors = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

async function goto(hash) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
}

async function setTheme(theme) {
  await page.evaluate((value) => localStorage.setItem("teamstudio.theme", value), theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
}

async function setScope(scopeValue) {
  await page.evaluate((value) => localStorage.setItem("teamstudio.scope", value), scopeValue);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
}

async function panelInfo() {
  return page.evaluate(() => {
    const panel = document.querySelector(".ts-select-panel");
    if (!panel) return null;
    const style = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    const expanded = Array.from(document.querySelectorAll('[aria-expanded="true"]'));
    const idref = expanded[0]?.getAttribute("aria-activedescendant") ?? null;
    return {
      position: style.position,
      background: style.backgroundColor,
      backdrop: style.backdropFilter,
      zIndex: style.zIndex,
      opacity: style.opacity,
      rect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
      },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      listbox: Boolean(document.querySelector('.ts-select-panel [role="listbox"]')),
      activedescendant: idref,
      activedescendantExists: idref ? Boolean(document.getElementById(idref)) : null,
    };
  });
}

async function openDayWithTodos() {
  const day = page.locator(".cal-cell", { has: page.locator(".cal-day-count") }).first();
  await day.click();
  await page.waitForTimeout(400);
}

/* ------------------------------------------------------------------ */
/* 1. Calendar: single-check completion icon                           */
/* ------------------------------------------------------------------ */
await goto("#/calendar");
await setTheme("light");
await openDayWithTodos();
await page.screenshot({ path: "../artifacts/t3-calendar-light.png" });

check("calendar has todo rows", (await page.locator(".cal-todo").count()) > 0, `rows=${await page.locator(".cal-todo").count()}`);

// Normalise the first todo to "not done", then mark it done for the shot.
const firstRow = page.locator(".cal-todo").first();
if ((await firstRow.locator(".cal-check").getAttribute("aria-pressed")) === "true") {
  await firstRow.locator(".cal-check").click();
  await page.waitForTimeout(400);
}
const toggleRow = page.locator(".cal-todo").first();
const toggleCheck = toggleRow.locator(".cal-check");
const checkBox = await toggleCheck.boundingBox();
const iconBox = await toggleCheck.locator("svg").boundingBox();
if (checkBox && iconBox) {
  const dx = Math.abs(checkBox.x + checkBox.width / 2 - (iconBox.x + iconBox.width / 2));
  const dy = Math.abs(checkBox.y + checkBox.height / 2 - (iconBox.y + iconBox.height / 2));
  check("calendar check glyph centred", dx <= 1.5 && dy <= 1.5, `dx=${dx.toFixed(2)} dy=${dy.toFixed(2)}`);
} else {
  check("calendar check glyph centred", false, "missing bounding box");
}

await toggleCheck.click();
await page
  .waitForFunction(() => document.querySelectorAll(".cal-todo.is-done").length > 0, undefined, { timeout: 6000 })
  .catch(() => {});
const doneRow = page.locator(".cal-todo.is-done").first();
const doneIconHtml = await doneRow.locator(".cal-check svg").evaluate((svg) => svg.outerHTML).catch(() => "");
check(
  "calendar completion uses a single Check glyph",
  /lucide-check"/.test(doneIconHtml) && !/check-check|checkcheck/i.test(doneIconHtml),
  doneIconHtml.slice(0, 90),
);
await page.locator(".cal-side").screenshot({ path: "../artifacts/t3-calendar-done-light.png" });
await page.screenshot({ path: "../artifacts/t3-calendar-done-page-light.png" });
await page.locator(".cal-todo.is-done").first().locator(".cal-check").click();
await page.waitForTimeout(500);

// Dark theme: mark done again for the dark shot, then restore.
await setTheme("dark");
await openDayWithTodos();
const darkRow = page.locator(".cal-todo").first();
if ((await darkRow.locator(".cal-check").getAttribute("aria-pressed")) !== "true") {
  await darkRow.locator(".cal-check").click();
}
await page.waitForTimeout(500);
await page.locator(".cal-side").screenshot({ path: "../artifacts/t3-calendar-done-dark.png" });
await page.locator(".cal-todo.is-done").first().locator(".cal-check").click();
await page.waitForTimeout(300);

/* ------------------------------------------------------------------ */
/* 2. TodoDialog assignee Select inside a Modal                        */
/* ------------------------------------------------------------------ */
await setTheme("light");
await goto("#/calendar");
await page.locator(".cal-page .page-actions").getByRole("button", { name: /新建待办/ }).first().click();
await page.waitForTimeout(500);
check("todo dialog opened", await page.locator(".modal-panel").isVisible());

const assignee = page.getByRole("combobox", { name: "负责人" }).first();
await assignee.click();
await page.waitForTimeout(350);
await page.screenshot({ path: "../artifacts/t3-tododialog-select-light.png" });
await page.locator(".ts-select-panel").screenshot({ path: "../artifacts/t3-select-panel-light.png" });

let info = await panelInfo();
check("select panel is position:fixed", info?.position === "fixed", info?.position ?? "missing");
check(
  "select panel uses opaque surface",
  Boolean(info && /^rgb\(/.test(info.background) && info.opacity === "1" && info.backdrop === "none"),
  `${info?.background} backdrop=${info?.backdrop}`,
);
check("select panel has role=listbox", Boolean(info?.listbox));
check("select panel has aria-activedescendant", Boolean(info?.activedescendant), info?.activedescendant ?? "none");
check("activedescendant target exists", info?.activedescendantExists === true);
check(
  "select panel stays inside viewport (not clipped)",
  Boolean(
    info &&
      info.rect.top >= 0 &&
      info.rect.left >= 0 &&
      info.rect.bottom <= info.viewport.h &&
      info.rect.left + info.rect.width <= info.viewport.w,
  ),
  JSON.stringify(info?.rect),
);
check("select panel sits above modal backdrop", Number(info?.zIndex) > 200, `z-index=${info?.zIndex}`);

// Escape should close only the dropdown, not the dialog.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Escape closes dropdown", (await page.locator(".ts-select-panel").count()) === 0);
check("Escape keeps modal open", await page.locator(".modal-panel").isVisible());

// Keyboard: ArrowDown + Enter selects a member.
await assignee.click();
await page.waitForTimeout(250);
const beforeLabel = await assignee.innerText();
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(150);
const activeText = await page.locator(".ts-select-option.is-active .ts-select-option-label").first().innerText();
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
const afterLabel = await assignee.innerText();
check(
  "ArrowDown/Enter selects option",
  afterLabel.trim() === activeText.trim() && afterLabel !== beforeLabel,
  `${beforeLabel.trim()} -> ${afterLabel.trim()}`,
);
await page.locator(".modal-footer .btn-ghost").first().click();
await page.waitForTimeout(300);

/* ------------------------------------------------------------------ */
/* 3. Matrix: toolbar filter Select (searchable) + dialog Selects      */
/* ------------------------------------------------------------------ */
await goto("#/matrix");
await page.waitForTimeout(900);
const filter = page.getByRole("combobox", { name: "按成员筛选责任田" }).first();
await filter.click();
await page.waitForTimeout(350);
await page.locator(".ts-select-panel").screenshot({ path: "../artifacts/t3-matrix-filter-panel.png" });
await page.screenshot({ path: "../artifacts/t3-matrix-filter-light.png" });

info = await panelInfo();
check(
  "matrix filter panel not clipped",
  Boolean(info && info.rect.top >= 0 && info.rect.bottom <= info.viewport.h),
  JSON.stringify(info?.rect),
);
const search = page.locator(".ts-select-search-input");
check("searchable panel shows search input", await search.isVisible());
await search.fill("林");
await page.waitForTimeout(400);
const optionCount = await page.locator(".ts-select-option").count();
check("search input filters options", optionCount >= 1, `options=${optionCount}`);
await page.screenshot({ path: "../artifacts/t3-matrix-filter-search.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("filter dropdown closed", (await page.locator(".ts-select-panel").count()) === 0);

// Open the edit dialog and its owner Select.
await page.locator('button[aria-label^="编辑"]').first().click();
await page.waitForTimeout(450);
const owner = page.getByRole("combobox", { name: "负责人" }).first();
await owner.click();
await page.waitForTimeout(400);
await page.screenshot({ path: "../artifacts/t3-matrix-dialog-select-light.png" });
info = await panelInfo();
check(
  "matrix dialog select panel not clipped",
  Boolean(info && info.rect.top >= 0 && info.rect.bottom <= info.viewport.h),
  JSON.stringify(info?.rect),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.locator(".modal-footer .btn-ghost").first().click();
await page.waitForTimeout(300);

/* ------------------------------------------------------------------ */
/* 4. RedBlack: member Select inside the editor modal                  */
/* ------------------------------------------------------------------ */
await goto("#/redblack");
await page.waitForTimeout(800);
await page.getByRole("button", { name: /编辑榜单|创建本月榜单/ }).first().click();
await page.waitForTimeout(600);
await page.getByRole("combobox", { name: "选择成员" }).first().click();
await page.waitForTimeout(400);
await page.locator(".ts-select-panel").screenshot({ path: "../artifacts/t3-redblack-member-panel.png" });
await page.screenshot({ path: "../artifacts/t3-redblack-select-light.png" });
info = await panelInfo();
check(
  "redblack dialog select panel not clipped",
  Boolean(info && info.rect.top >= 0 && info.rect.bottom <= info.viewport.h),
  JSON.stringify(info?.rect),
);
check("redblack select panel opaque", Boolean(info && /^rgb\(/.test(info.background) && info.opacity === "1"), info?.background);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.locator(".modal-close").first().click();
await page.waitForTimeout(300);

// Dark theme dropdown.
await setTheme("dark");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /编辑榜单|创建本月榜单/ }).first().click();
await page.waitForTimeout(600);
await page.getByRole("combobox", { name: "选择成员" }).first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: "../artifacts/t3-redblack-select-dark.png" });
info = await panelInfo();
check("dark theme select panel opaque", Boolean(info && /^rgb\(/.test(info.background) && info.opacity === "1"), info?.background);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.locator(".modal-close").first().click();
await page.waitForTimeout(200);

/* ------------------------------------------------------------------ */
/* 5. Aggregate scope: group badges + create hint                      */
/* ------------------------------------------------------------------ */
await setTheme("light");
await setScope("all");

await goto("#/calendar");
await openDayWithTodos();
await page.waitForTimeout(600);
const calBadges = await page.locator(".cal-group-badge").count();
const chipGroupNames = await page.locator(".cal-chip-group").count();
check("calendar aggregate shows group badges", calBadges + chipGroupNames > 0, `sideBadges=${calBadges} chipNames=${chipGroupNames}`);
await page.screenshot({ path: "../artifacts/t3-calendar-aggregate-light.png" });

await page.locator(".cal-page .page-actions").getByRole("button", { name: /新建待办/ }).first().click();
await page.waitForTimeout(500);
const hint = page.locator(".td-target-hint");
check("todo dialog shows create-target hint", await hint.isVisible(), await hint.innerText().catch(() => ""));
await page.screenshot({ path: "../artifacts/t3-tododialog-create-target.png" });
await page.locator(".modal-footer .btn-ghost").first().click();
await page.waitForTimeout(300);

await goto("#/matrix");
await page.waitForTimeout(900);
const mxBadges = await page.locator(".mx-group-badge").count();
check("matrix aggregate shows group badges", mxBadges > 0, `badges=${mxBadges}`);
await page.screenshot({ path: "../artifacts/t3-matrix-aggregate-light.png" });

await goto("#/links");
await page.waitForTimeout(900);
const linkBadges = await page.locator(".links-group-badge").count();
const linkCards = await page.locator(".links-card").count();
check("links aggregate shows group badges", linkBadges > 0 && linkBadges === linkCards, `badges=${linkBadges} cards=${linkCards}`);
await page.screenshot({ path: "../artifacts/t3-links-aggregate-light.png" });

await goto("#/announcements");
await page.waitForTimeout(900);
const annBadges = await page.locator(".ann-group-badge").count();
const annCards = await page.locator(".ann-card").count();
check("announcements aggregate shows group badges", annBadges > 0 && annBadges === annCards, `badges=${annBadges} cards=${annCards}`);
await page.screenshot({ path: "../artifacts/t3-announcements-aggregate-light.png" });

// Aggregate + dark is the riskiest contrast combination.
await setTheme("dark");
await goto("#/links");
await page.waitForTimeout(900);
await page.screenshot({ path: "../artifacts/t3-links-aggregate-dark.png" });
await goto("#/announcements");
await page.waitForTimeout(900);
await page.screenshot({ path: "../artifacts/t3-announcements-aggregate-dark.png" });

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (consoleErrors.length) {
  console.log("console errors:", consoleErrors.slice(0, 8));
}
await browser.close();
process.exit(failed.length ? 1 : 0);
