/**
 * approve.js
 * Usage: node approve.js requests.csv
 *
 * Robust version that:
 * - switches user (Noelle/Alvaro)
 * - finds the correct search input (avoids filling checkboxes)
 * - waits up to 40s for results
 * - selects the result's checkbox by clicking the visible label
 * - bulk approves and confirms
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
   Robust switchUser: same as before
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
    'div[role="dialog"] >> [role="combobox"]'
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

  const shot = await safeScreenshot(page, "-switch-failed");
  await saveText("switch-error.txt", `Could not select "${who}" in Switch dialog. Screenshot: ${shot}\n`);
  throw new Error(`switchUser: unable to select "${who}". Screenshot: ${shot}`);
}

/* -------------------------
   Find the correct search input (defensive)
   Returns locator string we can use (a Playwright locator)
-------------------------- */
async function findSearchInput(page, timeout = 15000) {
  // try placeholder match
  const placeholderCandidates = [
    'input[placeholder*="Search by request ID"]',
    'input[placeholder*="Search by request"]',
    'input[placeholder*="Search"]'
  ];

  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of placeholderCandidates) {
      try {
        const loc = page.locator(sel);
        if (await loc.count()) {
          // pick the visible and enabled one
          const count = await loc.count();
          for (let i = 0; i < count; i++) {
            const l = loc.nth(i);
            if (await l.isVisible().catch(()=>false)) {
              return l;
            }
          }
        }
      } catch (e){}
    }

    // fallback: look for a react-select container that contains an input
    try {
      const container = page.locator('div[id^="Search-"], div.react-select, div.search-container').first();
      if (await container.count()) {
        const innerInput = container.locator('input').first();
        if (await innerInput.count() && await innerInput.isVisible().catch(()=>false)) {
          return innerInput;
        }
      }
    } catch (e){}

    await sleep(300);
  }

  throw new Error("Search input not found on page");
}

/* -------------------------
   Clear + fill search input safely
-------------------------- */
async function fillSearch(page, inputLocator, id) {
  // inputLocator is a Playwright locator object
  try {
    await inputLocator.scrollIntoViewIfNeeded();
    await inputLocator.click({ clickCount: 3, force: true }).catch(()=>{});
    await inputLocator.fill(""); // clear
    await sleep(120);
    await inputLocator.fill(id);
    await sleep(250);
    // try to press Enter or click search icon if present
    try {
      await inputLocator.press('Enter');
    } catch {}
    await clickIf(page, cfg.sel.searchBtn);
  } catch (e) {
    throw new Error("fillSearch failed: " + e.message);
  }
}

/* -------------------------
   Wait up to 40s for a row result to appear
   row locator pattern is provided by cfg.sel.rowById(id)
-------------------------- */
async function waitForResultRow(page, id, maxMs = 40000) {
  const sel = cfg.sel.rowById(id);
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const count = await page.locator(sel).count().catch(()=>0);
    if (count > 0) {
      // ensure visible one exists
      for (let i = 0; i < count; i++) {
        const l = page.locator(sel).nth(i);
        if (await l.isVisible().catch(()=>false)) {
          return l;
        }
      }
    }
    await sleep(700);
  }
  return null;
}

/* -------------------------
   Select checkbox for a row locator
   Tries label click, input.click(), row.click offsets.
-------------------------- */
async function selectRowCheckbox(page, rowLocator, id) {
  // try to find visible label inside the row
  try {
    const label = rowLocator.locator('.custom-control-label').first();
    if (await label.count() && await label.isVisible().catch(()=>false)) {
      await label.scrollIntoViewIfNeeded();
      await label.click({ force: true });
      await sleep(240);
      // confirm checkbox is selected via bottom "x selected" indicator
      return true;
    }
  } catch (e){}

  // try to click the input[type=checkbox] via page.evaluate to call click()
  try {
    const input = await rowLocator.locator('input[type="checkbox"]').first();
    if (await input.count()) {
      await page.evaluate((el) => el.click(), await input.elementHandle());
      await sleep(200);
      return true;
    }
  } catch (e) {}

  // fallback: click near the left side of the row
  try {
    const box = await rowLocator.boundingBox();
    if (box) {
      await page.mouse.click(box.x + 12, box.y + box.height / 2, { force: true });
      await sleep(200);
      return true;
    }
  } catch (e) {}

  return false;
}

/* -------------------------
   selectBySearch: search + wait + select checkbox
-------------------------- */
async function selectBySearch(page, id) {
  // find the specific search input locator each time (defensive)
  const inputLoc = await findSearchInput(page, 8000).catch(()=>null);
  if (!inputLoc) throw new Error("selectBySearch: search input not found");

  await fillSearch(page, inputLoc, id);

  // wait for result row
  const row = await waitForResultRow(page, id, 40000);
  if (!row) return false;

  // attempt to select its checkbox
  const ok = await selectRowCheckbox(page, row, id);
  if (!ok) {
    // capture screenshot and return false so we can inspect
    await safeScreenshot(page, `-checkbox-failed-${id}`);
    return false;
  }
  return true;
}

/* -------------------------
   batch approve helpers
-------------------------- */
async function bulkApprove(page) {
  // scroll bottom into view to click approve
  try {
    await page.locator(cfg.sel.bulkApproveBtn).first().scrollIntoViewIfNeeded();
    await clickIf(page, cfg.sel.bulkApproveBtn);
    await sleep(400);
  } catch (e) {}
  await clickIf(page, cfg.sel.approveConfirmBtn); // when modal appears
  await sleep(900);
}

async function batchApproveInUser(page, ids, batchSize = cfg.batchSize) {
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    let selected = 0;
    for (const id of [...remaining]) {
      try {
        const ok = await selectBySearch(page, id).catch((e) => {
          console.warn("selectBySearch failed for", id, e.message);
          return false;
        });
        if (ok) { remaining.delete(id); selected++; }
        if (selected >= batchSize) break;
      } catch (e) {
        console.warn("Error selecting id", id, e.message);
      }
    }
    if (selected === 0) break;
    await bulkApprove(page);
    // clear search input
    try {
      const inputLoc = await findSearchInput(page, 4000).catch(()=>null);
      if (inputLoc) {
        await inputLoc.fill("");
      }
    } catch (e) {}
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
