"use strict";

importScripts("shared.js");

const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
const DOWNLOAD_RECORD_PREFIX = "calameo-pdf-download:";
let offscreenCreation;
const activeJobs = new Set();
const preparationJobs = new Map();
const finishedDownloadIds = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "CALAMEO_PDF_PREPARE") {
    if (!isCalameoReader(sender.url) || !Number.isInteger(sender.tab?.id)) {
      sendResponse({ ok: false });
      return false;
    }

    startOffscreenPreparation(message, sender.tab.id)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === "CALAMEO_PDF_START") {
    if (!isCalameoReader(sender.url) || !Number.isInteger(sender.tab?.id)) {
      sendResponse({ ok: false, error: "Ouvre une publication dans le lecteur Calaméo." });
      return false;
    }

    startOffscreenJob(message, sender.tab.id)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === "CALAMEO_PDF_CANCEL") {
    if (!isCalameoReader(sender.url)) {
      sendResponse({ ok: false });
      return false;
    }

    chrome.runtime.sendMessage({
      target: "calameo-pdf-offscreen",
      type: "CANCEL_JOB",
      requestId: message.requestId
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (sender.url === OFFSCREEN_URL) {
    if (message.type === "CALAMEO_PDF_STATUS") {
      forwardToTab(message.tabId, {
        type: "CALAMEO_PDF_PROGRESS",
        requestId: message.requestId,
        phase: message.phase,
        completed: message.completed,
        total: message.total,
        detail: message.detail
      });
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "CALAMEO_PDF_DOWNLOAD") {
      startDownload(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
      return true;
    }

    if (message.type === "CALAMEO_PDF_OFFSCREEN_IDLE") {
      activeJobs.delete(String(message.requestId || ""));
      preparationJobs.delete(String(message.requestId || ""));
      if (activeJobs.size === 0 && preparationJobs.size === 0) {
        scheduleOffscreenClose();
      }
      sendResponse({ ok: true });
      return false;
    }
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [requestId, preparation] of preparationJobs) {
    if (preparation.tabId === tabId) {
      chrome.runtime.sendMessage({
        target: "calameo-pdf-offscreen",
        type: "CANCEL_JOB",
        requestId
      }).catch(() => {});
      preparationJobs.delete(requestId);
    }
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) {
    return;
  }

  void finishDownload(delta.id, delta.state.current);
});

async function startOffscreenJob(message, tabId) {
  const job = validateJob(message);
  if (activeJobs.size > 0) {
    throw new Error("Un autre export PDF est déjà en cours. Réessaie dans un instant.");
  }

  await ensureOffscreenDocument();

  activeJobs.add(job.requestId);
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      target: "calameo-pdf-offscreen",
      type: "START_JOB",
      requestId: job.requestId,
      tabId,
      pageCount: job.pageCount,
      pages: job.pages,
      pageTemplate: job.pageTemplate,
      title: job.title,
      filename: job.filename
    });
  } catch (error) {
    activeJobs.delete(job.requestId);
    throw error;
  }

  if (!result?.ok) {
    activeJobs.delete(job.requestId);
    throw new Error(result?.error || "L'export PDF n'a pas pu démarrer.");
  }

  return { ok: true, requestId: job.requestId };
}

async function startOffscreenPreparation(message, tabId) {
  const preparation = validatePreparation(message);
  if (activeJobs.size > 0) {
    return { ok: false, error: "Un export PDF est déjà en cours." };
  }

  for (const [requestId, activePreparation] of preparationJobs) {
    if (activePreparation.tabId === tabId && activePreparation.cacheKey === preparation.cacheKey) {
      return { ok: true, requestId };
    }
    if (activePreparation.tabId === tabId) {
      chrome.runtime.sendMessage({
        target: "calameo-pdf-offscreen",
        type: "CANCEL_JOB",
        requestId
      }).catch(() => {});
      preparationJobs.delete(requestId);
    }
  }
  if (preparationJobs.size > 0) {
    return { ok: false, error: "Une autre publication est déjà en préparation." };
  }

  await ensureOffscreenDocument();
  if (activeJobs.size > 0 || preparationJobs.size > 0) {
    return { ok: false, error: "Une opération PDF vient de démarrer." };
  }

  preparationJobs.set(preparation.requestId, { tabId, cacheKey: preparation.cacheKey });
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      target: "calameo-pdf-offscreen",
      type: "PREPARE_FULL",
      requestId: preparation.requestId,
      tabId,
      pageCount: preparation.pageCount,
      pageTemplate: preparation.pageTemplate,
      title: preparation.title,
      force: preparation.force
    });
  } catch (error) {
    preparationJobs.delete(preparation.requestId);
    throw error;
  }

  if (!result?.ok) {
    preparationJobs.delete(preparation.requestId);
    return { ok: false, error: result?.error || "La préparation en arrière-plan n'a pas pu démarrer." };
  }

  return { ok: true, requestId: preparation.requestId };
}

function validateJob(message) {
  const requestId = String(message.requestId || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
    throw new Error("Identifiant d'export invalide.");
  }

  const pageCount = Number(message.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000) {
    throw new Error("Nombre de pages introuvable ou trop élevé.");
  }

  const pages = Array.isArray(message.pages)
    ? message.pages.map(Number)
    : [];
  if (!pages.length || pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
    throw new Error("La sélection de pages est invalide.");
  }

  const pageTemplate = validatePageTemplate(message.pageTemplate);

  const title = String(message.title || "Publication Calaméo").slice(0, 240);
  const filename = sanitizeFilename(String(message.filename || title));

  return { requestId, pageCount, pages, pageTemplate, title, filename };
}

