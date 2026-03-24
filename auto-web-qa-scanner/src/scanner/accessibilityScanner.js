const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { injectCssPathHelper } = require('./utils');
const { takeIssueScreenshot } = require('./screenshotter');

async function runAccessibilityScan(url, jobId, statePath = null, html = null) {
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

    // 1. Images missing alt text
    const missingAlt = await page.$$eval('img', (imgs) =>
      imgs
        .filter((img) => !img.hasAttribute('alt') || img.alt.trim() === '')
        .map((img) => ({ src: img.src || img.getAttribute('src') || '[no src]', selector: window.getCssPath(img) }))
        .slice(0, 10)
    );
    for (const img of missingAlt) {
      issues.push({
        title: 'Image Missing Alt Text',
        description: `Image "${img.src.slice(0, 100)}" has no alt attribute, making it inaccessible to screen readers.`,
        severity: 'High',
        url,
        category: 'accessibility',
        fix: 'Add a descriptive alt attribute to every <img> element. Use alt="" for purely decorative images.',
        element: img.selector,
      });
    }

    // 2. Heading hierarchy validation
    const headings = await page.$$eval('h1, h2, h3, h4, h5, h6', (els) =>
      els.map((el) => ({
        level: parseInt(el.tagName[1]),
        text: el.textContent?.trim().slice(0, 80),
        selector: window.getCssPath(el)
      }))
    );

    // Check multiple h1s
    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length === 0) {
      issues.push({
        title: 'Missing H1 Heading',
        description: 'This page has no <h1> heading, which is critical for SEO and accessibility.',
        severity: 'High',
        url,
        category: 'accessibility',
        fix: 'Add exactly one <h1> element to the page that describes the main content.',
        element: null,
      });
    } else if (h1s.length > 1) {
      issues.push({
        title: 'Multiple H1 Headings',
        description: `Page contains ${h1s.length} <h1> headings. There should be exactly one.`,
        severity: 'Medium',
        url,
        category: 'accessibility',
        fix: 'Keep only one <h1> per page. Use <h2>–<h6> for subheadings.',
        element: h1s[1].selector || 'h1',
      });
    }

    // Check for skipped heading levels
    for (let i = 1; i < headings.length; i++) {
      const prev = headings[i - 1].level;
      const curr = headings[i].level;
      if (curr > prev + 1) {
        issues.push({
          title: 'Skipped Heading Level',
          description: `Heading jumps from <h${prev}> to <h${curr}> ("${headings[i].text}"), skipping a level.`,
          severity: 'Medium',
          url,
          category: 'accessibility',
          fix: `Use sequential heading levels. After <h${prev}>, use <h${prev + 1}> next.`,
          element: headings[i].selector,
        });
      }
    }

    // 3. Form inputs without labels
    const unlabelledInputs = await page.$$eval('input, textarea, select', (inputs) =>
      inputs
        .filter((input) => {
          const id = input.id;
          const hasLabel = id && document.querySelector(`label[for="${id}"]`);
          const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
          const hasPlaceholder = input.placeholder;
          return !hasLabel && !hasAriaLabel && !hasPlaceholder;
        })
        .map((input) => ({ type: input.type || input.tagName.toLowerCase(), selector: window.getCssPath(input) }))
        .slice(0, 5)
    );
    for (const input of unlabelledInputs) {
      issues.push({
        title: 'Form Input Without Label',
        description: `An <input type="${input.type}"> has no associated <label>, aria-label, or placeholder.`,
        severity: 'High',
        url,
        category: 'accessibility',
        fix: 'Add a <label for="inputId"> or aria-label attribute to every form input.',
        element: input.selector,
      });
    }

    // Check for clearly broken interactive elements (like buttons/links that are completely hidden but in tab order)
    const hiddenFocusable = await page.$$eval('a, button, input', (els) => {
      return els.filter(el => {
        const style = window.getComputedStyle(el);
        return (style.opacity === '0' || style.visibility === 'hidden') && el.tabIndex !== -1;
      }).map(el => window.getCssPath(el));
    });

    for (const sel of hiddenFocusable.slice(0, 3)) {
      issues.push({
        title: 'Hidden Interactive Element',
        errorType: 'UX/A11y',
        description: `Actual Error on Page: This element is completely invisible but can still be focused via keyboard. This causes severe confusion for users navigating with keyboards.`,
        severity: 'Medium',
        url,
        category: 'accessibility',
        fix: 'Add tabindex="-1" to hidden interactive elements, or use display: none.',
        element: sel,
      });
    }

    // 5. Buttons with no accessible name
    const emptyButtons = await page.$$eval('button', (btns) =>
      btns
        .filter((b) => !b.textContent?.trim() && !b.getAttribute('aria-label') && !b.title)
        .map((b) => ({ html: b.outerHTML.slice(0, 100), selector: window.getCssPath(b) }))
        .slice(0, 5)
    );
    for (const btn of emptyButtons) {
      issues.push({
        title: 'Button With No Accessible Name',
        description: `Button "${btn.html}" has no visible text or aria-label.`,
        severity: 'High',
        url,
        category: 'accessibility',
        fix: 'Add text content or an aria-label attribute to all buttons.',
        element: btn.selector,
      });
    }

    // 6. Low-contrast text (heuristic: very light on white or very dark on dark)
    const contrastIssues = await page.evaluate(() => {
      const results = [];
      const parseColor = (str) => {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
      };
      const luminance = ([r, g, b]) => {
        const [R, G, B] = [r, g, b].map((c) => {
          c /= 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * R + 0.7152 * G + 0.0722 * B;
      };

      const els = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4, li, a, button, label'));
      for (const el of els.slice(0, 100)) {
        const style = window.getComputedStyle(el);
        const fg = parseColor(style.color);
        const bg = parseColor(style.backgroundColor);
        if (fg && bg && bg[0] !== 0 && (bg[0] !== 255 || bg[1] !== 255 || bg[2] !== 255)) {
          const L1 = luminance(fg);
          const L2 = luminance(bg);
          const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
          if (ratio < 3.0) {
            results.push({
              text: el.textContent?.trim().slice(0, 60) || '',
              ratio: Math.round(ratio * 100) / 100,
              tag: el.tagName.toLowerCase(),
              selector: window.getCssPath(el)
            });
          }
        }
      }
      return results.slice(0, 5);
    });

    for (const c of contrastIssues) {
      issues.push({
        title: 'Low Color Contrast',
        description: `Element <${c.tag}> "${c.text}" has a contrast ratio of ${c.ratio}:1, below the WCAG 3:1 minimum.`,
        severity: 'Medium',
        url,
        category: 'accessibility',
        fix: 'Increase the contrast between text and background colors. WCAG AA requires 4.5:1 for normal text.',
        element: c.selector,
      });
    }

  } catch (e) {
    issues.push({
      title: 'Accessibility Scan Error',
      description: `Could not complete accessibility scan: ${e.message}`,
      severity: 'Low',
      url,
      category: 'accessibility',
      fix: 'Ensure the page loads correctly for accessibility analysis.',
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

module.exports = { runAccessibilityScan };
