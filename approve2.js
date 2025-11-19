// approve.js
import fs from "fs";
import path from "path";
import { startBrowser, readIdsFromFile, switchUser, waitForSearchResult, clickInlineApproveInRow, saveLog } from "./utils.js";
import { cfg } from "./config.js";

/**
 * Approve requests one-by-one using the inline blue approve button in each row.
 *
 * Usage: node approve.js requests.csv
 */

function usageAndExit() {
  console.error("Usage: node approve.js requests.csv");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args[0]) usageAndExit();
  const ids = readIdsFromFile(args[0]);
  if (!ids.length) {
    console.error("No IDs found in file.");
    process.exit(1);
  }

  // start browser (Edge fallback)
  const { browser, context, page } = await startBrowser({ headless: false });

  try {
    // navigate to home (cfg.urls.homeNoelle should open default portal page)
    await page.goto(cfg.urls.homeNoelle || "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log("Opened home page.");

    // Ensure we start as Noelle as per earlier config
    await switchUser(page, cfg.users.noelle, cfg);

    const results = [];
    for (const id of ids) {
      console.log(`\nProcessing ${id} ...`);
      // Make sure search input is visible
      const input = page.locator(cfg.sel.searchInput);
      await input.waitFor({ state: "visible", timeout: 8000 });

      // Clear & type ID
      await input.fill("");
      await page.waitForTimeout(250);
      await input.type(id, { delay: 50 });

      // press Enter or click search
      try {
        if (cfg.sel.searchBtn) {
          await page.click(cfg.sel.searchBtn, { timeout: 5000 });
        } else {
          await input.press("Enter");
        }
      } catch (e) { /* ignore; maybe the input triggers search automatically */ }

      // Wait for results (up to 40s)
      const foundInNoelle = await waitForSearchResult(page, id, cfg, 40000);
      if (!foundInNoelle) {
        console.log(`${id} not found for Noelle, switching to Alvaro and retrying...`);
        const switched = await switchUser(page, cfg.users.alvaro, cfg);
        if (!switched) {
          console.warn("Failed to switch to Alvaro. Skipping ID:", id);
          results.push({ id, status: "skipped-switch-failed" });
          continue;
        }
        // clear & type again
        await input.fill("");
        await page.waitForTimeout(300);
        await input.type(id, { delay: 50 });
        try { if (cfg.sel.searchBtn) await page.click(cfg.sel.searchBtn, { timeout: 5000 }); } catch(e){}
        const foundInAlvaro = await waitForSearchResult(page, id, cfg, 40000);
        if (!foundInAlvaro) {
          console.warn(`${id} not found in Alvaro either. Skipping.`);
          results.push({ id, status: "not-found" });
          // switch back to Noelle for next ID
          await switchUser(page, cfg.users.noelle, cfg);
          continue;
        }
      }

      // locate the row
      const row = page.locator(cfg.sel.rowById(id)).first();
      try {
        await row.waitFor({ state: "visible", timeout: 8000 });
      } catch (e) {
        console.warn("Row located but not visible/interactable. Skipping:", id);
        results.push({ id, status: "row-not-visible" });
        continue;
      }

      // Click inline approve button inside the row (no confirm expected)
      const clicked = await clickInlineApproveInRow(row);
      if (!clicked) {
        console.warn("Inline approve button not clicked (not found). Trying fallback: click row then find bottom approve");
        // fallback: click row to highlight then click bottom approve (bulk) - but user asked not to bulk; we try fallback then skip
        results.push({ id, status: "approve-button-not-found" });
        continue;
      }

      console.log(`Clicked inline approve for ${id}. Waiting 17s for server action...`);
      await page.waitForTimeout(17000); // wait 17s as requested

      // Optionally verify success toast
      let success = false;
      if (cfg.sel.successToast) {
        try {
          const toast = page.locator(cfg.sel.successToast).first();
          await toast.waitFor({ state: "visible", timeout: 10000 });
          success = true;
        } catch (e) {
          // no toast found
        }
      }

      results.push({ id, status: success ? "approved" : "clicked-no-toast" });

      // ensure we are back to Noelle view for next ID (if we had switched earlier)
      try { await switchUser(page, cfg.users.noelle, cfg); } catch(e){}
      // small pause before next ID
      await page.waitForTimeout(800);
    }

    // Save run results
    const out = results.map(r => `${r.id},${r.status}`).join("\n");
    const logfile = saveLog("run", out);
    console.log("Done. Log saved:", logfile);

  } catch (err) {
    console.error("Fatal error:", err);
    const snapshot = path.join(process.cwd(), "logs", `error-${Date.now()}.png`);
    try { await page.screenshot({ path: snapshot, fullPage: true }); console.log("Saved screenshot", snapshot);} catch(e){}
    throw err;
  } finally {
    try { await context.close(); } catch(e){}
    try { await browser.close(); } catch(e){}
  }
}

main().catch(err => {
  console.error("Script failed:", err);
  process.exit(1);
});
