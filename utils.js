import fs from "fs";
import path from "path";

/**
 * Ensures that a directory exists (creates if missing)
 */
export function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    console.warn("ensureDir failed:", e.message);
  }
}

/**
 * Timestamp helper
 */
export function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Reads a CSV containing request IDs (one per line)
 */
export function readRequests(csvPath) {
  try {
    const raw = fs.readFileSync(csvPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  } catch (e) {
    console.error("readRequests failed:", e.message);
    return [];
  }
}

/**
 * Appends a line to a log file
 */
export function appendLog(filePath, line) {
  try {
    fs.appendFileSync(filePath, line, "utf8");
  } catch (e) {
    console.warn("appendLog failed:", e.message);
  }
}

/**
 * Sleep helper
 */
export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Captures a screenshot safely
 */
export async function safeScreenshot(page, nameSuffix = "") {
  try {
    const filename = path.join("logs", "errors", `${Date.now()}${nameSuffix}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log("Saved screenshot:", filename);
    return filename;
  } catch (e) {
    console.warn("safeScreenshot failed:", e.message);
    return null;
  }
}

/**
 * Writes text to a file safely
 */
export async function saveText(filename, text) {
  try {
    await fs.promises.writeFile(path.join("logs", "errors", filename), text, "utf8");
  } catch (e) {
    console.warn("saveText failed:", e.message);
  }
}
