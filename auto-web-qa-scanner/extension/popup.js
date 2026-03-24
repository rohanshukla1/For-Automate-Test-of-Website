document.addEventListener('DOMContentLoaded', async () => {
  const urlEl = document.getElementById('tab-url');
  const scanBtn = document.getElementById('quick-scan-btn');
  
  const progressView = document.getElementById('progress-view');
  const statusText = document.getElementById('status-text');
  const progressFill = document.getElementById('progress-fill');
  
  const dashboardView = document.getElementById('dashboard-view');
  const resTotal = document.getElementById('res-total');
  const resBadges = document.getElementById('res-badges');
  const resPages = document.getElementById('res-pages');
  const viewReportLink = document.getElementById('view-report-link');
  const downloadReportLink = document.getElementById('download-report-link');
  const newScanBtn = document.getElementById('new-scan-btn');

  // API Backend
  const API = 'http://localhost:3000';
  let currentJobId = null;
  let pollTimer = null;

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  urlEl.textContent = tab.url;

  scanBtn.addEventListener('click', async () => {
    // UI Transitions
    scanBtn.style.display = 'none';
    progressView.style.display = 'flex';
    dashboardView.style.display = 'none';
    statusText.textContent = 'Capturing live DOM...';
    progressFill.style.width = '10%';

    let pageData = { html: null, localStorageData: [], sessionStorageData: [] };
    if (!chrome.scripting) {
      statusText.textContent = 'Setup Error: Please go to chrome://extensions/ and hit the Reload icon for AutoWebQA.';
      progressFill.style.background = '#ef4444';
      setTimeout(() => { scanBtn.style.display = 'block'; progressView.style.display = 'none'; }, 5000);
      return;
    }

    try {
      const [{result}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Clone the DOM to safely mutate it before serialization
          const clone = document.documentElement.cloneNode(true);
          
          // Remove ALL noscript tags. Because the scanner disables JS to freeze the SPA,
          // any <noscript><meta http-equiv="refresh" content="0;url=/login"></noscript> 
          // will immediately trigger and ruin the scan.
          const noscripts = clone.querySelectorAll('noscript');
          noscripts.forEach(n => n.remove());
          
          // Remove any stray meta refreshes
          const metas = clone.querySelectorAll('meta[http-equiv="refresh"]');
          metas.forEach(m => m.remove());

          return {
            html: clone.outerHTML,
            localStorageData: Object.entries(localStorage || {}),
            sessionStorageData: Object.entries(sessionStorage || {})
          };
        }
      });
      pageData = result;
      
      if (!pageData || !pageData.html) {
        throw new Error("Failed to read page content.");
      }
    } catch (e) {
      statusText.textContent = `Permission Error: ${e.message} (Reload extension)`;
      progressFill.style.background = '#ef4444';
      setTimeout(() => { scanBtn.style.display = 'block'; progressView.style.display = 'none'; }, 5000);
      return;
    }

    statusText.textContent = 'Gathering authenticated session...';
    progressFill.style.width = '20%';
    const cookies = await chrome.cookies.getAll({ url: tab.url });

    // Step 2: Post to Backend
    statusText.textContent = 'Uploading DOM to QA Engine...';
    progressFill.style.width = '30%';

    try {
      const res = await fetch(`${API}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: tab.url,
          depth: 0, // Quick single page mode
          cookies: cookies,
          html: pageData.html,
          localStorageData: pageData.localStorageData,
          sessionStorageData: pageData.sessionStorageData
        })
      });

      const data = await res.json();
      if (!res.ok || !data.jobId) throw new Error(data.error || 'Failed to start scan.');
      
      currentJobId = data.jobId;
      startPolling();

    } catch (err) {
      statusText.textContent = 'Error: ' + err.message;
      progressFill.style.background = '#ef4444';
      setTimeout(() => { scanBtn.style.display = 'block'; progressView.style.display = 'none'; }, 3000);
    }
  });

  function startPolling() {
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/scan/${currentJobId}/status`);
        const data = await res.json();
        
        statusText.textContent = data.step || 'Analyzing...';
        progressFill.style.width = `${Math.max(35, data.progress || 0)}%`;

        if (data.status === 'complete') {
          clearInterval(pollTimer);
          chrome.storage.local.remove(['currentJobId']); // Clear from storage so next open is fresh
          fetchAndShowResults();
        } else if (data.status === 'failed') {
          clearInterval(pollTimer);
          chrome.storage.local.remove(['currentJobId']);
          statusText.textContent = 'Analysis Failed. Check backend logs.';
          progressFill.style.background = '#ef4444';
        }
      } catch (e) {}
    }, 1000); // Fast 1s polling
  }

  async function fetchAndShowResults() {
    try {
      statusText.textContent = 'Generating Dashboard...';
      const res = await fetch(`${API}/api/scan/${currentJobId}/report`);
      const report = await res.json();
      
      progressView.style.display = 'none';
      dashboardView.style.display = 'flex';
      
      // Calculate severities
      let high = 0, med = 0, low = 0;
      Object.values(report.categories || {}).forEach(cat => {
        high += cat.high || 0;
        med += cat.medium || 0;
        low += cat.low || 0;
      });

      resTotal.textContent = report.totalIssues || 0;
      resPages.textContent = report.pagesScanned || 1;
      
      resBadges.innerHTML = `
        <span class="badge high">${high} H</span>
        <span class="badge med">${med} M</span>
        <span class="badge low">${low} L</span>
      `;

      viewReportLink.href = `${API}/?jobId=${currentJobId}`;
      downloadReportLink.href = `${API}/api/scan/${currentJobId}/download`;

    } catch (e) {
      statusText.textContent = 'Failed to load report data.';
      progressFill.style.background = '#ef4444';
    }
  }

  newScanBtn.addEventListener('click', () => {
    dashboardView.style.display = 'none';
    progressView.style.display = 'none';
    scanBtn.style.display = 'block';
    currentJobId = null;
    statusText.textContent = '';
    progressFill.style.width = '0%';
  });
});
