const HOME_BOOT_DEFERRED_SCRIPT_TYPE = 'application/x-taskpoints-boot-deferred';

const HOME_BOOT_COORDINATOR_SCRIPT = `<script id="tp-mobile-boot-runtime-coordinator">
(function coordinateTaskPointsMobileBoot(){
  if (window.__tpMobileBootCoordinator) return;

  const FINAL_HOLD_MS = 1000;
  const WORD = "TASKPOINTS";
  const root = document.documentElement;
  const shouldGateBoot = root.classList.contains("tp-boot-pending");
  const originalCompleteBootView = window.__tpCompleteBootView;
  const titleEl = document.getElementById("matrixTitle");
  const splash = document.getElementById("bootSplash");

  let runtimeStarter = null;
  let resolveRuntimeStarter;
  const runtimeStarterReady = new Promise(resolve => {
    resolveRuntimeStarter = resolve;
  });
  let runtimePromise = null;
  let runtimeReady = false;
  let finalAt = 0;
  let revealRequested = null;
  let revealTimer = null;
  let skipRequested = false;
  let revealed = false;
  let observer = null;
  const lateReadyListeners = [];
  const nativeDocumentAddEventListener = document.addEventListener.bind(document);
  const nativeDocumentRemoveEventListener = document.removeEventListener.bind(document);
  const nativeWindowAddEventListener = window.addEventListener.bind(window);
  const nativeWindowRemoveEventListener = window.removeEventListener.bind(window);
  let readyListenerCaptureActive = true;

  const captureLateReadyListener = (target, type, listener, options) => {
    if (!readyListenerCaptureActive || !listener) return false;
    const alreadyPassed = type === "DOMContentLoaded"
      ? document.readyState !== "loading"
      : type === "load" && document.readyState === "complete";
    if (!alreadyPassed) return false;
    lateReadyListeners.push({ target, type, listener, options });
    return true;
  };

  document.addEventListener = function(type, listener, options) {
    if (captureLateReadyListener(document, type, listener, options)) return;
    return nativeDocumentAddEventListener(type, listener, options);
  };
  document.removeEventListener = function(type, listener, options) {
    for (let index = lateReadyListeners.length - 1; index >= 0; index -= 1) {
      const row = lateReadyListeners[index];
      if (row.target === document && row.type === type && row.listener === listener) {
        lateReadyListeners.splice(index, 1);
      }
    }
    return nativeDocumentRemoveEventListener(type, listener, options);
  };
  window.addEventListener = function(type, listener, options) {
    if (captureLateReadyListener(window, type, listener, options)) return;
    return nativeWindowAddEventListener(type, listener, options);
  };
  window.removeEventListener = function(type, listener, options) {
    for (let index = lateReadyListeners.length - 1; index >= 0; index -= 1) {
      const row = lateReadyListeners[index];
      if (row.target === window && row.type === type && row.listener === listener) {
        lateReadyListeners.splice(index, 1);
      }
    }
    return nativeWindowRemoveEventListener(type, listener, options);
  };

  const flushLateReadyListeners = () => {
    readyListenerCaptureActive = false;
    document.addEventListener = nativeDocumentAddEventListener;
    document.removeEventListener = nativeDocumentRemoveEventListener;
    window.addEventListener = nativeWindowAddEventListener;
    window.removeEventListener = nativeWindowRemoveEventListener;

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
  };

  const captureEvents = ["pointerdown", "touchstart", "click", "keydown"];

  const cleanup = () => {
    if (observer) observer.disconnect();
    observer = null;
    if (!splash) return;
    captureEvents.forEach(type => splash.removeEventListener(type, captureSkip, true));
  };

  const performReveal = () => {
    if (revealed || !revealRequested || !runtimeReady) return;
    if (shouldGateBoot && !skipRequested && !finalAt) return;

    const remainingHold = shouldGateBoot && !skipRequested
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
      originalCompleteBootView(revealRequested);
    }
  };

  const startRuntime = () => {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (runtimeStarter
      ? Promise.resolve(runtimeStarter)
      : runtimeStarterReady
    )
      .then(starter => starter())
      .catch(error => {
        console.error("TaskPoints deferred Home startup failed", error);
      })
      .finally(() => {
        runtimeReady = true;
        performReveal();
      });
    return runtimePromise;
  };

  const markFinalTitle = () => {
    if (!finalAt) finalAt = performance.now();
    startRuntime();
    performReveal();
  };

  const titleIsFinal = () => {
    if (!titleEl) return false;
    if (titleEl.querySelector(".tp-matrix-stage")) return false;
    return titleEl.textContent.trim() === WORD;
  };

  const checkFinalTitle = () => {
    if (titleIsFinal()) markFinalTitle();
  };

  const requestReveal = (options = {}) => {
    const skipped = Boolean(options.skipped);
    revealRequested = { skipped };
    if (skipped) {
      skipRequested = true;
      if (!finalAt) finalAt = performance.now();
      startRuntime();
    }
    performReveal();
    return true;
  };

  window.__tpCompleteBootView = requestReveal;

  function captureSkip(event) {
    if (event.type === "keydown" && !["Enter", " ", "Escape"].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (skipRequested || revealed) return;

    skipRequested = true;
    revealRequested = { skipped: true };
    finalAt = performance.now();
    window.__tpForceMatrixCompletion?.();
    startRuntime();
    performReveal();
  }

  if (shouldGateBoot && splash) {
    captureEvents.forEach(type => splash.addEventListener(type, captureSkip, {
      capture: true,
      passive: false
    }));
  }

  if (titleEl) {
    observer = new MutationObserver(checkFinalTitle);
    observer.observe(titleEl, {
      childList: true,
      subtree: true,
      characterData: true
    });
    checkFinalTitle();
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
      if (!shouldGateBoot || finalAt || skipRequested) startRuntime();
    },
    requestReveal,
    markFinalTitle,
    isSkipRequested() {
      return skipRequested;
    },
    flushLateReadyListeners
  };

  if (!shouldGateBoot) {
    finalAt = performance.now();
    startRuntime();
  } else if (window.__tpBootRevealPending?.skipped) {
    skipRequested = true;
    revealRequested = { skipped: true };
    finalAt = performance.now();
    window.__tpForceMatrixCompletion?.();
    startRuntime();
  }

  setTimeout(() => {
    if (!shouldGateBoot || finalAt || revealed) return;
    window.__tpForceMatrixCompletion?.();
    if (!titleIsFinal()) window.__tpForceMatrixFinal?.();
    markFinalTitle();
  }, 4200);
})();
</script>`;

