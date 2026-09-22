(function installTaskPointsStateRuntimeV2LiveReview(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2LiveReview?.installed) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  const REVIEWER_SRC = '/state_runtime_v2_trace_review.js?v=20260915-1';
  const CORRELATOR_SRC = '/state_runtime_v2_foreground_correlation.js?v=20260913-2';
  const PAINT_PROBE_NAME = 'stateV2.foreground.nextPaint';
  const BUTTON_ID = 'tpV2LiveReviewButton';
  const PANEL_ID = 'tpV2LiveReviewPanel';
  const REVIEW_SCRIPT_ATTR = 'data-taskpoints-state-v2-trace-review';
  const CORRELATOR_SCRIPT_ATTR = 'data-taskpoints-state-v2-foreground-correlation';
  const productionHosts = new Set(['taskpoints.pages.dev', 'www.taskpoints.pages.dev']);
  let lastReview = null;
  let reviewerPromise = null;
  let correlatorPromise = null;
  let paintProbeInstalled = false;

  const now = () => global.performance?.now?.() ?? Date.now();

  function isAllowedPreview() {
    const hostname = String(global.location?.hostname || '').toLowerCase();
    if (productionHosts.has(hostname)) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    return hostname.endsWith('.taskpoints.pages.dev');
  }

  function isDarkEnabled() {
    try { return global.localStorage?.getItem?.(DARK_MODE_KEY) === '1'; }
    catch (_) { return false; }
  }

  function traceAvailable() {
    return Boolean(global.TaskPointsPerf?.enabled && typeof global.TaskPointsPerf?.buildReport === 'function');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function describeTarget(target) {
    if (!target) return '';
    const tag = String(target.tagName || '').toLowerCase();
    const id = target.id ? `#${String(target.id)}` : '';
    const className = typeof target.className === 'string' && target.className.trim()
      ? `.${target.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    return `${tag}${id}${className}`.slice(0, 120);
  }

  function isHabitInteractionTarget(target) {
    try {
      return Boolean(target?.closest?.([
        '#homePanelScwm .habitDay',
        '#homePanelScwm .scwm-card',
        '#homePanelScwm button',
        '#homePanelScwm input',
        '#homePanelScwm textarea',
        '#homePanelScwm select',
        '[id$="EditModal"] button',
        '[id$="EditModal"] input',
        '[id$="EditModal"] textarea',
        '[id$="EditModal"] select'
      ].join(',')));
    } catch (_) {
      return false;
    }
  }

  function installForegroundPaintProbe() {
    if (paintProbeInstalled) return true;
    const document = global.document;
    if (!document?.addEventListener || typeof global.requestAnimationFrame !== 'function') return false;

    for (const interactionType of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(interactionType, (event) => {
        if (!traceAvailable() || !isHabitInteractionTarget(event?.target)) return;
        const started = now();
        const target = describeTarget(event?.target);
        global.requestAnimationFrame(() => {
          const elapsed = Math.max(0, now() - started);
          try {
            global.TaskPointsPerf?.duration?.(PAINT_PROBE_NAME, elapsed, {
              interactionType,
              target,
              foregroundBoundary: true
            });
          } catch (_) {}
        });
      }, true);
    }

    paintProbeInstalled = true;
    return true;
  }

  function reviewerReady() {
    return Boolean(global.TaskPointsStateRuntimeV2TraceReview?.installed
      && typeof global.TaskPointsStateRuntimeV2TraceReview?.review === 'function');
  }

  function correlatorReady() {
    return Boolean(global.TaskPointsStateRuntimeV2ForegroundCorrelation?.installed
      && typeof global.TaskPointsStateRuntimeV2ForegroundCorrelation?.review === 'function');
  }

  function loadReviewer() {
    if (reviewerReady()) return Promise.resolve(global.TaskPointsStateRuntimeV2TraceReview);
    if (reviewerPromise) return reviewerPromise;
    if (!global.document?.createElement) return Promise.reject(new Error('document_unavailable'));

    reviewerPromise = new Promise((resolve, reject) => {
      let script = global.document.querySelector?.(`script[${REVIEW_SCRIPT_ATTR}]`);
      if (!script) {
        script = global.document.createElement('script');
        script.src = REVIEWER_SRC;
        script.defer = true;
        script.setAttribute(REVIEW_SCRIPT_ATTR, 'true');
        (global.document.head || global.document.documentElement)?.appendChild?.(script);
      }

      const finish = () => {
        if (reviewerReady()) resolve(global.TaskPointsStateRuntimeV2TraceReview);
        else reject(new Error('v2_trace_reviewer_unavailable'));
      };
      if (reviewerReady()) finish();
      else {
        script.addEventListener?.('load', finish, { once: true });
        script.addEventListener?.('error', () => reject(new Error('v2_trace_reviewer_load_failed')), { once: true });
      }
    }).finally(() => {
      reviewerPromise = null;
    });

    return reviewerPromise;
  }

  function loadCorrelator() {
    if (correlatorReady()) return Promise.resolve(global.TaskPointsStateRuntimeV2ForegroundCorrelation);
    if (correlatorPromise) return correlatorPromise;
    if (!global.document?.createElement) return Promise.reject(new Error('document_unavailable'));

    correlatorPromise = new Promise((resolve, reject) => {
      let script = global.document.querySelector?.(`script[${CORRELATOR_SCRIPT_ATTR}]`);
      if (!script) {
        script = global.document.createElement('script');
        script.src = CORRELATOR_SRC;
        script.defer = true;
        script.setAttribute(CORRELATOR_SCRIPT_ATTR, 'true');
        (global.document.head || global.document.documentElement)?.appendChild?.(script);
      }

      const finish = () => {
        if (correlatorReady()) resolve(global.TaskPointsStateRuntimeV2ForegroundCorrelation);
        else reject(new Error('v2_foreground_correlator_unavailable'));
      };
      if (correlatorReady()) finish();
      else {
        script.addEventListener?.('load', finish, { once: true });
        script.addEventListener?.('error', () => reject(new Error('v2_foreground_correlator_load_failed')), { once: true });
      }
    }).finally(() => {
      correlatorPromise = null;
    });

    return correlatorPromise;
  }

  function checkRows(review) {
    const mutations = review?.mutationClasses || {};
    return [
      { key: 'completion', label: 'Habit completion / toggle', ok: mutations.completion?.observed === true },
      { key: 'order', label: 'Habit reorder', ok: mutations.order?.observed === true },
      { key: 'edit', label: 'Habit edit', ok: mutations.edit?.observed === true },
      { key: 'presence', label: 'Habit add / delete', ok: mutations.presence?.observed === true },
      { key: 'foreground', label: 'No direct foreground V2 maintenance', ok: review?.noDirectForegroundMaintenanceObserved === true },
      { key: 'idle', label: 'Automatic parity waited for deep idle', ok: review?.automaticParityDeepIdleObserved === true },
      { key: 'preemption', label: 'Interaction postponed pending maintenance', ok: review?.interactionPreemptionObserved === true },
      { key: 'ownership', label: 'V2 stores only Habit/Vice pilot completions', ok: review?.pilotOwnership?.v2StoreContainsOnlyPilotCompletions === true },
      { key: 'parity', label: 'V2 data matches legacy data', ok: review?.parity?.matchConfirmed === true },
      { key: 'failures', label: 'No V2 failures observed', ok: review?.failures?.noV2FailuresObserved === true }
    ];
  }

  function progress(review) {
    const rows = checkRows(review);
    return { complete: rows.filter((row) => row.ok).length, total: rows.length, rows };
  }

  function updateButton(review = lastReview) {
    const button = global.document?.getElementById?.(BUTTON_ID);
    if (!button) return;
    if (!traceAvailable()) {
      button.textContent = 'V2 TEST';
      button.title = 'Performance tracing is not enabled for this preview session.';
      return;
    }
    if (!review) {
      button.textContent = 'V2 TEST';
      button.title = 'Review physical-device Step 4 evidence.';
      return;
    }
    const state = progress(review);
    button.textContent = review.evidenceCompleteForDeviceTrace === true
      ? 'V2 TEST ✓'
      : `V2 TEST ${state.complete}/${state.total}`;
    button.title = review.evidenceCompleteForDeviceTrace === true
      ? 'Step 4 trace evidence is complete for this session.'
      : `${state.complete} of ${state.total} Step 4 trace checks observed.`;
  }

  function panelMarkup(review, error = '') {
    if (error) {
      return `<div class="tp-v2-live-head"><strong>V2 physical trace test</strong><button type="button" data-v2-close>Close</button></div>
        <p class="tp-v2-live-error">${escapeHtml(error)}</p>
        <p>Enable the V2 preview with <code>?perf=1</code>, then use TaskPoints normally before reviewing the trace.</p>`;
    }

    const state = progress(review);
    const rows = state.rows.map((row) => (
      `<div class="tp-v2-live-check ${row.ok ? 'ok' : 'pending'}"><span aria-hidden="true">${row.ok ? '✓' : '○'}</span><span>${escapeHtml(row.label)}</span></div>`
    )).join('');
    const failures = Number(review?.failures?.failedEventCount || 0)
      + Number(review?.failures?.mutationFailureCount || 0)
      + Number(review?.failures?.subsystemFailureCount || 0);
    const legacyCount = Array.isArray(review?.legacyFullStateCandidates) ? review.legacyFullStateCandidates.length : 0;
    const legacyMax = Number.isFinite(Number(review?.maxLegacyFullStateCandidateMs))
      ? `${Number(review.maxLegacyFullStateCandidateMs).toFixed(1)} ms max`
      : 'none timed';
    const correlation = review?.foregroundCorrelation || {};
    const correlatedWindows = Number(correlation.correlatedMutationWindowCount || 0);
    const enqueueCount = Number(correlation.enqueueCount || 0);
    const paintBoundedWindows = Number(correlation.paintBoundedMutationWindowCount || 0);
    const overlappingWindows = Number(correlation.windowsWithLegacyWork || 0);
    const overlappingMax = Number.isFinite(Number(correlation.maxLegacyForegroundCandidateMs))
      ? `${Number(correlation.maxLegacyForegroundCandidateMs).toFixed(1)} ms max`
      : 'none observed';
    const foregroundCorrelationLine = enqueueCount > 0
      ? `${correlatedWindows}/${enqueueCount} mutation windows correlated; ${paintBoundedWindows} reached next paint; ${overlappingWindows} contained legacy/full-state work (${escapeHtml(overlappingMax)})`
      : 'No V2 mutation enqueue window is available to correlate yet.';
    const verdict = review?.evidenceCompleteForDeviceTrace === true
      ? '<div class="tp-v2-live-verdict ok">Step 4 trace evidence complete ✓</div>'
      : `<div class="tp-v2-live-verdict pending">${state.complete}/${state.total} checks observed</div>`;

    return `<div class="tp-v2-live-head"><strong>V2 physical trace test</strong><button type="button" data-v2-close>Close</button></div>
      ${verdict}
      <div class="tp-v2-live-checks">${rows}</div>
      <div class="tp-v2-live-meta">V2 failures counted: ${failures}<br>Legacy/full-state timing candidates: ${legacyCount} (${escapeHtml(legacyMax)})<br>Foreground correlation: ${foregroundCorrelationLine}</div>
      <p class="tp-v2-live-note">Foreground correlation is diagnostic, not an automatic Step 4 failure. When a render-frame probe is available it measures from the recorded interaction through the next paint boundary; otherwise it falls back to the V2 enqueue boundary. This lets us catch legacy whole-state work that begins after enqueue but still delays visible response.</p>
      <details open><summary>How to finish the test</summary><ol>
        <li>Tap <strong>Start fresh test</strong> once. This clears only PERF trace history and reloads; it does not change TaskPoints data.</li>
        <li>Toggle a Habit completion.</li>
        <li>Reorder Habits.</li>
        <li>Edit a Habit.</li>
        <li>Add a temporary Habit. Adding it is enough to exercise the V2 presence path; deleting a Habit also counts.</li>
        <li>Keep using the app briefly after a mutation so pending parity is postponed.</li>
        <li>Then leave the app untouched and visible for at least 20 seconds.</li>
        <li>Open V2 TEST again and tap Refresh evidence.</li>
      </ol></details>
      <div class="tp-v2-live-actions"><button type="button" data-v2-start>Start fresh test</button><button type="button" data-v2-refresh>Refresh evidence</button><button type="button" data-v2-copy>Copy review</button></div>
      <div data-v2-status class="tp-v2-live-status"></div>`;
  }

  function ensureStyles() {
    if (!global.document?.createElement || global.document.getElementById('tpV2LiveReviewStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'tpV2LiveReviewStyles';
    style.textContent = `
      body:has(#addHabitModal:not(.hidden)) #${BUTTON_ID},body:has(#addHabitModal:not(.hidden)) #tpPerfTraceButton,body:has([data-act="habit-save"]) #${BUTTON_ID},body:has([data-act="habit-save"]) #tpPerfTraceButton{visibility:hidden!important;pointer-events:none!important;opacity:0!important}
      #addHabitModal:not(.hidden){z-index:2147483646!important}
      #${BUTTON_ID}{position:fixed;left:10px;bottom:calc(env(safe-area-inset-bottom,0px) + 135px);z-index:2147483645;border:1px solid #64748b;border-radius:999px;background:#111827;color:#f8fafc;padding:7px 11px;min-height:36px;font:700 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:.92}
      #${PANEL_ID}{position:fixed;inset:calc(env(safe-area-inset-top,0px) + 18px) 12px calc(env(safe-area-inset-bottom,0px) + 18px);z-index:2147483647;overflow:auto;border:1px solid #475569;border-radius:14px;background:#0b0f14;color:#f8fafc;padding:14px;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)}
      #${PANEL_ID} .tp-v2-live-head{display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:-14px;background:#0b0f14;padding:14px 0 10px;z-index:2}
      #${PANEL_ID} button{min-height:42px;border:1px solid #64748b;border-radius:10px;background:#111827;color:#f8fafc;padding:8px 12px;font:600 14px inherit}
      #${PANEL_ID} .tp-v2-live-verdict{margin:8px 0 12px;padding:10px;border-radius:10px;font-weight:700}
      #${PANEL_ID} .tp-v2-live-verdict.ok{background:#052e1b;color:#86efac;border:1px solid #166534}
      #${PANEL_ID} .tp-v2-live-verdict.pending{background:#27210a;color:#fde68a;border:1px solid #854d0e}
      #${PANEL_ID} .tp-v2-live-checks{display:grid;gap:7px;margin:12px 0}
      #${PANEL_ID} .tp-v2-live-check{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;border-radius:9px;background:#111827}
      #${PANEL_ID} .tp-v2-live-check.ok{color:#86efac} #${PANEL_ID} .tp-v2-live-check.pending{color:#cbd5e1}
      #${PANEL_ID} .tp-v2-live-meta{margin:12px 0;color:#cbd5e1;line-height:1.5}
      #${PANEL_ID} .tp-v2-live-note,#${PANEL_ID} details{color:#94a3b8;line-height:1.45}
      #${PANEL_ID} details ol{padding-left:22px;color:#cbd5e1} #${PANEL_ID} details li{margin:6px 0}
      #${PANEL_ID} .tp-v2-live-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
      #${PANEL_ID} .tp-v2-live-status{min-height:20px;margin-top:8px;color:#94a3b8}
      #${PANEL_ID} .tp-v2-live-error{color:#fca5a5}
      @media(min-width:769px){#${BUTTON_ID}{left:8px;bottom:auto;top:8px}#${PANEL_ID}{left:auto;width:min(520px,calc(100vw - 24px));box-sizing:border-box}}
    `;
    (global.document.head || global.document.documentElement)?.appendChild?.(style);
  }

  async function buildReview() {
    if (!traceAvailable()) throw new Error('Performance tracing is off. Re-open the V2 opt-in page with ?perf=1.');
    const [reviewer, correlator] = await Promise.all([loadReviewer(), loadCorrelator()]);
    const report = global.TaskPointsPerf.buildReport();
    const review = reviewer.review(report);
    review.foregroundCorrelation = correlator.review(report);
    lastReview = review;
    updateButton(review);
    return review;
  }

  function closePanel() {
    global.document?.getElementById?.(PANEL_ID)?.remove?.();
  }

  function startFreshTest() {
    if (!traceAvailable() || typeof global.TaskPointsPerf?.clearTrace !== 'function') {
      throw new Error('Performance tracing is not ready.');
    }
    global.TaskPointsPerf.clearTrace();
    lastReview = null;
    updateButton(null);
    if (typeof global.setTimeout === 'function') global.setTimeout(() => global.location?.reload?.(), 80);
    else global.location?.reload?.();
    return true;
  }

  function bindPanel(panel) {
    panel.querySelector?.('[data-v2-close]')?.addEventListener?.('click', closePanel);
    panel.querySelector?.('[data-v2-start]')?.addEventListener?.('click', () => {
      const status = panel.querySelector?.('[data-v2-status]');
      try {
        if (status) status.textContent = 'Clearing only PERF trace history and reloading…';
        startFreshTest();
      } catch (error) {
        if (status) status.textContent = String(error?.message || error);
      }
    });
    panel.querySelector?.('[data-v2-refresh]')?.addEventListener?.('click', async () => {
      const status = panel.querySelector?.('[data-v2-status]');
      if (status) status.textContent = 'Refreshing trace evidence…';
      try {
        const review = await buildReview();
        renderPanel(review);
      } catch (error) {
        renderPanel(null, String(error?.message || error));
      }
    });
    panel.querySelector?.('[data-v2-copy]')?.addEventListener?.('click', async () => {
      const status = panel.querySelector?.('[data-v2-status]');
      try {
        const review = lastReview || await buildReview();
        const text = JSON.stringify(review, null, 2);
        if (typeof global.navigator?.clipboard?.writeText === 'function') await global.navigator.clipboard.writeText(text);
        else throw new Error('Clipboard API unavailable');
        if (status) status.textContent = 'V2 review copied.';
      } catch (error) {
        if (status) status.textContent = `Copy failed: ${String(error?.message || error)}`;
      }
    });
  }

  function renderPanel(review, error = '') {
    if (!global.document?.body) return;
    closePanel();
    ensureStyles();
    const panel = global.document.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'V2 physical trace test');
    panel.innerHTML = panelMarkup(review, error);
    global.document.body.appendChild(panel);
    bindPanel(panel);
  }

  async function openPanel() {
    try {
      const review = await buildReview();
      renderPanel(review);
    } catch (error) {
      renderPanel(null, String(error?.message || error));
    }
  }

  function mountButton() {
    if (!isAllowedPreview() || !isDarkEnabled() || !global.document?.body) return false;
    installForegroundPaintProbe();
    if (global.document.getElementById(BUTTON_ID)) return true;
    ensureStyles();
    const button = global.document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'V2 TEST';
    button.setAttribute('aria-label', 'Review V2 physical trace evidence');
    button.addEventListener('click', openPanel);
    global.document.body.appendChild(button);
    updateButton();
    return true;
  }

  const api = {
    installed: true,
    version: 6,
    isAllowedPreview,
    isDarkEnabled,
    traceAvailable,
    installForegroundPaintProbe,
    buildReview,
    startFreshTest,
    openPanel,
    closePanel,
    mountButton,
    getLastReview: () => lastReview,
    getStatus() {
      return {
        installed: true,
        allowedPreview: isAllowedPreview(),
        darkEnabled: isDarkEnabled(),
        traceAvailable: traceAvailable(),
        reviewerReady: reviewerReady(),
        correlatorReady: correlatorReady(),
        paintProbeInstalled,
        lastEvidenceComplete: lastReview?.evidenceCompleteForDeviceTrace === true,
        foregroundCorrelationAvailable: Boolean(lastReview?.foregroundCorrelation)
      };
    }
  };

  global.TaskPointsStateRuntimeV2LiveReview = api;

  if (isAllowedPreview() && isDarkEnabled()) {
    loadReviewer().catch(() => undefined);
    loadCorrelator().catch(() => undefined);
    if (global.document?.readyState === 'loading') global.document.addEventListener?.('DOMContentLoaded', mountButton, { once: true });
    else mountButton();
    global.addEventListener?.('pageshow', mountButton);
  }
})(typeof window !== 'undefined' ? window : globalThis);