// approve.js
// Script to approve requests one-by-one by clicking the inline blue ✓ approve button in each row.
//
// Usage:
//   node --experimental-specifier-resolution=node approve.js requests.csv
//
// Files created: logs/run-<ts>.csv, logs/errors/*.png

import path from "path";
import { fileURLToPath } from "url";
import { startBrowser, safeScreenshot, appendLog, saveText, readIdsFromFile } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------- CONFIG ---------------- */
const cfg = {
  // change to the actual portal URL that opens as Kartik/Noelle
  homeNoelle: "https://leap.standardchartered.com/tsp/workforce-management/team/request/2/list/redirect",
  // search input selector (best guess from your screenshots)
  sel: {
    searchInput: 'input[placeholder*="Search by request ID"]',
  },
  // how many ms to wait after clicking inline approve before moving on
  waitAfterApproveMs: 17000, // 15-20s you wanted; set 17000 (17s)
  // Where logs go
  outLog: path.join(process.cwd(), "logs", `run-${Date.now()}.csv`),
};
/* ---------------------------------------- */

async function clickInlineApproveInRow(page, requestId, opts = {}) {
  const waitAfterMs = opts.waitAfterMs ?? cfg.waitAfterApproveMs;
  console.log(`→ locate anchor for ${requestId}`);

  // 1) Wait for anchor with requestId to appear
  const idAnchor = page.locator(`a:has-text("${requestId}")`).first();
  try {
    await idAnchor.waitFor({ timeout: 40000 }); // up to 40s
  } catch (e) {
    console.warn(`❌ anchor ${requestId} not found within 40s`);
    return false;
  }

  // 2) Find the nearest row ancestor (div with class containing "row")
  const rowLocator = idAnchor.locator('xpath=ancestor::div[contains(@class,"row")][1]');
  if ((await rowLocator.count()) === 0) {
    console.warn("row ancestor not found — trying fallback ancestor");
    // fallback: go up 3 levels
    const fallback = idAnchor.locator('xpath=ancestor::div[3]');
    if ((await fallback.count()) === 0) {
      console.warn("fallback ancestor missing");
      await safeScreenshot(page, `no-row-${requestId}`);
      return false;
    } else {
      console.log("Using fallback ancestor");
    }
  }

  // prefer a locator variable that points to the chosen ancestor
  const row = (await rowLocator.count()) ? rowLocator : idAnchor.locator('xpath=ancestor::div[3]');

  // 3) Inside row, find the approve button (the inline blue ✓)
  // your screenshot shows a button with classes like btn-secondary and literal "✓" char
  const approveBtn = row.locator('button.btn-secondary:has-text("✓")').first();

  // fallback: sometimes it is a span[title="Approve"] wrapper
  const approveBtnFallback = row.locator('span[title="Approve"] button').first();

  // last fallback: any following button with ✓ near the anchor
  const nearbyBtn = idAnchor.locator('xpath=following::button[contains(., "✓")][1]');

  try {
    if (await approveBtn.count()) {
      await approveBtn.waitFor({ timeout: 8000 });
      await approveBtn.click({ force: true });
      console.log(`✔ clicked approve for ${requestId}`);
      await page.waitForTimeout(waitAfterMs);
      return true;
    } else if (await approveBtnFallback.count()) {
      await approveBtnFallback.waitFor({ timeout: 8000 });
      await approveBtnFallback.click({ force: true });
      console.log(`✔ clicked approve (fallback) for ${requestId}`);
      await page.waitForTimeout(waitAfterMs);
      return true;
    } else if (await nearbyBtn.count()) {
      await nearbyBtn.click({ force: true });
      console.log(`✔ clicked nearby approve for ${requestId}`);
      await page.waitForTimeout(waitAfterMs);
      return true;
    } else {
      console.warn("No approve button found in row");
      await safeScreenshot(page, `no-approve-${requestId}`);
      return false;
    }
  } catch (err) {
    console.warn("Error clicking approve:", err?.message);
    await safeScreenshot(page, `approve-err-${requestId}`);
    return false;
  }
}

async function ensureOnManageRequests(page) {
  // navigate to list URL if not already
  if (!page.url().includes("/workforce-management")) {
    console.log("Navigating to manage requests page...");
    await page.goto(cfg.homeNoelle, { waitUntil: "domcontentloaded" });
    // small wait to let SPA render
    await page.waitForTimeout(1500);
  } else {
    // small wait for stability
    await page.waitForTimeout(700);
  }
}

async function clearAndSearch(page, id) {
  // find input and fill
  const searchSel = cfg.sel.searchInput;
  const input = page.locator(searchSel).first();
  await input.waitFor({ timeout: 10000 });
  // clear any previous contents
  await input.fill("");
  await input.type(id, { delay: 30 });
  // press Enter or click search icon — try Enter first
  await page.keyboard.press("Enter").catch(() => {});
  // small delay then main waitFor for anchor is in clickInlineApproveInRow
  await page.waitForTimeout(200);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node approve.js requests.csv");
    process.exit(1);
  }
  const inputFile = path.resolve(args[0]);
  const ids = await readIdsFromFile(inputFile);

  // header for log
  await saveText(cfg.outLog, "ts,requestId,result\n");

  // start browser (non-headless so you can inspect)
  const { browser, context, page } = await startBrowser({ headless: false });
  try {
    await ensureOnManageRequests(page);

    for (const id of ids) {
      const ts = new Date().toISOString();
      try {
        console.log("=========");
        console.log(`Processing ${id} ...`);

        // search
        await clearAndSearch(page, id);
        console.log(`Typed "${id}" — waiting for result anchor...`);

        // click inline approve
        const ok = await clickInlineApproveInRow(page, id, { waitAfterMs: cfg.waitAfterApproveMs });
        if (ok) {
          console.log(`${id} approved inline`);
          await appendLog(cfg.outLog, `${ts},${id},approved\n`);
        } else {
          console.warn(`${id} -> failed to approve`);
          await appendLog(cfg.outLog, `${ts},${id},failed\n`);
        }

        // small cooldown before next loop
        await page.waitForTimeout(800);
      } catch (e) {
        console.warn("Per-ID error", e?.message || e);
        await safeScreenshot(page, `fatal-${id}`);
        await appendLog(cfg.outLog, `${new Date().toISOString()},${id},error\n`);
      }
    }

    console.log("Done queue. Closing browser in 3s...");
    await page.waitForTimeout(3000);
    await context.close();
    await browser.close();
    console.log("Finished.");
  } catch (err) {
    console.error("Fatal error:", err);
    await safeScreenshot(page, "fatal");
    try { await context.close(); await browser.close(); } catch (_) {}
    process.exit(2);
  }
}

main();
