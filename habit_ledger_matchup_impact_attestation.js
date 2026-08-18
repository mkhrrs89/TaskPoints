;(function installHabitLedgerImpactAttestation(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__completeImpactChainAttestationInstalled || typeof planner.buildHabitLedgerRepairPlan !== 'function') return;
  planner.__completeImpactChainAttestationInstalled = true;
  const previousBuild = planner.buildHabitLedgerRepairPlan.bind(planner);
  const VERSION = '20260801-1';

  function hasPointRemovals(plan) {
    return (Array.isArray(plan?.failedDateRemovals) && plan.failedDateRemovals.length > 0)
      || (Array.isArray(plan?.duplicateRemovals) && plan.duplicateRemovals.length > 0);
  }

  function chainAvailable() {
    return Boolean(
      global.TaskPointsHabitLedgerMatchupImpact
      && global.TaskPointsCanonicalHabitLedgerMatchupImpact
      && global.TaskPointsHabitLedgerDateIsoImpact
      && global.TaskPointsHabitLedgerLegacyScoreFallback
    );
  }

  function attestImpact(plan) {
    const complete = chainAvailable();
    const existing = plan?.matchupImpact && typeof plan.matchupImpact === 'object'
      ? plan.matchupImpact
      : {
          days: [],
          blockingDays: [],
          resultChangingDays: [],
          affectedDays: 0,
          pointsRemoved: Number(plan?.pointsRemoved) || 0,
          hasBlockingImpact: false
        };

    if (complete || !hasPointRemovals(plan)) {
      return {
        ...existing,
        completeImpactChain: complete,
        impactChainVersion: complete ? VERSION : ''
      };
    }

    const failure = {
      dayKey: '',
      pointsRemoved: Number(plan?.pointsRemoved) || 0,
      matchupCount: 0,
      status: 'analysis-error',
      blocking: true,
      resultChanges: null,
      reason: 'The complete canonical matchup-impact chain did not load. Repair is blocked.'
    };
    const retained = (Array.isArray(existing.days) ? existing.days : [])
      .filter((day) => day?.status !== 'impact-chain-incomplete');
    const days = retained.concat({ ...failure, status: 'impact-chain-incomplete' });
    const blockingDays = days.filter((day) => day?.blocking);
    const resultChangingDays = blockingDays.filter((day) => day?.resultChanges === true);
    return {
      ...existing,
      days,
      blockingDays,
      resultChangingDays,
      affectedDays: days.length,
      hasBlockingImpact: true,
      completeImpactChain: false,
      impactChainVersion: ''
    };
  }

  planner.buildHabitLedgerRepairPlan = function attestedImpactBuild(stateInput) {
    const plan = previousBuild(stateInput);
    return {
      ...plan,
      matchupImpact: attestImpact(plan)
    };
  };

  global.TaskPointsHabitLedgerImpactAttestation = {
    VERSION,
    hasPointRemovals,
    chainAvailable,
    attestImpact
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerImpactAttestation;
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsAuditLiveProgress(global) {
  'use strict';

  const document = global.document;
  if (!document || global.__taskpointsAuditLiveProgressInstalled) return;
  global.__taskpointsAuditLiveProgressInstalled = true;

  const STYLE_ID = 'taskpointsAuditLiveProgressStyle';
  const PHASE_ID = 'auditLivePhase';

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #auditProgressFill {
        transform-origin: left center;
      }
      #auditProgressWrap[data-state="running"] #auditProgressFill {
        width: 100% !important;
        transform: scaleX(0.06);
        transition: none !important;
        will-change: transform;
        animation:
          taskpointsAuditLiveFill 16s cubic-bezier(.18,.55,.2,1) forwards,
          auditProgressPulse 1.2s linear infinite;
      }
      #auditProgressWrap[data-state="complete"] #auditProgressFill,
      #auditProgressWrap[data-state="error"] #auditProgressFill {
        width: 100% !important;
        transform: scaleX(1);
        animation: none;
      }
      @keyframes taskpointsAuditLiveFill {
        0%   { transform: scaleX(0.06); }
        10%  { transform: scaleX(0.13); }
        28%  { transform: scaleX(0.29); }
        52%  { transform: scaleX(0.52); }
        70%  { transform: scaleX(0.68); }
        86%  { transform: scaleX(0.82); }
        100% { transform: scaleX(0.92); }
      }
      #${PHASE_ID} {
        position: relative;
        min-height: 0.95rem;
        margin-top: 0.05rem;
        overflow: hidden;
        color: rgba(94, 234, 212, 0.9);
        font-size: 0.68rem;
        font-weight: 600;
      }
      #${PHASE_ID}[hidden] { display: none !important; }
      #${PHASE_ID} span {
        position: absolute;
        inset: 0 auto auto 0;
        opacity: 0;
        white-space: nowrap;
        animation-duration: 16s;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
      }
      #${PHASE_ID} span:nth-child(1) { animation-name: taskpointsAuditPhase1; }
      #${PHASE_ID} span:nth-child(2) { animation-name: taskpointsAuditPhase2; }
      #${PHASE_ID} span:nth-child(3) { animation-name: taskpointsAuditPhase3; }
      #${PHASE_ID} span:nth-child(4) { animation-name: taskpointsAuditPhase4; }
      #${PHASE_ID} span:nth-child(5) { animation-name: taskpointsAuditPhase5; }
      @keyframes taskpointsAuditPhase1 { 0%,12% {opacity:1} 15%,100% {opacity:0} }
      @keyframes taskpointsAuditPhase2 { 0%,12% {opacity:0} 15%,55% {opacity:1} 58%,100% {opacity:0} }
      @keyframes taskpointsAuditPhase3 { 0%,55% {opacity:0} 58%,72% {opacity:1} 75%,100% {opacity:0} }
      @keyframes taskpointsAuditPhase4 { 0%,72% {opacity:0} 75%,91% {opacity:1} 94%,100% {opacity:0} }
      @keyframes taskpointsAuditPhase5 { 0%,91% {opacity:0} 94%,100% {opacity:1} }

      main.audit-compact-main > :not([hidden]) ~ :not([hidden]) {
        margin-top: 0.7rem !important;
      }
      .audit-control-card {
        padding: 0.9rem 1rem !important;
        display: grid !important;
        gap: 0.62rem !important;
      }
      .audit-control-card > :not([hidden]) ~ :not([hidden]) {
        margin-top: 0 !important;
      }
      .audit-control-header {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) !important;
        gap: 0.55rem !important;
        align-items: stretch !important;
      }
      .audit-control-title-block {
        min-width: 0;
      }
      .audit-control-title-block > :first-child {
        font-size: 1.08rem !important;
        line-height: 1.25 !important;
        font-weight: 700 !important;
      }
      .audit-primary-controls {
        display: grid !important;
        grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.65fr) !important;
        grid-template-rows: auto 2.55rem !important;
        gap: 0.22rem 0.5rem !important;
        align-items: stretch !important;
        width: 100%;
      }
      .audit-primary-controls > label {
        grid-column: 1;
        grid-row: 1;
        align-self: end;
        font-size: 0.7rem !important;
        line-height: 1 !important;
      }
      .audit-primary-controls > #auditDate {
        grid-column: 1;
        grid-row: 2;
        width: 100% !important;
        min-width: 0 !important;
        height: 2.55rem !important;
        padding: 0.42rem 0.55rem !important;
        font-size: 0.83rem !important;
      }
      .audit-primary-controls > #runAuditBtn {
        grid-column: 2;
        grid-row: 2;
        width: 100% !important;
        min-width: 0 !important;
        min-height: 2.55rem !important;
        padding: 0.45rem 0.7rem !important;
        font-size: 0.84rem !important;
        font-weight: 700 !important;
      }
      .audit-secondary-controls {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 0.38rem !important;
      }
      .audit-secondary-controls .btn {
        flex: 0 0 auto !important;
        min-height: 2.05rem !important;
        padding: 0.43rem 0.58rem !important;
        font-size: 0.73rem !important;
        line-height: 1.05 !important;
        border-radius: 0.65rem !important;
      }
      #auditProgressWrap {
        border: 0 !important;
        background: transparent !important;
        border-radius: 0 !important;
        padding: 0.16rem 0 0 !important;
        gap: 0.25rem !important;
      }
      #auditProgressLabel {
        font-size: 0.74rem !important;
      }
      #auditProgressMeta {
        font-size: 0.67rem !important;
      }
      #auditProgressTrack {
        height: 0.32rem !important;
      }
      .audit-summary-card {
        padding: 0.82rem 1rem !important;
      }
      .audit-summary-card > :not([hidden]) ~ :not([hidden]) {
        margin-top: 0.6rem !important;
      }
      .audit-summary-title {
        font-size: 0.92rem !important;
        line-height: 1.2 !important;
        text-transform: uppercase;
        letter-spacing: 0.035em;
      }
      #auditSummaryMeta {
        font-size: 0.76rem !important;
        line-height: 1.3 !important;
      }
      #auditHighlights {
        grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
        gap: 0.45rem !important;
      }
      #auditHighlights > div {
        padding: 0.55rem 0.6rem !important;
      }
      #auditHighlights > div > :last-child {
        font-size: 1.45rem !important;
        line-height: 1.05 !important;
      }
      @media (max-width: 360px) {
        .audit-primary-controls {
          grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.4fr) !important;
        }
        .audit-secondary-controls .btn {
          padding-left: 0.5rem !important;
          padding-right: 0.5rem !important;
          font-size: 0.7rem !important;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function installPhaseFeedback() {
    const wrap = document.getElementById('auditProgressWrap');
    const meta = document.getElementById('auditProgressMeta');
    if (!wrap || document.getElementById(PHASE_ID)) return;

    const phase = document.createElement('div');
    phase.id = PHASE_ID;
    phase.hidden = true;
    phase.setAttribute('aria-hidden', 'true');
    phase.innerHTML = [
      'Loading state & rebuilding daily totals…',
      'Checking scoring, history & records…',
      'Checking Season, matchups & game history…',
      'Testing page save paths & sticky data…',
      'Finalizing audit report…'
    ].map(text => `<span>${text}</span>`).join('');
    wrap.appendChild(phase);

    function sync() {
      const running = wrap.dataset.state === 'running';
      phase.hidden = !running;
      if (running && meta) {
        meta.textContent = 'Working through scoring, records, Season, integrity, and save-path checks.';
      }
    }

    const observer = new MutationObserver(sync);
    observer.observe(wrap, { attributes: true, attributeFilter: ['data-state'] });
    sync();
  }

  function installCompactLayout() {
    const main = document.querySelector('main');
    const runBtn = document.getElementById('runAuditBtn');
    if (!main || !runBtn) return;

    const controlCard = Array.from(main.children).find((child) => child.classList?.contains('glass'));
    if (!controlCard || controlCard.dataset.auditCompactLayout === '1') return;
    controlCard.dataset.auditCompactLayout = '1';
    main.classList.add('audit-compact-main');
    controlCard.classList.add('audit-control-card');

    const controlHeader = controlCard.firstElementChild;
    if (controlHeader) {
      controlHeader.classList.add('audit-control-header');
      const titleBlock = controlHeader.firstElementChild;
      if (titleBlock) {
        titleBlock.classList.add('audit-control-title-block');
        Array.from(titleBlock.children).forEach((node) => {
          if (/Re-run TaskPoints math for one day without mutating data\./i.test(String(node.textContent || '').trim())) {
            node.remove();
          }
        });
      }
    }

    const primaryControls = runBtn.parentElement;
    primaryControls?.classList.add('audit-primary-controls');

    const syncMatchupsBtn = document.getElementById('syncMatchupsBtn');
    syncMatchupsBtn?.parentElement?.classList.add('audit-secondary-controls');

    const summaryCard = Array.from(main.children).filter((child) => child.classList?.contains('glass'))[1];
    if (summaryCard) {
      summaryCard.classList.add('audit-summary-card');
      const summaryTitle = summaryCard.querySelector('.text-lg.font-semibold');
      if (summaryTitle) {
        summaryTitle.classList.add('audit-summary-title');
        summaryTitle.textContent = 'Audit Summary';
      }
    }
  }

  function install() {
    installStyle();
    installPhaseFeedback();
    installCompactLayout();
  }

  install();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsAuditCompactMobileSizingFix(global) {
  'use strict';
  const document = global.document;
  if (!document || document.getElementById('taskpointsAuditCompactMobileSizingFix')) return;

  const style = document.createElement('style');
  style.id = 'taskpointsAuditCompactMobileSizingFix';
  style.textContent = `
    .audit-primary-controls {
      grid-template-columns: minmax(7.75rem, 0.72fr) minmax(0, 1.28fr) !important;
      grid-template-rows: auto 2.4rem !important;
      column-gap: 0.72rem !important;
      row-gap: 0.22rem !important;
      align-items: end !important;
    }
    .audit-primary-controls > #auditDate {
      box-sizing: border-box !important;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      height: 2.4rem !important;
      min-height: 2.4rem !important;
      padding: 0.34rem 0.42rem !important;
      font-size: 0.78rem !important;
      line-height: 1.15 !important;
      overflow: hidden !important;
      position: static !important;
      margin: 0 !important;
    }
    .audit-primary-controls > #runAuditBtn {
      box-sizing: border-box !important;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      height: 2.4rem !important;
      min-height: 2.4rem !important;
      padding: 0.38rem 0.62rem !important;
      font-size: 0.8rem !important;
      line-height: 1.1 !important;
      position: static !important;
      margin: 0 !important;
      transform: none !important;
    }
    .audit-secondary-controls {
      display: grid !important;
      grid-template-columns: repeat(3, max-content) !important;
      grid-auto-rows: minmax(2rem, auto) !important;
      gap: 0.36rem 0.4rem !important;
      justify-content: start !important;
      align-items: start !important;
      width: 100% !important;
    }
    .audit-secondary-controls .btn {
      box-sizing: border-box !important;
      width: auto !important;
      max-width: 100% !important;
      min-width: 0 !important;
      min-height: 2rem !important;
      margin: 0 !important;
      white-space: nowrap !important;
    }
    .audit-secondary-controls .btn:nth-child(4) {
      grid-column: 1 !important;
    }
    @media (max-width: 380px) {
      .audit-primary-controls {
        grid-template-columns: minmax(7.2rem, 0.75fr) minmax(0, 1.25fr) !important;
        column-gap: 0.55rem !important;
      }
      .audit-primary-controls > #auditDate {
        font-size: 0.73rem !important;
        padding-left: 0.34rem !important;
        padding-right: 0.34rem !important;
      }
      .audit-secondary-controls {
        gap: 0.32rem !important;
      }
      .audit-secondary-controls .btn {
        font-size: 0.67rem !important;
        padding-left: 0.44rem !important;
        padding-right: 0.44rem !important;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsAuditDateSizingFixV2(global) {
  'use strict';
  const document = global.document;
  if (!document || document.getElementById('taskpointsAuditDateSizingFixV2')) return;

  const style = document.createElement('style');
  style.id = 'taskpointsAuditDateSizingFixV2';
  style.textContent = `
    .audit-primary-controls {
      grid-template-columns: 7.25rem minmax(0, 1fr) !important;
      grid-template-rows: 1rem 2.15rem !important;
      column-gap: 0.62rem !important;
      row-gap: 0.28rem !important;
      align-items: end !important;
    }
    .audit-primary-controls > label {
      grid-column: 1 !important;
      grid-row: 1 !important;
      display: block !important;
      align-self: end !important;
      position: relative !important;
      z-index: 3 !important;
      min-height: 1rem !important;
      height: 1rem !important;
      margin: 0 !important;
      padding: 0 !important;
      line-height: 1rem !important;
      overflow: visible !important;
    }
    .audit-primary-controls > #auditDate {
      grid-column: 1 !important;
      grid-row: 2 !important;
      box-sizing: border-box !important;
      width: 7.25rem !important;
      min-width: 7.25rem !important;
      max-width: 7.25rem !important;
      height: 2.15rem !important;
      min-height: 2.15rem !important;
      max-height: 2.15rem !important;
      padding: 0.24rem 0.36rem !important;
      font-size: 0.74rem !important;
      line-height: 1 !important;
      position: relative !important;
      z-index: 1 !important;
      margin: 0 !important;
    }
    .audit-primary-controls > #runAuditBtn {
      grid-column: 2 !important;
      grid-row: 2 !important;
      box-sizing: border-box !important;
      height: 2.15rem !important;
      min-height: 2.15rem !important;
      max-height: 2.15rem !important;
      align-self: end !important;
      margin: 0 !important;
    }
    @media (max-width: 380px) {
      .audit-primary-controls {
        grid-template-columns: 6.85rem minmax(0, 1fr) !important;
        column-gap: 0.5rem !important;
      }
      .audit-primary-controls > #auditDate {
        width: 6.85rem !important;
        min-width: 6.85rem !important;
        max-width: 6.85rem !important;
        font-size: 0.7rem !important;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})(typeof window !== 'undefined' ? window : globalThis);
