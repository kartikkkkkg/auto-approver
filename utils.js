// utils.js
import fs from "fs";
import path from "path";
import os from "os";
import { chromium } from "playwright";

/**
 * Utilities for auto-approver:
 * - startBrowser() with Edge fallback
 * - readIdsFromFile()
 * - switchUser(page, who) to switch portal view
 * - saveLog()
 */

const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

export function userDataDir() {
  // keep a persistent profile per Windows user so site stays logged in if possible
  const base = process.env.USERPROFILE || os.homedir();
  return path.join(base, "auto-approver-profile");
}

function edgeCommonPaths() {
  return [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
}

/**
 * Start Playwright browser. Try:
 *  1) launchPersistentContext with channel 'msedge'
 *  2) explicit executablePath for system Edge
 *  3) chromium.launch (final fallback)
 *
 * Returns: { browser, context, page }
 */
export async function startBrowser({ headless = false } = {}) {
  const profile = userDataDir();

  // 1) Try persistent context with channel 'msedge' (works if Edge installed)
  try {
    if (!fs.existsSync(profile)) fs.mkdirSync(profile, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, {
      headless,
      channel: "msedge",
      viewport: { width: 1400, height: 900 },
    });
    const page = context.pages()[0] || await context.newPage();
    return { browser: context.browser(), context, page };
  } catch (err) {
    console.warn("Persistent msedge launch failed:", err.message);
  }

  // 2) Try explicit installed Edge path(s)
  for (const p of edgeCommonPaths()) {
    try {
      if (fs.existsSync(p)) {
        const browser = await chromium.launch({
          headless,
          executablePath: p,
          args: ["--start-maximized"],
        });
        const context = await browser.newContext({ viewport: { width: 1400, height: 900 }});
        const page = await context.newPage();
        return { browser, context, page };
      }
    } catch (err) {
      console.warn(`Launch with executablePath ${p} failed:`, err.message);
    }
  }

  // 3) final attempt
  try {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }});
    const page = await context.newPage();
    return { browser, context, page };
  } catch (err) {
    console.error("Unable to launch a browser. If you can run `npx playwright install` as admin it will install Playwright browsers.");
    throw err;
  }
}

/**
 * Read list of IDs from CSV-like file (one per line or comma separated).
 * Returns array of trimmed strings (non-empty).
 */
export function readIdsFromFile(filepath) {
  const txt = fs.readFileSync(filepath, "utf8");
  // accept CSV or line-separated; find tokens that look like WF-123 or numbers
  const tokens = txt.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  return tokens;
}

/**
 * Save run log
 */
export function saveLog(name, content) {
  const fn = path.join(LOG_DIR, `${name.replace(/\s+/g, "_")}-${Date.now()}.log.txt`);
  fs.writeFileSync(fn, content, "utf8");
  return fn;
}

/**
 * switchUser(page, whoText, cfg)
 * - whoText: visible text like "Eder, Noelle" or "Garrido, Alvaro"
 * - cfg.sel contains selectors used earlier (keeps compatibility)
 */
export async function switchUser(page, whoText, cfg) {
  // If already viewing that user, skip
  try {
    const activeText = await page.locator(`text=${cfg.sel.activeUserText}`).textContent().catch(()=>null);
    if (activeText && activeText.includes(whoText)) {
      console.log("Already viewing", whoText);
      return true;
    }
  } catch(e) { /* ignore */ }

  console.log(`switchUser: choose "${whoText}"`);
  // click the "Switch" link
  try {
    await page.click(cfg.sel.switchLink, { timeout: 5000 });
  } catch (e) {
    console.warn("Could not click switch link directly:", e.message);
    // try click by alternative: text=Switch
    try { await page.click(`text=Switch`, { timeout: 5000 }); } catch(e2){ /* ignore */ }
  }

  // Wait for dialog and choose option text
  const opt = cfg.sel.switchOption(whoText);
  await page.waitForTimeout(600); // tiny wait for dialog animation
  try {
    await page.click(opt, { timeout: 8000 });
    await page.click(cfg.sel.switchConfirm, { timeout: 8000 });
    // Wait for the view to change
    await page.waitForTimeout(1500);
    console.log("clicked option via selector:", opt);
    return true;
  } catch (err) {
    console.warn("switchUser click failed:", err.message);
    return false;
  }
}

/**
 * Wait for search results after typing ID.
 * We type into cfg.sel.searchInput and then wait up to 'waitMs' ms for a row/link to appear.
 * Returns true if found, false otherwise.
 */
export async function waitForSearchResult(page, id, cfg, waitMs = 40000) {
  const inputLocator = page.locator(cfg.sel.searchInput);
  // Ensure input exists
  await inputLocator.waitFor({ state: "visible", timeout: 8000 }).catch(()=>{});
  // press Enter or click search button if available
  // But the caller will have already typed the ID
  const rowLocator = page.locator(cfg.sel.rowById(id));
  try {
    await rowLocator.waitFor({ state: "visible", timeout: waitMs });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Click the inline approve button inside a row locator
 * Returns true if clicked; false otherwise
 */
export async function clickInlineApproveInRow(rowLocator) {
  // We try to find a button that looks like the approve checkmark
  // Two approaches: a button with title "Approve" or button with visible '✓' text.
  try {
    // Try title=Approve
    const titled = rowLocator.locator('span[title="Approve"], button[title="Approve"]');
    if (await titled.count() > 0) {
      await titled.first().click({ timeout: 8000 });
      return true;
    }
  } catch(e){ /* ignore */ }

  try {
    // Try button that contains the check-mark character
    const btn = rowLocator.locator('button:has-text("✓"), button:has-text("✔")');
    if (await btn.count() > 0) {
      await btn.first().click({ timeout: 8000 });
      return true;
    }
  } catch(e){ /* ignore */ }

  try {
    // Try any button with class 'btn' inside that row (less safe) but filtered by color or index
    const anyBtn = rowLocator.locator('button.btn');
    if (await anyBtn.count() > 0) {
      // find the button which is leftmost (likely approve)
      await anyBtn.first().click({ timeout: 8000 });
      return true;
    }
  } catch(e){ /* ignore */ }

  return false;
}
