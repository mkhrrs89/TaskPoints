const DEFERRED_SCRIPT_TYPE = 'application/x-taskpoints-boot-deferred';

const COORDINATOR_SCRIPT = `<script id="tp-mobile-boot-runtime-coordinator">
(function coordinateTaskPointsMobileBoot(){
  if (window.__tpMobileBootCoordinator) return;

  const WORD = "TASKPOINTS";
  // Keep the finished TASKPOINTS animation visible briefly, but avoid an
  // extra full second of blank-app waiting once runtime initialization is ready.
  const FINAL_HOLD_MS = 160;
  const shouldGate = document.documentElement.classList.contains("tp-boot-pending");
  const originalCompleteBootView = window.__tpCompleteBootView;
  const titleEl = document.getElementById("matrixTitle");
  const splash = document.getElementById("bootSplash");

  let runtimeStarter = null;
  let resolveRuntimeStarter;
  const runtimeStarterReady = new Promise(resolve => { resolveRuntimeStarter = resolve; });
  let runtimePromise = null;
  let runtimeReady = false;
  let revealOptions = null;
  let finalAt = 0;
  let skipRequested = false;
  let revealed = false;
  let revealTimer = null;
  let titleObserver = null;

  const lateReadyListeners = [];
  const nativeDocumentAdd = document.addEventListener.bind(document);
  const nativeDocumentRemove = document.removeEventListener.bind(document);
  const nativeWindowAdd = window.addEventListener.bind(window);
  const nativeWindowRemove = window.removeEventListener.bind(window);
  let captureLateReady = true;

  // Tiny, content-free boot timeline survives a killed/suspended iPhone tab.
  // Separate from TaskPoints' authoritative game data and safety vault.
  function bootTraceStage(name) {
    try {
      // Settings is also transformed by the mobile boot gate, but opening
      // Settings to inspect the Home trace must NOT overwrite the evidence.
      if (/(^|\\/)settings(?:\\.html)?$/.test(window.location?.pathname || '')) return;
      const storage = window.localStorage;
      const key = 'tp_home_boot_timing_v1';
      const now = new Date();
      const dateKey = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
      ].join('-');
      const raw = storage.getItem(key);
      let report = raw ? JSON.parse(raw) : null;
      if (!report || report.dateKey !== dateKey || !Array.isArray(report.phases)) {
        report = { version: 1, dateKey, phases: [], priorAttempts: [] };
      }
      if (name === 'coordinator-start' && report.phases.length) {
        // Keep the previous attempts so two force-closes followed by a
        // successful third try still leave useful troubleshooting evidence.
        report.priorAttempts = Array.isArray(report.priorAttempts) ? report.priorAttempts : [];
        report.priorAttempts.push(report.phases);
        report.priorAttempts = report.priorAttempts.slice(-3);
        report.phases = [];
      }
      report.phases.push({ name, atMs: Math.round(performance.now()) });
      report.phases = report.phases.slice(-16);
      storage.setItem(key, JSON.stringify(report));
    } catch (_) {}
  }
  window.__tpBootTraceStage = bootTraceStage;
  bootTraceStage('coordinator-start');

  function passedReadyEvent(type) {
    if (type === "DOMContentLoaded") return document.readyState !== "loading";
    if (type === "load") return document.readyState === "complete";
    return false;
  }

  function captureListener(target, type, listener, options) {
    if (!captureLateReady || !listener || !passedReadyEvent(type)) return false;
    lateReadyListeners.push({ target, type, listener, options });
    return true;
  }

  document.addEventListener = function(type, listener, options) {
    if (captureListener(document, type, listener, options)) return;
    return nativeDocumentAdd(type, listener, options);
  };
  document.removeEventListener = function(type, listener, options) {
    for (let index = lateReadyListeners.length - 1; index >= 0; index -= 1) {
      const row = lateReadyListeners[index];
      if (row.target === document && row.type === type && row.listener === listener) {
        lateReadyListeners.splice(index, 1);
      }
    }
    return nativeDocumentRemove(type, listener, options);
  };
  window.addEventListener = function(type, listener, options) {
    if (captureListener(window, type, listener, options)) return;
    return nativeWindowAdd(type, listener, options);
  };
  window.removeEventListener = function(type, listener, options) {
    for (let index = lateReadyListeners.length - 1; index >= 0; index -= 1) {
      const row = lateReadyListeners[index];
      if (row.target === window && row.type === type && row.listener === listener) {
        lateReadyListeners.splice(index, 1);
      }
    }
    return nativeWindowRemove(type, listener, options);
  };

  function flushLateReadyListeners() {
    bootTraceStage('ready-listeners-start');
    captureLateReady = false;
    document.addEventListener = nativeDocumentAdd;
    document.removeEventListener = nativeDocumentRemove;
    window.addEventListener = nativeWindowAdd;
    window.removeEventListener = nativeWindowRemove;

    while (lateReadyListeners.length) {
      const row = lateReadyListeners.shift();
      const event = new Event(row.type);
      try {
        if (typeof row.listener === "function") row.listener.call(row.target, event);
        else row.listener?.handleEvent?.(event);
      } catch (error) {
        setTimeout(() => { throw error; });
      }
    }
    bootTraceStage('ready-listeners-finished');
  }

  function titleIsFinal() {
    return Boolean(titleEl && titleEl.textContent.trim() === WORD);
  }

  // A failed or stalled deferred runtime must not trap the user on the splash.
  // This notice lives OUTSIDE the splash so the splash's skip-event handlers
  // cannot intercept taps on the recovery link.
  function showStartupRecovery(reason = "slow") {
    if (revealed || document.getElementById("tp-boot-recovery-notice")) return;
    const parent = document.body || document.documentElement;
    if (!parent) return;
    const notice = document.createElement("div");
    notice.id = "tp-boot-recovery-notice";
    notice.setAttribute("role", "alert");
    notice.style.cssText = "position:fixed;z-index:2147483647;left:14px;right:14px;bottom:max(28px,env(safe-area-inset-bottom));margin:0 auto;max-width:460px;padding:16px;border:1px solid #b86b45;border-radius:14px;background:#241817;color:#ffe3d6;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 35px #000a;pointer-events:auto";
    const title = document.createElement("strong");
    title.textContent = "TaskPoints could not finish opening.";
    const explanation = document.createElement("div");
    explanation.textContent = reason === "failed"
      ? "The app encountered a startup error. Do not reset, import, or clear website data."
      : "Loading is taking longer than expected. Do not reset, import, or clear website data.";
    const link = document.createElement("a");
    link.href = "/emergency_recovery.html";
    link.textContent = "Open Recovery to inspect saved copies";
    link.style.cssText = "display:block;color:#ffca9f;text-decoration:underline;margin-top:10px;padding:6px 0";
    notice.append(title, explanation, link);
    parent.appendChild(notice);
  }

  function cleanup() {
    titleObserver?.disconnect();
    titleObserver = null;
    if (!splash) return;
    ["pointerdown", "touchstart", "click", "keydown"].forEach(type => {
      splash.removeEventListener(type, captureSkip, true);
    });
  }

  function performReveal() {
    if (revealed || !revealOptions || !runtimeReady) return;
    if (shouldGate && !skipRequested && !finalAt) return;

    const remainingHold = shouldGate && !skipRequested
      ? Math.max(0, FINAL_HOLD_MS - (performance.now() - finalAt))
      : 0;

    if (remainingHold > 0) {
      if (revealTimer !== null) clearTimeout(revealTimer);
      revealTimer = setTimeout(() => {
        revealTimer = null;
        performReveal();
      }, remainingHold);
      return;
    }

    revealed = true;
    bootTraceStage('home-revealed');
    cleanup();
    document.getElementById("tp-boot-recovery-notice")?.remove();
    if (typeof originalCompleteBootView === "function") {
      originalCompleteBootView(revealOptions);
    }
  }

  function startRuntime() {
    if (runtimePromise) return runtimePromise;
    bootTraceStage('runtime-start');
    runtimePromise = (runtimeStarter ? Promise.resolve(runtimeStarter) : runtimeStarterReady)
      .then(starter => starter())
      .then(() => {
        // Only reveal Home after the complete runtime successfully starts.
        // A failed script must leave the existing read-only Recovery route visible.
        runtimeReady = true;
        bootTraceStage('runtime-ready');
        performReveal();
      })
      .catch(error => {
        console.error("TaskPoints deferred Home startup failed", error);
        bootTraceStage('runtime-error');
        showStartupRecovery("failed");
      });
    return runtimePromise;
  }

  function markFinalTitle() {
    if (!finalAt) finalAt = performance.now();
    startRuntime();
    performReveal();
  }

  function requestReveal(options = {}) {
    revealOptions = { skipped: Boolean(options.skipped) };
    if (revealOptions.skipped) {
      skipRequested = true;
      if (!finalAt) finalAt = performance.now();
      startRuntime();
    }
    performReveal();
    return true;
  }

  window.__tpCompleteBootView = requestReveal;

  function captureSkip(event) {
    if (event.type === "keydown" && !["Enter", " ", "Escape"].includes(event.key)) return;
    if (event.cancelable) event.preventDefault();
    // Do not swallow this event: the installed sequential-animation handler
    // must also receive it, otherwise it keeps animating after the tap.
    if (skipRequested || revealed) return;

    skipRequested = true;
    revealOptions = { skipped: true };
    finalAt = performance.now();
    if (typeof window.__tpSkipSequentialMatrix === 'function') {
      window.__tpSkipSequentialMatrix();
    } else {
      window.__tpForceMatrixCompletion?.();
    }
    // Skip the title immediately, even if the saved data is still loading.
    // Do not expose empty Home placeholders until the runtime is ready.
    if (titleEl) titleEl.style.display = 'none';
    const hint = splash?.querySelector('.bootSkipHint');
    if (hint) {
      hint.textContent = 'Loading your saved data…';
      hint.setAttribute('aria-hidden', 'false');
    }
    startRuntime();
    performReveal();
  }

  if (shouldGate && splash) {
    ["pointerdown", "touchstart", "click", "keydown"].forEach(type => {
      splash.addEventListener(type, captureSkip, { capture: true, passive: false });
    });
  }

  if (titleEl) {
    titleObserver = new MutationObserver(() => {
      if (titleIsFinal()) markFinalTitle();
    });
    titleObserver.observe(titleEl, { childList: true, subtree: true, characterData: true });
    if (titleIsFinal()) markFinalTitle();
  }

  window.addEventListener("tp:matrixFinished", () => {
    if (!titleIsFinal()) window.__tpForceMatrixFinal?.();
    markFinalTitle();
  }, { once: true });

  window.__tpMobileBootCoordinator = {
    installRuntimeStarter(starter) {
      if (runtimeStarter) return;
      runtimeStarter = starter;
      resolveRuntimeStarter(starter);
      if (!shouldGate || finalAt || skipRequested) startRuntime();
    },
    requestReveal,
    isSkipRequested() { return skipRequested; },
    isRevealed() { return revealed; },
    flushLateReadyListeners
  };

  if (!shouldGate) {
    finalAt = performance.now();
    startRuntime();
  }

  setTimeout(() => {
    if (!shouldGate || finalAt || revealed) return;
    window.__tpForceMatrixCompletion?.();
    if (!titleIsFinal()) window.__tpForceMatrixFinal?.();
    markFinalTitle();
  }, 4200);

  // Independent of matrix animation flags and the main Home code. The old
  // watchdog could think the animation had finished even when data had not.
  setTimeout(() => {
    if (!revealed) showStartupRecovery("slow");
  }, 11000);
})();
</script>`;

