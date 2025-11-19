/**
 * approve.js — full file (40s forced wait after filling search)
 *
 * Usage:
 *   node approve.js requests.csv
 *
 * Requirements:
 *   - Node 18+
 *   - npm i playwright
 *   - npx playwright install msedge
 */

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { cfg } from "./config.js";
import {
  ensureDir,
  ts,
  readRequests,
  appendLog,
  sleep
} from "./utils.js";

const LOGS_DIR = path.resolve("logs");
const ERR_DIR = path.join(LOGS_DIR, "errors");
ensureDir(LOGS_DIR);
ensureDir(ERR_DIR);

function userDataDir() {
  return `C:\\Users\\${cfg.edgeProfileUser}\\AppData\\Local\\Microsoft\\Edge\\User Data`;
}

async function startBrowser() {
  const profile = userDataDir();
  try {
    if (fs.existsSync(profile)) {
      return await chromium.launchPersistentContext(profile, {
        headless: false,
        channel: "msedge",
        viewport: { width: 1400, height: 900 }
      });
    }
  } catch (e) {
    console.warn("Persistent context failed:", e.message);
  }
  const browser = await chromium.launch({ headless: false, channel: "msedge" });
  return await browser.newContext({ viewport: { width: 1400, height: 900 } });
}

async function gotoHome(page) {
  if (!cfg.urls.homeNoelle || cfg.urls.homeNoelle.includes("<your-noelle-url-here>")) {
    throw new Error("Please set cfg.urls.homeNoelle to your portal URL in config.js");
  }
  await page.goto(cfg.urls.homeNoelle, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}

async function safeScreenshot(page, nameSuffix = "") {
  try {
    const filename = path.join(ERR_DIR, `${ts().replace(/[: ]/g,"")}${nameSuffix}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log("Saved screenshot:", filename);
    return filename;
  } catch (e) {
    console.warn("screenshot failed:", e.message);
    return null;
  }
}

async function saveText(name, text) {
  try {
    const p = path.join(ERR_DIR, name);
    fs.writeFileSync(p, text);
    return p;
  } catch (e) {
    console.warn("saveText failed:", e.message);
    return null;
  }
}

async function clickIf(page, selector) {
  try {
    const loc = page.locator(selector);
    if (await loc.count()) {
      await loc.first().click({ force: true });
      return true;
    }
  } catch (e) {}
  return false;
}

/* -------------------------
   switchUser (robust)
-------------------------- */
async function switchUser(page, who) {
  console.log(`→ switchUser: choose "${who}"`);
  await clickIf(page, cfg.sel.switchLink);
  await sleep(300);
  await page.waitForSelector(`text=${cfg.sel.switchDialogTitle}`, { timeout: 6000 }).catch(()=>{});

  const openerCandidates = [
    'div[role="dialog"] >> text="Select..."',
    'div[role="dialog"] >> [role="combobox"]',
    'div[role="dialog"] >> .react-select__control',
    'div[role="dialog"] >> button[aria-haspopup="listbox"]',
    'div[role="dialog"] >> svg',
    'select'
  ];

  let opened = false;
  for (const s of openerCandidates) {
    try {
      const loc = page.locator(s);
      if (await loc.count()) {
        await loc.first().click({ force: true });
        opened = true;
        await sleep(220);
        break;
      }
    } catch (e) {}
  }

  if (!opened) {
    try {
      const dialog = page.locator('div[role="dialog"]').first();
      if (await dialog.count()) {
        const box = await dialog.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width - 60, box.y + 60, { force: true });
          opened = true;
          await sleep(250);
        }
      }
    } catch (e) {}
  }

  const opt = cfg.sel.switchOption ? cfg.sel.switchOption(who) : `text="${who}"`;
  const optionSelectors = [
    opt,
    `div[role="option"]:has-text("${who}")`,
    `text="${who}"`,
    `li:has-text("${who}")`
  ];

  for (const sel of optionSelectors) {
    try {
      const loc = page.locator(sel);
      if (await loc.count()) {
        await loc.first().click({ force: true });
        console.log("   clicked option via selector:", sel);
        await sleep(150);
        await clickIf(page, cfg.sel.switchConfirm);
        await page.waitForLoadState("networkidle").catch(()=>{});
        await sleep(600);
        return;
      }
    } catch (e) {}
  }

  const firstName = who.split(",")[0].trim();
  const partials = [`text=${firstName}`, `div[role="option"]:has-text("${firstName}")`];
  for (const sel of partials) {
    try {
      const loc = page.locator(sel);
      if (await loc.count()) {
        await loc.first().click({ force: true });
        await sleep(120);
        await clickIf(page, cfg.sel.switchConfirm);
        await page.waitForLoadState("networkidle").catch(()=>{});
        await sleep(600);
        return;
      }
    } catch (e) {}
  }

  const shot = await safeScreenshot(page, "-switch-failed");
  await saveText("switch-error.txt", `Could not select "${who}". Screenshot: ${shot}`);
  throw new Error(`switchUser: unable to programmatically select "${who}". Screenshot: ${shot}`);
}

/* -------------------------
   Wait for search control (react-select style or plain input)
-------------------------- */
async function waitForSearchControl(page, timeout = 20000) {
  const start = Date.now();

  const reactCandidates = [
    '.react-select__control',
    '.react-select__value-container',
    'div[class*="react-select"]',
    'div[role="combobox"]',
    'div[class*="Search-"]'
  ];

  const inputCandidates = [
    cfg.sel.searchInput,
    'input[placeholder*="Search by request ID"]',
    'input[type="search"]',
    'input[aria-label*="Search"]',
    'input'
  ];

  while (Date.now() - start < timeout) {
    for (const sel of inputCandidates) {
      try {
        if (!sel) continue;
        const loc = page.locator(sel).first();
        if (await loc.count() && await loc.isVisible().catch(()=>false)) {
          console.log("Found plain input using:", sel);
          return { type: 'input', selector: sel };
        }
      } catch (e) {}
    }

    for (const sel of reactCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() && await loc.isVisible().catch(()=>false)) {
          console.log("Found react-style control using:", sel);
          return { type: 'react', selector: sel };
        }
      } catch (e) {}
    }

    await sleep(300);
  }

  throw new Error("waitForSearchControl: timed out waiting for search control");
}

/* -------------------------
   Fill handler for control
-------------------------- */
async function fillSearchControl(page, control, text) {
  if (control.type === 'input') {
    await page.fill(control.selector, text);
    await sleep(300);
  } else {
    const loc = page.locator(control.selector).first();
    await loc.click({ force: true });
    await sleep(150);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await sleep(100);
    await page.keyboard.type(text, { delay: 50 });
    await sleep(200);
  }
}

async function clearSearchGeneric(page, control) {
  if (control.type === 'input') {
    try { await page.fill(control.selector, ""); } catch {}
  } else {
    try {
      await page.locator(control.selector).first().click({ force: true });
      await sleep(80);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await sleep(80);
    } catch (e) {}
  }
}

/* -------------------------
   SELECT BY SEARCH (with forced 40s wait)
   -> replaced per your request to wait 40 seconds AFTER typing the ID
-------------------------- */
async function selectBySearch(page, control, id) {
  // clear previous text then type the id into the control
  await clearSearchGeneric(page, control);
  await fillSearchControl(page, control, id);

  // WAIT 40 seconds to allow the portal to perform its search and load results
  console.log(`Typed "${id}" — waiting 40s for results to appear...`);
  await sleep(40000);

  // after the forced wait, poll for the result row for a short while
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const rowCount = await page.locator(cfg.sel.rowById(id)).count().catch(()=>0);
    if (rowCount > 0) {
      try {
        // try to toggle the checkbox; if that fails, click the row then checkbox
        await page.check(cfg.sel.rowCheckbox(id)).catch(async () => {
          const row = page.locator(cfg.sel.rowById(id)).first();
          await row.click({ position: { x: 20, y: 12 } }).catch(()=>{});
          try { await page.check(cfg.sel.rowCheckbox(id)); } catch {}
        });
      } catch (e) {
        // ignore and continue — we still consider the row found
      }
      return true;
    }
  }
  // no result after polling
  return false;
}

async function bulkApprove(page) {
  await page.click(cfg.sel.bulkApproveBtn);
  await sleep(300);
  await clickIf(page, cfg.sel.approveConfirmBtn);
  await sleep(900);
}

async function batchApproveInUser(page, control, ids, batchSize = cfg.batchSize) {
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    let selected = 0;
    for (const id of [...remaining]) {
      const ok = await selectBySearch(page, control, id);
      if (ok) { remaining.delete(id); selected++; }
      if (selected >= batchSize) break;
    }
    if (selected === 0) break;
    await bulkApprove(page);
    await clearSearchGeneric(page, control);
    await sleep(300);
  }
  return [...remaining];
}

/* -------------------------
   ensureSwitchedTo wrapper
-------------------------- */
async function ensureSwitchedTo(page, who) {
  await switchUser(page, who);

  try {
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(()=>{});
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForLoadState('networkidle').catch(()=>{});
  } catch (e) {
    console.warn("ensureSwitchedTo: reload step failed:", e.message);
  }

  const control = await waitForSearchControl(page, 20000).catch(async (e) => {
    const shot = await safeScreenshot(page, "-no-search-found");
    await saveText("no-search-found.txt", `Switched to ${who} but search control not found. Screenshot: ${shot}\n`);
    throw e;
  });

  try { await page.locator(control.selector).first().focus().catch(()=>{}); await sleep(150); } catch (e) {}

  return control;
}

/* -------------------------
   MAIN
-------------------------- */
async function main() {
  const input = process.argv[2] || "requests.csv";
  if (!fs.existsSync(input)) { console.error("requests.csv missing"); return; }
  const ids = readRequests(input);
  const outPath = path.join(LOGS_DIR, `run-${ts().replace(/[: ]/g,"")}.csv`);
  appendLog(outPath, "time,request_id,result,notes\n");

  const context = await startBrowser();
  const page = await context.newPage();

  try {
    await gotoHome(page);

    const body = await page.textContent("body").catch(()=>"");
    if (!body.includes(cfg.users.noelle.split(",")[0])) {
      console.log("Switching to Noelle initially...");
      await ensureSwitchedTo(page, cfg.users.noelle);
    }

    // detect control
    let control = await waitForSearchControl(page, 15000);
    console.log("Search control:", control);

    console.log("→ Approving in Noelle...");
    const notFoundNoelle = await batchApproveInUser(page, control, ids);
    const approvedNoelle = ids.filter(x => !notFoundNoelle.includes(x));
    for (const x of approvedNoelle) appendLog(outPath, `${ts()},${x},approved_in_noelle,\n`);

    if (notFoundNoelle.length === 0) {
      console.log("Done. Log:", outPath);
      await context.close();
      return;
    }

    console.log("→ Switching to Alvaro...");
    await ensureSwitchedTo(page, cfg.users.alvaro);
    control = await waitForSearchControl(page, 15000);
    const notFoundAlvaro = await batchApproveInUser(page, control, notFoundNoelle);
    const approvedAlvaro = notFoundNoelle.filter(x => !notFoundAlvaro.includes(x));
    for (const x of approvedAlvaro) appendLog(outPath, `${ts()},${x},approved_in_alvaro,\n`);

    if (approvedAlvaro.length > 0) {
      console.log("→ Returning to Noelle for final approvals...");
      await ensureSwitchedTo(page, cfg.users.noelle);
      control = await waitForSearchControl(page, 15000);
      const retry = await batchApproveInUser(page, control, approvedAlvaro);
      for (const x of approvedAlvaro) {
        if (!retry.includes(x)) appendLog(outPath, `${ts()},${x},approved_after_alvaro_then_noelle,\n`);
        else appendLog(outPath, `${ts()},${x},approved_in_alvaro_only,\n`);
      }
    }

    for (const x of notFoundAlvaro) appendLog(outPath, `${ts()},${x},not_found_anywhere,\n`);

    console.log("✔ DONE → Log:", outPath);
    await context.close();
  } catch (err) {
    console.error("Fatal error:", err.message);
    const shot = await safeScreenshot(page, "-fatal");
    await saveText("fatal-error.txt", `${err.stack}\nScreenshot: ${shot}\n`);
    console.log("Browser left open for inspection (check logs/errors).");
  }
}

main().catch(e => console.error("unhandled:", e));
