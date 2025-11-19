// utils.js
// ESM module of general helpers used by approve.js

import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

/**
 * Start and return a Playwright browser + context + page.
 * Options:
 *   headless: boolean (default: false so you can see what's happening)
 *   profile: optional path to use for persistent context
 */
export async function startBrowser({ headless = false, userDataDir = null } = {}) {
  if (userDataDir) {
    // persistent context
    const browser = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1366, height: 768 },
      args: ["--start-maximized"],
    });
    const pages = browser.pages();
    const page = pages.length ? pages[0] : await browser.newPage();
    return { browser, context: browser, page };
  } else {
    const browser = await chromium.launch({ headless, args: ["--start-maximized"] });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    return { browser, context, page };
  }
}

export async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {}
}

/** Save a screenshot to logs/errors with timestamp */
export async function safeScreenshot(page, tag = "") {
  try {
    const dir = path.join(process.cwd(), "logs", "errors");
    await ensureDir(dir);
    const file = path.join(dir, `error-${Date.now()}${tag ? "-" + tag : ""}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("Saved screenshot:", file);
    return file;
  } catch (e) {
    console.warn("safeScreenshot failed:", e?.message);
    return null;
  }
}

/** Simple logger append (CSV friendly) */
export async function appendLog(filePath, text) {
  try {
    await ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, text);
  } catch (e) {
    console.warn("appendLog error", e?.message);
  }
}

/** Overwrite (create) a file */
export async function saveText(filePath, text) {
  try {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, text);
  } catch (e) {
    console.warn("saveText error", e?.message);
  }
}

/** Read CSV-ish file of request IDs: one per line, skip blank lines */
export async function readIdsFromFile(fn) {
  const raw = await fs.readFile(fn, { encoding: "utf8" });
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // If CSV-like, allow comma separated in first column -> just use first token
  const ids = lines.map((l) => l.split(",")[0].trim());
  return ids;
}
