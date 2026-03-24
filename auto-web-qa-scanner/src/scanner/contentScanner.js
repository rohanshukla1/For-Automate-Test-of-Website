const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { injectCssPathHelper, waitForPageAssets } = require('./utils');
const { takeIssueScreenshot } = require('./screenshotter');

const PLACEHOLDER_PATTERNS = [
  /lorem ipsum/i,
  /\[placeholder\]/i,
  /\[insert\s/i,
  /\btodo\b/i,
  /\bfixme\b/i,
  /sample text/i,
  /dummy text/i,
  /test content/i,
  /your text here/i,
  /coming soon/i,
  /under construction/i,
];

async function runContentScan(url, jobId, statePath = null, html = null) {
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

    // Extract all text content from visible elements
    const texts = await page.$$eval(
      'p, h1, h2, h3, h4, h5, h6, li, span, div, td, th, label, button, a',
      (els) =>
        els
          .filter((el) => {
            const style = window.getComputedStyle(el);
            return (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              el.offsetParent !== null &&
              el.children.length === 0 // leaf text nodes
            );
          })
          .map((el) => ({ text: el.textContent?.trim() || '', tag: el.tagName.toLowerCase(), selector: window.getCssPath(el) }))
          .filter((t) => t.text.length > 3)
    );

    // 1. Placeholder text detection
    for (const { text, tag, selector } of texts) {
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(text)) {
          issues.push({
            title: 'Placeholder/Dummy Text Detected',
            description: `"${text.slice(0, 150)}" appears to be placeholder content in <${tag}>.`,
            severity: 'Medium',
            url,
            category: 'content',
            fix: 'Replace placeholder text with actual, meaningful content before publishing.',
            element: selector,
          });
          break;
        }
      }
    }

    // 2. Grammar checks: Consecutive duplicate words ("the the", "and and")
    for (const { text, tag, selector } of texts) {
      const duplicateMatch = text.match(/\b([a-zA-Z]{3,})\s+\1\b/i);
      if (duplicateMatch) {
        issues.push({
          title: 'Grammar Issue: Repeated Word',
          errorType: 'Grammar',
          description: `Actual Error on Page: The word "${duplicateMatch[1]}" is repeated consecutively.\nContext: "${text.slice(0, 120)}..."`,
          severity: 'Medium',
          url,
          category: 'content',
          fix: 'Remove the duplicate word to improve readability and grammar.',
          element: selector,
        });
      }
    }

    // 6. Spelling checks: Common typos
    const typos = { "teh": "the", "recieve": "receive", "seperate": "separate", "definately": "definitely", "alot": "a lot", "untill": "until", "occured": "occurred", "adress": "address", "calender": "calendar", "tommorow": "tomorrow", "accomodate": "accommodate", "foward": "forward", "wich": "which" };
    for (const { text, tag, selector } of texts) {
      for (const [wrong, right] of Object.entries(typos)) {
        const regex = new RegExp(`\\b${wrong}\\b`, 'i');
        if (regex.test(text)) {
          issues.push({
            title: 'Spelling Mistake Detected',
            errorType: 'Spelling',
            description: `Actual Error on Page: Found common typo "${wrong}". Did you mean "${right}"?\nContext: "${text.slice(0, 120)}..."`,
            severity: 'Medium',
            url,
            category: 'content',
            fix: `Correct the spelling of "${wrong}" to "${right}".`,
            element: selector,
          });
        }
      }
    }

    // 4. Web Standards Checks (W3C HTML compliance that affects users)
    const standardsIssues = await page.evaluate(() => {
      const issues = [];
      
      if (document.doctype === null) {
        issues.push({ title: 'Missing DOCTYPE HTML', type: 'W3C Standards', desc: 'The page is missing a <!DOCTYPE html> declaration at the very top. This forces browsers into legacy Quirks Mode, severely breaking modern CSS and layout pipelines for users.', severe: 'High' });
      }

      if (!document.title || document.title.trim().length === 0) {
        issues.push({ title: 'Missing or Empty <title>', type: 'User Experience', desc: 'The page has no title tag. Users will see "Untitled Document" in their browser tabs.', severe: 'High' });
      }

      // Duplicate IDs physically break anchor linking and JS querySelectors
      const allElements = document.querySelectorAll('[id]');
      const ids = {};
      const duplicates = new Set();
      allElements.forEach(el => {
        if (ids[el.id]) duplicates.add(el.id);
        else ids[el.id] = true;
      });
      if (duplicates.size > 0) {
        issues.push({ title: 'Duplicate HTML IDs', type: 'W3C Bug', desc: `Found duplicated IDs on the page: ${Array.from(duplicates).slice(0, 3).join(', ')}. The id attribute must be mathematically unique across the entire DOM tree because it physically breaks anchor scroll links and Javascript functionality.`, severe: 'High' });
      }

      return issues;
    });

    for (const std of standardsIssues) {
      issues.push({
        title: std.title,
        errorType: std.type,
        description: `Actual Error on Page: ${std.desc}`,
        severity: std.severe,
        url,
        category: 'content',
        fix: 'Recode the application HTML to strictly adhere to modern W3C web standards.',
        element: null,
      });
    }

  } catch (e) {
    issues.push({
      title: 'Content Scan Error',
      errorType: 'Crash',
      description: `Could not complete content scan: ${e.message}`,
      severity: 'Low',
      url,
      category: 'content',
      fix: 'Ensure the page loads correctly for content analysis.',
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

module.exports = { runContentScan };
