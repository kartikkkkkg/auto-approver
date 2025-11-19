// utils.js
import fs from "fs";
import path from "path";

/**
 * Ensure directory exists (creates recursively)
 */
export function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    console.warn("ensureDir failed:", e.message);
  }
}

/**
 * Timestamp string usable in filenames
 */
export function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Read CSV of requests (simple one-column list or header+one column).
 * Returns array of trimmed IDs (skips blank lines).
 */
export function readRequests(csvPath) {
  const txt = fs.readFileSync(csvPath, { encoding: "utf8" });
  const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // if file has header that looks like non-numeric first line, ignore first line
  if (lines.length > 1 && /[A-Za-z]/.test(lines[0]) && !/^\d/.test(lines[0])) {
    lines.shift();
  }
  return lines;
}

/**
 * Append a single CSV line to a log file
 */
export function appendLog(filePath, text) {
  fs.appendFileSync(filePath, text, { encoding: "utf8" });
}

/**
 * Sleep helper (ms)
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Save a text file to the errors/logs directory (useful for dumps)
 */
export function saveText(name, text, dir = "logs/errors") {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, text, "utf8");
    return p;
  } catch (e) {
    console.warn("saveText failed:", e.message);
    return null;
  }
}
