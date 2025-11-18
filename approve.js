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
ensureDir(LOGS_DIR);

/* -----------------------------------------------------
   USE YOUR REAL EDGE PROFILE
----------------------------------------------------- */
function userDataDir() {
  return `C:\\Users\\${cfg.edgeProfileUser}\\AppData\\Local\\Microsoft\\Edge\\User Data`;
}

/* -----------------------------------------------------
   START EDGE (PERSISTENT PROFILE)
----------------------------------------------------- */
async function startBrowser() {
  const profile = userDataDir();
  let context;

  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      channel: "msedge",
      viewport: { width: 1500, height: 900 }
    });
    return context;
  } catch (e) {
    console.warn("Persistent profile launch failed:", e.message);
  }

  const browser = await chromium.launch({
    headless: false,
    channel: "msedge"
  });

  context = await browser.newContext({
    viewport: { width: 1500, height: 900 }
  });

  return context;
}

/* -----------------------------------------------------
   NAVIGATE TO HOME
----------------------------------------------------- */
async function gotoHome(page) {
  await page.goto(cfg.urls.homeNoelle, {
    waitUntil: "domcontentloaded"
  });
  await page.waitForLoadState("networkidle");
}

/* -----------------------------------------------------
   GET ACTIVE USER
----------------------------------------------------- */
async function getActiveUser(page) {
  return (await page.textContent("body").catch(() => "")) || "";
}

/* -----------------------------------------------------
   SAFE CLICK
----------------------------------------------------- */
async function clickIf(page, selector) {
  try {
    const loc = page.locator(selector);
    if (await loc.count()) {
      await loc.first().click();
      return true;
    }
  } catch {}
  return false;
}

/* -----------------------------------------------------
   *** PERFECT MATCH SWITCH USER ***
   Works for your exact dropdown
----------------------------------------------------- */
async function switchUser(page, who) {
  console.log(`→ Switching to ${who} ...`);

  // open dialog
  await clickIf(page, cfg.sel.switchLink);
  await sleep(300);

  // wait for dialog
  await page.waitForSelector('text=Switch View', { timeout: 5000 });

  // open dropdown
  await page.click("select");
  await sleep(150);

  // select user by visible label
  await page.selectOption("select", { label: who });
  console.log(`   Selected: ${who}`);

  // click Switch button
  await page.click('button:has-text("Switch")');
  console.log("   Clicked Switch button");

  // wait for reload
  await page.waitForLoadState("networkidle").catch(()=>{});
  await sleep(800);
}

/* -----------------------------------------------------
   CLEAR SEARCH
----------------------------------------------------- */
async function clearSearch(page) {
  await page.click(cfg.sel.searchInput);
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
}

/* -----------------------------------------------------
   SELECT REQUEST BY SEARCH
----------------------------------------------------- */
async function selectBySearch(page, id) {
  await clearSearch(page);
  await page.fill(cfg.sel.searchInput, id);

  for (let i = 0; i < 12; i++) {
    await sleep(250);

    const row = page.locator(cfg.sel.rowById(id));
    const count = await row.count().catch(() => 0);

    if (count > 0) {
      try {
        await page.check(cfg.sel.rowCheckbox(id));
        return true;
      } catch {
        const firstRow = row.first();
        await firstRow.click({ position: { x: 25, y: 15 } }).catch(() => {});
        try {
          await page.check(cfg.sel.rowCheckbox(id));
          return true;
        } catch {}
      }
    }
  }
  return false;
}

/* -----------------------------------------------------
   BULK APPROVE
----------------------------------------------------- */
async function bulkApprove(page) {
  await page.click(cfg.sel.bulkApproveBtn);
  await sleep(300);
  await clickIf(page, cfg.sel.approveConfirmBtn);
  await sleep(1000);
}

/* -----------------------------------------------------
   BATCH APPROVE
----------------------------------------------------- */
async function batchApproveInUser(page, ids, batchSize = cfg.batchSize) {
  const remaining = new Set(ids);

  while (remaining.size > 0) {
    let selected = 0;

    for (const id of [...remaining]) {
      const ok = await selectBySearch(page, id);
      if (ok) {
        remaining.delete(id);
        selected++;
      }
      if (selected >= batchSize) break;
    }

    if (selected === 0) break;

    await bulkApprove(page);
    await clearSearch(page);
  }

  return [...remaining];
}

/* -----------------------------------------------------
   MAIN FLOW
----------------------------------------------------- */
async function main() {
  const input = process.argv[2] || "requests.csv";

  if (!fs.existsSync(input)) {
    console.error("❌ requests.csv missing!");
    return;
  }

  const ids = readRequests(input);

  const outPath = path.join(
    LOGS_DIR,
    `run-${ts().replace(/[: ]/g, "")}.csv`
  );
  appendLog(outPath, "time,request_id,result,notes\n");

  const context = await startBrowser();
  const page = await context.newPage();

  await gotoHome(page);

  const active = await getActiveUser(page);

  // Always move to Noelle first
  if (!active.includes("Eder")) {
    if (active.includes("Gupta")) await switchUser(page, cfg.users.noelle);
    if (active.includes("Garrido")) await switchUser(page, cfg.users.noelle);
  }

  console.log("→ Approving in Noelle...");
  const notFoundNoelle = await batchApproveInUser(page, ids);
  const approvedNoelle = ids.filter(x => !notFoundNoelle.includes(x));

  for (const x of approvedNoelle)
    appendLog(outPath, `${ts()},${x},approved_in_noelle,\n`);

  if (notFoundNoelle.length === 0) {
    console.log("✔ All approved in Noelle");
    await context.close();
    return;
  }

  console.log("→ Switching to Alvaro...");
  await switchUser(page, cfg.users.alvaro);

  const notFoundAlvaro = await batchApproveInUser(page, notFoundNoelle);
  const approvedAlvaro = notFoundNoelle.filter(
    x => !notFoundAlvaro.includes(x)
  );

  for (const x of approvedAlvaro)
    appendLog(outPath, `${ts()},${x},approved_in_alvaro,\n`);

  // If some were approved in Alvaro → go back to Noelle again
  if (approvedAlvaro.length > 0) {
    console.log("→ Returning to Noelle for second pass...");
    await switchUser(page, cfg.users.noelle);

    const retry = await batchApproveInUser(page, approvedAlvaro);

    for (const x of approvedAlvaro) {
      if (!retry.includes(x))
        appendLog(outPath, `${ts()},${x},approved_after_alvaro,\n`);
      else
        appendLog(outPath, `${ts()},${x},approved_only_alvaro,\n`);
    }
  }

  for (const x of notFoundAlvaro)
    appendLog(outPath, `${ts()},${x},not_found_anywhere,\n`);

  console.log("✔ DONE → Log file:", outPath);
  await context.close();
}

main();
