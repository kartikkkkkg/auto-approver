/**
 * approve.js - robust version (search typing + label-click checkbox + 40s wait)
 *
 * Usage:
 *   node approve.js requests.csv
 *
 * Requirements:
 * - config.js exporting `cfg` (your existing file)
 * - utils.js exporting helper functions used previously (ensure names match)
 *
 * This file assumes ESM (import) like your previous snippet.
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
  sleep,
  safeScreenshot as utilSafeScreenshot,
  saveText
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

/* --------------------------
   SWITCH USER (unchanged robust version)
--------------------------- */
async function switchUser(page, who) {
  console.log(`→ switchUser: choose "${who}"`);

  await clickIf(page, cfg.sel.switchLink);
  await sleep(300);

  await page.waitForSelector('text=Switch View', { timeout: 6000 }).catch(()=>{});

  const openerCandidates = [
    'div[role="dialog"] >> text="Select..."',
    'div[role="dialog"] >> text=Select',
    'div[role="dialog"] >> .select__control',
    'div[role="dialog"] >> button[aria-haspopup="listbox"]',
    'div[role="dialog"] >> [role="combobox"]',
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

  await sleep(220);

  const optionSelectors = [
    `div[role="option"]:has-text("${who}")`,
    `div[role="listbox"] >> text="${who}"`,
    `div[role="dialog"] >> text="${who}"`,
    `text="${who}"`,
    `li:has-text("${who}")`,
    `div:has-text("${who}")`
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
  const partialCandidates = [
    `div[role="option"]:has-text("${firstName}")`,
    `div[role="dialog"] >> text=${firstName}`,
    `text=${firstName}`
  ];
  for (const sel of partialCandidates) {
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
  await saveText("switch-error.txt", `Could not select "${who}" in Switch dialog. Screenshot: ${shot}\n`);
  throw new Error(`switchUser: unable to programmatically select "${who}". Screenshot: ${shot}`);
}

/* -------------------------
   SEARCH helpers (new robust approach)
-------------------------- */

// Type into the visible search control (safe)
async function typeIntoSearch(page, text) {
  // Try a few container selectors for the visible search box (from your screenshots)
  const containerCandidates = [
    'div[id^="Search"]',
    'div.react-select__control',
    'div.css-1trtksz.react-select__value-container',
    'div[role="combobox"]',
    'div.search-container',
    'div[placeholder*="Search by request"]'
  ];

  let clicked = false;
  for (const c of containerCandidates) {
    try {
      const cont = page.locator(c);
      if (await cont.count() > 0) {
        await cont.first().click({ force: true });
        clicked = true;
        break;
      }
    } catch (e) { /* ignore */ }
  }

  if (!clicked) {
    try {
      await page.click('text=Search by request ID', { timeout: 2000 }).catch(()=>{});
      clicked = true;
    } catch (e) {}
  }

  // Clear any previous content, then type slowly
  try {
    await page.keyboard.down('Control');
    await page.keyboard.press('A').catch(()=>{});
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace').catch(()=>{});
  } catch (e) {}

  await page.keyboard.type(text, { delay: 50 });
}

// Given a visible id text in the page, find its result row and click label to toggle checkbox
async function findRowAndCheck(page, id) {
  const waitMs = 40000; // 40s as requested

  // Wait for the text to appear somewhere
  const txtLoc = page.locator(`text=${id}`).first();
  try {
    await txtLoc.waitFor({ timeout: waitMs });
  } catch (e) {
    return false;
  }

  // Find ancestor row container that includes the id link. We will try xpath and generic div:has-text.
  const rowCandidates = [
    `xpath=//div[.//a[contains(normalize-space(.),"${id}")]]`,
    `xpath=//div[.//*[contains(normalize-space(text()),"${id}")]]`,
    `div:has-text("${id}")`
  ];

  let row = null;
  for (const r of rowCandidates) {
    const cand = page.locator(r).first();
    if (await cand.count()) { row = cand; break; }
  }
  if (!row) return false;

  // inside the row, find the checkbox input
  const checkbox = row.locator('input[type="checkbox"]');
  if (await checkbox.count() === 0) {
    // fallback: click a clickable area in the row (left area)
    try {
      await row.click({ position: { x: 10, y: 10 }, force: true });
      await page.waitForTimeout(200);
      return true;
    } catch (e) {
      return false;
    }
  }

  // prefer to click the label associated with the input id
  const cbId = (await checkbox.first().getAttribute('id')) || null;
  if (cbId) {
    const labelSel = `label[for="${cbId}"]`;
    try {
      const lab = page.locator(labelSel).first();
      if (await lab.count()) {
        await lab.click({ force: true });
        await page.waitForTimeout(200);
        return true;
      }
    } catch (e) {}
  }

  // final fallback: click the input itself
  try {
    await checkbox.first().click({ force: true });
    await page.waitForTimeout(200);
    return true;
  } catch (e) {
    return false;
  }
}

// Combined selectBySearch using the safe type + findRowAndCheck
async function selectBySearch(page, id) {
  await typeIntoSearch(page, id);
  console.log(`Typed "${id}" - waiting 40s for results to appear...`);
  const ok = await findRowAndCheck(page, id);
  if (!ok) {
    console.warn("selectBySearch: not found/checked:", id);
    return false;
  }
  await page.waitForTimeout(400);
  return true;
}

/* -------------------------
   Bulk approve helper
-------------------------- */
async function bulkApprove(page) {
  await page.click(cfg.sel.bulkApproveBtn).catch(()=>{});
  await sleep(300);
  await clickIf(page, cfg.sel.approveConfirmBtn);
  await sleep(900);
}

/* iterate ids within a user's view */
async function batchApproveInUser(page, ids, batchSize = cfg.batchSize) {
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    let selected = 0;
    for (const id of [...remaining]) {
      const ok = await selectBySearch(page, id).catch(()=>false);
      if (ok) { remaining.delete(id); selected++; }
      if (selected >= batchSize) break;
    }
    if (selected === 0) break;
    await bulkApprove(page);
    // after approve, clear search (click the clear x or re-focus search and backspace)
    try {
      // try clicking clear X if present
      await clickIf(page, 'button:has-text("Clear"), button[aria-label="Clear"]');
    } catch {}
    await typeIntoSearch(page, ""); // clear
    await sleep(400);
  }
  return [...remaining];
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
    if (!body.includes("Eder")) {
      await switchUser(page, cfg.users.noelle);
    }

    console.log("→ Approving in Noelle...");
    const notFoundNoelle = await batchApproveInUser(page, ids);
    const approvedNoelle = ids.filter(x => !notFoundNoelle.includes(x));
    for (const x of approvedNoelle) appendLog(outPath, `${ts()},${x},approved_in_noelle,\n`);

    if (notFoundNoelle.length === 0) {
      console.log("Done. Log:", outPath);
      await context.close();
      return;
    }

    console.log("→ Switching to Alvaro...");
    await switchUser(page, cfg.users.alvaro);

    const notFoundAlvaro = await batchApproveInUser(page, notFoundNoelle);
    const approvedAlvaro = notFoundNoelle.filter(x => !notFoundAlvaro.includes(x));
    for (const x of approvedAlvaro) appendLog(outPath, `${ts()},${x},approved_in_alvaro,\n`);

    if (approvedAlvaro.length > 0) {
      console.log("→ Returning to Noelle for final approvals...");
      await switchUser(page, cfg.users.noelle);
      const retry = await batchApproveInUser(page, approvedAlvaro);
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