const SETTINGS_COLLAPSE_HEAD = `<style id="tp-settings-collapse-prepaint">html.tp-settings-collapsing body{visibility:hidden}</style>
<script id="tp-settings-collapse-prepaint-script">
(function prepareSettingsCollapse(){
  if (/(^|\\/)settings(?:\\.html)?$/.test(location.pathname)) {
    document.documentElement.classList.add("tp-settings-collapsing");
  }
})();
</script>`;

const SETTINGS_COLLAPSE_SCRIPT = `<script id="tp-settings-collapse-all">
(function collapseAllTaskPointsSettingsSections(){
  if (!/(^|\\/)settings(?:\\.html)?$/.test(location.pathname)) return;

  function finish() {
    document.documentElement.classList.remove("tp-settings-collapsing");
  }

  try {
    const stacks = Array.from(document.querySelectorAll("body .space-y-4"));
    const page = stacks.find(container => Array.from(container.children).some(child => {
      const heading = child.querySelector?.(".text-lg.font-semibold");
      return heading && heading.textContent.trim() === "Navigation Shortcuts";
    }));

    if (!page) return;

    const idsByTitle = {
      "Shadow IndexedDB Migration": "shadowMigrationSection",
      "Daily Brief + GitHub": "briefToolsSection",
      "Points Category Report": "categoryReportSection",
      "SCWM 2-Week Trend Lines": "scwmTrendSection",
      "Skills Data": "skillsDataSection",
      "Reset All Data": "resetAllDataSection"
    };

    const cards = Array.from(page.children);
    const navigationCard = cards.find(child => {
      const heading = child.querySelector?.(".text-lg.font-semibold");
      return heading && heading.textContent.trim() === "Navigation Shortcuts";
    });

    for (const card of cards) {
      if (card === navigationCard) continue;

      if (card.tagName === "DETAILS") {
        card.removeAttribute("open");
        card.classList.add("tp-settings-section");
        continue;
      }

      const title = card.querySelector(".text-lg.font-semibold");
      if (!title) continue;
      const titleText = title.textContent.trim();
      const titleBlock = title.parentElement;
      const description = titleBlock?.querySelector(".muted.text-sm") || null;

      const details = document.createElement("details");
      for (const attribute of Array.from(card.attributes)) {
        if (attribute.name === "aria-labelledby") continue;
        details.setAttribute(attribute.name, attribute.value);
      }
      details.removeAttribute("open");
      details.classList.add("tp-settings-section");
      if (!details.id) {
        details.id = idsByTitle[titleText]
          || titleText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "Section";
      }

      const summary = document.createElement("summary");
      summary.className = "flex items-center justify-between gap-3 flex-wrap cursor-pointer";
      const summaryBlock = document.createElement("div");
      summaryBlock.appendChild(title.cloneNode(true));
      if (description) summaryBlock.appendChild(description.cloneNode(true));
      summary.appendChild(summaryBlock);

      const body = document.createElement("div");
      body.className = "space-y-3 pt-4";

      const headerParent = titleBlock?.parentElement || null;
      titleBlock?.remove();
      if (headerParent && headerParent !== card && !headerParent.children.length && !headerParent.textContent.trim()) {
        headerParent.remove();
      }

      while (card.firstChild) body.appendChild(card.firstChild);
      details.append(summary, body);
      card.replaceWith(details);
    }

    Array.from(page.children).forEach(child => {
      if (child !== navigationCard && child.tagName === "DETAILS") child.removeAttribute("open");
    });
    window.__tpSettingsSectionsCollapsed = true;
  } catch (error) {
    console.error("TaskPoints Settings collapse setup failed", error);
  } finally {
    finish();
  }
})();
</script>`;

