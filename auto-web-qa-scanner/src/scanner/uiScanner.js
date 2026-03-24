const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { injectCssPathHelper, waitForPageAssets } = require('./utils');
const { takeIssueScreenshot } = require('./screenshotter');

const VIEWPORTS = [
  { name: 'Mobile', width: 375, height: 812 },
  { name: 'Tablet', width: 768, height: 1024 },
  { name: 'Desktop', width: 1280, height: 800 },
];

async function runUIScan(url, jobId, statePath = null, html = null) {
  const issues = [];
  const browser = await chromium.launch({ headless: true });

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
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
    const viewportIssues = [];

    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (e) { }
      try { await waitForPageAssets(page); } catch (e) { }
      await page.waitForTimeout(1000);

      // 1. Elements overflowing viewport (horizontal scroll issues)
      const overflows = await page.evaluate((vw) => {
        const results = [];
        document.querySelectorAll('*').forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.right > vw + 5 && rect.width > 10 && rect.left < vw) {
            results.push({ selector: window.getCssPath(el), right: Math.round(rect.right), vw });
          }
        });
        return results.slice(0, 5);
      }, viewport.width);

      for (const o of overflows) {
        viewportIssues.push({
          title: `Overflow/Clipping Issue at ${viewport.name}`,
          description: `Element "${o.selector}" extends to ${o.right}px, beyond viewport width of ${o.vw}px on ${viewport.name} (${viewport.width}px).`,
          severity: 'Medium',
          url,
          category: 'uiux',
          fix: `Add overflow: hidden or max-width: 100% to the element. Use responsive CSS or flexbox to constrain width.`,
          element: o.selector,
          viewport: viewport.name,
        });
      }

      // 2. Overlapping elements (basic check: elements with same z-index covering each other)
      const overlaps = await page.evaluate(() => {
        const results = [];
        const els = Array.from(document.querySelectorAll('button, a, input, [role="button"]'));
        for (let i = 0; i < Math.min(els.length, 50); i++) {
          for (let j = i + 1; j < Math.min(els.length, 50); j++) {
            const r1 = els[i].getBoundingClientRect();
            const r2 = els[j].getBoundingClientRect();
            if (
              r1.width > 0 && r1.height > 0 && r2.width > 0 && r2.height > 0 &&
              r1.left < r2.right && r1.right > r2.left &&
              r1.top < r2.bottom && r1.bottom > r2.top
            ) {
              const el1Text = els[i].tagName + (els[i].textContent?.trim().slice(0, 20) || '');
              const el2Text = els[j].tagName + (els[j].textContent?.trim().slice(0, 20) || '');
              if (el1Text !== el2Text) {
                results.push({ el1: el1Text, el2: el2Text, selector: window.getCssPath(els[i]) });
              }
            }
          }
        }
        return results.slice(0, 3);
      });

      for (const o of overlaps) {
        viewportIssues.push({
          title: `Overlapping Interactive Elements at ${viewport.name}`,
          description: `"${o.el1}" and "${o.el2}" appear to overlap, potentially causing usability issues.`,
          severity: 'Medium',
          url,
          category: 'uiux',
          fix: 'Adjust z-index, margins, or positioning to prevent elements from overlapping.',
          element: o.selector,
          viewport: viewport.name,
        });
      }

      // 3. Images with zero dimensions (broken layout)
      const zeroImgs = await page.$$eval('img', (imgs) =>
        imgs
          .filter((i) => (i.naturalWidth === 0 || i.naturalHeight === 0) && i.src)
          .map((i) => ({ src: i.src.slice(0, 100), selector: window.getCssPath(i) }))
      );
      for (const img of zeroImgs.slice(0, 3)) {
        viewportIssues.push({
          title: `Image with Zero Dimensions at ${viewport.name}`,
          description: `Image "${img.src}" has zero width or height, causing layout distortion.`,
          severity: 'Low',
          url,
          category: 'uiux',
          fix: 'Set explicit width/height attributes or CSS dimensions on the image.',
          element: img.selector,
          viewport: viewport.name,
        });
      }

    } catch (e) {
      viewportIssues.push({
        title: `UI Scan Error at ${viewport.name}`,
        description: `Could not complete UI scan: ${e.message}`,
        severity: 'Low',
        url,
        category: 'uiux',
        fix: 'Ensure the page loads correctly at all screen sizes.',
        element: null,
        viewport: viewport.name,
      });
    }

    // Take inline screenshots for this viewport
    for (const issue of viewportIssues) {
      if (jobId) {
        issue.screenshot = await takeIssueScreenshot(page, issue, jobId);
      }
    }
    issues.push(...viewportIssues);

    await page.close();
    await context.close();
  }

  await browser.close();
  return issues;
}

module.exports = { runUIScan };
