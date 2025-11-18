/**
 * approve.js (robust)
 * - Improved switchUser with multiple strategies
 * - Saves screenshots on error to logs/errors/
 * - Does not auto-close browser on fatal error so you can inspect
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

/* -------------------------
   Profile helper
-------------------------- */
function userDataDir() {
  return `C:\\Users\\${cfg.edgeProfileUser}\\AppData\\Local\\Microsoft\\Edge\\User Data`;
}

/* -------------------------
   Start browser (persistent)
-------------------------- */
async function startBrowser() {
  const profile = userDataDir();
  try {
    if (fs.existsSync(profile)) {
      const context = await chromium.launchPersistentContext(profile, {
        headless: false,
        channel: "msedge",
        viewport: { width: 1500, height: 900 }
      });
      return context;
    }
  } catch (e) {
    console.warn("Persistent context failed:", e.message);
  }
  const browser = await chromium.launch({ headless: false, channel: "msedge" });
  return await browser.newContext({ viewport: { width: 1500, height: 900 } });
}

/* -------------------------
   Navigation
-------------------------- */
async function gotoHome(page) {
  await page.goto(cfg.urls.homeNoelle, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}

/* -------------------------
   Utilities
-------------------------- */
async function safeScreenshot(page, nameSuffix = "") {
  try {
    const filename = path.join(ERR_DIR, `${ts().replace(/[: ]/g,"")}${nameSuffix}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log("Saved screenshot:", filename);
    return filename;
  } catch (e) {
    console.warn("Screenshot failed:", e.message);
    return null;
  }
}

async function saveText(name, text) {
  try {
    const p = path.join(ERR_DIR, name);
    fs.writeFileSync(p, text);
    console.log("Saved text:", p);
    return p;
  } catch (e) {
    console.warn("Save text failed:", e.message);
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
   Robust switchUser
   multiple strategies tried in order:
   1) native selectOption
   2) set value + dispatchEvent via page.evaluate
   3) find option element and click via JS
   4) click visible text fallback
-------------------------- */
async function switchUser(page, who) {
  console.log(`→ switchUser: selecting "${who}"`);

  // open dialog
  await clickIf(page, cfg.sel.switchLink);
  await sleep(300);

  // wait for dialog to appear
  await page.waitForSelector('text=Switch View', { timeout: 6000 }).catch(()=>{});

  // Wait for any select to appear inside the dialog
  const selectHandle = await page.locator('div[role="dialog"] select, select').first();
  try {
    await selectHandle.waitFor({ timeout: 3000 });
  } catch (e) {
    // not found quickly — continue anyway
  }

  // Strategy A: native selectOption (preferred)
  try {
    const selCount = await page.locator('div[role="dialog"] select, select').count();
    if (selCount > 0) {
      console.log(" -> Found native <select>, trying page.selectOption by label");
      const res = await page.selectOption('div[role="dialog"] select, select', { label: who }).catch(e => { throw e; });
      // selectOption returns [] or value; check current value
      await sleep(300);
      // verify selection
      const selected = await page.evaluate(() => {
        const sel = document.querySelector('div[role="dialog"] select, select');
        return sel ? sel.options[sel.selectedIndex].textContent.trim() : "";
      });
      console.log("   selected text (after selectOption):", selected);
      if (selected && selected.includes(who.split(",")[0])) {
        console.log("   selectOption succeeded");
        await clickIf(page, cfg.sel.switchConfirm);
        await page.waitForLoadState("networkidle").catch(()=>{});
        await sleep(600);
        return;
      } else {
        console.log("   selectOption did not choose expected label, will try DOM set");
      }
    } else {
      console.log(" -> No native select found (selCount=0)");
    }
  } catch (e) {
    console.warn("selectOption attempt failed:", e.message);
  }

  // Strategy B: set value + dispatch change using DOM (works even if selectOption doesn't)
  try {
    console.log(" -> Trying DOM method: set select.value and dispatchEvent");
    const setResult = await page.evaluate((whoText) => {
      const sel = document.querySelector('div[role="dialog"] select, select');
      if (!sel) return { ok: false, msg: "no select element" };
      // find option index by text match
      let foundIndex = -1;
      for (let i = 0; i < sel.options.length; i++) {
        const t = (sel.options[i].text || "").trim();
        if (t === whoText || t.includes(whoText.split(",")[0])) { foundIndex = i; break; }
      }
      if (foundIndex === -1) return { ok: false, msg: "option not found" };
      sel.selectedIndex = foundIndex;
      const ev = new Event('change', { bubbles: true });
      sel.dispatchEvent(ev);
      return { ok: true, idx: foundIndex, label: sel.options[foundIndex].text };
    }, who);
    if (setResult && setResult.ok) {
      console.log("   DOM set succeeded, selected:", setResult.label);
      await clickIf(page, cfg.sel.switchConfirm);
      await page.waitForLoadState("networkidle").catch(()=>{});
      await sleep(600);
      return;
    } else {
      console.log("   DOM set did not find option:", setResult && setResult.msg);
    }
  } catch (e) {
    console.warn("DOM set attempt failed:", e.message);
  }

  // Strategy C: locate option element and click it via JS (useful on some UIs)
  try {
    console.log(" -> Trying to click option element via JS");
    const clicked = await page.evaluate((whoText) => {
      const sel = document.querySelector('div[role="dialog"] select, select');
      if (!sel) return false;
      for (let i = 0; i < sel.options.length; i++) {
        const t = (sel.options[i].text || "").trim();
        if (t === whoText || t.includes(whoText.split(",")[0])) {
          // create a MouseEvent on the option (some browsers ignore click on option)
          const opt = sel.options[i];
          try {
            opt.selected = true;
            const evt = new Event('change', { bubbles: true });
            sel.dispatchEvent(evt);
            return true;
          } catch (e) {
            continue;
          }
        }
      }
      return false;
    }, who);
    if (clicked) {
      console.log("   JS option click succeeded");
      await clickIf(page, cfg.sel.switchConfirm);
      await page.waitForLoadState("networkidle").catch(()=>{});
      await sleep(600);
      return;
    } else {
      console.log("   JS option click did not find a match");
    }
  } catch (e) {
    console.warn("JS option click failed:", e.message);
  }

  // Strategy D (last resort): click visible text nodes inside dialog
  try {
    const firstName = who.split(",")[0].trim();
    console.log(" -> Trying visible-text click for:", firstName);
    const textLocator = page.locator(`div[role="dialog"] >> text="${who}"`);
    if ((await textLocator.count()) > 0) {
      await textLocator.first().click({ force: true });
      await clickIf(page, cfg.sel.switchConfirm);
      await page.waitForLoadState("networkidle").catch(()=>{});
      await sleep(600);
      return;
    }
    // partial match
    const partialLocator = page.locator(`div[role="dialog"] >> text=${firstName}`);
    if ((await partialLocator.count()) > 0) {
      await partialLocator.first().click({ force: true });
      await clickIf(page, cfg.sel.switchConfirm);
      await page.waitForLoadState("networkidle").catch(()=>{});
      await sleep(600);
      return;
    }
  } catch (e) {
    console.warn("visible-text fallback failed:", e.message);
  }

  // If all strategies failed: save state and throw for inspection
  const shot = await safeScreenshot(page, "-switch-failed");
  await saveText("switch-error.txt", `Could not select "${who}" in Switch dialog. Screenshot: ${shot}\n`);
  throw new Error(`switchUser: unable to programmatically select "${who}". Screenshot: ${shot}`);
}

/* -------------------------
   search helpers
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

async function selectBySearch(page, id) {
  await clearSearch(page);
  await page.fill(cfg.sel.searchInput, id);
  for (let i = 0; i < 15; i++) {
    await sleep(250);
    const count = await page.locator(cfg.sel.rowById(id)).count().catch(()=>0);
    if (count > 0) {
      try {
        await page.check(cfg.sel.rowCheckbox(id));
        return true;
      } catch {
        const row = page.locator(cfg.sel.rowById(id)).first();
        await row.click({ position: { x: 20, y: 10 } }).catch(()=>{});
        try { await page.check(cfg.sel.rowCheckbox(id)); return true; } catch {}
        return true; // still consider found
      }
    }
  }
  return false;
}

async function bulkApprove(page) {
  await page.click(cfg.sel.bulkApproveBtn);
  await sleep(400);
  await clickIf(page, cfg.sel.approveConfirmBtn);
  await sleep(1000);
}

/* -------------------------
   batch approval
-------------------------- */
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

/* -------------------------
   MAIN with error capture (keeps browser open on failure)
-------------------------- */
async function main() {
  const input = process.argv[2] || "requests.csv";
  if (!fs.existsSync(input)) {
    console.error("requests.csv not found");
    return;
  }
  const ids = readRequests(input);
  const outPath = path.join(LOGS_DIR, `run-${ts().replace(/[: ]/g,"")}.csv`);
  appendLog(outPath, "time,request_id,result,notes\n");

  const context = await startBrowser();
  const page = await context.newPage();

  try {
    await gotoHome(page);

    // ensure Noelle first
    const body = await page.textContent("body").catch(()=>"");
    if (!body.includes("Eder")) {
      if (body.includes("Gupta")) await switchUser(page, cfg.users.noelle);
      else if (body.includes("Garrido")) await switchUser(page, cfg.users.noelle);
      else {
        // if ambiguous, attempt to switch anyway
        await switchUser(page, cfg.users.noelle).catch(e => console.warn("Switch attempt ambiguous:", e.message));
      }
    }

    console.log("→ Approving in Noelle...");
    const notFoundNoelle = await batchApproveInUser(page, ids);
    const approvedNoelle = ids.filter(x => !notFoundNoelle.includes(x));
    for (const x of approvedNoelle) appendLog(outPath, `${ts()},${x},approved_in_noelle,\n`);

    if (notFoundNoelle.length === 0) {
      console.log("All handled in Noelle.");
      await context.close();
      return;
    }

    console.log("→ Switching to Alvaro for remaining IDs...");
    await switchUser(page, cfg.users.alvaro);

    const notFoundAlvaro = await batchApproveInUser(page, notFoundNoelle);
    const approvedAlvaro = notFoundNoelle.filter(x => !notFoundAlvaro.includes(x));
    for (const x of approvedAlvaro) appendLog(outPath, `${ts()},${x},approved_in_alvaro,\n`);

    if (approvedAlvaro.length > 0) {
      console.log("→ Returning to Noelle to finalize chain...");
      await switchUser(page, cfg.users.noelle);
      const retry = await batchApproveInUser(page, approvedAlvaro);
      for (const x of approvedAlvaro) {
        if (!retry.includes(x)) appendLog(outPath, `${ts()},${x},approved_after_alvaro_then_noelle,\n`);
        else appendLog(outPath, `${ts()},${x},approved_in_alvaro_only,\n`);
      }
    }

    for (const x of notFoundAlvaro) appendLog(outPath, `${ts()},${x},not_found_anywhere,\n`);

    console.log("Done. Log:", outPath);
    await context.close();
  } catch (err) {
    console.error("Fatal error:", err.message);
    const shot = await safeScreenshot(page, "-fatal");
    await saveText("fatal-error.txt", `${err.stack}\nScreenshot: ${shot}\n`);
    console.log("Browser left open for inspection. Check logs/errors for screenshot and fatal-error.txt");
    // Do NOT close context so you can inspect the browser state.
  }
}

main().catch(e=>{
  console.error("Unhandled error:", e);
});