const RUNTIME_LOADER_SCRIPT = `<script id="tp-mobile-boot-runtime-loader">
(function installTaskPointsDeferredRuntime(){
  const coordinator = window.__tpMobileBootCoordinator;
  const isSettingsPage = /(^|\\/)settings(?:\\.html)?$/.test(location.pathname);

  const localLateReadyListeners = [];
  const nativeDocumentAdd = document.addEventListener.bind(document);
  const nativeDocumentRemove = document.removeEventListener.bind(document);
  const nativeWindowAdd = window.addEventListener.bind(window);
  const nativeWindowRemove = window.removeEventListener.bind(window);
  let localReadyCaptureActive = !coordinator;

  function passedReadyEvent(type) {
    if (type === "DOMContentLoaded") return document.readyState !== "loading";
    if (type === "load") return document.readyState === "complete";
    return false;
  }

  function captureLocalReadyListener(target, type, listener, options) {
    if (!localReadyCaptureActive || !listener || !passedReadyEvent(type)) return false;
    localLateReadyListeners.push({ target, type, listener, options });
    return true;
  }

  if (localReadyCaptureActive) {
    document.addEventListener = function(type, listener, options) {
      if (captureLocalReadyListener(document, type, listener, options)) return;
      return nativeDocumentAdd(type, listener, options);
    };
    document.removeEventListener = function(type, listener, options) {
      for (let index = localLateReadyListeners.length - 1; index >= 0; index -= 1) {
        const row = localLateReadyListeners[index];
        if (row.target === document && row.type === type && row.listener === listener) {
          localLateReadyListeners.splice(index, 1);
        }
      }
      return nativeDocumentRemove(type, listener, options);
    };
    window.addEventListener = function(type, listener, options) {
      if (captureLocalReadyListener(window, type, listener, options)) return;
      return nativeWindowAdd(type, listener, options);
    };
    window.removeEventListener = function(type, listener, options) {
      for (let index = localLateReadyListeners.length - 1; index >= 0; index -= 1) {
        const row = localLateReadyListeners[index];
        if (row.target === window && row.type === type && row.listener === listener) {
          localLateReadyListeners.splice(index, 1);
        }
      }
      return nativeWindowRemove(type, listener, options);
    };
  }

  function flushLocalReadyListeners() {
    if (!localReadyCaptureActive) return;
    localReadyCaptureActive = false;
    document.addEventListener = nativeDocumentAdd;
    document.removeEventListener = nativeDocumentRemove;
    window.addEventListener = nativeWindowAdd;
    window.removeEventListener = nativeWindowRemove;

    while (localLateReadyListeners.length) {
      const row = localLateReadyListeners.shift();
      const event = new Event(row.type);
      try {
        if (typeof row.listener === "function") row.listener.call(row.target, event);
        else row.listener?.handleEvent?.(event);
      } catch (error) {
        setTimeout(() => { throw error; });
      }
    }
  }

  function replayScript(node) {
    return new Promise((resolve, reject) => {
      const live = document.createElement("script");
      const originalType = node.getAttribute("data-tp-boot-original-type");

      for (const attribute of Array.from(node.attributes)) {
        if (["type", "data-tp-boot-deferred", "data-tp-boot-original-type", "async", "defer"].includes(attribute.name)) continue;
        live.setAttribute(attribute.name, attribute.value);
      }
      if (originalType) live.setAttribute("type", originalType);

      const source = node.getAttribute("src");
      if (source) {
        live.async = false;
        const isRequiredCore = source.split('?')[0].split('/').pop() === 'scoring_core.js';
        live.addEventListener("load", () => {
          if (isRequiredCore && typeof window.TaskPointsCore?.loadAppState !== "function") {
            reject(new Error("TaskPoints core script loaded but did not initialize"));
            return;
          }
          resolve();
        }, { once: true });
        live.addEventListener("error", () => {
          console.error("TaskPoints startup script failed to load", source);
          if (isRequiredCore) reject(new Error("Required TaskPoints core script could not load"));
          else resolve();
        }, { once: true });
        node.replaceWith(live);
        return;
      }

      live.textContent = node.textContent;
      node.replaceWith(live);
      resolve();
    });
  }

  async function replayDeferredRuntime() {
    window.__tpBootTraceStage?.('scripts-replay-start');
    const runtime = Array.from(document.querySelectorAll('script[data-tp-boot-deferred="runtime"]'));
    const afterRuntime = Array.from(document.querySelectorAll('script[data-tp-boot-deferred="after-runtime"]'));
    for (const node of runtime) await replayScript(node);
    for (const node of afterRuntime) await replayScript(node);
    window.__tpBootTraceStage?.('scripts-replay-finished');
  }

  function installSettingsLazyInitializers() {
    if (!isSettingsPage || window.__tpSettingsLazyInitializersInstalled) return;
    window.__tpSettingsLazyInitializersInstalled = true;

    function lazySection(sectionId, functionName) {
      const section = document.getElementById(sectionId);
      const original = window[functionName];
      if (!section || typeof original !== "function") return;

      let initialized = false;
      const run = (...args) => {
        initialized = true;
        return original.apply(window, args);
      };

      window[functionName] = function(...args) {
        if (!section.open) return;
        return run(...args);
      };

      section.addEventListener("toggle", () => {
        if (!section.open || initialized) return;
        requestAnimationFrame(() => run());
      });
    }

    lazySection("shadowMigrationSection", "refreshShadowMigrationStatus");
    lazySection("storageHealthSection", "renderStorageHealthPanel");
    lazySection("healthDataManagerSection", "renderHealthDataManager");
    lazySection("habitCalendarReportSection", "renderHabitCalendarSelector");
    lazySection("missingScoresSection", "populateMissingFlexOptions");
    lazySection("scoringSettingsSection", "renderScoringSettings");
    lazySection("habitTagColorsSection", "renderHabitTagColors");
  }

  const starter = async () => {
    await replayDeferredRuntime();
    installSettingsLazyInitializers();
    if (coordinator) coordinator.flushLateReadyListeners();
    else flushLocalReadyListeners();
    await Promise.resolve();
    await Promise.resolve();
    // A missing Home state means initialization failed, not that the user's
    // records are empty. Keep the fallback recovery screen instead.
    if (!isSettingsPage && (
      typeof window.TaskPointsCore?.loadAppState !== 'function'
      || typeof window.TaskPointsHomeLiveState?.getState !== 'function'
    )) {
      throw new Error('TaskPoints Home data runtime did not initialize');
    }
    coordinator?.requestReveal({ skipped: coordinator.isSkipRequested() });
  };

  if (coordinator) {
    coordinator.installRuntimeStarter(starter);
  } else {
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    nextFrame().then(nextFrame).then(starter);
  }
})();
</script>`;

