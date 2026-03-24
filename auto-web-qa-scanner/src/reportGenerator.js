const fs = require('fs');
const path = require('path');

function severityColor(severity) {
  if (severity === 'High') return '#ff3b30';
  if (severity === 'Medium') return '#ff9f0a';
  return '#34c759';
}

function severityBg(severity) {
  if (severity === 'High') return 'rgba(255,59,48,0.12)';
  if (severity === 'Medium') return 'rgba(255,159,10,0.12)';
  return 'rgba(52,199,89,0.12)';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function issueCard(issue, index, baseUrl) {
  const color = severityColor(issue.severity);
  const bg = severityBg(issue.severity);
  const screenshotSrc = issue.screenshot ? (issue.screenshot.startsWith('data:') ? issue.screenshot : `http://localhost:3000${issue.screenshot}`) : null;

  return `
  <div class="issue-card" style="border-left: 4px solid ${color}; background: ${bg};">
    <div class="issue-header">
      <span class="badge" style="background:${color};">${escapeHtml(issue.severity)}</span>
      ${issue.errorType ? `<span class="badge" style="background:#475569; margin-left:6px;">${escapeHtml(issue.errorType)}</span>` : ''}
      <h3 class="issue-title">${escapeHtml(issue.title)}</h3>
    </div>
    <div class="issue-body">
      <div class="issue-meta">
        <span class="meta-label">URL:</span>
        <a href="${escapeHtml(issue.url)}" class="issue-url" target="_blank">${escapeHtml(issue.url)}</a>
      </div>
      <p class="issue-desc" style="white-space: pre-wrap; font-family: monospace; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; margin: 10px 0; border: 1px solid rgba(255,255,255,0.05);">${escapeHtml(issue.description)}</p>
      ${issue.element ? `<div class="issue-meta"><span class="meta-label">Element:</span> <code>${escapeHtml(issue.element)}</code></div>` : ''}
      ${issue.viewport ? `<div class="issue-meta"><span class="meta-label">Viewport:</span> <span>${escapeHtml(issue.viewport)}</span></div>` : ''}
      <div class="fix-box">
        <span class="fix-label">💡 Suggested Fix:</span>
        <p>${escapeHtml(issue.fix)}</p>
      </div>
      ${screenshotSrc ? `<div class="screenshot-container"><img src="${screenshotSrc}" alt="Issue screenshot" class="screenshot" /></div>` : ''}
    </div>
  </div>`;
}

async function generateHTMLReport(jobId, results) {
  const { url, scannedAt, pagesScanned, totalIssues, summary, categories } = results;

  const totalHigh = Object.values(summary).reduce((s, c) => s + c.high, 0);
  const totalMedium = Object.values(summary).reduce((s, c) => s + c.medium, 0);
  const totalLow = Object.values(summary).reduce((s, c) => s + c.low, 0);

  const summaryCards = Object.entries(summary)
    .map(
      ([key, cat]) => `
    <div class="summary-card">
      <div class="summary-icon">${cat.icon}</div>
      <div class="summary-name">${escapeHtml(cat.label)}</div>
      <div class="summary-total">${cat.total}</div>
      <div class="summary-breakdown">
        <span style="color:#ff3b30;">${cat.high} High</span> &bull;
        <span style="color:#ff9f0a;">${cat.medium} Med</span> &bull;
        <span style="color:#34c759;">${cat.low} Low</span>
      </div>
    </div>`
    )
    .join('');

  const categoryHTML = Object.entries(categories)
    .map(([key, cat]) => {
      if (cat.issues.length === 0) return '';
      return `
    <section class="category-section" id="cat-${key}">
      <h2 class="category-title">${cat.icon} ${escapeHtml(cat.label)} Issues <span class="issue-count">${cat.issues.length}</span></h2>
      <div class="issues-list">
        ${cat.issues.map((issue, i) => issueCard(issue, i, url)).join('')}
      </div>
    </section>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QA Report – ${escapeHtml(url)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
    :root {
      --bg: #0a0a0f;
      --surface: #13131a;
      --surface2: #1c1c28;
      --border: #2a2a38;
      --text: #e8e8f0;
      --text-dim: #888899;
      --accent: #6c63ff;
      --high: #ff3b30;
      --medium: #ff9f0a;
      --low: #34c759;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    
    .report-header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      padding: 48px 40px 40px;
      border-bottom: 1px solid var(--border);
    }
    .report-header h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; }
    .report-header h1 span { color: var(--accent); }
    .scan-meta { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 16px; }
    .scan-meta-item { background: rgba(255,255,255,0.05); padding: 8px 16px; border-radius: 8px; font-size: 0.85rem; }
    .scan-meta-item strong { color: var(--accent); }

    .severity-bar { display: flex; gap: 20px; margin-top: 24px; }
    .sev-badge { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; font-weight: 600; }
    .sev-dot { width: 10px; height: 10px; border-radius: 50%; }

    .main-content { max-width: 1200px; margin: 0 auto; padding: 40px 24px; }

    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 48px; }
    .summary-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      transition: transform 0.2s;
    }
    .summary-card:hover { transform: translateY(-2px); }
    .summary-icon { font-size: 2rem; margin-bottom: 8px; }
    .summary-name { font-size: 0.85rem; color: var(--text-dim); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .summary-total { font-size: 2rem; font-weight: 700; color: var(--text); }
    .summary-breakdown { font-size: 0.75rem; color: var(--text-dim); margin-top: 4px; }

    .category-section { margin-bottom: 48px; }
    .category-title {
      font-size: 1.3rem; font-weight: 700; margin-bottom: 20px;
      padding-bottom: 12px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 10px;
    }
    .issue-count {
      font-size: 0.8rem; background: var(--accent);
      color: white; padding: 2px 10px; border-radius: 20px;
      font-weight: 600;
    }

    .issues-list { display: flex; flex-direction: column; gap: 16px; }
    .issue-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      border-left-width: 4px !important;
      transition: box-shadow 0.2s;
    }
    .issue-card:hover { box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
    .issue-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .badge {
      color: white; font-size: 0.72rem; font-weight: 700;
      padding: 3px 10px; border-radius: 20px;
      text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;
    }
    .issue-title { font-size: 1rem; font-weight: 600; color: var(--text); }
    .issue-body { font-size: 0.9rem; }
    .issue-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .meta-label { color: var(--text-dim); font-size: 0.82rem; font-weight: 600; white-space: nowrap; }
    .issue-url { color: var(--accent); text-decoration: none; word-break: break-all; font-size: 0.82rem; }
    .issue-url:hover { text-decoration: underline; }
    .issue-desc { color: var(--text-dim); margin-bottom: 12px; line-height: 1.7; }
    code { background: rgba(255,255,255,0.07); padding: 2px 6px; border-radius: 4px; font-size: 0.82rem; font-family: monospace; }
    .fix-box {
      background: rgba(108,99,255,0.08);
      border: 1px solid rgba(108,99,255,0.2);
      border-radius: 8px; padding: 12px 16px; margin-top: 12px;
    }
    .fix-label { font-size: 0.82rem; font-weight: 600; color: var(--accent); }
    .fix-box p { color: var(--text-dim); margin-top: 4px; font-size: 0.88rem; }
    .screenshot-container { margin-top: 16px; }
    .screenshot {
      width: 100%; max-width: 800px; border-radius: 8px;
      border: 1px solid var(--border);
    }
    
    .toc { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; margin-bottom: 40px; }
    .toc h2 { font-size: 1rem; font-weight: 600; margin-bottom: 12px; color: var(--text-dim); }
    .toc-links { display: flex; flex-wrap: wrap; gap: 10px; }
    .toc-link {
      background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
      padding: 6px 14px; text-decoration: none; color: var(--text); font-size: 0.85rem;
      transition: background 0.2s; display: flex; align-items: center; gap: 6px;
    }
    .toc-link:hover { background: var(--accent); border-color: var(--accent); }
    
    footer { text-align: center; padding: 32px; color: var(--text-dim); font-size: 0.82rem; border-top: 1px solid var(--border); }
  </style>
</head>
<body>
  <header class="report-header">
    <h1>🔍 Auto Web <span>QA Scanner</span> Report</h1>
    <div class="scan-meta">
      <div class="scan-meta-item">🌐 <strong>URL:</strong> ${escapeHtml(url)}</div>
      <div class="scan-meta-item">📅 <strong>Scanned:</strong> ${new Date(scannedAt).toLocaleString()}</div>
      <div class="scan-meta-item">📄 <strong>Pages:</strong> ${pagesScanned}</div>
      <div class="scan-meta-item">🐛 <strong>Total Issues:</strong> ${totalIssues}</div>
    </div>
    <div class="severity-bar">
      <div class="sev-badge"><div class="sev-dot" style="background:#ff3b30;"></div>${totalHigh} High</div>
      <div class="sev-badge"><div class="sev-dot" style="background:#ff9f0a;"></div>${totalMedium} Medium</div>
      <div class="sev-badge"><div class="sev-dot" style="background:#34c759;"></div>${totalLow} Low</div>
    </div>
  </header>

  <main class="main-content">
    <!-- Summary Dashboard -->
    <section>
      <div class="summary-grid">${summaryCards}</div>
    </section>

    <!-- TOC -->
    <nav class="toc">
      <h2>JUMP TO CATEGORY</h2>
      <div class="toc-links">
        ${Object.entries(categories).filter(([,c]) => c.issues.length > 0).map(([key, c]) => `<a class="toc-link" href="#cat-${key}">${c.icon} ${escapeHtml(c.label)} <strong>(${c.issues.length})</strong></a>`).join('')}
      </div>
    </nav>

    <!-- Category Sections -->
    ${categoryHTML}

    ${totalIssues === 0 ? '<div style="text-align:center;padding:80px;color:#888;">✅ No issues found! Great job.</div>' : ''}
  </main>

  <footer>
    Generated by <strong>Auto Web QA Scanner</strong> &bull; ${new Date(scannedAt).toUTCString()}
  </footer>
</body>
</html>`;

  const reportDir = path.join(__dirname, '../reports', jobId);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'report.html');
  fs.writeFileSync(reportPath, html, 'utf-8');
  return reportPath;
}

module.exports = { generateHTMLReport };
