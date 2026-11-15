(() => {
  "use strict";

  const ROOT_ID = "calameo-pdf-export-root";
  const PAGE_IMAGE_PATTERN = /\/p\d+\.svgz$/i;
  const state = {
    host: null,
    shadow: null,
    currentRequestId: null,
    terminalRequestId: null,
    busy: false,
    observer: null
  };

  initialize();

  function initialize() {
    if (!isReaderUrl()) {
      return;
    }

    if (!mountWidget()) {
      return;
    }
    refreshMetadata();

    state.observer = new MutationObserver((records) => {
      if (records.some((record) => !state.host.contains(record.target))) {
        refreshMetadata();
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"]
    });

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  function mountWidget() {
    if (document.getElementById(ROOT_ID)) {
      return false;
    }

    state.host = document.createElement("div");
    state.host.id = ROOT_ID;
    state.shadow = state.host.attachShadow({ mode: "open" });
    state.shadow.innerHTML = `
      <style>${styles()}</style>
      <div id="root">
        <section id="panel" class="panel" role="dialog" aria-label="Exporter en PDF" hidden>
          <header class="panel-head">
            <div class="identity">
              <span class="eyebrow">CALAMÉO</span>
              <h2>Exporter en PDF</h2>
            </div>
            <button id="close" class="icon-button" type="button" aria-label="Fermer la fenêtre">×</button>
          </header>

          <p id="book-meta" class="book-meta">Lecture des informations du document…</p>

          <fieldset id="options" class="options">
            <legend>Pages à inclure</legend>
            <label class="choice">
              <input type="radio" name="page-mode" value="all" checked>
              <span class="radio-mark" aria-hidden="true"></span>
              <span>Toutes les pages</span>
            </label>
            <label class="choice">
              <input type="radio" name="page-mode" value="selection">
              <span class="radio-mark" aria-hidden="true"></span>
              <span>Une sélection</span>
            </label>
            <div id="selection-wrap" class="selection-wrap" hidden>
              <label for="page-range">Numéros ou plages</label>
              <input id="page-range" class="page-range" type="text" inputmode="numeric" maxlength="160" placeholder="1-3, 8, 12-15" autocomplete="off">
              <p class="hint">Sépare les numéros par des virgules. Exemple : 1-3, 8, 12-15.</p>
            </div>
          </fieldset>

          <div class="actions">
            <button id="export" class="export-button" type="button" disabled>
              <span class="export-icon" aria-hidden="true">↓</span>
              <span>Créer le PDF</span>
            </button>
            <button id="cancel" class="cancel-button" type="button" hidden>Annuler</button>
          </div>

          <div id="progress-wrap" class="progress-wrap" hidden>
            <progress id="progress" max="1" value="0"></progress>
            <p id="status" class="status" role="status" aria-live="polite"></p>
          </div>
          <p id="message" class="message" role="status" aria-live="polite"></p>
        </section>

        <button id="launcher" class="launcher" type="button" aria-label="Exporter cette publication en PDF" aria-expanded="false" title="Exporter en PDF">
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M10 2.5v9.2m0 0 3.5-3.5M10 11.7 6.5 8.2M3.5 13.5v3h13v-3" />
          </svg>
          <span>PDF</span>
        </button>
      </div>`;

    (document.body || document.documentElement).appendChild(state.host);

    const launcher = getElement("launcher");
    const panel = getElement("panel");
    const closeButton = getElement("close");
    const exportButton = getElement("export");
    const cancelButton = getElement("cancel");
    const rangeInput = getElement("page-range");
    const selectionWrap = getElement("selection-wrap");

    launcher.addEventListener("click", () => togglePanel());
    closeButton.addEventListener("click", () => closePanel());
    exportButton.addEventListener("click", startExport);
    cancelButton.addEventListener("click", cancelExport);
    rangeInput.addEventListener("input", () => {
      if (getMode() === "selection") {
        clearMessage();
      }
    });

    state.shadow.querySelectorAll('input[name="page-mode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        selectionWrap.hidden = getMode() !== "selection";
        if (getMode() === "selection") {
          rangeInput.focus();
        }
        refreshMetadata();
      });
    });

    state.shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        closePanel();
      }
    });

    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return true;
  }

  function refreshMetadata() {
    if (!state.shadow || state.busy) {
      return;
    }

    const metadata = readReaderMetadata();
    const metaNode = getElement("book-meta");
    const exportButton = getElement("export");
    const canExport = metadata.pageCount > 0 && Boolean(metadata.pageTemplate);

    const metaText = metadata.pageCount
      ? `${metadata.pageCount} ${metadata.pageCount === 1 ? "page" : "pages"} dans cette publication`
      : "Lecture des informations du document…";
    if (metaNode.textContent !== metaText) {
      metaNode.textContent = metaText;
    }
    if (exportButton.disabled !== !canExport) {
      exportButton.disabled = !canExport;
    }

    if (!canExport && getElement("message").textContent === "") {
      getElement("message").textContent = "Le lecteur prépare les pages. Laisse la première page s’afficher puis réessaie.";
    } else if (canExport && getElement("message").textContent.includes("prépare les pages")) {
      clearMessage();
    }
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

  async function startExport() {
    if (state.busy) {
      return;
    }

    const metadata = readReaderMetadata();
    if (!metadata.pageCount || !metadata.pageTemplate) {
      refreshMetadata();
      return;
    }

    let pages;
    try {
      pages = getMode() === "all"
        ? Array.from({ length: metadata.pageCount }, (_, index) => index + 1)
        : parsePageRange(getElement("page-range").value, metadata.pageCount);
    } catch (error) {
      showMessage(error.message, "error");
      return;
    }

    const title = metadata.title;
    const suffix = getMode() === "all" ? "" : `-selection-${pages.length}-pages`;
    const requestId = createRequestId();
    state.currentRequestId = requestId;
    state.terminalRequestId = null;
    setBusy(true);
    showProgress("Préparation de l’export…", 0, pages.length);
    clearMessage();

    try {
      const result = await chrome.runtime.sendMessage({
        type: "CALAMEO_PDF_START",
        requestId,
        title,
        filename: `${slugify(title)}${suffix}`,
        pageCount: metadata.pageCount,
        pages,
        pageTemplate: metadata.pageTemplate
      });

      if (!result?.ok) {
        finishWithError(result?.error || "L’export PDF n’a pas pu démarrer.");
      }
    } catch {
      finishWithError("Impossible de communiquer avec l’extension. Recharge le lecteur et réessaie.");
    }
  }

  function cancelExport() {
    if (!state.currentRequestId) {
      return;
    }

    getElement("cancel").disabled = true;
    showProgress("Interruption de l’export…", 0, 1);
    chrome.runtime.sendMessage({
      type: "CALAMEO_PDF_CANCEL",
      requestId: state.currentRequestId
    }).catch(() => {});
  }

  function handleRuntimeMessage(message) {
    if (
      message?.type !== "CALAMEO_PDF_PROGRESS" ||
      message.requestId !== state.currentRequestId ||
      message.requestId === state.terminalRequestId
    ) {
      return;
    }

    switch (message.phase) {
      case "fetching":
        showProgress(message.detail || "Lecture des pages…", message.completed || 0, message.total || 1);
        break;
      case "assembling":
        showProgress(message.detail || "Création du PDF…", message.total || 1, message.total || 1);
        break;
      case "download-started":
        getElement("cancel").hidden = true;
        showProgress("Téléchargement du PDF…", message.total || 1, message.total || 1);
        break;
      case "complete":
        state.terminalRequestId = message.requestId;
        setBusy(false);
        setStatus("PDF téléchargé dans le dossier Téléchargements.", "success");
        break;
      case "download-error":
        state.terminalRequestId = message.requestId;
        finishWithError("Le navigateur n’a pas pu terminer le téléchargement du PDF.");
        break;
      case "cancelled":
        state.terminalRequestId = message.requestId;
        setBusy(false);
        setStatus("Export annulé.", "muted");
        break;
      case "error":
        state.terminalRequestId = message.requestId;
        finishWithError(message.detail || "Une erreur a empêché la création du PDF.");
        break;
      default:
        break;
    }
  }

  function parsePageRange(rawValue, pageCount) {
    const value = String(rawValue || "").trim();
    if (!value) {
      throw new Error("Entre au moins un numéro de page ou une plage.");
    }

    const pages = new Set();
    const parts = value.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) {
      throw new Error("La sélection de pages n’est pas valide.");
    }

    for (const part of parts) {
      const match = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part);
      if (!match) {
        throw new Error(`La valeur « ${part} » n’est pas valide. Utilise par exemple 1-3, 8, 12-15.`);
      }

      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      if (start < 1 || end < start || end > pageCount) {
        throw new Error(`Les pages doivent être comprises entre 1 et ${pageCount}.`);
      }
      for (let page = start; page <= end; page += 1) {
        pages.add(page);
      }
    }

    return [...pages].sort((left, right) => left - right);
  }

  function showProgress(text, completed, total) {
    const wrap = getElement("progress-wrap");
    const progress = getElement("progress");
    wrap.hidden = false;
    progress.max = Math.max(1, Number(total) || 1);
    progress.value = Math.min(progress.max, Math.max(0, Number(completed) || 0));
    setStatus(text, "normal");
  }

  function setStatus(text, tone) {
    const node = getElement("status");
    node.textContent = text;
    node.dataset.tone = tone;
  }

  function showMessage(text, tone = "normal") {
    const node = getElement("message");
    node.textContent = text;
    node.dataset.tone = tone;
  }

  function clearMessage() {
    if (!state.shadow) {
      return;
    }
    const node = getElement("message");
    node.textContent = "";
    node.dataset.tone = "normal";
  }

  function finishWithError(text) {
    state.terminalRequestId = state.currentRequestId;
    state.currentRequestId = null;
    setBusy(false);
    getElement("progress-wrap").hidden = true;
    showMessage(text, "error");
  }

  function setBusy(busy) {
    state.busy = busy;
    getElement("launcher").setAttribute("aria-busy", String(busy));
    const metadata = readReaderMetadata();
    getElement("export").disabled = busy || !metadata.pageCount || !metadata.pageTemplate;
    getElement("close").disabled = busy;
    getElement("cancel").hidden = !busy;
    getElement("cancel").disabled = false;
    state.shadow.querySelectorAll('input[name="page-mode"], #page-range').forEach((input) => {
      input.disabled = busy;
    });
  }

  function togglePanel() {
    const panel = getElement("panel");
    if (!panel.hidden) {
      closePanel();
      return;
    }

    refreshMetadata();
    panel.hidden = false;
    getElement("launcher").setAttribute("aria-expanded", "true");
    if (getMode() === "selection") {
      getElement("page-range").focus();
    }
  }

  function closePanel() {
    getElement("panel").hidden = true;
    getElement("launcher").setAttribute("aria-expanded", "false");
    getElement("launcher").focus();
  }

  function handleOutsidePointerDown(event) {
    if (!state.host || getElement("panel").hidden || state.host.contains(event.target)) {
      return;
    }
    closePanel();
  }

  function getMode() {
    return state.shadow.querySelector('input[name="page-mode"]:checked')?.value || "all";
  }

  function getElement(id) {
    return state.shadow.getElementById(id);
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

  function styles() {
    return `
      :host { all: initial; color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      #root {
        position: fixed;
        z-index: 2147483647;
        right: max(18px, env(safe-area-inset-right));
        bottom: max(18px, env(safe-area-inset-bottom));
        display: flex;
        align-items: flex-end;
        flex-direction: column;
        gap: 12px;
        color: #202426;
        font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .launcher {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 70px;
        height: 48px;
        padding: 0 15px;
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 999px;
        background: #252b2e;
        color: #fff;
        box-shadow: 0 8px 24px rgba(17, 27, 32, .28);
        font: 700 13px/1 system-ui, sans-serif;
        letter-spacing: .08em;
        cursor: pointer;
        transition: transform .16s ease, background .16s ease, box-shadow .16s ease;
      }
      .launcher:hover { transform: translateY(-2px); background: #171c1e; box-shadow: 0 10px 28px rgba(17,27,32,.34); }
      .launcher:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #84bd4d; outline-offset: 3px; }
      .launcher svg { width: 18px; height: 18px; fill: none; stroke: #a9d979; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .launcher[aria-busy="true"] { opacity: .75; cursor: progress; }
      .panel {
        width: min(356px, calc(100vw - 36px));
        padding: 21px;
        border: 1px solid rgba(32,36,38,.1);
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 18px 60px rgba(13, 23, 27, .24), 0 2px 8px rgba(13,23,27,.08);
        color: #202426;
        animation: panel-in .18s cubic-bezier(.2,.8,.2,1) both;
      }
      .panel[hidden] { display: none; }
      @keyframes panel-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
      .panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .identity { min-width: 0; }
      .eyebrow { display: block; margin-bottom: 4px; color: #687276; font-size: 10px; font-weight: 750; letter-spacing: .15em; }
      h2 { margin: 0; color: #202426; font: 600 21px/1.15 Georgia, "Times New Roman", serif; letter-spacing: -.025em; }
      .icon-button { display: grid; place-items: center; width: 30px; height: 30px; margin: -3px -4px 0 0; border: 0; border-radius: 50%; background: transparent; color: #778084; font: 400 23px/1 system-ui, sans-serif; cursor: pointer; }
      .icon-button:hover { background: #f1f4f2; color: #202426; }
      .book-meta { margin: 12px 0 18px; color: #6b7477; font-size: 12px; }
      .options { min-width: 0; margin: 0; padding: 0; border: 0; }
      .options legend { margin-bottom: 8px; color: #31393c; font-size: 12px; font-weight: 700; }
      .choice { position: relative; display: flex; align-items: center; gap: 10px; min-height: 35px; color: #263034; cursor: pointer; }
      .choice input { position: absolute; width: 1px; height: 1px; opacity: 0; }
      .radio-mark { display: grid; place-items: center; width: 17px; height: 17px; border: 1.5px solid #aab2b5; border-radius: 50%; transition: border-color .15s ease; }
      .choice input:checked + .radio-mark { border-color: #669537; }
      .choice input:checked + .radio-mark::after { width: 9px; height: 9px; border-radius: 50%; background: #84bd4d; content: ""; }
      .choice input:focus-visible + .radio-mark { outline: 3px solid #84bd4d; outline-offset: 3px; }
      .selection-wrap { padding: 5px 0 2px 27px; }
      .selection-wrap[hidden] { display: none; }
      .selection-wrap > label { display: block; margin-bottom: 6px; color: #566064; font-size: 11px; font-weight: 650; }
      .page-range { width: 100%; height: 39px; padding: 0 11px; border: 1px solid #c8d0d1; border-radius: 8px; background: #fbfcfb; color: #202426; font: 13px/1 system-ui, sans-serif; }
      .page-range::placeholder { color: #9aa3a5; }
      .hint { margin: 6px 0 0; color: #899194; font-size: 10px; line-height: 1.35; }
      .actions { display: flex; align-items: center; gap: 10px; margin-top: 17px; }
      .export-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; flex: 1; padding: 0 16px; border: 0; border-radius: 9px; background: #252b2e; color: #fff; font: 650 13px/1 system-ui, sans-serif; cursor: pointer; transition: background .15s ease, transform .15s ease; }
      .export-button:hover:not(:disabled) { transform: translateY(-1px); background: #111719; }
      .export-button:disabled { opacity: .42; cursor: not-allowed; }
      .export-icon { color: #b6e38d; font-size: 18px; line-height: 12px; }
      .cancel-button { min-height: 38px; padding: 0 10px; border: 1px solid #d6dcdd; border-radius: 8px; background: #fff; color: #5f696c; font: 600 12px/1 system-ui, sans-serif; cursor: pointer; }
      .cancel-button[hidden] { display: none; }
      .cancel-button:hover:not(:disabled) { background: #f4f6f5; }
      .progress-wrap { margin-top: 14px; }
      .progress-wrap[hidden] { display: none; }
      progress { display: block; width: 100%; height: 5px; border: 0; border-radius: 9px; overflow: hidden; appearance: none; }
      progress::-webkit-progress-bar { border-radius: 9px; background: #edf0ed; }
      progress::-webkit-progress-value { border-radius: 9px; background: #84bd4d; transition: width .2s ease; }
      progress::-moz-progress-bar { border-radius: 9px; background: #84bd4d; }
      .status { margin: 8px 0 0; color: #667074; font-size: 11px; }
      .status[data-tone="success"] { color: #42741f; }
      .message { margin: 11px 0 0; color: #738084; font-size: 11px; }
      .message:empty { display: none; }
      .message[data-tone="error"] { color: #a3332d; }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
      @media (max-width: 480px) { #root { right: 12px; bottom: 12px; } .panel { width: min(340px, calc(100vw - 24px)); } }
    `;
  }
})();
