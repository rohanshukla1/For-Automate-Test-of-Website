const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { injectCssPathHelper, waitForPageAssets } = require('./utils');
const { takeIssueScreenshot } = require('./screenshotter');

async function runFunctionalScan(url, jobId, statePath = null, html = null) {
  const issues = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(statePath ? { storageState: statePath } : {})
  });
  await injectCssPathHelper(context);

  const sessionPath = statePath ? path.join(path.dirname(statePath), 'session.json') : null;
  if (sessionPath && fs.existsSync(sessionPath)) {
    const sessionData = JSON.parse(fs.readFileSync(sessionPath));
    if (sessionData && sessionData.length > 0) {
      await context.addInitScript((data) => {
        data.forEach(([k, v]) => sessionStorage.setItem(k, v));
      }, sessionData);
    }
  }

  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const networkFailures = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location() });
    }
  });

  page.on('pageerror', (exception) => {
    pageErrors.push(exception);
  });

  const ignoredDomains = [
    'google-analytics.com', 
    'googletagmanager.com', 
    'facebook.net', 
    'clarity.ms', 
    'hotjar.com', 
    'doubleclick.net'
  ];

  page.on('requestfailed', (request) => {
    const reqUrl = request.url();
    // Ignore common tracking scripts failing in headless mode
    if (ignoredDomains.some(d => reqUrl.includes(d))) return;
    
    networkFailures.push({
      url: reqUrl,
      reason: request.failure()?.errorText || 'Unknown',
    });
  });

  const responseMap = new Map();
  page.on('response', (response) => {
    responseMap.set(response.url(), response.status());
  });

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (e) { }
    try { await waitForPageAssets(page); } catch (e) { }
    await page.waitForTimeout(1000);

    // 1. Uncaught Page Exceptions (Crashes)
    for (const err of pageErrors) {
      issues.push({
        title: 'Uncaught JavaScript Exception',
        errorType: 'App Crash',
        description: `Actual Error on Page:\n${err.message}\n\nStack Trace:\n${err.stack || 'No stack trace'}`,
        severity: 'High',
        url,
        category: 'functional',
        fix: 'Fix the fatal JavaScript exception preventing the page from running correctly.',
        element: null,
      });
    }

    // 2. JavaScript console errors
    for (const err of consoleErrors) {
      const loc = err.location ? `${err.location.url}:${err.location.lineNumber}` : 'Unknown location';
      issues.push({
        title: 'JavaScript Console Error',
        errorType: 'Console Error',
        description: `Actual Error on Page: ${err.text.slice(0, 300)}\n\nLocation: ${loc}`,
        severity: 'High',
        url,
        category: 'functional',
        fix: 'Review the browser console output and resolve the script error.',
        element: null,
      });
    }

    // 3. Network request failures
    for (const fail of networkFailures.slice(0, 10)) {
      issues.push({
        title: 'Network Request Failed',
        errorType: `Network (${fail.reason})`,
        description: `Actual Error: The browser failed to download the required resource "${fail.url}". Exact reason: ${fail.reason}`,
        severity: 'High',
        url,
        category: 'functional',
        fix: 'Ensure the endpoint is online, CORS is configured correctly, and the URL is accurate.',
        element: null,
      });
    }

    // 4. Broken links (4xx, 5xx) detected from network responses
    for (const [resUrl, status] of responseMap.entries()) {
      if (status >= 400) {
        issues.push({
          title: `Broken Resource (HTTP ${status})`,
          errorType: `HTTP ${status}`,
          description: `Actual Error on Page: The server responded with a ${status} error code when trying to load "${resUrl}".`,
          severity: status >= 500 ? 'High' : 'Medium',
          url,
          category: 'functional',
          fix: `Fix the broken reference to "${resUrl}" or ensure the server handles the request with a 2xx success status.`,
          element: null,
        });
      }
    }

    // 5. Dead Link Verification (Actively Check Clickable Links)
    const linksOnPage = await page.$$eval('a[href]', (els) => {
      return els
        .map(el => el.href)
        .filter(href => href.startsWith('http'))
        .filter((v, i, a) => a.indexOf(v) === i); // Unique absolute URLs
    });

    for (const linkUrl of linksOnPage.slice(0, 15)) { // Check top 15 links to prevent extreme scan times
      try {
        // Use Node fetch to avoid CORS errors from browser eval
        const res = await fetch(linkUrl, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
                          .catch(() => fetch(linkUrl, { method: 'GET', signal: AbortSignal.timeout(5000) }));
        
        if (!res || (!res.ok && res.status >= 400)) {
          issues.push({
            title: 'Dead Clickable Link Detected',
            errorType: 'Broken Link',
            description: `Actual Error on Page: A user-facing anchor link pointing to "${linkUrl}" is physically broken. It returned an HTTP ${res ? res.status : 'Network/Timeout'} error.`,
            severity: 'High',
            url,
            category: 'functional',
            fix: 'Remove the dead link or fix the URL to point to an active, working webpage.',
            element: `a[href*="${new URL(linkUrl).pathname}"]`,
          });
        }
      } catch (e) {
        // Timeout or hard failure
        issues.push({
          title: 'Unreachable Clickable Link',
          errorType: 'Dead Link',
          description: `Actual Error on Page: A user-facing link pointing to "${linkUrl}" could not be reached (Network Timeout or DNS failure).`,
          severity: 'High',
          url,
          category: 'functional',
          fix: 'Ensure the link points to a publicly accessible resource and has no typos.',
          element: null, // Hard to reliably select cross-domain links sometimes
        });
      }
    }

  } catch (e) {
    issues.push({
      title: 'Page Load Failure',
      description: `Could not fully load page: ${e.message}`,
      severity: 'High',
      url,
      category: 'functional',
      fix: 'Verify the URL is accessible and the server is running.',
      element: null,
    });
  }

  // Take inline screenshots while page is still open
  for (const issue of issues) {
    if (jobId) {
      issue.screenshot = await takeIssueScreenshot(page, issue, jobId);
    }
  }

  await page.close();
  await browser.close();

  return issues;
}

module.exports = { runFunctionalScan };
