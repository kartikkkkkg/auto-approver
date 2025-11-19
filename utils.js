import fs from "fs";
import path from "path";

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\..+/, "");
}

export function readRequests(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw
    .split(/\r?\n/)
    .map((l) => l.split(",")[0].trim())
    .filter(Boolean);
}

export function appendLog(file, line) {
  fs.appendFileSync(file, line);
}

export function safeText(s) {
  return (s || "").replace(/"/g, '""');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
export async function saveText(filename, text) {
  try {
    await fs.promises.writeFile(filename, text, "utf8");
  } catch (e) {
    console.warn("saveText failed:", e.message);
  }
}
