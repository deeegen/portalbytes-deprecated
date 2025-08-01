// proxify.js
export const proxify = {
  // Encode a single URL to proxied form
  url: (url, decode = false) => {
    if (!url) return;

    if (decode) {
      try {
        // Remove leading slash if present
        const cleanUrl = url.startsWith("/") ? url.substring(1) : url;

        if (cleanUrl.startsWith("_") && cleanUrl.includes("_/")) {
          const parts = cleanUrl.split("_");
          if (parts.length >= 3 && parts[1]) return atob(parts[1]);
        }

        const parts = cleanUrl.split("_");
        if (parts.length >= 3) {
          const decodedOrigin = atob(parts[1]);
          const pathPart = parts.slice(2).join("_").replace(/^\//, "");
          return decodedOrigin + (pathPart ? "/" + pathPart : "");
        }

        return url;
      } catch (e) {
        console.error("Failed to decode proxified URL:", e);
        return url;
      }
    }

    try {
      url = url.trim();

      // Normalize URL relative to current origin or alloy.baseURL
      if (!url.match(/^(#|about:|data:|blob:|mailto:|javascript:|{|\*)/)) {
        if (!/^https?:\/\//i.test(url)) {
          if (alloy.baseURL) {
            url = new URL(url, alloy.baseURL).href;
          } else {
            url = new URL(url, window.location.origin).href;
          }
        } else {
          url = new URL(url).href;
        }
      } else {
        // Do not proxy special schemes
        return url;
      }

      // Avoid double proxying
      if (
        url.startsWith(alloy.prefix) ||
        url.startsWith(window.location.origin + alloy.prefix)
      ) {
        return url;
      }

      return alloy.prefix + "_" + btoa(url) + "_/";
    } catch (e) {
      console.error("Failed to encode URL:", e);
      return url;
    }
  },

  // Decode a proxied URL back to original
  url_decode: (proxiedUrl) => proxify.url(proxiedUrl, true),

  // Proxy all URLs in a srcset string
  srcset: (srcset) => {
    if (!srcset) return "";

    // srcset format: "url1 1x, url2 2x, url3 100w, ..."
    return srcset
      .split(",")
      .map((entry) => {
        const [url, descriptor] = entry.trim().split(/\s+/, 2);
        return proxify.url(url) + (descriptor ? " " + descriptor : "");
      })
      .join(", ");
  },
};
