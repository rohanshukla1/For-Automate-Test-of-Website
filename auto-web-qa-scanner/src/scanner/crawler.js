const { chromium } = require('playwright');
const path = require('path');

/**
 * Crawl a website up to `depth` levels deep, returning unique internal URLs
 */
async function crawlSite(baseUrl, depth = 2, statePath = null) {
  const visited = new Set();
  const toVisit = [{ url: baseUrl, level: 0 }];
  const found = [];

  const baseDomain = new URL(baseUrl).hostname;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (compatible; AutoWebQAScanner/1.0; +https://github.com/auto-web-qa)',
    ignoreHTTPSErrors: true,
    ...(statePath ? { storageState: statePath } : {})
  });

  try {
    while (toVisit.length > 0) {
      const { url, level } = toVisit.shift();
      const normalizedUrl = url.replace(/\/$/, ''); // simple normalization
      if (visited.has(normalizedUrl) || level > depth) continue;
      visited.add(normalizedUrl);
      found.push(url);
      console.log(`[Crawler] Visiting (${level}/${depth}): ${url}`);

      if (level >= depth) continue;

      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Wait for network, but also look for common dashboard indicators
        try { 
          await Promise.race([
            page.waitForLoadState('networkidle', { timeout: 10000 }),
            page.waitForSelector('nav, .sidebar, .menu, .dashboard, .projects', { timeout: 10000 })
          ]);
        } catch (e) {}
        await page.waitForTimeout(3000); // Breathe for client-side rendering
        const links = await page.$$eval('a[href], [routerlink], [ng-reflect-router-link], [onclick]', (elements) => {
          return elements
            .map((el) => {
               if (el.tagName === 'A') return el.href;
               // Try common SPA attributes
               const rl = el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link');
               if (rl) {
                 // Convert to full URL
                 try {
                   const b = window.location.origin + window.location.pathname;
                   return new URL(rl, b).href;
                 } catch(e) { return null; }
               }
               return null;
            })
            .filter((href) => {
              if (!href) return false;
              try {
                const u = new URL(href);
                return u.protocol === 'http:' || u.protocol === 'https:';
              } catch {
                return false;
              }
            });
        });

        for (const link of links) {
          try {
            const u = new URL(link);
            // Same domain only
            if (u.hostname === baseDomain) {
              // FOR SPAS: Keep the hash! Only strip it if it's a simple anchor (no slash)
              // If it has a slash (e.g. #/dashboard), it's a route.
              const isAnchor = u.hash && !u.hash.includes('/');
              if (isAnchor) u.hash = '';
              
              const cleanUrl = u.href;
              if (!visited.has(cleanUrl)) {
                console.log(`[Crawler] Found new link: ${cleanUrl}`);
                toVisit.push({ url: cleanUrl, level: level + 1 });
              }
            }
          } catch {
            // skip
          }
        }
      } catch (e) {
        // Page failed to load, still include it in found list
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return [...new Set(found)];
}

module.exports = { crawlSite };
