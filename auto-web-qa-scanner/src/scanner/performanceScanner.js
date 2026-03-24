const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { waitForPageAssets } = require('./utils');

async function runPerformanceScan(url, jobId, statePath = null, html = null) {
  const issues = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(statePath ? { storageState: statePath } : {})
  });

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

  try {
    const startTime = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    const loadTime = Date.now() - startTime;
    try { await waitForPageAssets(page); } catch (e) { }
    await page.waitForTimeout(1000);

    // 1. Page load time
    if (loadTime > 5000) {
      issues.push({
        title: 'Slow Page Load Time',
        description: `Page took ${(loadTime / 1000).toFixed(2)}s to load. Ideal load time is under 3s.`,
        severity: 'High',
        url,
        category: 'performance',
        fix: 'Optimize critical resources, enable caching, use a CDN, and minimize render-blocking scripts.',
        element: null,
      });
    } else if (loadTime > 3000) {
      issues.push({
        title: 'Moderate Page Load Time',
        description: `Page took ${(loadTime / 1000).toFixed(2)}s to load. Target under 3s for good UX.`,
        severity: 'Medium',
        url,
        category: 'performance',
        fix: 'Consider lazy-loading images, deferring scripts, and optimizing server response time.',
        element: null,
      });
    }

    // (Removed pure engineering metrics like TTFB and Raw Transfer Size)

    // 3. Heavy resource detection
    const heavyResources = await page.evaluate(() => {
      const entries = performance.getEntriesByType('resource');
      return entries
        .filter((e) => e.transferSize > 500 * 1024)
        .map((e) => ({
          url: e.name,
          size: Math.round(e.transferSize / 1024),
          type: e.initiatorType,
          duration: Math.round(e.duration),
        }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 5);
    });

    for (const res of heavyResources) {
      issues.push({
        title: `Heavy Asset Detected (${res.type})`,
        description: `"${res.url.split('/').pop()}" is ${res.size}KB (${res.type}), taking ${res.duration}ms to load.`,
        severity: res.size > 1000 ? 'High' : 'Medium',
        url,
        category: 'performance',
        fix: `Compress or optimize this ${res.type} asset. Consider code splitting for JS bundles.`,
        element: null,
      });
    }

    // (Removed Render-Blocking Script and Raw CSS Size checks to prevent false positive nitpicks)

  } catch (e) {
    issues.push({
      title: 'Performance Scan Error',
      description: `Could not complete performance scan: ${e.message}`,
      severity: 'Low',
      url,
      category: 'performance',
      fix: 'Ensure the page is accessible for performance analysis.',
      element: null,
    });
  } finally {
    await page.close();
    await browser.close();
  }

  return issues;
}

module.exports = { runPerformanceScan };
