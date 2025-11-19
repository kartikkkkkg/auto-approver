/**
 * approve.js - auto-approver with robust label-click checkbox handling
 *
 * Usage:
 *   node approve.js requests.csv
 *
 * Behavior:
 *  - launches Edge with your profile
 *  - goes to configured URL
 *  - ensures view switches to Noelle (Eder, Noelle)
 *  - searches & batch-approves requests
 *  - on failures saves screenshots to logs/errors/
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
   Robust switchUser for custom dropdown
--------------------------- */
async function switchUser(page, who) {
  console.log(`→ switchUser: choose "${who}"`);

  // open the Switch dialog
  await clickIf(page, cfg.sel.switchLink);
  await sleep(300);

  // wait for dialog to appear (text from screenshots)
  await page.waitForSelector('text=Switch View', { timeout: 6000 }).catch(()=>{});

  // Strategy: click the visible "Select..." area or the caret icon
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

  // Try partial match
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
   search & select helpers
-------------------------- */
async function clearSearch(page) {
  try {
    await page.click(cfg.sel.searchInput);
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
  } catch (e) {
    try { await page.fill(cfg.sel.searchInput, ""); } catch {}
  }
}

/**
 * selectBySearch: type id, wait up to waitMs (default 40s) for row,
 * then click label or checkbox (works when input is hidden and label is clickable).
 */
async function selectBySearch(page, id, waitMs = 40000) {
  await clearSearch(page);

  // fill and allow React to process
  await page.fill(cfg.sel.searchInput, id);
  await page.waitForTimeout(250);
  try { await page.click(cfg.sel.searchBtn); } catch (e) {}

  console.log(`Typed "${id}" - waiting ${Math.round(waitMs/1000)}s for results to appear...`);
  const start = Date.now();

  while (Date.now() - start < waitMs) {
    await sleep(700);

    const rows = page.locator(cfg.sel.rowById(id));
    const count = await rows.count().catch(()=>0);
    if (count > 0) {
      const row = rows.first();

      // 1) Click visible label inside row (most robust for styled checkboxes)
      const label = row.locator("label.custom-control-label");
      if (await label.count()) {
        try {
          await label.first().click({ force: true });
          await sleep(350);
          return true;
        } catch (e) {
          console.warn("label click failed, fallback:", e.message);
        }
      }

      // 2) Try evaluating a click on the hidden input in-page
      const checkbox = row.locator('input[type="checkbox"]');
      if (await checkbox.count()) {
        try {
          await checkbox.first().evaluate(el => el.click());
          await sleep(350);
          return true;
        } catch (e) {
          console.warn("checkbox.evaluate click failed:", e.message);
        }
      }

      // 3) Click coordinates inside row (approx left)
      try {
        const box = await row.boundingBox();
        if (box) {
          await page.mouse.click(box.x + 18, box.y + box.height / 2, { force: true });
          await sleep(350);
          return true;
        }
      } catch (e) { /* ignore */ }

      // continue waiting/polling if none worked
    }
  }

  return false;
}

async function bulkApprove(page) {
  // Try several candidate selectors for the Approve button (footer/visible)
  const approveBtnCandidates = [
    'footer button:has-text("Approve")',
    'button:has-text("Approve")',
    'div[class*="pagination-bottom"] button:has-text("Approve")',
    'button[aria-label="Approve"]'
  ];

  for (const sel of approveBtnCandidates) {
    try {
      const loc = page.locator(sel);
      if (await loc.count()) {
        await loc.first().click({ force: true });
        await sleep(300);
        // Wait for confirm button to appear
        await page.waitForSelector('button:has-text("Confirm")', { timeout: 4000 }).catch(()=>{});
        return true;
      }
    } catch (e) {
      console.warn("bulkApprove candidate failed:", sel, e.message);
    }
  }

  throw new Error("bulkApprove: could not find Approve button");
}

async function batchApproveInUser(page, ids, batchSize = cfg.batchSize) {
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    let selected = 0;
    for (const id of [...remaining]) {
      const ok = await selectBySearch(page, id);
      if (ok) {
        remaining.delete(id);
        selected++;
      } else {
        console.log(" → not found:", id);
      }
      if (selected >= batchSize) break;
    }
    if (selected === 0) break;
    // Approve whatever's selected
    await bulkApprove(page);
    // Click confirm (modal)
    await clickIf(page, 'button:has-text("Confirm")').catch(()=>{});
    await sleep(900);
    await clearSearch(page);
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

    // Check active user snapshot (simple text search)
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
