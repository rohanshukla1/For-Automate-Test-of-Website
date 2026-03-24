const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('https://demo.instabuild360.com/login', { timeout: 60000 });
    await page.waitForTimeout(5000);
    const buttonsHTML = await page.$$eval('button', btns => btns.map(b => b.outerHTML).join('\n'));
    console.log('BUTTONS:\n' + buttonsHTML);
  } catch (e) {
    console.error('FAILED:', e.message);
  } finally {
    await browser.close();
  }
})();
