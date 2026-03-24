const path = require('path');
const fs = require('fs');
const jobStore = require('../jobStore');

/**
 * Take a screenshot of the current page state, highlighting the issue element.
 */
async function takeIssueScreenshot(page, issue, jobId) {
  const job = jobStore.get(jobId);
  if (!job) return null;
  
  // Cap at 30 screenshots per scan to save disk and time
  job.screenshotCount = job.screenshotCount || 0;
  if (job.screenshotCount >= 30) return null;
  job.screenshotCount++;

  try {
    if (issue.element) {
      const locator = page.locator(issue.element).first();
      // Check if element exists and is visible
      const isVisible = await locator.isVisible().catch(() => false);
      
      if (isVisible) {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300); // let scroll finish
        
        // Draw outline
        await locator.evaluate((el) => {
          el.dataset.oldOutline = el.style.outline;
          el.dataset.oldOutlineOffset = el.style.outlineOffset;
          el.style.outline = '4px solid #ff3b30';
          el.style.outlineOffset = '2px';
        }).catch(() => {});
        
        const buffer = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
        
        // Cleanup outline
        await locator.evaluate((el) => {
          el.style.outline = el.dataset.oldOutline || '';
          el.style.outlineOffset = el.dataset.oldOutlineOffset || '';
        }).catch(() => {});
        
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
      }
    }
    
    // Fallback: take a regular viewport screenshot
    const buffer = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

module.exports = { takeIssueScreenshot };
