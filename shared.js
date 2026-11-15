(() => {
  "use strict";

  const CACHE_KEY_VERSION = 1;

  function documentCacheKey(pageTemplate, pageCount, title) {
    try {
      const url = new URL(pageTemplate);
      if (!/\/p\d+\.svgz$/i.test(url.pathname)) {
        return "";
      }

      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/p\d+\.svgz$/i, "p*.svgz");
      const normalizedTitle = String(title || "Publication Calaméo").trim().toLocaleLowerCase();
      return `v${CACHE_KEY_VERSION}|${url.origin}${url.pathname}|${Number(pageCount)}|${normalizedTitle}`;
    } catch {
      return "";
    }
  }

  globalThis.CalameoPdfShared = Object.freeze({ documentCacheKey });
})();