const HOME_BOOT_RUNTIME_LOADER_SCRIPT = `<script id="tp-mobile-boot-runtime-loader">
(function installTaskPointsDeferredRuntime(){
  const coordinator = window.__tpMobileBootCoordinator;

  const replayScript = node => new Promise(resolve => {
    const live = document.createElement("script");
    const originalType = node.getAttribute("data-tp-boot-original-type");

    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name === "type") continue;
      if (attribute.name === "data-tp-boot-deferred") continue;
      if (attribute.name === "data-tp-boot-original-type") continue;
      if (attribute.name === "async" || attribute.name === "defer") continue;
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

  const replayDeferredRuntime = async () => {
    const deferred = Array.from(document.querySelectorAll("script[data-tp-boot-deferred=\"runtime\"]"));
    const deferredLate = Array.from(document.querySelectorAll("script[data-tp-boot-deferred=\"after-runtime\"]"));
    for (const node of deferred) {
      await replayScript(node);
    }
    for (const node of deferredLate) {
      await replayScript(node);
    }
  };

  if (coordinator) {
    coordinator.installRuntimeStarter(async () => {
      await replayDeferredRuntime();
      coordinator.flushLateReadyListeners();
      await Promise.resolve();
      await Promise.resolve();
      coordinator.requestReveal({ skipped: coordinator.isSkipRequested() });
    });
  } else {
    replayDeferredRuntime();
  }
})();
</script>`;

function isHomePagePath(pathname) {
  const clean = String(pathname || '').replace(/\/+$/, '');
  return clean === '' || clean === '/index.html';
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
  let deferRuntimeScripts = false;

  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(
          '<link rel="preload" href="/scoring_core.js" as="script">'
          + '<link rel="apple-touch-startup-image" href="/assets/taskpoints-startup-1170x2532.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)">',
          { html: true }
        );
      }
    })
    .on('script#tp-early-matrix-bootstrap', {
      element(element) {
        element.after(HOME_BOOT_COORDINATOR_SCRIPT, { html: true });
      }
    })
    .on('script', {
      element(element) {
        const src = String(element.getAttribute('src') || '').split('?')[0];
        const isToolbar = /(^|\/)toolbar\.js$/.test(src);
        if (/(^|\/)scoring_core\.js$/.test(src)) deferRuntimeScripts = true;
        if (!isToolbar && !deferRuntimeScripts) return;

        const originalType = element.getAttribute('type');
        if (originalType) element.setAttribute('data-tp-boot-original-type', originalType);
        element.setAttribute('data-tp-boot-deferred', isToolbar ? 'after-runtime' : 'runtime');
        element.setAttribute('type', HOME_BOOT_DEFERRED_SCRIPT_TYPE);
      }
    })
    .on('body', {
      element(element) {
        element.append(HOME_BOOT_RUNTIME_LOADER_SCRIPT, { html: true });
      }
    })
    .transform(freshResponse);
}

export { isHomePagePath, transformHomeBoot };
