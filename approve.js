import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { cfg } from "./config.js";
import {
  ensureDir,
  ts,
  readRequests,
  appendLog,
  safeText,
  sleep
} from "./utils.js";

const LOGS_DIR = path.resolve("logs");
ensureDir(LOGS_DIR);

function userDataDir() {
  return `C:\\Users\\${cfg.edgeProfileUser}\\AppData\\Local\\Microsoft\\Edge\\User Data`;
}

async function startBrowser() {
  const profile = userDataDir();
  let context;

  if (fs.existsSync(profile)) {
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: false,
        channel: "msedge",
        viewport: { width: 1400, height: 900 }
      });
      return context;
    } catch (e) {
      console.warn("Edge persistent failed:", e.message);
    }
  }

  const browser = await chromium.launch({
    headless: false,
    channel: "msedge"
  });

  context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });

  return context;
}

async function gotoHome(page) {
  await page.goto(cfg.urls.homeNoelle, {
    waitUntil: "domcontentloaded"
  });
  await page.waitForLoadState("networkidle");
}

async function getActiveUser(page) {
  const body = await page.textContent("body").catch(() => "");
  return body || "";
}

async function clickIf(page, selector) {
  try {
    const loc = page.locator(selector);
    if (await loc.count()) {
      await loc.first().click();
      return true;
    }
  } catch (e) {}
  return false;
}

async function switchUser(page, who) {
  console.log(`→ Switching to ${who}`);

  await clickIf(page, cfg.sel.switchLink);
  await sleep(300);

  await page.waitForSelector(`text=${cfg.sel.switchDialogTitle}`, {
    timeout: 4000
  }).catch(() => {});

  await clickIf(page, cfg.sel.switchOption(who));
  await sleep(300);

  await clickIf(page, cfg.sel.switchConfirm);
  await page.waitForLoadState("networkidle");
  await sleep(800);
}

async function clearSearch(page) {
  await page.click(cfg.sel.searchInput);
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
}

async function selectBySearch(page, id) {
  await clearSearch(page);
  await page.fill(cfg.sel.searchInput, id);

  for (let i = 0; i < 12; i++) {
    await sleep(200);
    const rowCount = await page
      .locator(cfg.sel.rowById(id))
      .count()
      .catch(() => 0);

    if (rowCount > 0) {
      try {
        await page.check(cfg.sel.rowCheckbox(id), { timeout: 2000 });
        return true;
      } catch (e) {
        const row = page.locator(cfg.sel.rowById(id)).first();
        await row.click({ position: { x: 20, y: 10 } }).catch(() => {});
        try {
          await page.check(cfg.sel.rowCheckbox(id));
          return true;
        } catch {}
      }
    }
  }
  return false;
}

async function bulkApprove(page) {
  await page.click(cfg.sel.bulkApproveBtn);
  await sleep(300);
  await clickIf(page, cfg.sel.approveConfirmBtn);
  await sleep(800);
}

async function batchApproveInUser(page, ids, batchSize = cfg.batchSize) {
  const left = new Set(ids);

  while (left.size > 0) {
    let selected = 0;

    for (const id of [...left]) {
      const ok = await selectBySearch(page, id);
      if (ok) {
        left.delete(id);
        selected++;
      }
      if (selected >= batchSize) break;
    }

    if (selected === 0) break;

    await bulkApprove(page);
    await clearSearch(page);
  }

  return [...left];
}

async function main() {
  const input = process.argv[2] || "requests.csv";

  if (!fs.existsSync(input)) {
    console.error("requests.csv not found");
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

  // Always begin in Noelle
  const body = await getActiveUser(page);

  if (!body.includes("Eder")) {
    if (body.includes("Gupta")) await switchUser(page, cfg.users.noelle);
    if (body.includes("Garrido")) await switchUser(page, cfg.users.noelle);
  }

  console.log("→ Approving in Noelle...");

  const notFoundNoelle = await batchApproveInUser(page, ids);
  const approvedNoelle = ids.filter((x) => !notFoundNoelle.includes(x));

  for (const x of approvedNoelle)
    appendLog(outPath, `${ts()},${x},approved_in_noelle,\n`);

  if (notFoundNoelle.length === 0) {
    console.log("✔ All approved in Noelle.");
    await context.close();
    return;
  }

  console.log("→ Switching to Alvaro...");
  await switchUser(page, cfg.users.alvaro);

  const notFoundAlvaro = await batchApproveInUser(
    page,
    notFoundNoelle
  );
  const approvedAlvaro = notFoundNoelle.filter(
    (x) => !notFoundAlvaro.includes(x)
  );

  for (const x of approvedAlvaro)
    appendLog(outPath, `${ts()},${x},approved_in_alvaro,\n`);

  if (approvedAlvaro.length > 0) {
    console.log("→ Returning to Noelle to finalize chain...");
    await switchUser(page, cfg.users.noelle);

    const notFoundAfterAlvaro = await batchApproveInUser(
      page,
      approvedAlvaro
    );

    for (const x of approvedAlvaro) {
      if (!notFoundAfterAlvaro.includes(x)) {
        appendLog(
          outPath,
          `${ts()},${x},approved_after_alvaro_then_noelle,\n`
        );
      } else {
        appendLog(
          outPath,
          `${ts()},${x},approved_in_alvaro_only,Noelle did not show afterward\n`
        );
      }
    }
  }

  for (const x of notFoundAlvaro)
    appendLog(outPath, `${ts()},${x},not_found_anywhere,\n`);

  console.log("✔ DONE → Log saved:", outPath);

  await context.close();
}

main();
