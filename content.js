(() => {
  "use strict";

  const PAGE_IMAGE_PATTERN = /\/p\d+\.svgz$/i;
  const state = {
    nativeDownloadButton: null,
    nativeDownloadClickHandler: null,
    nativeDownloadButtonObserver: null,
    nativeDownloadSnapshot: null,
    nativeOverrideActive: false,
    nativePrintButton: null,
    nativePrintClickHandler: null,
    nativePrintButtonObserver: null,
    nativePrintSnapshot: null,
    nativePrintOverrideActive: false,
    currentRequestId: null,
    terminalRequestId: null,
    busy: false,
    preparingDocumentKey: null,
    preparationRetryAfter: 0,
    printFrameHost: null,
    printFrame: null,
    observer: null
  };

  initialize();

  function initialize() {
    if (!isReaderUrl()) {
      return;
    }

    refreshMetadata();
    state.observer = new MutationObserver(() => refreshMetadata());
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"]
    });

    document.addEventListener("keydown", handlePrintShortcut, true);
    document.addEventListener("visibilitychange", refreshMetadata);
    window.addEventListener("message", handlePrintFrameMessage);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  function refreshMetadata() {
    const metadata = readReaderMetadata();
    syncNativeDownloadButton(metadata);
    syncNativePrintButton(metadata);
    if (metadata.pageCount > 0 && metadata.pageTemplate && !state.busy) {
      schedulePdfPreparation(metadata);
    }
  }

  function syncNativeDownloadButton(metadata = readReaderMetadata()) {
    const button = document.getElementById("action-8");
    if (button !== state.nativeDownloadButton) {
      releaseNativeDownloadButton();
      if (!button) {
        return;
      }

      state.nativeDownloadButton = button;
      state.nativeDownloadButtonObserver = new MutationObserver(() => syncNativeDownloadButton());
      state.nativeDownloadButtonObserver.observe(button, {
        attributes: true,
        attributeFilter: ["class", "disabled"]
      });
    }

    if (!button) {
      return;
    }
    if (!state.nativeOverrideActive && isNativeButtonDisabled(button)) {
      beginNativeDownloadOverride(button);
    }
    if (state.nativeOverrideActive && button === state.nativeDownloadButton) {
      updateNativeDownloadButton(metadata);
    }
  }

  function beginNativeDownloadOverride(button) {
    state.nativeDownloadSnapshot = captureButtonState(button);
    state.nativeDownloadClickHandler = handleNativeDownloadClick;
    state.nativeOverrideActive = true;
    button.addEventListener("click", state.nativeDownloadClickHandler, true);
    button.setAttribute("data-calameo-pdf-override", "true");
  }

  function updateNativeDownloadButton(metadata) {
    const button = state.nativeDownloadButton;
    if (!button || !state.nativeOverrideActive) {
      return;
    }

    const canExport = metadata.pageCount > 0 && Boolean(metadata.pageTemplate);
    const enabled = canExport && !state.busy;
    if (button.disabled !== !enabled) {
      button.disabled = !enabled;
    }
    button.classList.toggle("button-disabled", !enabled);
    button.classList.toggle("button-enabled", enabled);
    button.setAttribute("aria-label", state.busy
      ? "Création du PDF complet en cours"
      : canExport ? "Télécharger le document complet en PDF" : "Préparation du téléchargement PDF");
    button.setAttribute("title", state.busy
      ? "Création du PDF complet en cours…"
      : canExport ? "Télécharger le PDF complet" : "Le lecteur prépare les pages pour l’export PDF");
    button.setAttribute("aria-busy", String(state.busy));
  }

  function releaseNativeDownloadButton() {
    const button = state.nativeDownloadButton;
    if (button && state.nativeDownloadClickHandler) {
      button.removeEventListener("click", state.nativeDownloadClickHandler, true);
    }
    state.nativeDownloadButtonObserver?.disconnect();

    if (button && state.nativeOverrideActive && state.nativeDownloadSnapshot) {
      restoreButtonState(button, state.nativeDownloadSnapshot);
      button.removeAttribute("data-calameo-pdf-override");
    }

    state.nativeDownloadButton = null;
    state.nativeDownloadClickHandler = null;
    state.nativeDownloadButtonObserver = null;
    state.nativeDownloadSnapshot = null;
    state.nativeOverrideActive = false;
  }

  function syncNativePrintButton(metadata = readReaderMetadata()) {
    const button = document.getElementById("action-7");
    if (button !== state.nativePrintButton) {
      releaseNativePrintButton();
      if (!button) {
        return;
      }

      state.nativePrintButton = button;
      state.nativePrintButtonObserver = new MutationObserver(() => syncNativePrintButton());
      state.nativePrintButtonObserver.observe(button, {
        attributes: true,
        attributeFilter: ["class", "disabled"]
      });
    }

    if (!button) {
      return;
    }
    if (!state.nativePrintOverrideActive && isNativeButtonDisabled(button)) {
      beginNativePrintOverride(button);
    }
    if (state.nativePrintOverrideActive && button === state.nativePrintButton) {
      updateNativePrintButton(metadata);
    }
  }

  function beginNativePrintOverride(button) {
    state.nativePrintSnapshot = captureButtonState(button);
    state.nativePrintClickHandler = handleNativePrintClick;
    state.nativePrintOverrideActive = true;
    button.addEventListener("click", state.nativePrintClickHandler, true);
    button.setAttribute("data-calameo-pdf-print-override", "true");
  }

  function updateNativePrintButton(metadata) {
    const button = state.nativePrintButton;
    if (!button || !state.nativePrintOverrideActive) {
      return;
    }

    const canPrint = metadata.pageCount > 0 && metadata.pageCount <= 2000 && Boolean(metadata.pageTemplate);
    if (button.disabled !== !canPrint) {
      button.disabled = !canPrint;
    }
    button.classList.toggle("button-disabled", !canPrint);
    button.classList.toggle("button-enabled", canPrint);
    button.setAttribute("aria-label", canPrint
      ? "Imprimer le document complet"
      : metadata.pageCount > 2000 ? "Impression directe indisponible pour cette publication" : "Préparation du document pour l’impression");
    button.setAttribute("title", canPrint
      ? "Imprimer le PDF complet"
      : metadata.pageCount > 2000 ? "L’impression directe est limitée à 2 000 pages" : "Le lecteur prépare les pages pour l’impression");
  }

  function releaseNativePrintButton() {
    const button = state.nativePrintButton;
    if (button && state.nativePrintClickHandler) {
      button.removeEventListener("click", state.nativePrintClickHandler, true);
    }
    state.nativePrintButtonObserver?.disconnect();

    if (button && state.nativePrintOverrideActive && state.nativePrintSnapshot) {
      restoreButtonState(button, state.nativePrintSnapshot);
      button.removeAttribute("data-calameo-pdf-print-override");
    }

    state.nativePrintButton = null;
    state.nativePrintClickHandler = null;
    state.nativePrintButtonObserver = null;
    state.nativePrintSnapshot = null;
    state.nativePrintOverrideActive = false;
  }

  function captureButtonState(button) {
    return {
      disabled: button.disabled,
      disabledClass: button.classList.contains("button-disabled"),
      enabledClass: button.classList.contains("button-enabled"),
      ariaLabel: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      ariaHaspopup: button.getAttribute("aria-haspopup"),
      ariaExpanded: button.getAttribute("aria-expanded"),
      ariaBusy: button.getAttribute("aria-busy")
    };
  }

  function restoreButtonState(button, snapshot) {
    button.disabled = snapshot.disabled;
    button.classList.toggle("button-disabled", snapshot.disabledClass);
    button.classList.toggle("button-enabled", snapshot.enabledClass);
    restoreAttribute(button, "aria-label", snapshot.ariaLabel);
    restoreAttribute(button, "title", snapshot.title);
    restoreAttribute(button, "aria-haspopup", snapshot.ariaHaspopup);
    restoreAttribute(button, "aria-expanded", snapshot.ariaExpanded);
    restoreAttribute(button, "aria-busy", snapshot.ariaBusy);
  }

  function restoreAttribute(node, name, value) {
    if (value === null) {
      node.removeAttribute(name);
    } else {
      node.setAttribute(name, value);
    }
  }

  function isNativeButtonDisabled(button) {
    return Boolean(button?.disabled || button?.classList.contains("button-disabled"));
  }

  function handleNativeDownloadClick(event) {
    if (!state.nativeOverrideActive || event.currentTarget !== state.nativeDownloadButton) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    void startFullDocumentDownload();
  }

  function handleNativePrintClick(event) {
    if (!state.nativePrintOverrideActive || event.currentTarget !== state.nativePrintButton) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    startPdfPrint();
  }

  function readReaderMetadata() {
    const description = document.querySelector('meta[name="description"]')?.content || "";
    const countMatch = /\bLength:\s*([\d,]+)\s*pages?\b/i.exec(description);
    const pageCount = countMatch
      ? Number(countMatch[1].replace(/,/g, ""))
      : 0;

    const pageUrls = [...document.querySelectorAll("img")]
      .flatMap((image) => [image.currentSrc, image.src, image.getAttribute("src"), image.getAttribute("data-src")])
      .filter(Boolean)
      .map(toPageUrl)
      .filter(Boolean)
      .sort((left, right) => pageNumberFromUrl(left) - pageNumberFromUrl(right));

    return {
      title: document.title.replace(/\s*[|–—-]\s*Calam[eé]o\s*$/i, "").trim() || "Publication Calaméo",
      pageCount: Number.isSafeInteger(pageCount) && pageCount <= 10000 ? pageCount : 0,
      pageTemplate: pageUrls[0] || ""
    };
  }

  function toPageUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const isAssetHost = url.hostname === "calameoassets.com" || url.hostname.endsWith(".calameoassets.com");
      if (url.protocol === "https:" && isAssetHost && PAGE_IMAGE_PATTERN.test(url.pathname) && url.searchParams.has("_token_")) {
        return url.href;
      }
    } catch {
      // Ignore malformed image URLs in the viewer.
    }
    return "";
  }

  function pageNumberFromUrl(rawUrl) {
    const match = /\/p(\d+)\.svgz$/i.exec(new URL(rawUrl).pathname);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function schedulePdfPreparation(metadata = readReaderMetadata(), force = false) {
    if (
      !metadata.pageCount
      || !metadata.pageTemplate
      || (!force && metadata.pageCount > 500)
      || document.visibilityState === "hidden"
      || Date.now() < state.preparationRetryAfter
    ) {
      return;
    }

    const cacheKey = CalameoPdfShared.documentCacheKey(metadata.pageTemplate, metadata.pageCount, metadata.title);
    if (!cacheKey || (!force && state.preparingDocumentKey === cacheKey)) {
      return;
    }
    state.preparingDocumentKey = cacheKey;

    const start = () => {
      const current = readReaderMetadata();
      const currentKey = CalameoPdfShared.documentCacheKey(current.pageTemplate, current.pageCount, current.title);
      if (state.busy || document.visibilityState === "hidden" || currentKey !== cacheKey) {
        if (state.preparingDocumentKey === cacheKey) {
          state.preparingDocumentKey = null;
        }
        return;
      }

      chrome.runtime.sendMessage({
        type: "CALAMEO_PDF_PREPARE",
        requestId: createRequestId(),
        pageCount: metadata.pageCount,
        pageTemplate: metadata.pageTemplate,
        title: metadata.title,
        force
      }).then((result) => {
        if (!result?.ok && state.preparingDocumentKey === cacheKey) {
          state.preparingDocumentKey = null;
          state.preparationRetryAfter = Date.now() + 5000;
          window.setTimeout(() => {
            if (!state.busy) {
              schedulePdfPreparation(readReaderMetadata(), force);
            }
          }, 5500);
        }
      }).catch(() => {
        if (state.preparingDocumentKey === cacheKey) {
          state.preparingDocumentKey = null;
          state.preparationRetryAfter = Date.now() + 5000;
          window.setTimeout(() => {
            if (!state.busy) {
              schedulePdfPreparation(readReaderMetadata(), force);
            }
          }, 5500);
        }
      });
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(start, { timeout: 2500 });
    } else {
      window.setTimeout(start, 1200);
    }
  }

  function handlePrintShortcut(event) {
    if (
      event.defaultPrevented
      || event.repeat
      || (!event.ctrlKey && !event.metaKey)
      || event.altKey
      || event.shiftKey
      || String(event.key).toLowerCase() !== "p"
    ) {
      return;
    }

    const metadata = readReaderMetadata();
    if (!metadata.pageCount || !metadata.pageTemplate || metadata.pageCount > 2000) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    startPdfPrint(metadata);
  }

  function startPdfPrint(metadata = readReaderMetadata()) {
    if (!metadata.pageCount || !metadata.pageTemplate || metadata.pageCount > 2000) {
      return;
    }

    const cacheKey = CalameoPdfShared.documentCacheKey(metadata.pageTemplate, metadata.pageCount, metadata.title);
    if (!cacheKey) {
      return;
    }

    schedulePdfPreparation(metadata, true);
    const printUrl = `${chrome.runtime.getURL("print.html")}?key=${encodeURIComponent(cacheKey)}`;
    openPrintFrame(printUrl);
  }

  function openPrintFrame(printUrl) {
    if (state.printFrameHost?.isConnected) {
      state.printFrame?.contentWindow?.focus();
      return;
    }

    const host = document.createElement("div");
    host.id = "calameo-pdf-print-host";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;";

    const frame = document.createElement("iframe");
    frame.id = "calameo-pdf-print-frame";
    frame.title = "Impression du PDF Calaméo";
    frame.tabIndex = -1;
    frame.src = printUrl;
    frame.style.cssText = "display:block;width:1px;height:1px;border:0;";
    host.appendChild(frame);
    (document.documentElement || document.body).appendChild(host);

    state.printFrameHost = host;
    state.printFrame = frame;
  }

  function handlePrintFrameMessage(event) {
    if (
      !state.printFrame
      || event.source !== state.printFrame.contentWindow
      || event.origin !== new URL(chrome.runtime.getURL("")).origin
      || event.data?.source !== "calameo-pdf-export"
    ) {
      return;
    }

    if (event.data.type === "PRINT_CLOSED") {
      closePrintFrame();
    } else if (event.data.type === "PRINT_ERROR") {
      console.error("[Calaméo PDF Export]", event.data.message || "Impossible d’ouvrir l’impression du PDF complet.");
      closePrintFrame();
    }
  }

  function closePrintFrame() {
    state.printFrameHost?.remove();
    state.printFrameHost = null;
    state.printFrame = null;
  }

  async function startFullDocumentDownload() {
    if (state.busy) {
      return;
    }

    const metadata = readReaderMetadata();
    if (!metadata.pageCount || !metadata.pageTemplate) {
      refreshMetadata();
      return;
    }

    const requestId = createRequestId();
    state.preparingDocumentKey = null;
    state.currentRequestId = requestId;
    state.terminalRequestId = null;
    setDownloadBusy(true);

    try {
      const result = await chrome.runtime.sendMessage({
        type: "CALAMEO_PDF_START",
        requestId,
        title: metadata.title,
        filename: slugify(metadata.title),
        pageCount: metadata.pageCount,
        pages: Array.from({ length: metadata.pageCount }, (_, index) => index + 1),
        pageTemplate: metadata.pageTemplate
      });

      if (!result?.ok) {
        finishDownloadRequest(requestId, result?.error || "L’export PDF n’a pas pu démarrer.");
      }
    } catch {
      finishDownloadRequest(requestId, "Impossible de communiquer avec l’extension. Recharge le lecteur et réessaie.");
    }
  }

  function handleRuntimeMessage(message) {
    if (
      message?.type !== "CALAMEO_PDF_PROGRESS"
      || message.requestId !== state.currentRequestId
      || message.requestId === state.terminalRequestId
    ) {
      return;
    }

    switch (message.phase) {
      case "download-started":
        setDownloadBusy(false);
        schedulePdfPreparation(readReaderMetadata());
        break;
      case "complete":
        finishDownloadRequest(message.requestId);
        break;
      case "download-error":
      case "cancelled":
      case "error":
        finishDownloadRequest(message.requestId, message.detail || "Une erreur a empêché la création du PDF.");
        break;
      default:
        break;
    }
  }

  function finishDownloadRequest(requestId, error = "") {
    if (state.currentRequestId !== requestId) {
      return;
    }
    state.terminalRequestId = requestId;
    state.currentRequestId = null;
    setDownloadBusy(false);
    if (error) {
      console.error("[Calaméo PDF Export]", error);
    }
  }

  function setDownloadBusy(busy) {
    state.busy = busy;
    const metadata = readReaderMetadata();
    if (state.nativeOverrideActive) {
      updateNativeDownloadButton(metadata);
    }
  }

  function createRequestId() {
    return globalThis.crypto?.randomUUID?.()
      || `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function isReaderUrl() {
    return ["www.calameo.com", "calameo.com"].includes(location.hostname) && /^\/read\//.test(location.pathname);
  }

  function slugify(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100)
      || "publication-calameo";
  }
})();
