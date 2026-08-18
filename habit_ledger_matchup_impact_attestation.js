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
        min-height: 1.05rem;
        margin-top: 0.08rem;
        overflow: hidden;
        color: rgba(94, 234, 212, 0.9);
        font-size: 0.72rem;
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

  function install() {
    installStyle();
    installPhaseFeedback();
  }

  install();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);
