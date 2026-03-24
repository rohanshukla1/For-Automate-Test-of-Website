const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { injectCssPathHelper, waitForPageAssets } = require('./utils');
const { takeIssueScreenshot } = require('./screenshotter');

async function runMediaScan(url, jobId, statePath = null, html = null) {
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

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (e) { }
    try { await waitForPageAssets(page); } catch (e) { }
    await page.waitForTimeout(1000);

    // 1. Broken images (naturalWidth === 0)
    const brokenImages = await page.$$eval('img', (imgs) =>
      imgs
        .filter((img) => img.complete && img.naturalWidth === 0)
        .map((img) => ({ src: img.src || img.getAttribute('src') || '[no src]', alt: img.alt, selector: window.getCssPath(img) }))
    );
    for (const img of brokenImages) {
      issues.push({
        title: 'Broken Image',
        description: `Image "${img.src}" failed to load. Alt text: "${img.alt || '[none]'}"`,
        severity: 'High',
        url,
        category: 'media',
        fix: `Verify the image path "${img.src}" is correct and the file exists on the server.`,
        element: img.selector,
      });
    }

    // 2. Images without src attribute
    const noSrcImages = await page.$$eval('img', (imgs) =>
      imgs.filter((img) => !img.src).map((img) => window.getCssPath(img))
    );
    for (const selector of noSrcImages) {
      issues.push({
        title: 'Image Without Source',
        description: 'An <img> element is missing its src attribute entirely.',
        severity: 'High',
        url,
        category: 'media',
        fix: 'Add a valid src attribute to all <img> elements.',
        element: selector,
      });
    }



    // 4. Images larger than 500KB (from resource timing transferSize)
    const heavyImages = await page.evaluate(() => {
      const entries = performance.getEntriesByType('resource');
      return entries
        .filter((e) => e.initiatorType === 'img' && e.transferSize > 500000)
        .map((e) => ({ url: e.name, size: Math.round(e.transferSize / 1024) }));
    });
    for (const img of heavyImages.slice(0, 5)) {
      issues.push({
        title: 'Oversized Image',
        description: `Image "${img.url}" is ${img.size}KB, which is too large and will slow down page loads.`,
        severity: 'Medium',
        url,
        category: 'media',
        fix: 'Compress the image using tools like Squoosh or TinyPNG. Target < 200KB for web images.',
        element: null,
      });
    }

    // 5. Video/audio with no fallback text
    const noFallbackMedia = await page.$$eval('video, audio', (els) =>
      els
        .filter((el) => el.textContent.trim().length === 0 && !el.querySelector('track'))
        .map((el) => ({ tag: el.tagName.toLowerCase(), selector: window.getCssPath(el) }))
    );
    for (const { tag, selector } of noFallbackMedia) {
      issues.push({
        title: `<${tag}> Missing Fallback Content`,
        description: `A <${tag}> element has no fallback text or captions for unsupported browsers.`,
        severity: 'Low',
        url,
        category: 'media',
        fix: `Add fallback text inside the <${tag}> element or use <track> for captions/subtitles.`,
        element: selector,
      });
    }

  } catch (e) {
    issues.push({
      title: 'Media Scan Error',
      description: `Could not complete media scan: ${e.message}`,
      severity: 'Low',
      url,
      category: 'media',
      fix: 'Ensure the page loads correctly for media analysis.',
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

module.exports = { runMediaScan };
