(() => {
  "use strict";

  const DATABASE_NAME = "calameo-pdf-prepared";
  const STORE_NAME = "documents";
  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
  const POLL_INTERVAL_MS = 500;
  const cacheKey = new URLSearchParams(location.search).get("key") || "";
  const preview = document.getElementById("pdf-preview");
  let previewUrl = "";

  window.addEventListener("afterprint", finishPrint);

  function finishPrint() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }
    notifyParent("PRINT_CLOSED");
  }
  window.addEventListener("pagehide", () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }
  });

  void waitForPreparedPdf();

  async function waitForPreparedPdf() {
    if (!cacheKey) {
      showError("Le document à imprimer est introuvable. Retourne au lecteur Calaméo et réessaie.");
      return;
    }

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let failureObservedAt = 0;
    while (Date.now() < deadline) {
      try {
        const record = await readPreparedDocument(cacheKey);
        if (record?.status === "ready" && record.pdf instanceof Blob && record.pdf.size > 0) {
          showPdf(record.pdf);
          return;
        }
        if (record?.status === "failed") {
          failureObservedAt ||= Date.now();
          if (Date.now() - failureObservedAt >= 3000) {
            showError("La préparation du PDF complet a échoué. Retourne au lecteur et réessaie.");
            return;
          }
        } else {
          failureObservedAt = 0;
        }
      } catch {
        // The background page may still be creating the IndexedDB store.
      }
      await delay(POLL_INTERVAL_MS);
    }

    showError("La préparation du PDF prend trop de temps. Retourne au lecteur et utilise le bouton Télécharger.");
  }

  function showPdf(pdfBlob) {
    previewUrl = URL.createObjectURL(pdfBlob);
    preview.hidden = false;
    preview.addEventListener("load", () => {
      try {
        preview.contentWindow.addEventListener("afterprint", finishPrint, { once: true });
      } catch {
        // The browser PDF viewer may not expose its inner window.
      }
      window.setTimeout(printPdf, 1000);
    }, { once: true });
    preview.src = previewUrl;
  }

  function printPdf() {
    try {
      preview.contentWindow.print();
    } catch {
      showError("Impossible d’ouvrir l’impression du PDF complet.");
    }
  }

  function showError(message) {
    notifyParent("PRINT_ERROR", message);
  }

  function notifyParent(type, message) {
    window.parent.postMessage({ source: "calameo-pdf-export", type, message }, "*");
  }

  function readPreparedDocument(key) {
    return new Promise((resolve, reject) => {
      const openRequest = indexedDB.open(DATABASE_NAME, 1);
      openRequest.onupgradeneeded = () => {
        if (!openRequest.result.objectStoreNames.contains(STORE_NAME)) {
          openRequest.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      openRequest.onerror = () => reject(openRequest.error);
      openRequest.onsuccess = () => {
        const database = openRequest.result;
        const transaction = database.transaction(STORE_NAME, "readonly");
        const getRequest = transaction.objectStore(STORE_NAME).get(key);
        getRequest.onsuccess = () => {
          const record = getRequest.result;
          if (!record || Date.now() - record.createdAt > CACHE_MAX_AGE_MS) {
            resolve(null);
          } else {
            resolve(record);
          }
        };
        getRequest.onerror = () => reject(getRequest.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
})();
