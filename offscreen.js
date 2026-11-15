"use strict";

const OFFSCREEN_TARGET = "calameo-pdf-offscreen";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const PDF_REFERENCE_EDGE_PT = 842;
const PREPARED_PDF_DATABASE = "calameo-pdf-prepared";
const PREPARED_PDF_STORE = "documents";
const PREPARED_PDF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREPARE_MAX_PAGES = 500;
const PREPARE_FORCED_MAX_PAGES = 2000;
const PREPARED_PDF_MAX_BYTES = 128 * 1024 * 1024;
const jobs = new Map();
const downloadUrls = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== OFFSCREEN_TARGET) {
    return false;
  }

  if (message.type === "START_JOB") {
    const requestId = String(message.requestId || "");
    const activePreparation = [...jobs.values()].find((job) => job.kind === "prepare");
    if (activePreparation) {
      const requestedCacheKey = CalameoPdfShared.documentCacheKey(
        message.pageTemplate,
        message.pageCount,
        message.title
      );
      if (isFullDocumentJob(message) && requestedCacheKey === activePreparation.cacheKey) {
        activePreparation.pendingExport = {
          requestId,
          tabId: Number(message.tabId),
          pageCount: Number(message.pageCount)
        };
        void report(
          activePreparation.tabId,
          requestId,
          "fetching",
          0,
          Number(message.pageCount),
          "Préparation du PDF complet en arrière-plan…"
        );
      } else {
        activePreparation.controller.abort();
      }
      activePreparation.done
        .then(() => startExportJob(message, sendResponse))
        .catch(() => sendResponse({ ok: false, error: "La préparation en arrière-plan n'a pas pu être interrompue." }));
      return true;
    }

    if (jobs.size > 0) {
      sendResponse({ ok: false, error: "Un autre export PDF est déjà en cours." });
      return false;
    }

    startExportJob(message, sendResponse);
    return false;
  }

  if (message.type === "PREPARE_FULL") {
    const requestId = String(message.requestId || "");
    if (jobs.size > 0) {
      sendResponse({ ok: false, error: "Une autre opération PDF est déjà en cours." });
      return false;
    }

    const controller = new AbortController();
    const job = {
      controller,
      kind: "prepare",
      tabId: Number(message.tabId),
      cacheKey: CalameoPdfShared.documentCacheKey(message.pageTemplate, message.pageCount, message.title),
      done: null
    };
    jobs.set(requestId, job);
    job.done = runPreparation(message, controller.signal, job)
      .finally(() => jobs.delete(requestId));
    sendResponse({ ok: true, requestId });
    return false;
  }

  if (message.type === "CANCEL_JOB") {
    jobs.get(String(message.requestId || ""))?.controller.abort();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "REVOKE_DOWNLOAD_URL") {
    revokeDownloadUrl(String(message.requestId || ""));
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function startExportJob(message, sendResponse) {
  const requestId = String(message.requestId || "");
  if (jobs.size > 0) {
    sendResponse({ ok: false, error: "Un autre export PDF est déjà en cours." });
    return;
  }

  const controller = new AbortController();
  const job = { controller, kind: "export", tabId: Number(message.tabId), done: null };
  jobs.set(requestId, job);
  sendResponse({ ok: true });
  job.done = runExport(message, controller.signal)
    .finally(() => jobs.delete(requestId));
}

async function runPreparation(job, signal, jobState) {
  const requestId = String(job.requestId || "");
  const pageCount = Number(job.pageCount);
  const title = String(job.title || "Publication Calaméo");
  const force = Boolean(job.force);
  const maxPages = force ? PREPARE_FORCED_MAX_PAGES : PREPARE_MAX_PAGES;
  const maxBytes = PREPARED_PDF_MAX_BYTES;
  const cacheKey = CalameoPdfShared.documentCacheKey(job.pageTemplate, pageCount, title);

  try {
    if (pageCount < 1 || pageCount > maxPages || !cacheKey) {
      return;
    }
    if (await readPreparedPdf(cacheKey, pageCount, title)) {
      return;
    }

    const writer = new PdfWriter(pageCount, title);
    let imageBytes = 0;
    for (let index = 0; index < pageCount; index += 1) {
      throwIfAborted(signal);
      const svgText = await fetchPageSvg(job.pageTemplate, index + 1, signal);
      const pageImage = await extractPageImage(svgText);
      throwIfAborted(signal);
      imageBytes += pageImage.bytes.length;
      if (imageBytes > maxBytes) {
        throw new Error("Le PDF dépasse la taille de préparation en arrière-plan.");
      }
      writer.appendPage(pageImage, index);
      if (jobState.pendingExport) {
        await report(
          jobState.pendingExport.tabId,
          jobState.pendingExport.requestId,
          "fetching",
          index + 1,
          pageCount,
          `Préparation de la page ${index + 1}…`
        );
      }
    }

    throwIfAborted(signal);
    const pdfBlob = writer.finish();
    await writePreparedPdf(cacheKey, pageCount, title, pdfBlob);
  } catch (error) {
    if (!signal.aborted) {
      await writePreparationFailure(cacheKey, pageCount, title, readableError(error)).catch(() => {});
    }
  } finally {
    await chrome.runtime.sendMessage({
      type: "CALAMEO_PDF_OFFSCREEN_IDLE",
      requestId
    }).catch(() => {});
  }
}

function isFullDocumentJob(job) {
  const pageCount = Number(job.pageCount);
  return Array.isArray(job.pages)
    && job.pages.length === pageCount
    && job.pages.every((page, index) => Number(page) === index + 1);
}

async function runExport(job, signal) {
  const requestId = String(job.requestId || "");
  const tabId = Number(job.tabId);

  try {
    const isFullDocument = job.pages.length === job.pageCount
      && job.pages.every((page, index) => page === index + 1);
    const cacheKey = CalameoPdfShared.documentCacheKey(job.pageTemplate, job.pageCount, job.title);
    let pdfBlob = isFullDocument
      ? await readPreparedPdf(cacheKey, job.pageCount, job.title)
      : null;

    if (pdfBlob) {
      await report(tabId, requestId, "assembling", job.pages.length, job.pages.length, "PDF complet déjà préparé en arrière-plan…");
    } else {
      const writer = new PdfWriter(job.pages.length, job.title);
      let imageBytes = 0;
      for (let index = 0; index < job.pages.length; index += 1) {
        throwIfAborted(signal);
        const pageNumber = job.pages[index];
        await report(tabId, requestId, "fetching", index, job.pages.length, `Lecture de la page ${pageNumber}…`);
        const svgText = await fetchPageSvg(job.pageTemplate, pageNumber, signal);
        const pageImage = await extractPageImage(svgText);
        throwIfAborted(signal);

        writer.appendPage(pageImage, index);
        imageBytes += pageImage.bytes.length;
        await report(tabId, requestId, "fetching", index + 1, job.pages.length, `Page ${pageNumber} prête`);
      }

      throwIfAborted(signal);
      await report(tabId, requestId, "assembling", job.pages.length, job.pages.length, "Création du PDF…");
      pdfBlob = writer.finish();
      if (isFullDocument && imageBytes <= PREPARED_PDF_MAX_BYTES && pdfBlob.size <= PREPARED_PDF_MAX_BYTES) {
        await writePreparedPdf(cacheKey, job.pageCount, job.title, pdfBlob).catch(() => {});
      }
    }

    throwIfAborted(signal);
    const blobUrl = URL.createObjectURL(pdfBlob);
    downloadUrls.set(requestId, blobUrl);

    const result = await chrome.runtime.sendMessage({
      type: "CALAMEO_PDF_DOWNLOAD",
      requestId,
      tabId,
      blobUrl,
      filename: job.filename
    });

    if (!result?.ok) {
      revokeDownloadUrl(requestId);
      throw new Error(result?.error || "Le navigateur n'a pas démarré le téléchargement.");
    }

    await chrome.runtime.sendMessage({
      type: "CALAMEO_PDF_OFFSCREEN_IDLE",
      requestId
    });

    // Keep the offscreen Blob alive while Chrome reads it; the downloads API also
    // asks the background worker to revoke it as soon as the transfer completes.
    setTimeout(() => {
      revokeDownloadUrl(requestId);
    }, 10 * 60 * 1000);
  } catch (error) {
    const cancelled = signal.aborted || error?.name === "AbortError";
    await report(
      tabId,
      requestId,
      cancelled ? "cancelled" : "error",
      0,
      job.pages.length,
      cancelled ? "Export interrompu" : readableError(error)
    );
    revokeDownloadUrl(requestId);
    await chrome.runtime.sendMessage({
      type: "CALAMEO_PDF_OFFSCREEN_IDLE",
      requestId
    });
  } finally {
    jobs.delete(requestId);
  }
}

async function fetchPageSvg(template, pageNumber, signal) {
  const url = createPageUrl(template, pageNumber);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    throw new Error(`Impossible de lire la page ${pageNumber}. Vérifie que le lecteur est toujours ouvert.`);
  }

  if (!response.ok) {
    throw new Error(`Calaméo a refusé la page ${pageNumber} (${response.status}). Recharge le lecteur et réessaie.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 4 || bytes.length > 25 * 1024 * 1024) {
    throw new Error(`La page ${pageNumber} a une taille inattendue.`);
  }

  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("Ce navigateur ne sait pas décompresser les pages SVG de cette publication.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }

  return new TextDecoder("utf-8").decode(bytes);
}

async function readPreparedPdf(cacheKey, pageCount, title) {
  if (!cacheKey) {
    return null;
  }

  const database = await openPreparedDatabase();
  const record = await new Promise((resolve, reject) => {
    const transaction = database.transaction(PREPARED_PDF_STORE, "readonly");
    const request = transaction.objectStore(PREPARED_PDF_STORE).get(cacheKey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });

  if (!record) {
    return null;
  }

  const isCurrent = record.status === "ready"
    && record.pageCount === pageCount
    && record.title === title
    && Date.now() - record.createdAt <= PREPARED_PDF_TTL_MS
    && record.pdf instanceof Blob
    && record.pdf.size > 0;
  if (!isCurrent) {
    await deletePreparedRecord(cacheKey).catch(() => {});
    return null;
  }
  return record.pdf;
}

async function writePreparedPdf(cacheKey, pageCount, title, pdfBlob) {
  if (!cacheKey || !(pdfBlob instanceof Blob) || pdfBlob.size === 0 || pdfBlob.size > PREPARED_PDF_MAX_BYTES) {
    return false;
  }

  await writePreparedRecord({
    key: cacheKey,
    status: "ready",
    pageCount,
    title,
    createdAt: Date.now(),
    pdf: pdfBlob
  });
  return true;
}

async function writePreparationFailure(cacheKey, pageCount, title, error) {
  if (!cacheKey) {
    return;
  }
  await writePreparedRecord({
    key: cacheKey,
    status: "failed",
    pageCount,
    title,
    createdAt: Date.now(),
    error: String(error || "")
  });
}

async function writePreparedRecord(record) {
  const database = await openPreparedDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(PREPARED_PDF_STORE, "readwrite");
    const store = transaction.objectStore(PREPARED_PDF_STORE);
    store.clear();
    store.put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Le cache PDF local n'a pas pu être enregistré."));
  }).finally(() => database.close());
}

async function deletePreparedRecord(cacheKey) {
  const database = await openPreparedDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(PREPARED_PDF_STORE, "readwrite");
    transaction.objectStore(PREPARED_PDF_STORE).delete(cacheKey);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Le cache PDF local n'a pas pu être supprimé."));
  }).finally(() => database.close());
}

function openPreparedDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PREPARED_PDF_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PREPARED_PDF_STORE)) {
        request.result.createObjectStore(PREPARED_PDF_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createPageUrl(template, pageNumber) {
  const url = new URL(template);
  if (!isCalameoAssetHost(url.hostname) || !url.searchParams.has("_token_")) {
    throw new Error("Le lien de page Calaméo n'est plus valide. Recharge le lecteur.");
  }

  if (!/\/p\d+\.svgz$/i.test(url.pathname)) {
    throw new Error("Le format des pages fourni par le lecteur n'est pas reconnu.");
  }

  url.pathname = url.pathname.replace(/p\d+\.svgz$/i, `p${pageNumber}.svgz`);
  return url.href;
}

async function extractPageImage(svgText) {
  const documentNode = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = documentNode.documentElement;
  if (root?.namespaceURI !== SVG_NS || root.localName.toLowerCase() !== "svg") {
    throw new Error("Une page reçue de Calaméo n'est pas un SVG valide.");
  }

  const svgSize = readSvgSize(root);
  const embeddedImage = root.querySelector("image");
  const href = embeddedImage?.getAttribute("href")
    || embeddedImage?.getAttributeNS(XLINK_NS, "href")
    || "";
  const dataImage = /^data:image\/jpeg;base64,([a-z0-9+/=\s]+)$/i.exec(href);

  if (dataImage) {
    const bytes = decodeBase64(dataImage[1]);
    const dimensions = readJpegDimensions(bytes);
    return {
      bytes,
      width: svgSize.width,
      height: svgSize.height,
      jpegWidth: dimensions.width,
      jpegHeight: dimensions.height,
      colorSpace: dimensions.colorSpace
    };
  }

  return rasterizeSvg(svgText, svgSize);
}

function readSvgSize(root) {
  const viewBox = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  const width = parseFloat(root.getAttribute("width") || "");
  const height = parseFloat(root.getAttribute("height") || "");
  if (width > 0 && height > 0) {
    return { width, height };
  }
  throw new Error("Les dimensions de cette page sont introuvables.");
}

async function rasterizeSvg(svgText, svgSize) {
  const blobUrl = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = blobUrl;
    await image.decode();

    const maxDimension = 2600;
    const scale = Math.min(1, maxDimension / Math.max(svgSize.width, svgSize.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(svgSize.width * scale));
    canvas.height = Math.max(1, Math.round(svgSize.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Impossible de préparer l'image PDF dans ce navigateur.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const jpegBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Impossible d'encoder une page en JPEG."));
      }, "image/jpeg", 0.94);
    });
    const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
    const dimensions = readJpegDimensions(bytes);
    return {
      bytes,
      width: svgSize.width,
      height: svgSize.height,
      jpegWidth: dimensions.width,
      jpegHeight: dimensions.height,
      colorSpace: dimensions.colorSpace
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function decodeBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1) {
    bytes[offset] = binary.charCodeAt(offset);
  }
  return bytes;
}

function readJpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Une page du document ne contient pas un JPEG valide.");
  }

  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) {
      break;
    }

    if (startOfFrame.has(marker) && offset + 9 < bytes.length) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      const components = bytes[offset + 9];
      return {
        width,
        height,
        colorSpace: components === 1 ? "DeviceGray" : components === 4 ? "DeviceCMYK" : "DeviceRGB"
      };
    }

    offset += length + 2;
  }

  throw new Error("Les dimensions JPEG de cette page sont introuvables.");
}

class PdfWriter {
  constructor(pageCount, title) {
    this.pageCount = pageCount;
    this.title = title;
    this.encoder = new TextEncoder();
    this.chunks = [];
    this.offsets = [];
    this.length = 0;
    this.objectCount = 3 + pageCount * 3;
    this.infoId = this.objectCount;
    this.nextPageIndex = 0;

    this.appendText("%PDF-1.4\n");
    this.appendObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const pageRefs = Array.from({ length: pageCount }, (_, index) => `${3 + index * 3} 0 R`);
    this.appendObject(2, `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageCount} >>`);
  }

  appendPage(image, pageIndex) {
    if (pageIndex !== this.nextPageIndex || pageIndex >= this.pageCount) {
      throw new Error("L'ordre des pages du PDF est invalide.");
    }

    const pageId = 3 + pageIndex * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const scale = PDF_REFERENCE_EDGE_PT / Math.max(image.width, image.height);
    const pageWidth = image.width * scale;
    const pageHeight = image.height * scale;
    const content = this.encoder.encode(
      `q\n${formatNumber(pageWidth)} 0 0 ${formatNumber(pageHeight)} 0 0 cm\n/Im0 Do\nQ\n`
    );

    this.appendObject(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(pageWidth)} ${formatNumber(pageHeight)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    const colorSpace = image.colorSpace === "DeviceGray" ? "/DeviceGray"
      : image.colorSpace === "DeviceCMYK" ? "/DeviceCMYK"
        : "/DeviceRGB";
    this.appendStreamObject(
      imageId,
      `<< /Type /XObject /Subtype /Image /Width ${image.jpegWidth} /Height ${image.jpegHeight} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>`,
      image.bytes
    );
    this.appendStreamObject(contentId, `<< /Length ${content.length} >>`, content);
    this.nextPageIndex += 1;
  }

  finish() {
    if (this.nextPageIndex !== this.pageCount) {
      throw new Error("Il manque des pages pour créer le PDF.");
    }

    const title = this.title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[\\()]/g, "\\$&")
      .slice(0, 240);
    this.appendObject(this.infoId, `<< /Title (${title}) /Creator (Calameo PDF Export) >>`);

    const xrefOffset = this.length;
    this.appendText(`xref\n0 ${this.objectCount + 1}\n`);
    this.appendText("0000000000 65535 f \n");
    for (let id = 1; id <= this.objectCount; id += 1) {
      this.appendText(`${String(this.offsets[id]).padStart(10, "0")} 00000 n \n`);
    }
    this.appendText(
      `trailer\n<< /Size ${this.objectCount + 1} /Root 1 0 R /Info ${this.infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    );
    return new Blob(this.chunks, { type: "application/pdf" });
  }

  appendObject(id, body) {
    this.offsets[id] = this.length;
    this.appendText(`${id} 0 obj\n${body}\nendobj\n`);
  }

  appendStreamObject(id, dictionary, bytes) {
    this.offsets[id] = this.length;
    this.appendText(`${id} 0 obj\n${dictionary}\nstream\n`);
    this.appendBytes(bytes);
    this.appendText("\nendstream\nendobj\n");
  }

  appendText(value) {
    this.appendBytes(this.encoder.encode(value));
  }

  appendBytes(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
}

function formatNumber(value) {
  return Number(value.toFixed(4)).toString();
}

function revokeDownloadUrl(requestId) {
  const url = downloadUrls.get(requestId);
  if (url) {
    URL.revokeObjectURL(url);
    downloadUrls.delete(requestId);
  }
}

async function report(tabId, requestId, phase, completed, total, detail) {
  await chrome.runtime.sendMessage({
    type: "CALAMEO_PDF_STATUS",
    tabId,
    requestId,
    phase,
    completed,
    total,
    detail
  }).catch(() => {});
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new DOMException("Export interrompu", "AbortError");
  }
}

function isCalameoAssetHost(hostname) {
  return hostname === "calameoassets.com" || hostname.endsWith(".calameoassets.com");
}

function readableError(error) {
  return error instanceof Error ? error.message : "Erreur inattendue pendant la création du PDF.";
}
