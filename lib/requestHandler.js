// └── all of the HTTP proxy logic, extracted from the `.http(...)` method

const http = require("http");
const https = require("https");
const fs = require("fs");
const zlib = require("zlib");
const { btoa, atob, proxifyRequestURL } = require("./utils");
const { JSDOM } = require("./dom");

module.exports = function handleHttp(req, res, next) {
  const prefix = this.prefix;
  const config = this.config;

  if (!req.url.startsWith(prefix)) return next();

  // strip off our proxy prefix
  req.path = req.url.replace(prefix.slice(1), "");
  req.pathname = req.path.split("#")[0].split("?")[0];

  // serve our client hook
  if (req.pathname === "/client_hook" || req.pathname === "/client_hook/") {
    return res.end(fs.readFileSync(__dirname + "/window.js", "utf-8"));
  }

  // decode the real target URL
  let targetUrl;
  try {
    targetUrl = proxifyRequestURL(req.path, true);
    new URL(targetUrl);
  } catch (e) {
    console.error("URL Parse Error:", e, "Path:", req.path);
    return res.end(`URL Parse Error: Invalid URL format. Path: ${req.path}`);
  }

  const proxyURL = {
    href: targetUrl,
    origin: new URL(targetUrl).origin,
    hostname: new URL(targetUrl).hostname,
  };
  const protocol = proxyURL.href.startsWith("https://") ? https : http;

  // build request options
  const proxyOptions = {
    headers: { ...req.headers },
    method: req.method,
    rejectUnauthorized: false,
  };
  delete proxyOptions.headers.host;

  // blacklist check
  let isBlocked = false;
  if (Array.isArray(config.blacklist) && config.blacklist.length) {
    config.blacklist.forEach((blk) => {
      if (
        proxyURL.hostname === blk ||
        proxyURL.href === blk ||
        proxyURL.href.includes(blk)
      )
        isBlocked = true;
    });
  }
  if (isBlocked) {
    return res.end(
      "The URL you are trying to access is not permitted for use."
    );
  }

  // enforce the proper encoded‐URL prefix
  const expectedPrefix = `_${btoa(proxyURL.href)}_/`;
  const cleanPath = req.path.startsWith("/") ? req.path.slice(1) : req.path;
  if (!cleanPath.startsWith(expectedPrefix)) {
    const redirectPath = prefix + expectedPrefix;
    res.writeHead(308, { location: redirectPath });
    return res.end();
  }

  // adjust Origin header if present
  if (proxyOptions.headers.origin) {
    try {
      const originPath =
        "/" + proxyOptions.headers.origin.split("/").splice(3).join("/");
      const decodedOrigin = proxifyRequestURL(
        originPath.replace(prefix, ""),
        true
      );
      if (
        decodedOrigin.startsWith("https://") ||
        decodedOrigin.startsWith("http://")
      ) {
        proxyOptions.headers.origin = new URL(decodedOrigin).origin;
      } else {
        proxyOptions.headers.origin = proxyURL.origin;
      }
    } catch {
      proxyOptions.headers.origin = proxyURL.origin;
    }
  }

  // adjust Referer header if present
  if (proxyOptions.headers.referer) {
    try {
      const refPath =
        "/" +
        proxyOptions.headers.referer
          .split("/")
          .splice(3)
          .join("/")
          .replace(prefix, "");
      const decodedRef = proxifyRequestURL(refPath, true);
      if (
        decodedRef.startsWith("https://") ||
        decodedRef.startsWith("http://")
      ) {
        proxyOptions.headers.referer = decodedRef;
      } else {
        proxyOptions.headers.referer = proxyURL.href;
      }
    } catch {
      proxyOptions.headers.referer = proxyURL.href;
    }
  }

  // scope cookies to this hostname
  if (proxyOptions.headers.cookie) {
    const newCookies = [];
    proxyOptions.headers.cookie.split("; ").forEach((cookie) => {
      const idx = cookie.indexOf("=");
      if (idx === -1) return;
      const name = cookie.slice(0, idx);
      const value = cookie.slice(idx + 1);
      if (!name.includes("@")) return;
      const [base, domainPrefix] = name.split("@");
      if (domainPrefix === proxyURL.hostname.replace(/\./g, "@")) {
        newCookies.push(`${base}=${value}`);
      }
    });
    proxyOptions.headers.cookie = newCookies.join("; ");
  }

  // optional localAddress rotation
  if (Array.isArray(config.localAddress) && config.localAddress.length) {
    proxyOptions.localAddress =
      config.localAddress[
        Math.floor(Math.random() * config.localAddress.length)
      ];
  }

  // perform the proxied request
  const makeRequest = protocol.request(
    proxyURL.href,
    proxyOptions,
    (proxyRes) => {
      const rawData = [];
      proxyRes.on("data", (chunk) => rawData.push(chunk));
      proxyRes.on("end", () => {
        // decompress if needed
        let sendData;
        switch (proxyRes.headers["content-encoding"]) {
          case "gzip":
            sendData = zlib.gunzipSync(Buffer.concat(rawData));
            break;
          case "deflate":
            sendData = zlib.inflateSync(Buffer.concat(rawData));
            break;
          case "br":
            sendData = zlib.brotliDecompressSync(Buffer.concat(rawData));
            break;
          default:
            sendData = Buffer.concat(rawData);
        }

        // CSP / header rewrites
        const proxyOriginForCSP = req.headers.host
          ? `http://${req.headers.host}`
          : prefix;

        Object.entries(proxyRes.headers).forEach(([hdr, val]) => {
          const name = hdr.toLowerCase();

          // Set-Cookie: add per-site prefix & rewrite Domain
          if (name === "set-cookie") {
            const cookies = [];
            val.forEach((c) => {
              const semi = c.indexOf(";");
              const pair = semi !== -1 ? c.slice(0, semi) : c;
              const eq = pair.indexOf("=");
              if (eq === -1) {
                cookies.push(c);
              } else {
                const key = pair.slice(0, eq).trim();
                const value = pair.slice(eq + 1);
                const pref = `${key}@${proxyURL.hostname.replace(/\./g, "@")}`;
                const updated = c
                  .replace(new RegExp(`^${key}`), pref)
                  .replace(/Domain=[^;]+;/i, `Domain=${req.headers.host};`);
                cookies.push(updated);
              }
            });
            proxyRes.headers[hdr] = cookies;
          }

          // remove unwanted headers
          if (
            name.startsWith("content-encoding") ||
            name.startsWith("x-") ||
            name.startsWith("cf-") ||
            name.startsWith("strict-transport-security") ||
            name.startsWith("content-security-policy-report-only")
          ) {
            delete proxyRes.headers[hdr];
          }

          // rewrite CSP header
          if (name === "content-security-policy") {
            let csp = val;
            [
              "frame-src",
              "script-src",
              "style-src",
              "img-src",
              "connect-src",
            ].forEach((dir) => {
              const regex = new RegExp(`(${dir}\\s+[^;]+)`, "gi");
              csp = csp.replace(regex, (m) => {
                if (m.includes(proxyOriginForCSP)) return m;
                if (/\'self\'/.test(m)) {
                  return m.replace(/\'self\'/, `'self' ${proxyOriginForCSP}`);
                }
                return `${m} ${proxyOriginForCSP}`;
              });
              if (!new RegExp(`${dir}\\s`, "i").test(csp)) {
                csp += `; ${dir} ${proxyOriginForCSP}`;
              }
            });
            proxyRes.headers[hdr] = csp;
          }

          // rewrite Location
          if (name === "location") {
            proxyRes.headers[hdr] = proxifyRequestURL(val, false);
          }
        });

        // transform body by content-type
        const ct = proxyRes.headers["content-type"] || "";
        if (ct.startsWith("text/html")) {
          sendData = proxifyHtml(sendData.toString());
        } else if (
          ct.startsWith("application/javascript") ||
          ct.startsWith("text/javascript")
        ) {
          sendData = proxifyJs(sendData.toString());
        } else if (ct.startsWith("text/css")) {
          sendData = proxifyCss(sendData.toString());
        }

        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(sendData);
      });
    }
  );

  makeRequest.on("error", (err) => res.end(err.toString()));
  req.pipe(makeRequest);

  // ——— helpers for in‐flight content rewriting ———

  function proxifyUrl(url) {
    if (/^(#|about:|data:|blob:|mailto:|javascript:|{|\*)/.test(url))
      return url;

    let absolute;
    if (url.startsWith("//")) absolute = new URL("http:" + url);
    else if (url.startsWith("/")) absolute = new URL(proxyURL.origin + url);
    else if (/^https?:\/\//.test(url)) absolute = new URL(url);
    else
      absolute = new URL(
        proxyURL.href.split("/").slice(0, -1).join("/") + "/" + url
      );

    return prefix + proxifyRequestURL(absolute.href, false);
  }

  function proxifyJs(buf) {
    return buf
      .replace(/(\s|,|\()document.location/gi, (m) =>
        m.replace(".location", ".alloyLocation")
      )
      .replace(/(\s|,|\()window.location/gi, (m) =>
        m.replace(".location", ".alloyLocation")
      )
      .replace(/(\s|,|\()location(?![A-Za-z0-9_])/gi, (m) =>
        m.replace("location", "alloyLocation")
      );
  }

  function proxifyCss(buf) {
    return buf
      .replace(/url\("(.*?)"\)/gi, (_, u) => `url("${proxifyUrl(u)}")`)
      .replace(/url\('(.*?)'\)/gi, (_, u) => `url('${proxifyUrl(u)}')`)
      .replace(/url\((.*?)\)/gi, (_, u) => {
        if (/^["']/.test(u)) return `url(${u})`;
        return `url("${proxifyUrl(u)}")`;
      })
      .replace(
        /@import\s+url\("(.*?)"\);/gi,
        (_, u) => `@import url("${proxifyUrl(u)}");`
      )
      .replace(/@import\s+'(.*?)';/gi, (_, u) => `@import '${proxifyUrl(u)}';`);
  }

  function proxifyHtml(body) {
    const dom = new JSDOM(body, { contentType: "text/html" });
    const doc = dom.window.document;

    // clean and reset title
    doc.querySelectorAll("title").forEach((t) => t.remove());
    const titleEl = doc.createElement("title");
    titleEl.textContent = "Loading…";
    doc.querySelector("head").appendChild(titleEl);

    // remove icon links
    doc
      .querySelectorAll(
        'link[rel*="icon"],link[rel*="shortcut icon"],link[rel*="apple-touch-icon"]'
      )
      .forEach((ln) => ln.remove());

    // disable MS tile image
    const meta = doc.createElement("meta");
    meta.name = "msapplication-TileImage";
    meta.content = "false";
    doc.querySelector("head").appendChild(meta);

    // handle base tag
    let baseHref = doc.querySelector("head base")?.href || "";
    if (baseHref) {
      if (/[#?]/.test(baseHref)) baseHref = baseHref.split(/[#?]/)[0];
      if (baseHref.startsWith("//")) baseHref = "http:" + baseHref;
      if (!/^https?:\/\//.test(baseHref)) {
        baseHref = new URL(
          baseHref.startsWith("/")
            ? proxyURL.origin + baseHref
            : proxyURL.href.split("/").slice(0, -1).join("/") + "/" + baseHref
        ).href;
      }
    }

    // strip integrity & nonce, rewrite inline styles
    doc.querySelectorAll("*").forEach((n) => {
      if (n.hasAttribute("nonce")) n.removeAttribute("nonce");
      if (n.hasAttribute("integrity")) n.removeAttribute("integrity");
      if (n.hasAttribute("style")) {
        n.setAttribute("style", proxifyCss(n.getAttribute("style")));
      }
    });

    // rewrite src/srcset, script bodies
    doc
      .querySelectorAll(
        "script,embed,iframe,audio,video,img,input,source,track"
      )
      .forEach((n) => {
        if (n.src) n.src = proxifyUrl(n.src);
        if (n.tagName.toLowerCase() === "script" && n.textContent.trim()) {
          n.textContent = proxifyJs(n.textContent);
        }
      });

    doc.querySelectorAll("img[srcset],source[srcset]").forEach((n) => {
      n.srcset = n.srcset
        .split(",")
        .map((item) => {
          const [u, desc] = item.trim().split(/\s+/);
          return `${proxifyUrl(u)}${desc ? " " + desc : ""}`;
        })
        .join(", ");
    });

    // rewrite links, forms
    doc.querySelectorAll("a,link,area,form").forEach((n) => {
      const attr = n.tagName.toLowerCase() === "form" ? "action" : "href";
      if (n[attr]) n[attr] = proxifyUrl(n[attr]);
    });

    // rewrite <style> blocks
    doc.querySelectorAll("style").forEach((n) => {
      n.textContent = proxifyCss(n.textContent);
    });

    // inject our client hook
    const hook = doc.createElement("script");
    hook.src = prefix + "client_hook";
    hook.setAttribute(
      "data-config",
      btoa(
        JSON.stringify({
          prefix,
          url: proxyURL.href,
          baseURL: baseHref || undefined,
        })
      )
    );
    doc.querySelector("head").prepend(hook);

    return dom.serialize();
  }
};
