// utils.js
// └── all of your tiny helpers (btoa/atob + request‐URL encoder/decoder)
const btoa = (str) => Buffer.from(str).toString("base64");
const atob = (str) => Buffer.from(str, "base64").toString("utf-8");

function proxifyRequestURL(url, decode) {
  if (decode) {
    try {
      const cleanPath = url.startsWith("/") ? url.substring(1) : url;
      if (cleanPath.startsWith("_") && cleanPath.includes("_/")) {
        const parts = cleanPath.split("_");
        if (parts.length >= 3 && parts[1]) {
          return atob(parts[1]);
        }
      }
      const parts = cleanPath.split("_");
      if (parts.length >= 3) {
        const encodedOrigin = parts[1];
        const pathPart = parts.slice(2).join("_").replace(/^\//, "");
        const decodedOrigin = atob(encodedOrigin);
        return decodedOrigin + (pathPart ? "/" + pathPart : "");
      }
      return url;
    } catch (e) {
      console.error("Failed to decode URL:", e, "Input:", url);
      return url;
    }
  } else {
    try {
      const encodedFullUrl = btoa(url);
      return `_${encodedFullUrl}_/`;
    } catch (e) {
      console.error("Failed to encode URL:", e);
      return url;
    }
  }
}

module.exports = { btoa, atob, proxifyRequestURL };