function isHomePagePath(pathname) {
  const clean = String(pathname || '').replace(/\/+$/, '');
  return clean === '' || clean === '/index.html' || clean === '/settings.html' || clean === '/settings';
}

function transformHomeBoot(response) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('etag');
  headers.delete('last-modified');
  // Home/Settings contain substantial inline runtime code. Never let Safari,
  // an installed iPhone web app, or an intermediary reuse an older transformed
  // HTML shell after a production deploy; stale inline code can otherwise make
  // a successfully deployed UI fix appear to revert later.
  headers.set('cache-control', 'no-cache, no-store, must-revalidate');
  headers.set('pragma', 'no-cache');
  headers.set('expires', '0');
  headers.set('content-type', 'text/html; charset=utf-8');

  const freshResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });

  let deferRuntime = false;

  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(
          '<link rel="preload" href="/scoring_core.js" as="script">'
          + '<link rel="prefetch" href="/settings.html">'
          + SETTINGS_COLLAPSE_HEAD,
          { html: true }
        );
      }
    })
    .on('script#tp-early-matrix-bootstrap', {
      element(element) {
        element.after(COORDINATOR_SCRIPT, { html: true });
      }
    })
    .on('script', {
      element(element) {
        const src = String(element.getAttribute('src') || '').split('?')[0];
        const isToolbar = /(^|\/)toolbar\.js$/.test(src);
        if (/(^|\/)scoring_core\.js$/.test(src)) deferRuntime = true;
        if (!isToolbar && !deferRuntime) return;

        const originalType = element.getAttribute('type');
        if (originalType) element.setAttribute('data-tp-boot-original-type', originalType);
        element.setAttribute('data-tp-boot-deferred', isToolbar ? 'after-runtime' : 'runtime');
        element.setAttribute('type', DEFERRED_SCRIPT_TYPE);
      }
    })
    .on('body', {
      element(element) {
        element.append(SETTINGS_COLLAPSE_SCRIPT + RUNTIME_LOADER_SCRIPT, { html: true });
      }
    })
    .transform(freshResponse);
}

export { isHomePagePath, transformHomeBoot };