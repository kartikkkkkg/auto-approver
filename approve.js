// approve.js
// Usage: node approve.js "Eder, Noelle"
// Requires: npm install puppeteer
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const LOGS_DIR = path.join(__dirname, 'logs', 'errors');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g,'-');
}

async function saveScreenshot(page, namePrefix) {
  const p = path.join(LOGS_DIR, `${nowStamp()}-${namePrefix}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log('Saved screenshot:', p);
  return p;
}

// Helpful utility: normalized text
function normalizeText(s) {
  return s ? s.replace(/\s+/g,' ').trim().toLowerCase() : '';
}

async function clickElementByText(page, selector, wantedText) {
  // returns true if clicked
  const clicked = await page.evaluate((sel, wantedText) => {
    const norm = t => (t || '').replace(/\s+/g,' ').trim().toLowerCase();
    const nodes = Array.from(document.querySelectorAll(sel || '*'));
    for (const n of nodes) {
      // inspect visible text
      const text = norm(n.innerText || n.textContent || n.value || '');
      if (!text) continue;
      if (text.includes(wantedText.toLowerCase())) {
        // ensure it's visible
        n.scrollIntoView && n.scrollIntoView({ block: 'center' });
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
        n.dispatchEvent(ev);
        const ev2 = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
        n.dispatchEvent(ev2);
        n.click && n.click();
        return true;
      }
    }
    return false;
  }, selector, wantedText);
  return clicked;
}

async function selectUserInSwitchDialog(page, userFullName) {
  // Try multiple strategies. Return true on success.
  userFullName = (userFullName || '').trim();
  if (!userFullName) throw new Error('No user name provided.');

  // Strategy 0: Native <select>
  try {
    const selectHandle = await page.$('select');
    if (selectHandle) {
      console.log('Found native <select> - trying select option by value/text');
      // Try by visible text
      const success = await page.evaluate((selText) => {
        const s = document.querySelector('select');
        if (!s) return false;
        // try exact match
        for (const opt of Array.from(s.options)) {
          if ((opt.text || '').trim().toLowerCase() === selText.toLowerCase()) {
            s.value = opt.value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        // try includes
        for (const opt of Array.from(s.options)) {
          if ((opt.text || '').toLowerCase().includes(selText.toLowerCase())) {
            s.value = opt.value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, userFullName);
      if (success) {
        console.log('Selected via native <select>.');
        return true;
      }
      console.log('Native <select> present but option not found.');
    }
  } catch (e) {
    console.warn('Native select attempt failed:', e && e.message);
  }

  // Strategy 1: Find an input (combobox/search) inside the modal and type text
  const possibleInputSelectors = [
    'div[role="dialog"] input[placeholder*="Select"]',
    'div[role="dialog"] input[placeholder*="Search"]',
    'div[role="dialog"] input[type="search"]',
    'div[role="dialog"] input',
    'input[placeholder*="Select"]',
    'input[aria-label*="User"]',
    'input[role="combobox"]',
    'input'
  ];

  for (const sel of possibleInputSelectors) {
    try {
      const input = await page.$(sel);
      if (!input) continue;
      console.log('Using input selector:', sel);
      await input.click({ clickCount: 3 }).catch(()=>{});
      await input.focus();
      // clear field
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await input.type(userFullName, { delay: 60 });

      // wait for options list to appear
      const listSelectors = [
        'div[role="listbox"]',
        'ul[role="listbox"]',
        '.select__menu',
        '.dropdown-menu',
        '.rc-virtual-list',
        '.options',
        '.Select-menu',
        'div[role="presentation"] li',
        'div[role="option"]'
      ];
      let found = false;
      for (const lsel of listSelectors) {
        try {
          await page.waitForSelector(lsel, { timeout: 1500 });
          // click first that matches text
          const clicked = await clickElementByText(page, lsel + ' *', userFullName);
          if (clicked) { found = true; break; }
        } catch (e) {
          // no list with that selector
        }
      }
      if (found) {
        console.log('Selected via combobox typing + list click.');
        return true;
      }

      // fallback: press ArrowDown + Enter (some comboboxes respond)
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      // wait a bit and check if selection happened by checking that the dropdown input now has the selected text
      await page.waitForTimeout(700);
      // verify by reading input value or placeholder
      const curVal = await page.evaluate((elSel) => {
        const el = document.querySelector(elSel);
        if (!el) return '';
        return (el.value || el.innerText || el.textContent || '').trim();
      }, sel);
      if (curVal && curVal.toLowerCase().includes(userFullName.toLowerCase().split(' ')[0])) {
        console.log('Selection likely succeeded via ArrowDown+Enter. Current value:', curVal);
        return true;
      }
      console.log('Typing approach did not find the option for selector', sel);
    } catch (e) {
      // ignore and continue to next selector
      console.warn('Combobox attempt with', sel, 'failed:', e && e.message);
    }
  }

  // Strategy 2: click the dropdown toggle to open options, then click option by visible text
  const dropdownToggleSelectors = [
    'div[role="dialog"] .dropdown-toggle',
    'div[role="dialog"] .select__control',
    '.select__control',
    '.dropdown-toggle',
    '.rc-select',
    '[aria-haspopup="listbox"]',
    '[data-toggle="dropdown"]',
    'button[aria-expanded]'
  ];
  for (const toggleSel of dropdownToggleSelectors) {
    try {
      const toggle = await page.$(toggleSel);
      if (!toggle) continue;
      console.log('Found dropdown toggle:', toggleSel);
      await toggle.click({ delay: 50 });
      // wait for options to appear
      await page.waitForTimeout(400);
      // look for any option nodes and match text
      const optionSelectors = [
        'div[role="option"]',
        'li[role="option"]',
        '.select__option',
        '.dropdown-item',
        '.option',
        '.rc-virtual-list-holder li',
        '.ant-select-item'
      ];
      for (const optSel of optionSelectors) {
        try {
          await page.waitForSelector(optSel, { timeout: 1200 });
          const clicked = await clickElementByText(page, optSel, userFullName);
          if (clicked) {
            console.log('Clicked option via toggle+optionSelector', optSel);
            return true;
          }
        } catch (e) {
          // no options with that selector
        }
      }
      // if not found, try global match
      const clickedGlobal = await clickElementByText(page, '*', userFullName);
      if (clickedGlobal) return true;
    } catch (e) {
      console.warn('Dropdown toggle attempt failed for', toggleSel, e && e.message);
    }
  }

  // Strategy 3: global search for visible nodes with the name and click them
  try {
    const clicked = await clickElementByText(page, '*', userFullName);
    if (clicked) {
      console.log('Clicked a global element matching the user text.');
      return true;
    }
  } catch(e){
    console.warn('Global click attempt failed:', e && e.message);
  }

  // All strategies failed
  return false;
}

async function clickSwitchButton(page) {
  // Try several selectors to find the "Switch" button inside modal
  const switchSelCandidates = [
    'div[role="dialog"] button',
    'div[role="dialog"] .btn-primary',
    'button:contains("Switch")', // won't work in querySelector, used differently below
    'button'
  ];
  // Best approach: find any button whose visible text contains "switch"
  const clicked = await page.evaluate(() => {
    const norm = t => (t || '').replace(/\s+/g,' ').trim().toLowerCase();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of buttons) {
      try {
        const t = norm(b.innerText || b.textContent || b.value);
        if (!t) continue;
        if (t === 'switch' || t.includes('switch')) {
          b.scrollIntoView && b.scrollIntoView({ block: 'center' });
          b.click();
          return true;
        }
      } catch (e) { /* ignore */ }
    }
    return false;
  });
  return clicked;
}

(async () => {
  const userName = process.argv[2] || 'Eder, Noelle';
  console.log('Requested user to select:', userName);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  const page = (await browser.pages())[0];

  try {
    // --- IMPORTANT: insert your authentication/navigation here ---
    // The script assumes you're already on the page with the Switch modal open.
    // If not, uncomment or add steps to navigate/login to your app and open the modal.
    //
    // Example:
    // await page.goto('https://your-workforce-mgmt.example.com/manage-requests');
    // await page.waitForSelector('button#open-switch-dialog');
    // await page.click('button#open-switch-dialog');

    // Wait a little for modal to be ready
    await page.waitForTimeout(800);

    // Try to select user, with retries (some UIs close the list quickly)
    const MAX_ATTEMPTS = 4;
    let success = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; ++attempt) {
      console.log(`Attempt ${attempt} to select user...`);
      success = await selectUserInSwitchDialog(page, userName);
      if (success) break;
      // small recovery: try to re-open the modal if it was closed (click the "Switch" link at top)
      console.log('Selection attempt failed — trying to re-open modal/refresh state and retry...');
      await page.waitForTimeout(600);
      // Try clicking any "Switch" open link in page header
      try {
        await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a, button'));
          for (const l of links) {
            const t = (l.innerText || l.textContent || '').trim().toLowerCase();
            if (t === 'switch' || t.includes('switch view') || t.includes('switch')) {
              try { l.click(); } catch(e){}
            }
          }
        });
      } catch (e) {}
      await page.waitForTimeout(600);
    }

    if (!success) {
      const shot = await saveScreenshot(page, 'switch-failed');
      const errPath = path.join(LOGS_DIR, `${nowStamp()}-switch-error.txt`);
      fs.writeFileSync(errPath, `Could not select "${userName}" in Switch dialog. Screenshot: ${shot}\n`);
      console.error('Fatal error: unable to programmatically select', userName);
      await page.waitForTimeout(8000); // leave browser open for inspection (similar to your current flow)
      process.exitCode = 1;
      return;
    }

    // After successful selection, click the Switch button
    const clickedSwitchBtn = await clickSwitchButton(page);
    if (!clickedSwitchBtn) {
      console.warn('Could not find/click the Switch button automatically. Please click it manually or adapt selector.');
      await saveScreenshot(page, 'no-switch-button-found');
      process.exitCode = 2;
      return;
    }

    console.log('Switch clicked successfully — waiting for app to change view.');
    await page.waitForTimeout(1200);
    // continue with your approval flows here...
    // e.g. run approval logic, click requests, etc.

    console.log('Done (switch flow).');
    // optionally: await browser.close();
    await page.waitForTimeout(1500);

  } catch (err) {
    console.error('Unhandled error:', err && err.stack || err);
    await saveScreenshot(page, 'fatal');
    fs.writeFileSync(path.join(LOGS_DIR, `${nowStamp()}-fatal-error.txt`), String(err));
    // leave browser open so you can inspect (same behaviour you had in logs)
    await page.waitForTimeout(8000);
  } finally {
    // we purposely do not always close the browser so you can inspect on failures
    // await browser.close();
  }

})();