function validatePreparation(message) {
  const requestId = String(message.requestId || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
    throw new Error("Identifiant de préparation invalide.");
  }

  const pageCount = Number(message.pageCount);
  const force = Boolean(message.force);
  const maxPages = force ? 2000 : 500;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > maxPages) {
    throw new Error("Cette publication est trop volumineuse pour une préparation anticipée.");
  }

  const pageTemplate = validatePageTemplate(message.pageTemplate);
  const title = String(message.title || "Publication Calaméo").slice(0, 240);
  const cacheKey = CalameoPdfShared.documentCacheKey(pageTemplate, pageCount, title);
  if (!cacheKey) {
    throw new Error("Le lecteur n'a pas fourni d'identifiant de document valide.");
  }

  return { requestId, pageCount, pageTemplate, title, force, cacheKey };
}

function validatePageTemplate(rawPageTemplate) {
  const pageTemplate = String(rawPageTemplate || "");
  const templateUrl = new URL(pageTemplate);
  if (
    templateUrl.protocol !== "https:" ||
    !isCalameoAssetHost(templateUrl.hostname) ||
    !/\/p\d+\.svgz$/i.test(templateUrl.pathname) ||
    !templateUrl.searchParams.has("_token_")
  ) {
    throw new Error("Le lecteur n'a pas fourni de ressource de page valide.");
  }
  return pageTemplate;
}

async function ensureOffscreenDocument() {
  if (offscreenCreation) {
    await offscreenCreation;
    return;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });
  if (contexts.length > 0) {
    return;
  }

  offscreenCreation = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS", "DOM_PARSER"],
    justification: "Assembler les ressources de pages Calaméo en PDF et créer le fichier local."
  });

  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = undefined;
  }
}

async function startDownload(message) {
  const requestId = String(message.requestId || "");
  const tabId = Number(message.tabId);
  const blobUrl = String(message.blobUrl || "");
  const expectedPrefix = `blob:${chrome.runtime.getURL("")}`;

  if (
    !/^[a-zA-Z0-9-]{8,80}$/.test(requestId) ||
    !Number.isInteger(tabId) ||
    !blobUrl.startsWith(expectedPrefix)
  ) {
    throw new Error("Le fichier PDF préparé n'est pas valide.");
  }

  const filename = `${sanitizeFilename(String(message.filename || "publication-calameo"))}.pdf`;
  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });

  const recordKey = `${DOWNLOAD_RECORD_PREFIX}${downloadId}`;
  await chrome.storage.session.set({
    [recordKey]: { requestId, tabId }
  });

  await forwardToTab(tabId, {
    type: "CALAMEO_PDF_PROGRESS",
    requestId,
    phase: "download-started"
  });

  const [item] = await chrome.downloads.search({ id: downloadId });
  if (item?.state === "complete" || item?.state === "interrupted") {
    void finishDownload(downloadId, item.state);
  }

  return { ok: true, downloadId };
}

async function finishDownload(downloadId, state) {
  const recordKey = `${DOWNLOAD_RECORD_PREFIX}${downloadId}`;
  const stored = await chrome.storage.session.get(recordKey);
  const record = stored[recordKey];
  if (!record || finishedDownloadIds.has(downloadId)) {
    return;
  }

  finishedDownloadIds.add(downloadId);
  await chrome.storage.session.remove(recordKey);
  await forwardToTab(record.tabId, {
    type: "CALAMEO_PDF_PROGRESS",
    requestId: record.requestId,
    phase: state === "complete" ? "complete" : "download-error"
  });

  chrome.runtime.sendMessage({
    target: "calameo-pdf-offscreen",
    type: "REVOKE_DOWNLOAD_URL",
    requestId: record.requestId
  }).catch(() => {});
  if (activeJobs.size === 0 && preparationJobs.size === 0) {
    scheduleOffscreenClose();
  }
}

function scheduleOffscreenClose() {
  setTimeout(async () => {
    try {
      if (activeJobs.size > 0 || preparationJobs.size > 0) {
        return;
      }

      const stored = await chrome.storage.session.get(null);
      const hasPendingDownloads = Object.keys(stored).some((key) => key.startsWith(DOWNLOAD_RECORD_PREFIX));
      if (hasPendingDownloads) {
        scheduleOffscreenClose();
        return;
      }

      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [OFFSCREEN_URL]
      });
      if (contexts.length) {
        await chrome.offscreen.closeDocument();
      }
    } catch {
      // A close can race with a newly started export. The next export reuses the document.
    }
  }, 120000);
}

async function forwardToTab(tabId, message) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The reader tab may have closed or navigated during a long export.
  }
}

function isCalameoReader(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return ["www.calameo.com", "calameo.com"].includes(url.hostname) && /^\/read\//.test(url.pathname);
  } catch {
    return false;
  }
}

function isCalameoAssetHost(hostname) {
  return hostname === "calameoassets.com" || hostname.endsWith(".calameoassets.com");
}

function sanitizeFilename(value) {
  const clean = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return clean || "publication-calameo";
}

function readableError(error) {
  return error instanceof Error ? error.message : "Erreur inattendue pendant l'export.";
}
