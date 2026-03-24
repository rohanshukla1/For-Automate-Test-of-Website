const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const jobStore = require('../jobStore');

/**
 * Attempts to log into an application using heuristics to find the email/password fields.
 * If successful, saves the browser context storageState to disk and returns the path.
 */
async function authenticate(jobId) {
  const job = jobStore.get(jobId);
  if (!job || !job.email || !job.password) return null;

  updateJob(jobId, { step: 'Authenticating with provided credentials...' });

  const statePath = path.join(__dirname, '../../reports', jobId, 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) {}

    // 1. Find and fill email/username
    // Give it up to 10 seconds to find any reasonable login input
    const emailLocators = [
      'input[type="email"]',
      'input[name*="user"]',
      'input[name*="email"]',
      'input[id*="user"]',
      'input[id*="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="user" i]'
    ].join(', ');
    
    const emailInput = page.locator(emailLocators).first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(job.email);

    // 2. Find and fill password
    const passLocators = [
      'input[type="password"]',
      'input[name*="pass"]',
      'input[id*="pass"]',
      'input[placeholder*="pass" i]'
    ].join(', ');

    const passInput = page.locator(passLocators).first();
    await passInput.waitFor({ state: 'visible', timeout: 5000 });
    await passInput.fill(job.password);

    // 3. Find and click submit/login button
    // Universal login: pressing Enter inside the password field
    await passInput.press('Enter');
    await page.waitForTimeout(1000);

    const submitLocators = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("LOG IN")',
      'button:has-text("SIGN IN")',
      'form button'
    ];

    let clicked = false;
    for (const sel of submitLocators) {
      const btnLocs = page.locator(sel);
      const count = await btnLocs.count();
      for (let i = 0; i < count; i++) {
        const btn = btnLocs.nth(i);
        if (await btn.isVisible()) {
          try {
             await btn.click({ timeout: 3000 });
             clicked = true;
             break;
          } catch(e) {}
        }
      }
      if (clicked) break;
    }

    // 4. Wait for navigation/network to settle after login
    // Wait for URL change or a "logged in" element (logout, profile, dashboard, etc.)
    const currentUrl = page.url();
    try {
      await Promise.race([
        page.waitForURL(url => url !== currentUrl, { timeout: 20000 }),
        page.waitForSelector('text=Logout, text=Log out, text=Sign out, .profile, .dashboard, .user, [aria-label*="profile" i]', { state: 'visible', timeout: 20000 })
      ]);
    } catch (e) {
      console.log('[Auth] No clear redirect detected, waiting for network idle...');
    }

    // EXTRA WAIT for Dashboard content (cards, charts, etc.)
    await page.waitForTimeout(5000); 
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (e) {}

    // 5. Save state
    await context.storageState({ path: statePath });
    const finalUrl = page.url();
    return { statePath, finalUrl };
  } catch (err) {
    console.warn(`[Job ${jobId}] Authentication failed:`, err.message);
    // Take a screenshot to help debug
    await page.screenshot({ path: path.join(path.dirname(statePath), 'auth_fail.png') }).catch(()=>{});
    return null;
  } finally {
    await page.close();
    await browser.close();
  }
}

function updateJob(jobId, updates) {
  const job = jobStore.get(jobId);
  if (job) jobStore.set(jobId, { ...job, ...updates });
}

module.exports = { authenticate };
