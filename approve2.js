// approve.js
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

// how long to wait after clicking the per-row approve button (ms)
const WAIT_AFTER_APPROVE_MS = cfg.waitAfterApproveMs || 15000; // default 15s

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
   switchUser (keeps your robust detection code)
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
   Defensive search input finder
-------------------------- */
async function findSearchInput(page, timeout = 10000) {
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
   Fill search
-------------------------- */
async function fillSearch(page, inputLoc, id) {
  try {
    await inputLoc.scrollIntoViewIfNeeded();
    await inputLoc.click({ clickCount: 3, force: true }).catch(()=>{});
    await inputLoc.fill("");
    await sleep(120);
    await inputLoc.fill(id);
    await sleep(250);
    try { await inputLoc.press('Enter'); } catch {}
    await clickIf(page, cfg.sel.searchBtn); // optional
  } catch (e) {
    throw new Error("fillSearch failed: " + e.message);
  }
}

/* -------------------------
   Wait for a row to appear
-------------------------- */
async function waitForResultRow(page, id, maxMs = 30000) {
  const sel = cfg.sel.rowById(id);
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const count = await page.locator(sel).count().catch(()=>0);
    if (count > 0) {
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
   Click the per-row approve button (blue) — no modal confirm
   The button sits inside the row; try a few selectors.
-------------------------- */
async function clickRowApproveButton(page, rowLocator) {
  // Try several ways to find the approve button in the row
  const candidateSelectors = [
    'button[title="Approve"]',
    'span[title="Approve"] button',
    'button:has-text("✓")',
    'button:has-text("Approve")',
    'button.btn.btn-secondary',
    'button'
  ];

  for (const sel of candidateSelectors) {
    try {
      const btn = rowLocator.locator(sel).first();
      if (await btn.count() && await btn.isVisible().catch(()=>false)) {
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ force: true });
        return true;
      }
    } catch (e) {}
  }

  // fallback: try to click at a likely coordinates area inside the row (right side)
  try {
    const box = await rowLocator.boundingBox();
    if (box) {
      // click near right-center of the row
      await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2, { force: true });
      return true;
    }
  } catch (e) {}

  return false;
}

/* -------------------------
   Single-request flow: search -> click approve button -> wait -> clear search
-------------------------- */
async function processSingleRequest(page, id) {
  const inputLoc = await findSearchInput(page, 8000).catch(()=>null);
  if (!inputLoc) {
    throw new Error("Search input not found");
  }

  await fillSearch(page, inputLoc, id);

  const row = await waitForResultRow(page, id, 30000);
  if (!row) {
    return { found: false };
  }

  const clicked = await clickRowApproveButton(page, row);
  if (!clicked) {
    const shot = await safeScreenshot(page, `-approveclick-failed-${id}`);
    await saveText(`approve-fail-${id}.txt`, `Could not click approve button for ${id}. Screenshot: ${shot}\n`);
    return { found: true, clicked: false };
  }

  // wait the configured settle time (15-20s) for the action to process
  await sleep(WAIT_AFTER_APPROVE_MS);

  // best-effort: clear the search input
  try {
    await inputLoc.fill("");
  } catch (e) {}

  return { found: true, clicked: true };
}

/* -------------------------
   Process lists for a specific user (Noelle/Alvaro)
   returns remaining IDs (not found in this user)
-------------------------- */
async function processIdsInUser(page, ids) {
  const remaining = [];
  for (const id of ids) {
    try {
      console.log("Searching:", id);
      const res = await processSingleRequest(page, id);
      if (!res.found) {
        console.log("Not found for this user:", id);
        remaining.push(id);
      } else if (res.clicked) {
        console.log("Approved (row button):", id);
      } else {
        console.warn("Found but approve click failed:", id);
        remaining.push(id);
      }
    } catch (e) {
      console.error("Error processing", id, e.message);
      const shot = await safeScreenshot(page, `-process-err-${id}`);
      await saveText(`process-err-${id}.txt`, `${e.stack}\nScreenshot: ${shot}\n`);
      remaining.push(id);
    }
    // small pause between items so UI has time to stabilize
    await sleep(500);
  }
  return remaining;
}

/* -------------------------
   MAIN
-------------------------- */
async function main() {
  const input = process.argv[2] || "requests.csv";
  if (!fs.existsSync(input)) { console.error("requests.csv missing"); return; }
  const ids = readRequests(input);
  if (!ids.length) { console.log("No IDs found"); return; }

  const outPath = path.join(LOGS_DIR, `run-${ts().replace(/[: ]/g,"")}.csv`);
  appendLog(outPath, "time,request_id,result,notes\n");

  const context = await startBrowser();
  const page = await context.newPage();

  try {
    await gotoHome(page);

    const body = await page.textContent("body").catch(()=>"");
    // ensure Noelle is active; if not, switch
    if (!body.includes(cfg.users.noelle.split(",")[1].trim()) && !body.includes(cfg.users.noelle.split(",")[0].trim())) {
      await switchUser(page, cfg.users.noelle);
    }

    console.log("→ Processing in Noelle...");
    const notInNoelle = await processIdsInUser(page, ids);
    const approvedNoelle = ids.filter(x => !notInNoelle.includes(x));
    for (const x of approvedNoelle) appendLog(outPath, `${ts()},${x},approved_in_noelle,per-row\n`);

    if (notInNoelle.length === 0) {
      console.log("Done. Log:", outPath);
      await context.close();
      return;
    }

    console.log("→ Switching to Alvaro...");
    await switchUser(page, cfg.users.alvaro);

    const notInAlvaro = await processIdsInUser(page, notInNoelle);
    const approvedAlvaro = notInNoelle.filter(x => !notInAlvaro.includes(x));
    for (const x of approvedAlvaro) appendLog(outPath, `${ts()},${x},approved_in_alvaro,per-row\n`);

    // anything still remaining is not found anywhere
    for (const x of notInAlvaro) appendLog(outPath, `${ts()},${x},not_found_anywhere,\n`);

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
