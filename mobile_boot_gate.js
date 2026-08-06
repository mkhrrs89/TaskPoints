const DEFERRED_SCRIPT_TYPE = 'application/x-taskpoints-boot-deferred';

const COORDINATOR_SCRIPT = `<script id="tp-mobile-boot-runtime-coordinator">
(function coordinateTaskPointsMobileBoot(){
  if (window.__tpMobileBootCoordinator) return;

  const WORD = "TASKPOINTS";
  const FINAL_HOLD_MS = 1000;
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
  }

  function titleIsFinal() {
    return Boolean(titleEl && titleEl.textContent.trim() === WORD);
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
    cleanup();
    if (typeof originalCompleteBootView === "function") {
      originalCompleteBootView(revealOptions);
    }
  }

  function startRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (runtimeStarter ? Promise.resolve(runtimeStarter) : runtimeStarterReady)
      .then(starter => starter())
      .catch(error => console.error("TaskPoints deferred Home startup failed", error))
      .finally(() => {
        runtimeReady = true;
        performReveal();
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
    event.stopImmediatePropagation();
    if (skipRequested || revealed) return;

    skipRequested = true;
    revealOptions = { skipped: true };
    finalAt = performance.now();
    window.__tpForceMatrixCompletion?.();
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
    return new Promise(resolve => {
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
        live.addEventListener("load", resolve, { once: true });
        live.addEventListener("error", () => {
          console.error("TaskPoints startup script failed to load", source);
          resolve();
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
    const runtime = Array.from(document.querySelectorAll('script[data-tp-boot-deferred="runtime"]'));
    const afterRuntime = Array.from(document.querySelectorAll('script[data-tp-boot-deferred="after-runtime"]'));
    for (const node of runtime) await replayScript(node);
    for (const node of afterRuntime) await replayScript(node);
  }

  function installSettingsLazyInitializers() {
    if (!isSettingsPage || window.__tpSettingsLazyInitializersInstalled) return;
    window.__tpSettingsLazyInitializersInstalled = true;

    const idle = window.requestIdleCallback
      ? callback => window.requestIdleCallback(callback, { timeout: 800 })
      : callback => setTimeout(callback, 120);

    function lazySection(sectionId, functionName) {
      const section = document.getElementById(sectionId);
      const original = window[functionName];
      if (!section || typeof original !== "function") return;

      let initialized = false;
      const run = (...args) => {
        if (initialized && !args.length) return;
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

    lazySection("storageHealthSection", "renderStorageHealthPanel");
    lazySection("healthDataManagerSection", "renderHealthDataManager");
    lazySection("habitCalendarReportSection", "renderHabitCalendarSelector");
    lazySection("missingScoresSection", "populateMissingFlexOptions");
    lazySection("scoringSettingsSection", "renderScoringSettings");
    lazySection("habitTagColorsSection", "renderHabitTagColors");

    const originalRefreshShadow = window.refreshShadowMigrationStatus;
    if (typeof originalRefreshShadow === "function") {
      let scheduled = false;
      window.refreshShadowMigrationStatus = function() {
        if (scheduled) return;
        scheduled = true;
        idle(() => originalRefreshShadow.call(window));
      };
    }
  }

  const starter = async () => {
    await replayDeferredRuntime();
    installSettingsLazyInitializers();
    if (coordinator) coordinator.flushLateReadyListeners();
    else flushLocalReadyListeners();
    await Promise.resolve();
    await Promise.resolve();
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
          + '<link rel="prefetch" href="/settings.html">',
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
        element.append(RUNTIME_LOADER_SCRIPT, { html: true });
      }
    })
    .transform(freshResponse);
}

export { isHomePagePath, transformHomeBoot };
