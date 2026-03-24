(() => {
  const API = '';
  let currentJobId = null;
  let pollInterval = null;

  const $ = (id) => document.getElementById(id);

  const urlInput = $('urlInput');
  const depthSelect = $('depthSelect');
  const emailInput = $('scanEmail');
  const passwordInput = $('scanPassword');
  const scanBtn = $('scanBtn');
  const progressSection = $('progressSection');
  const progressBar = $('progressBar');
  const progressStep = $('progressStep');
  const progressPct = $('progressPct');
  const progressUrl = $('progressUrl');
  const resultsSection = $('resultsSection');
  const summaryGrid = $('summaryGrid');
  const sevOverview = $('sevOverview');
  const categoryTabs = $('categoryTabs');
  const issuesPanel = $('issuesPanel');
  const downloadBtn = $('downloadBtn');
  const rescanBtn = $('rescanBtn');
  const resultsMeta = $('resultsMeta');

  const CATEGORY_ORDER = ['functional', 'uiux', 'content', 'media', 'performance', 'accessibility'];
  let reportData = null;
  let activeCategory = 'all';

  // ── Start Scan ──────────────────────────────────────────────────────────────
  scanBtn.addEventListener('click', startScan);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startScan(); });

  async function startScan() {
    let url = urlInput.value.trim();
    if (!url) { shake(urlInput); return; }
    if (!url.startsWith('http')) url = 'https://' + url;

    const depth = parseInt(depthSelect.value);
    const email = emailInput && emailInput.value ? emailInput.value.trim() : '';
    const password = passwordInput && passwordInput.value ? passwordInput.value.trim() : '';

    scanBtn.disabled = true;
    scanBtn.querySelector('span:last-child').textContent = 'Starting…';

    hideResults();

    try {
      const res = await fetch(`${API}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, depth, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start scan.');
      currentJobId = data.jobId;
      showProgress(url);
      startPolling();
    } catch (err) {
      alert(`Error: ${err.message}`);
      scanBtn.disabled = false;
      scanBtn.querySelector('span:last-child').textContent = 'Start Scan';
    }
  }

  // ── Progress Polling ─────────────────────────────────────────────────────────
  function showProgress(url) {
    progressSection.classList.remove('hidden');
    progressUrl.textContent = url;
    setProgress(5, 'Initializing crawl…');
  }

  function setProgress(pct, step) {
    progressBar.style.width = pct + '%';
    progressStep.textContent = step;
    progressPct.textContent = pct + '%';
  }

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/scan/${currentJobId}/status`);
        const data = await res.json();
        setProgress(data.progress || 0, data.step || '…');

        if (data.status === 'complete') {
          stopPolling();
          fetchAndShowResults();
        } else if (data.status === 'failed') {
          stopPolling();
          progressSection.classList.add('hidden');
          resetScanBtn();
          alert('Scan failed: ' + (data.step || 'Unknown error'));
        }
      } catch (e) {
        // network blip; keep polling
      }
    }, 2000);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // ── Fetch & Render Results ───────────────────────────────────────────────────
  async function fetchAndShowResults() {
    try {
      const res = await fetch(`${API}/api/scan/${currentJobId}/report`);
      reportData = await res.json();
      progressSection.classList.add('hidden');
      renderResults(reportData);
      resultsSection.classList.remove('hidden');
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      alert('Failed to load report.');
    } finally {
      resetScanBtn();
    }
  }

  function renderResults(data) {
    const { url, scannedAt, pagesScanned, totalIssues, summary, categories } = data;

    resultsMeta.textContent = `Scanned ${pagesScanned} page(s) on ${new Date(scannedAt).toLocaleString()} — ${totalIssues} issues found`;

    // Summary cards
    summaryGrid.innerHTML = '';
    CATEGORY_ORDER.forEach((key) => {
      const cat = summary[key];
      if (!cat) return;
      const card = document.createElement('div');
      card.className = 'summary-card';
      card.dataset.cat = key;
      card.innerHTML = `
        <div class="summary-icon">${cat.icon}</div>
        <div class="summary-name">${cat.label}</div>
        <div class="summary-count">${cat.total}</div>
        <div class="summary-breakdown">
          <span style="color:#ff4545">${cat.high} High</span> &bull;
          <span style="color:#ffb020">${cat.medium} Med</span> &bull;
          <span style="color:#30d484">${cat.low} Low</span>
        </div>`;
      card.addEventListener('click', () => {
        setActiveTab(key);
        document.querySelector('.issue-explorer').scrollIntoView({ behavior: 'smooth' });
      });
      summaryGrid.appendChild(card);
    });

    // Severity overview
    const totalHigh = Object.values(summary).reduce((s, c) => s + c.high, 0);
    const totalMedium = Object.values(summary).reduce((s, c) => s + c.medium, 0);
    const totalLow = Object.values(summary).reduce((s, c) => s + c.low, 0);
    sevOverview.innerHTML = `
      <div class="sev-item">
        <div class="sev-dot" style="background:#ff4545"></div>
        <div class="sev-label">High</div>
        <div class="sev-value" style="color:#ff4545">${totalHigh}</div>
      </div>
      <div class="sev-item">
        <div class="sev-dot" style="background:#ffb020"></div>
        <div class="sev-label">Medium</div>
        <div class="sev-value" style="color:#ffb020">${totalMedium}</div>
      </div>
      <div class="sev-item">
        <div class="sev-dot" style="background:#30d484"></div>
        <div class="sev-label">Low</div>
        <div class="sev-value" style="color:#30d484">${totalLow}</div>
      </div>
      <div class="sev-item" style="margin-left:auto">
        <div class="sev-label">Total Issues</div>
        <div class="sev-value">${totalIssues}</div>
      </div>`;

    // Tabs
    categoryTabs.innerHTML = '';
    // "All" tab
    const allTab = makeTab('all', '🗂️', 'All', totalIssues);
    categoryTabs.appendChild(allTab);

    CATEGORY_ORDER.forEach((key) => {
      const cat = summary[key];
      if (!cat) return;
      categoryTabs.appendChild(makeTab(key, cat.icon, cat.label, cat.total));
    });

    setActiveTab('all');
  }

  function makeTab(key, icon, label, count) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = key;
    btn.innerHTML = `${icon} ${label} <span class="tab-count">${count}</span>`;
    btn.addEventListener('click', () => setActiveTab(key));
    return btn;
  }

  function setActiveTab(key) {
    activeCategory = key;

    // Update tab styles
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.summary-card').forEach((c) => c.classList.remove('active'));
    const activeBtn = document.querySelector(`.tab-btn[data-tab="${key}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    const activeCard = document.querySelector(`.summary-card[data-cat="${key}"]`);
    if (activeCard) activeCard.classList.add('active');

    // Render issues
    renderIssues(key);
  }

  function renderIssues(catKey) {
    if (!reportData) return;
    issuesPanel.innerHTML = '';

    let issuesToRender = [];
    if (catKey === 'all') {
      CATEGORY_ORDER.forEach((k) => {
        const cat = reportData.categories[k];
        if (cat) issuesToRender.push(...cat.issues);
      });
    } else {
      const cat = reportData.categories[catKey];
      if (cat) issuesToRender = cat.issues;
    }

    if (issuesToRender.length === 0) {
      issuesPanel.innerHTML = `<div class="no-issues">✅ No issues found in this category!</div>`;
      return;
    }

    issuesToRender.forEach((issue, i) => {
      const card = buildIssueCard(issue, i);
      issuesPanel.appendChild(card);
    });
  }

  function buildIssueCard(issue, index) {
    const div = document.createElement('div');
    const sevClass = (issue.severity || 'low').toLowerCase();
    const borderColor = sevClass === 'high' ? '#ff4545' : sevClass === 'medium' ? '#ffb020' : '#30d484';
    div.className = 'issue-card';
    div.style.borderLeftColor = borderColor;
    div.style.animationDelay = (index * 0.04) + 's';

    const screenshotHTML = issue.screenshot
      ? `<div class="screenshot-wrap">
          <button class="screenshot-toggle" onclick="this.nextElementSibling.classList.toggle('visible'); this.textContent = this.nextElementSibling.classList.contains('visible') ? '🔼 Hide Screenshot' : '🖼️ Show Screenshot'">🖼️ Show Screenshot</button>
          <img src="${escapeHtml(issue.screenshot)}" class="screenshot-img" alt="Issue screenshot" />
        </div>`
      : '';

    const viewportHTML = issue.viewport
      ? `<div class="issue-meta-item"><strong>Viewport:</strong> ${escapeHtml(issue.viewport)}</div>`
      : '';

    const elementHTML = issue.element
      ? `<div class="issue-meta-item"><strong>Element:</strong> <code>${escapeHtml(issue.element)}</code></div>`
      : '';

    div.innerHTML = `
      <div class="issue-card-header">
        <span class="sev-badge ${sevClass}">${escapeHtml(issue.severity)}</span>
        <span class="issue-title">${escapeHtml(issue.title)}</span>
      </div>
      <div class="issue-url"><a href="${escapeHtml(issue.url)}" target="_blank">🔗 ${escapeHtml(issue.url)}</a></div>
      <p class="issue-desc">${escapeHtml(issue.description)}</p>
      <div class="issue-meta-row">${viewportHTML}${elementHTML}</div>
      <div class="fix-box">
        <div class="fix-label">💡 Suggested Fix</div>
        ${escapeHtml(issue.fix)}
      </div>
      ${screenshotHTML}`;
    return div;
  }

  // ── Download ─────────────────────────────────────────────────────────────────
  downloadBtn.addEventListener('click', async () => {
    if (!currentJobId) return;
    try {
      const res = await fetch(`${API}/api/scan/${currentJobId}/download`);
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Report download failed.');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qa-report-${currentJobId.slice(0, 8)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      alert('Network error while downloading the report.');
    }
  });

  // ── Re-scan ──────────────────────────────────────────────────────────────────
  rescanBtn.addEventListener('click', () => {
    hideResults();
    urlInput.value = '';
    urlInput.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function hideResults() {
    resultsSection.classList.add('hidden');
    progressSection.classList.add('hidden');
  }

  function resetScanBtn() {
    scanBtn.disabled = false;
    scanBtn.querySelector('span:last-child').textContent = 'Start Scan';
  }

  function shake(el) {
    el.style.animation = 'none';
    el.offsetHeight;
    el.style.animation = 'shake 0.4s ease';
    setTimeout(() => el.style.animation = '', 500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Add shake animation to stylesheet dynamically
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%,100%{transform:translateX(0)}
      25%{transform:translateX(-8px)}
      75%{transform:translateX(8px)}
    }`;
  document.head.appendChild(style);

  // --- Deep Linking Support ---
  window.addEventListener('load', async () => {
    const params = new URLSearchParams(window.location.search);
    const jobId = params.get('jobId');
    if (jobId) {
      currentJobId = jobId;
      try {
        const res = await fetch(`${API}/api/scan/${jobId}/status`);
        const data = await res.json();
        if (res.ok) {
          showProgress(data.url || 'Remote Scan');
          startPolling();
        }
      } catch (e) {
        console.error('Failed to attach to remote job:', e);
      }
    }
  });
})();
