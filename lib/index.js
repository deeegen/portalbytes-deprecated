const http = require("http"),
  https = require("https"),
  fs = require("fs"),
  zlib = require("zlib"),
  querystring = require("querystring"),
  WebSocket = require("ws"),
  btoa = (str) => Buffer.from(str).toString("base64"),
  atob = (str) => Buffer.from(str, "base64").toString("utf-8");

module.exports = class {
  constructor(prefix = "/web/", config = {}) {
    this.prefix = prefix;
    this.config = config;

    // Universal proxify URL function encoding entire URLs fully
    this.proxifyRequestURL = (url, decode) => {
      if (decode) {
        // Decode proxified URL string back to original
        try {
          const cleanPath = url.startsWith("/") ? url.substring(1) : url;

          // New full URL encoding format: _<base64fullurl>_/
          if (cleanPath.startsWith("_") && cleanPath.includes("_/")) {
            const parts = cleanPath.split("_");
            if (parts.length >= 3 && parts[1]) {
              const decodedUrl = atob(parts[1]);
              // console.log("Decoded URL:", decodedUrl);
              return decodedUrl;
            }
          }

          // Fallback to old format for compatibility (origin + path)
          const parts = cleanPath.split("_");
          if (parts.length >= 3) {
            const encodedOrigin = parts[1];
            const pathPart = parts.slice(2).join("_").replace(/^\//, "");

            const decodedOrigin = atob(encodedOrigin);
            const fullUrl = decodedOrigin + (pathPart ? "/" + pathPart : "");
            // console.log("Decoded URL (old format):", fullUrl);
            return fullUrl;
          }

          return url;
        } catch (e) {
          console.error("Failed to decode URL:", e, "Input:", url);
          return url;
        }
      } else {
        // Encode entire URL in base64 and wrap for proxification
        try {
          const encodedFullUrl = btoa(url);
          return `_${encodedFullUrl}_/`;
        } catch (e) {
          console.error("Failed to encode URL:", e);
          return url;
        }
      }
    };

    if (!prefix.startsWith("/")) this.prefix = "/" + prefix;
    if (!prefix.endsWith("/")) this.prefix = prefix + "/";
  }

  http(req, res, next = () => res.end("")) {
    if (!req.url.startsWith(this.prefix)) return next();

    req.path = req.url.replace(this.prefix.slice(1), "");
    req.pathname = req.path.split("#")[0].split("?")[0];

    if (req.pathname == "/client_hook" || req.pathname == "/client_hook/")
      return res.end(fs.readFileSync(__dirname + "/window.js", "utf-8"));

    let targetUrl;
    try {
      targetUrl = this.proxifyRequestURL(req.path, true);
      new URL(targetUrl); // Validate URL
      // console.log("Target URL:", targetUrl, "from path:", req.path);
    } catch (e) {
      console.error("URL Parse Error:", e, "Path:", req.path);
      return res.end(`URL Parse Error: Invalid URL format. Path: ${req.path}`);
    }

    var proxyURL = {
        href: targetUrl,
        origin: new URL(targetUrl).origin,
        hostname: new URL(targetUrl).hostname,
      },
      proxify = {},
      isBlocked = false,
      protocol = proxyURL.href.startsWith("https://") ? https : http,
      proxyOptions = {
        headers: Object.assign({}, req.headers),
        method: req.method,
        rejectUnauthorized: false,
      };

    // Validate protocol explicitly
    if (
      !proxyURL.href.startsWith("https://") &&
      !proxyURL.href.startsWith("http://")
    ) {
      return res.end("URL Parse Error: Invalid protocol");
    }

    delete proxyOptions.headers["host"];

    // Blacklist enforcement improved
    if (
      typeof this.config.blacklist == "object" &&
      this.config.blacklist.length
    ) {
      this.config.blacklist.forEach((blacklisted) => {
        if (
          proxyURL.hostname === blacklisted ||
          proxyURL.href === blacklisted ||
          proxyURL.href.includes(blacklisted)
        ) {
          isBlocked = true;
        }
      });
    }

    if (isBlocked) {
      return res.end(
        "The URL you are trying to access is not permitted for use."
      );
    }

    // === COOKIE SCOPING ENHANCEMENT START ===
    // Create a per-site cookie prefix using the hostname
    const cookiePrefix = proxyURL.hostname.replace(/\./g, "@") + "@";

    // Validate proxified path begins with correct new encoding prefix
    const expectedPrefix = `_${btoa(proxyURL.href)}_/`;
    const cleanPath = req.path.startsWith("/") ? req.path.substring(1) : req.path;

    if (!cleanPath.startsWith(expectedPrefix)) {
      // Try fallback old format prefix check
      const oldFormatPrefix = `_${btoa(proxyURL.origin)}_/`;
      if (!cleanPath.startsWith(oldFormatPrefix)) {
        const redirectPath = this.prefix + expectedPrefix;
        // console.log("Redirecting to correct path:", redirectPath);
        res.writeHead(308, { location: redirectPath });
        res.end("");
        return;
      }
    }

    // Normalize origin header with proxified URL decode
    if (proxyOptions.headers["origin"]) {
      try {
        const originPath =
          "/" + proxyOptions.headers["origin"].split("/").splice(3).join("/");
        const proxifiedOrigin = this.proxifyRequestURL(
          originPath.replace(this.prefix, ""),
          true
        );
        if (
          proxifiedOrigin.startsWith("https://") ||
          proxifiedOrigin.startsWith("http://")
        ) {
          proxyOptions.headers["origin"] = new URL(proxifiedOrigin).origin;
        } else {
          proxyOptions.headers["origin"] = proxyURL.origin;
        }
      } catch (e) {
        proxyOptions.headers["origin"] = proxyURL.origin;
      }
    }

    // Normalize referer header similarly
    if (proxyOptions.headers["referer"]) {
      try {
        const refererPath =
          "/" +
          proxyOptions.headers["referer"]
            .split("/")
            .splice(3)
            .join("/")
            .replace(this.prefix, "");
        const proxifiedReferer = this.proxifyRequestURL(refererPath, true);
        if (
          proxifiedReferer.startsWith("https://") ||
          proxifiedReferer.startsWith("http://")
        ) {
          proxyOptions.headers["referer"] = proxifiedReferer;
        } else {
          proxyOptions.headers["referer"] = proxyURL.href;
        }
      } catch (e) {
        proxyOptions.headers["referer"] = proxyURL.href;
      }
    }

    // Cookie header rewritten for proxied hostname with per-site isolation prefix
    if (proxyOptions.headers["cookie"]) {
      var new_cookie = [],
        cookie_array = proxyOptions.headers["cookie"].split("; ");

      cookie_array.forEach((cookie) => {
        // cookie format: "name@hostname=value" or "name=value"
        const [cookiePair, ...rest] = cookie.split(";"); // Just the cookie pair portion (should be just one)
        const eqIndex = cookie.indexOf("=");
        if (eqIndex === -1) return; // Skip invalid cookies

        let cookie_name = cookie.substring(0, eqIndex);
        let cookie_value = cookie.substring(eqIndex + 1);

        // If cookie_name includes @ for a proxy site, only include cookies for current hostname
        // We keep only cookies that either have no @ or the matching hostname prefix
        if (!cookie_name.includes("@")) {
          // Cookie without prefix: discard to avoid sending cookies cross domains
          // So skip it (don't push)
          return;
        } else {
          const [baseName, domainPrefix] = cookie_name.split("@");

          if (domainPrefix === proxyURL.hostname.replace(/\./g, "@")) {
            // Matching domain prefix: include with base name only (strip suffix)
            new_cookie.push(baseName + "=" + cookie_value);
          }
          // else skip cookie - it is not for current proxy target
        }
      });

      proxyOptions.headers["cookie"] = new_cookie.join("; ");
    }
    // === COOKIE SCOPING ENHANCEMENT END ===

    // Random local address option
    if (
      typeof this.config.localAddress == "object" &&
      this.config.localAddress.length != 0
    )
      proxyOptions.localAddress =
        this.config.localAddress[
          Math.floor(Math.random() * this.config.localAddress.length)
        ];

    var makeRequest = protocol.request(
      proxyURL.href,
      proxyOptions,
      (proxyResponse) => {
        var rawData = [],
          sendData = "";

        proxyResponse
          .on("data", (data) => rawData.push(data))
          .on("end", () => {
            const inject_config = {
              prefix: this.prefix,
              url: proxyURL.href,
            };

            proxify.url = (url) => {
              if (url.match(/^(#|about:|data:|blob:|mailto:|javascript:|{|\*)/))
                return url;

              if (url.startsWith("//")) url = new URL("http:" + url);
              else if (url.startsWith("/"))
                url = new URL(proxyURL.origin + url);
              else if (url.startsWith("https://") || url.startsWith("http://"))
                url = new URL(url);
              else
                url = new URL(
                  proxyURL.href.split("/").slice(0, -1).join("/") + "/" + url
                );

              if (url.protocol == "https:" || url.protocol == "http:")
                return this.prefix + this.proxifyRequestURL(url.href);
              else return url.href;
            };

            proxify.js = (buffer) =>
              buffer
                .toString()
                .replace(
                  /(,| |=|\()document.location(,| |=|\)|\.)/gi,
                  (str) => {
                    return str.replace(".location", `.alloyLocation`);
                  }
                )
                .replace(/(,| |=|\()window.location(,| |=|\)|\.)/gi, (str) => {
                  return str.replace(".location", `.alloyLocation`);
                })
                .replace(/(,| |=|\()location(,| |=|\)|\.)/gi, (str) => {
                  return str.replace("location", `alloyLocation`);
                });

            proxify.css = (buffer) => {
              return buffer
                .replace(/url\("(.*?)"\)/gi, (str) => {
                  var url = str.replace(/url\("(.*?)"\)/gi, "$1");
                  return `url("${proxify.url(url)}")`;
                })
                .replace(/url\('(.*?)'\)/gi, (str) => {
                  var url = str.replace(/url\('(.*?)'\)/gi, "$1");
                  return `url('${proxify.url(url)}')`;
                })
                .replace(/url\((.*?)\)/gi, (str) => {
                  var url = str.replace(/url\((.*?)\)/gi, "$1");

                  if (url.startsWith(`"`) || url.startsWith(`'`)) return str;

                  return `url("${proxify.url(url)}")`;
                })
                .replace(/@import (.*?)"(.*?)";/gi, (str) => {
                  var url = str.replace(/@import (.*?)"(.*?)";/, "$2");
                  return `@import "${proxify.url(url)}";`;
                })
                .replace(/@import (.*?)'(.*?)';/gi, (str) => {
                  var url = str.replace(/@import (.*?)'(.*?)';/, "$2");
                  return `@import '${proxify.url(url)}';`;
                });
            };

            proxify.html = (body) => {
              const html = new (require("./dom").JSDOM)(body, {
                  contentType: "text/html",
                }),
                document = html.window.document;

              let titleElements = document.querySelectorAll("title");
              titleElements.forEach((element) => element.remove());

              let title = document.createElement("title");
              title.textContent = "Loading...";
              document.querySelector("head").appendChild(title);

              document
                .querySelectorAll(
                  'link[rel*="icon"], link[rel*="shortcut icon"], link[rel*="apple-touch-icon"]'
                )
                .forEach((link) => link.remove());

              const metaTag = document.createElement("meta");
              metaTag.name = "msapplication-TileImage";
              metaTag.content = "false";
              document.querySelector("head").appendChild(metaTag);

              var base_tag = false;

              if (document.querySelector("head base"))
                base_tag = document
                  .querySelector("head base")
                  .getAttribute("href");

              if (base_tag) {
                if (base_tag.includes("#") || base_tag.includes("?"))
                  base_tag = base_tag.split("#")[0].split("?")[0];

                if (base_tag.startsWith("//")) base_tag = "http:" + base_tag;

                if (
                  base_tag.startsWith("https://") ||
                  base_tag.startsWith("http://")
                )
                  base_tag = new URL(base_tag).href;
                else if (base_tag.startsWith("/"))
                  base_tag = new URL(proxyURL.origin + base_tag).href;
                else
                  base_tag = new URL(
                    proxyURL.href.split("/").slice(0, -1).join("/") + "/" + base_tag
                  ).href;

                inject_config.baseURL = base_tag;
              }

              proxify.attribute = (attribute) => {
                if (
                  attribute.startsWith("https://") ||
                  attribute.startsWith("http://") ||
                  attribute.startsWith("//")
                )
                  return proxify.url(attribute);
                else if (base_tag) {
                  if (attribute.startsWith("/"))
                    return (attribute = proxify.url(
                      base_tag.split("/").splice(0, 3).join("/") + attribute
                    ));
                  else
                    return (attribute = proxify.url(
                      base_tag.split("/").slice(0, -1).join("/") + "/" + attribute
                    ));
                } else return proxify.url(attribute);
              };

              document.querySelectorAll("*").forEach((node) => {
                if (node.getAttribute("nonce")) node.removeAttribute("nonce");
                if (node.getAttribute("integrity"))
                  node.removeAttribute("integrity");
                if (node.getAttribute("style"))
                  node.setAttribute(
                    "style",
                    proxify.css(node.getAttribute("style"))
                  );
              });

              document
                .querySelectorAll(
                  "script, embed, iframe, audio, video, img, input, source, track"
                )
                .forEach((node) => {
                  if (node.src) node.src = proxify.attribute(node.src);
                  if (
                    node.tagName.toLowerCase() == "script" &&
                    node.innerHTML != ""
                  )
                    node.innerHTML = proxify.js(node.innerHTML);
                });

              document
                .querySelectorAll("img[srcset], source[srcset]")
                .forEach((node) => {
                  var arr = [];

                  node.srcset.split(",").forEach((url) => {
                    url = url.trimStart().split(" ");
                    url[0] = proxify.attribute(url[0]);
                    arr.push(url.join(" "));
                  });

                  node.srcset = arr.join(", ");
                });

              document.querySelectorAll("a, link, area").forEach((node) => {
                if (node.href) node.href = proxify.attribute(node.href);
              });

              document
                .querySelectorAll("base")
                .forEach((node) => (node.href = proxify.attribute(node.href)));

              document.querySelectorAll("form").forEach((node) => {
                if (node.action) node.action = proxify.attribute(node.action);
              });

              document.querySelectorAll("style").forEach((node) => {
                node.textContent = proxify.css(node.textContent);
              });

              const inject_script = document.createElement("script");

              inject_script.src = this.prefix + "client_hook";
              inject_script.setAttribute(
                "data-config",
                btoa(JSON.stringify(inject_config))
              );

              document
                .querySelector("head")
                .insertBefore(
                  inject_script,
                  document.querySelector("head").childNodes[0]
                );

              return html.serialize();
            };

            if (rawData.length != 0)
              switch (proxyResponse.headers["content-encoding"]) {
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
                  break;
              }

            Object.entries(proxyResponse.headers).forEach(
              ([header_name, header_value]) => {
                if (header_name == "set-cookie") {
                  const cookie_array = [];
                  header_value.forEach((cookie) => {
                    // Enhance set-cookie by prefixing cookie name with hostname (dot replaced by @) to scope cookies per site
                    // Extract cookie name and value before first ';' separator
                    const semiIndex = cookie.indexOf(";");
                    let cookiePairString =
                      semiIndex !== -1 ? cookie.substring(0, semiIndex) : cookie;
                    const eqIndex = cookiePairString.indexOf("=");
                    if (eqIndex === -1) {
                      // Malformed cookie? Just push as is
                      cookie_array.push(cookie);
                      return;
                    }
                    let cookie_name = cookiePairString.substring(0, eqIndex).trim();
                    let cookie_value = cookiePairString.substring(eqIndex + 1);

                    // Compose new cookie name with prefix
                    const prefixedName = cookie_name + "@" + proxyURL.hostname.replace(/\./g, "@");

                    // Replace cookie name with prefixed name in full cookie string
                    const newCookie =
                      cookie.replace(
                        new RegExp(`^${cookie_name}`),
                        prefixedName
                      ).replace(
                        /Domain=(.*?);/i,
                        `Domain=${req.headers["host"]};`
                      );

                    cookie_array.push(newCookie);
                  });
                  proxyResponse.headers[header_name] = cookie_array;
                }

                if (
                  header_name.startsWith("content-encoding") ||
                  header_name.startsWith("x-") ||
                  header_name.startsWith("cf-") ||
                  header_name.startsWith("strict-transport-security") ||
                  header_name.startsWith("content-security-policy") ||
                  header_name.startsWith("content-length")
                )
                  delete proxyResponse.headers[header_name];

                if (header_name == "location")
                  proxyResponse.headers[header_name] =
                    proxify.url(header_value);
              }
            );

            if (
              proxyResponse.headers["content-type"] &&
              proxyResponse.headers["content-type"].startsWith("text/html")
            )
              sendData = proxify.html(sendData.toString());
            else if (
              proxyResponse.headers["content-type"] &&
              (proxyResponse.headers["content-type"].startsWith(
                "application/javascript"
              ) ||
                proxyResponse.headers["content-type"].startsWith(
                  "text/javascript"
                ))
            )
              sendData = proxify.js(sendData.toString());
            else if (
              proxyResponse.headers["content-type"] &&
              proxyResponse.headers["content-type"].startsWith("text/css")
            )
              sendData = proxify.css(sendData.toString());

            res.writeHead(proxyResponse.statusCode, proxyResponse.headers);
            res.end(sendData);
          });
      }
    );

    makeRequest.on("error", (err) => res.end(err.toString()));

    if (!res.writableEnded)
      req
        .on("data", (data) => makeRequest.write(data))
        .on("end", () => makeRequest.end());
  }

  ws(server) {
    new WebSocket.Server({
      server: server,
    }).on("connection", (cli, req) => {
      var queryParams = querystring.parse(
          req.url.split("?").splice(1).join("?")
        ),
        proxyURL,
        options = {
          headers: {},
          followRedirects: true,
        },
        protocol = [];

      if (!queryParams.ws) return cli.close();

      proxyURL = atob(queryParams.ws);

      try {
        new URL(proxyURL);
      } catch {
        return cli.close();
      }

      Object.entries(req.headers).forEach(([header_name, header_value]) => {
        if (header_name == "sec-websocket-protocol")
          header_value.split(", ").forEach((proto) => protocol.push(proto));
        if (
          header_name.startsWith("cf-") ||
          header_name.startsWith("cdn-loop")
        );
        else if (!header_name.startsWith("sec-websocket"))
          options.headers[header_name] = header_value;
      });

      if (queryParams.origin)
        (options.origin = atob(queryParams.origin)),
          (options.headers.origin = atob(queryParams.origin));

      delete options.headers["host"];
      delete options.headers["cookie"];

      if (
        typeof this.config.localAddress == "object" &&
        this.config.localAddress.length != 0
      )
        options.localAddress =
          this.config.localAddress[
            Math.floor(Math.random() * this.config.localAddress.length)
          ];

      const proxy = new WebSocket(proxyURL, protocol, options),
        before_open = [];

      if (proxy.readyState == 0)
        cli.on("message", (data) => before_open.push(data));

      cli.on("close", () => proxy.close());
      proxy.on("close", () => cli.close());
      cli.on("error", () => proxy.terminate());
      proxy.on("error", () => cli.terminate());

      proxy.on("open", () => {
        if (before_open.length != 0)
          before_open.forEach((data) => proxy.send(data));

        cli.on("message", (data) => proxy.send(data));
        proxy.on("message", (data) => cli.send(data));
      });
    });
  }
};
