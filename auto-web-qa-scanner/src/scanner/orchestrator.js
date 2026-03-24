const jobStore = require('../jobStore');
const { crawlSite } = require('./crawler');
const { authenticate } = require('./authenticator');
const { runFunctionalScan } = require('./functionalScanner');
const { runUIScan } = require('./uiScanner');
const { runContentScan } = require('./contentScanner');
const { runMediaScan } = require('./mediaScanner');
const { runPerformanceScan } = require('./performanceScanner');
const { runAccessibilityScan } = require('./accessibilityScanner');
const { generateHTMLReport } = require('../reportGenerator');
const fs = require('fs');
const path = require('path');

function updateJob(jobId, updates) {
  const job = jobStore.get(jobId);
  if (job) {
    Object.assign(job, updates);
    jobStore.set(jobId, job);
  }
}

async function runScan(jobId) {
  const job = jobStore.get(jobId);
  if (!job) return;

  updateJob(jobId, { status: 'running', progress: 5, step: 'Crawling website...' });

  const allIssues = [];
  let urls = [];

  // --- Step 1: Optional Authentication ---
  let statePath = null;
  let startUrl = job.url;

  // Case A: Cookies provided via Chrome Extension
  if (job.cookies && job.cookies.length > 0) {
    updateJob(jobId, { progress: 5, step: 'Injecting session cookies from browser...' });
    statePath = path.join(__dirname, '../../reports', jobId, 'state.json');
    const storageState = {
      cookies: job.cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expirationDate || -1,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'unspecified' ? 'Lax' : 'Lax')
      })),
      origins: [
        {
          origin: new URL(startUrl).origin,
          localStorage: job.localStorageData ? job.localStorageData.map(([name, value]) => ({ name, value })) : []
        }
      ]
    };
    fs.writeFileSync(statePath, JSON.stringify(storageState, null, 2));

    const sessionPath = path.join(__dirname, '../../reports', jobId, 'session.json');
    fs.writeFileSync(sessionPath, JSON.stringify(job.sessionStorageData || []));
  } 
  // Case B: Credentials provided for auto-login
  else if (job.email && job.password) {
    updateJob(jobId, { progress: 5, step: 'Logging in with provided credentials...' });
    const authResult = await authenticate(jobId);
    if (!authResult || !authResult.statePath) {
      updateJob(jobId, { status: 'failed', step: 'Authentication failed. Please check credentials or URL.' });
      return;
    }
    statePath = authResult.statePath;
    startUrl = authResult.finalUrl;
  }

  // --- Step 2: Crawl ---
  if (job.depth > 0) {
    try {
      urls = await crawlSite(startUrl, job.depth, statePath);
    } catch (e) {
      urls = [startUrl];
    }
  } else {
    // Depth 0 = Single Page Scan
    urls = [startUrl];
  }
  console.log(`[Job ${jobId}] Crawler finished. Discovered URLs:`, urls);
  updateJob(jobId, { progress: 15, step: `Found ${urls.length} page(s). Starting analysis...` });

  // We process issues per-page and combine
  const scanTasks = [
    { name: 'Functional', fn: runFunctionalScan, start: 15, end: 30 },
    { name: 'UI/UX', fn: runUIScan, start: 30, end: 45 },
    { name: 'Content', fn: runContentScan, start: 45, end: 58 },
    { name: 'Media', fn: runMediaScan, start: 58, end: 68 },
    { name: 'Performance', fn: runPerformanceScan, start: 68, end: 78 },
    { name: 'Accessibility', fn: runAccessibilityScan, start: 78, end: 88 },
  ];

  // --- Step 3: Run Scans in Parallel ---
  updateJob(jobId, { progress: 20, step: `Analyzing ${urls.length} page(s) in parallel...` });

  const pageScanPromises = urls.map(async (pageUrl) => {
    const pageIssues = [];
    // Run all 6 scanners for this specific page in parallel
    const taskPromises = scanTasks.map(async (task) => {
      try {
        const issues = await task.fn(pageUrl, jobId, statePath, job.html && pageUrl === job.url ? job.html : null);
        return issues;
      } catch (e) {
        return [];
      }
    });
    const results = await Promise.all(taskPromises);
    results.forEach(issues => pageIssues.push(...issues));
    return pageIssues;
  });

  const allPageResults = await Promise.all(pageScanPromises);
  const rawIssues = [];
  allPageResults.forEach(issues => rawIssues.push(...issues));

  updateJob(jobId, { progress: 85, step: `Deduplicating identical issues...` });

  // Deduplicate identical issues across multiple pages to prevent spam
  const uniqueIssuesMap = new Map();
  for (const issue of rawIssues) {
    // Fingerprint based on the core error text and the element.
    const fingerprint = `${issue.title} || ${issue.description} || ${issue.element || 'no-element'}`;
    
    if (!uniqueIssuesMap.has(fingerprint)) {
      uniqueIssuesMap.set(fingerprint, issue);
    } else {
      const existing = uniqueIssuesMap.get(fingerprint);
      if (!existing.affectedUrls) existing.affectedUrls = new Set([existing.url]);
      existing.affectedUrls.add(issue.url);
    }
  }

  const finalIssues = Array.from(uniqueIssuesMap.values());
  finalIssues.forEach(i => {
    if (i.affectedUrls && i.affectedUrls.size > 1) {
      i.description += `\n\n*(Note: This exact issue was detected on ${i.affectedUrls.size} different pages)*`;
    }
  });

  allIssues.push(...finalIssues);
  updateJob(jobId, { progress: 86, step: `Analysis complete.` });

  // --- Step 4: Organize results ---
  updateJob(jobId, { progress: 88, step: 'Organizing results and generating report...' });

  const categories = {
    functional: { label: 'Functional', icon: '⚙️', issues: [] },
    uiux: { label: 'UI/UX', icon: '🎨', issues: [] },
    content: { label: 'Content', icon: '✍️', issues: [] },
    media: { label: 'Media', icon: '🖼️', issues: [] },
    performance: { label: 'Performance', icon: '⚡', issues: [] },
    accessibility: { label: 'Accessibility', icon: '♿', issues: [] },
  };

  for (const issue of allIssues) {
    if (categories[issue.category]) {
      categories[issue.category].issues.push(issue);
    }
  }

  const summary = {};
  for (const [key, cat] of Object.entries(categories)) {
    summary[key] = {
      label: cat.label,
      icon: cat.icon,
      total: cat.issues.length,
      high: cat.issues.filter((i) => i.severity === 'High').length,
      medium: cat.issues.filter((i) => i.severity === 'Medium').length,
      low: cat.issues.filter((i) => i.severity === 'Low').length,
    };
  }

  const results = {
    url: job.url,
    scannedAt: new Date().toISOString(),
    pagesScanned: urls.length,
    totalIssues: allIssues.length,
    summary,
    categories,
  };

  // --- Step 5: Generate HTML report ---
  const reportPath = await generateHTMLReport(jobId, results);

  updateJob(jobId, {
    status: 'complete',
    progress: 100,
    step: 'Scan complete!',
    results,
    reportPath,
  });
}

module.exports = { runScan };
