(function () {
  'use strict';

  if (!window.RADAR) {
    console.error('window.RADAR not found.');
    return;
  }

  const radar = window.RADAR;
  let boardDataRows = radar.rows || [];
  let boardJsonMap = new Map(); // slug -> full row from board.json (includes farm_steps)

  // State
  let currentSortCol = 'rank';
  let currentSortAsc = true;
  let searchTerm = '';
  let selectedCategory = '';
  let selectedVerdict = 'ALL';
  let watchlistOnly = false;

  // Formatters
  const formatUSD = (num) => {
    if (num === null || num === undefined) return 'N/A';
    if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'k';
    return '$' + num.toLocaleString();
  };

  const formatPct = (num) => {
    if (num === null || num === undefined) return 'N/A';
    const sign = num > 0 ? '+' : '';
    return sign + num.toFixed(2) + '%';
  };

  const formatNum = (num, decimals = 2) => {
    if (num === null || num === undefined) return 'N/A';
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  // Fetch board.json for farm steps (graceful fallback on file://)
  fetch('./board.json')
    .then(res => res.json())
    .then(data => {
      if (data && data.rows) {
        data.rows.forEach(r => {
          boardJsonMap.set(r.slug, r);
        });
        // re-render if currently on detail view
        handleRoute();
      }
    })
    .catch(() => {
      console.info('board.json fetch skipped/failed (file:// protocol mode). Farm steps will show fallback notes.');
    });

  // Initialization
  function init() {
    setupKPIs();
    setupCategories();
    setupEventListeners();
    window.addEventListener('hashchange', handleRoute);
    handleRoute();
  }

  function setupKPIs() {
    if (radar.as_of) {
      document.getElementById('kpi-date').textContent = radar.as_of;
    }
    if (radar.watchlist_size && radar.board_size) {
      document.getElementById('kpi-universe').textContent = `758 protocols / ${radar.watchlist_size} watch / ${radar.board_size} ranked`;
    }
    if (radar.validation) {
      const v = radar.validation;
      document.getElementById('kpi-loo').textContent = `Median error 3.5× (${(v.loo_within_2x_share * 100).toFixed(1)}% within 2×)`;
      if (v.bootstrap_slope_band) {
        document.getElementById('kpi-band').textContent = `[${v.bootstrap_slope_band[0]}, ${v.bootstrap_slope_band[1]}] (129 comps)`;
      }
    }
    renderAnchors();
  }

  function setupCategories() {
    const cats = new Set();
    boardDataRows.forEach(r => {
      if (r.category) cats.add(r.category);
    });
    const select = document.getElementById('category-select');
    Array.from(cats).sort().forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });
  }

  function setupEventListeners() {
    // Search
    document.getElementById('search-input').addEventListener('input', (e) => {
      searchTerm = e.target.value.toLowerCase().trim();
      renderBoardTable();
    });

    // Category
    document.getElementById('category-select').addEventListener('change', (e) => {
      selectedCategory = e.target.value;
      renderBoardTable();
    });

    // Verdict buttons
    document.querySelectorAll('.v-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.v-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        selectedVerdict = e.target.getAttribute('data-verdict');
        // Update URL hash for verdict filter if on board
        if (selectedVerdict === 'ALL') {
          window.location.hash = '#/';
        } else {
          window.location.hash = `#/f/${selectedVerdict}`;
        }
        renderBoardTable();
      });
    });

    // Watchlist toggle
    document.getElementById('watchlist-toggle').addEventListener('change', (e) => {
      watchlistOnly = e.target.checked;
      renderBoardTable();
    });

    // Table sorting
    document.querySelectorAll('#board-table th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-sort');
        if (currentSortCol === col) {
          currentSortAsc = !currentSortAsc;
        } else {
          currentSortCol = col;
          currentSortAsc = true;
        }
        renderBoardTable();
      });
    });

    // Sandbox listeners
    ['sb-tvl', 'sb-change', 'sb-age', 'sb-odds'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateSandbox);
      }
    });

    updateSandbox();
  }

  function handleRoute() {
    const hash = window.location.hash || '#/';
    
    // Hide all views
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));

    if (hash.startsWith('#/p/')) {
      const slug = hash.replace('#/p/', '');
      document.getElementById('view-detail').classList.add('active');
      renderDetail(slug);
    } else if (hash.startsWith('#/f/')) {
      const verdict = hash.replace('#/f/', '').toUpperCase();
      selectedVerdict = ['FARM', 'THIN', 'SKIP'].includes(verdict) ? verdict : 'ALL';
      syncVerdictButtons();
      document.getElementById('view-board').classList.add('active');
      document.getElementById('nav-board').classList.add('active');
      renderBoardTable();
    } else if (hash === '#/sandbox') {
      document.getElementById('view-sandbox').classList.add('active');
      document.getElementById('nav-sandbox').classList.add('active');
    } else if (hash === '#/research') {
      document.getElementById('view-research').classList.add('active');
      document.getElementById('nav-research').classList.add('active');
    } else {
      // Default board
      selectedVerdict = 'ALL';
      syncVerdictButtons();
      document.getElementById('view-board').classList.add('active');
      document.getElementById('nav-board').classList.add('active');
      renderBoardTable();
    }
    window.scrollTo(0, 0);
  }

  function syncVerdictButtons() {
    document.querySelectorAll('.v-btn').forEach(btn => {
      if (btn.getAttribute('data-verdict') === selectedVerdict) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function renderBoardTable() {
    const tbody = document.getElementById('board-tbody');
    tbody.innerHTML = '';

    let filtered = boardDataRows.filter(r => {
      if (searchTerm) {
        const matchName = r.name.toLowerCase().includes(searchTerm);
        const matchSlug = r.slug.toLowerCase().includes(searchTerm);
        if (!matchName && !matchSlug) return false;
      }
      if (selectedCategory && r.category !== selectedCategory) {
        return false;
      }
      if (selectedVerdict !== 'ALL' && r.verdict !== selectedVerdict) {
        return false;
      }
      if (watchlistOnly && r.rank > (radar.watchlist_size || 40)) {
        return false;
      }
      return true;
    });

    // Sort
    filtered.sort((a, b) => {
      let va = a[currentSortCol];
      let vb = b[currentSortCol];
      if (va === null || va === undefined) va = '';
      if (vb === null || vb === undefined) vb = '';
      if (typeof va === 'string') {
        return currentSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return currentSortAsc ? va - vb : vb - va;
    });

    document.getElementById('row-count').textContent = `Showing ${filtered.length} of ${boardDataRows.length} protocols`;

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">No protocols match the current filters.</td>`;
      tbody.appendChild(tr);
      return;
    }

    filtered.forEach(r => {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => {
        window.location.hash = `#/p/${r.slug}`;
      });

      const verdictClass = r.verdict ? r.verdict.toLowerCase() : 'skip';

      tr.innerHTML = `
        <td class="num">${r.rank}</td>
        <td class="proto-cell">
          <span class="proto-name">${escapeHTML(r.name)}</span>
          <span class="proto-cat">${escapeHTML(r.category || 'Unknown')}</span>
        </td>
        <td class="num">${formatUSD(r.tvl_usd)}</td>
        <td class="num">${formatPct(r.change_7d)}</td>
        <td class="num">${formatNum(r.token_odds, 4)}</td>
        <td class="num">${formatUSD(r.implied_value_usd)}</td>
        <td><span class="verdict-badge ${verdictClass}">${r.verdict}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderAnchors() {
    const tbody = document.getElementById('anchors-tbody');
    if (!tbody || !radar.live) return;
    tbody.innerHTML = '';

    radar.live.forEach(l => {
      const tr = document.createElement('tr');
      const tvl = l.tvl_usd || 0;
      const mcap = l.mcap_usd || 0;
      const ratio = tvl > 0 ? (mcap / tvl).toFixed(2) : 'N/A';
      const chainsStr = l.chains ? l.chains.slice(0, 3).join(', ') + (l.chains.length > 3 ? '...' : '') : '';

      tr.innerHTML = `
        <td><strong>${escapeHTML(l.name)}</strong></td>
        <td>${escapeHTML(l.category || '')}</td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">${escapeHTML(chainsStr)}</td>
        <td class="num">${formatUSD(tvl)}</td>
        <td class="num">${formatUSD(mcap)}</td>
        <td class="num">${ratio}×</td>
        <td class="num">${formatPct(l.change_7d)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderDetail(slug) {
    const container = document.getElementById('detail-content');
    const r = boardDataRows.find(item => item.slug === slug);
    const boardRow = boardJsonMap.get(slug);

    if (!r) {
      container.innerHTML = `<div class="panel"><h2>Protocol not found</h2><p>Could not find protocol with slug: <code>${escapeHTML(slug)}</code></p></div>`;
      return;
    }

    const chainsStr = r.chains ? r.chains.join(', ') : 'N/A';
    const verdictClass = r.verdict ? r.verdict.toLowerCase() : 'skip';
    
    // Get farm steps from r.farm_steps (window.RADAR) first, fallback to boardJsonMap if absent
    let stepsHTML = '';
    const steps = r.farm_steps || (boardRow && boardRow.farm_steps) ? (r.farm_steps || boardRow.farm_steps) : null;
    if (steps && steps.length > 0) {
      stepsHTML = `<ol class="steps-list">` + steps.map(s => `<li>${escapeHTML(s)}</li>`).join('') + `</ol>`;
    } else {
      stepsHTML = `<p style="color: var(--text-muted); font-style: italic;">Farm steps load when served over HTTP via board.json (or fallback copy). For ${escapeHTML(r.name)}, standard interactive farming guidelines apply across ${escapeHTML(chainsStr)}.</p>`;
    }

    container.innerHTML = `
      <div class="panel">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin-bottom: 16px;">
          <div>
            <h2 style="font-size: 1.75rem; margin-bottom: 4px;">${escapeHTML(r.name)}</h2>
            <p style="color: var(--text-muted);">Category: <strong>${escapeHTML(r.category || 'N/A')}</strong> • Rank #${r.rank}</p>
          </div>
          <div>
            <span class="verdict-badge ${verdictClass}" style="font-size: 1rem; padding: 6px 16px;">VERDICT: ${r.verdict}</span>
          </div>
        </div>

        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px;">
          ${r.chains ? r.chains.map(c => `<span class="badge">${escapeHTML(c)}</span>`).join('') : ''}
        </div>

        <div class="detail-grid">
          <div class="panel" style="margin-bottom: 0;">
            <h3>Key Metrics</h3>
            <div class="meta-row"><span class="label">Total Value Locked (TVL)</span><span class="val">${formatUSD(r.tvl_usd)}</span></div>
            <div class="meta-row"><span class="label">7d TVL Change</span><span class="val">${formatPct(r.change_7d)}</span></div>
            <div class="meta-row"><span class="label">Implied Value (Valuation)</span><span class="val" style="color: var(--accent-cyan); font-weight: 700;">${formatUSD(r.implied_value_usd)}</span></div>
            <div class="meta-row"><span class="label">Token Odds</span><span class="val">${formatNum(r.token_odds, 4)}</span></div>
            <div class="meta-row"><span class="label">Growth Multiplier</span><span class="val">${formatNum(r.growth_multiplier, 4)}</span></div>
            <div class="meta-row"><span class="label">Protocol Age</span><span class="val">${r.age_days !== null && r.age_days !== undefined ? r.age_days + ' days' : 'N/A'}</span></div>
          </div>

          <div class="panel" style="margin-bottom: 0;">
            <h3>Valuation Breakdown & Verdict Formula</h3>
            <p style="font-size: 0.9rem; color: var(--text-main); margin-bottom: 12px;">
              The implied valuation of <strong>${formatUSD(r.implied_value_usd)}</strong> is derived from the fitted power curve model:
            </p>
            <p style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent-cyan); background: var(--bg-main); padding: 8px; border-radius: 4px; margin-bottom: 12px;">
              log10(mcap) = 3.025 + 0.522 × log10(TVL)
            </p>
            <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">
              Adjusted by category risk weight, longevity age factor (${r.age_days || 'N/A'} days), 7d momentum multiplier (${formatNum(r.growth_multiplier, 3)}), and estimated token launch probability (odds: ${formatNum(r.token_odds, 3)}).
            </p>
          </div>
        </div>

        <div class="panel" style="margin-bottom: 0;">
          <h3>Farm Steps & Execution Guide</h3>
          <p class="section-desc">Recommended tactical steps to position for a potential protocol token distribution and airdrop.</p>
          ${stepsHTML}
        </div>
      </div>
    `;
  }

  function updateSandbox() {
    const tvlM = parseFloat(document.getElementById('sb-tvl').value) || 100;
    const tvlUSD = tvlM * 1e6;
    const change7d = parseFloat(document.getElementById('sb-change').value) || 0;
    const ageDays = parseFloat(document.getElementById('sb-age').value) || 365;
    const odds = parseFloat(document.getElementById('sb-odds').value) || 0.6;

    document.getElementById('sb-odds-val').textContent = odds.toFixed(2);

    // Formula calculation
    // log10(mcap) = intercept (3.025) + slope (0.522) * log10(TVL)
    const logTVL = Math.log10(tvlUSD);
    const intercept = 3.025;
    const slope = 0.522;
    const logMcapBase = intercept + (slope * logTVL);
    const baseValuation = Math.pow(10, logMcapBase);

    // Growth multiplier adjustment from 7d change
    const growthMult = 1.0 + (change7d / 200.0);
    // Age factor adjustment (e.g., log scale age relative to 365)
    const ageFactor = Math.min(1.2, Math.max(0.8, Math.log10(Math.max(30, ageDays)) / Math.log10(365)));

    const finalImplied = baseValuation * growthMult * ageFactor * odds;

    const stepsContainer = document.getElementById('sandbox-steps');
    stepsContainer.innerHTML = `
      <div class="calc-row"><span>TVL Input:</span><span>${formatUSD(tvlUSD)} ($${tvlM}M)</span></div>
      <div class="calc-row"><span>log10(TVL):</span><span>${logTVL.toFixed(4)}</span></div>
      <div class="calc-row"><span>Base Fitted log10(mcap):</span><span>3.025 + (0.522 × ${logTVL.toFixed(4)}) = ${logMcapBase.toFixed(4)}</span></div>
      <div class="calc-row"><span>Baseline Valuation ($10^x):</span><span>${formatUSD(baseValuation)}</span></div>
      <div class="calc-row"><span>7d Change Multiplier (${change7d}%):</span><span>× ${growthMult.toFixed(4)}</span></div>
      <div class="calc-row"><span>Age Factor (${ageDays} days):</span><span>× ${ageFactor.toFixed(4)}</span></div>
      <div class="calc-row"><span>Token Odds Factor:</span><span>× ${odds.toFixed(2)}</span></div>
      <div class="calc-row highlight"><span>Final Computed Implied Value:</span><span>${formatUSD(finalImplied)}</span></div>
    `;
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
