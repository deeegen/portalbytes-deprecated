const WebSocket = require("ws");
const querystring = require("querystring");

module.exports = function handleWs(server) {
  const { config, atob } = this;

  new WebSocket.Server({ server }).on("connection", (cli, req) => {
    const queryParams = querystring.parse(
      req.url.split("?").slice(1).join("?")
    );
    if (!queryParams.ws) return cli.close();

    const proxyURL = atob(queryParams.ws);
    try {
      new URL(proxyURL);
    } catch {
      return cli.close();
    }

    // forward headers, subprotocols…
    const protocols = req.headers["sec-websocket-protocol"]
      ? req.headers["sec-websocket-protocol"].split(",").map((p) => p.trim())
      : [];

    const options = { headers: {}, followRedirects: true };
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "sec-websocket-protocol") continue;
      if (
        !k.startsWith("cf-") &&
        !k.startsWith("cdn-loop") &&
        !k.startsWith("sec-websocket")
      ) {
        options.headers[k] = v;
      }
    }

    if (queryParams.origin) {
      options.origin = atob(queryParams.origin);
      options.headers.origin = atob(queryParams.origin);
    }
    delete options.headers.host;
    delete options.headers.cookie;

    if (Array.isArray(config.localAddress) && config.localAddress.length) {
      options.localAddress =
        config.localAddress[
          Math.floor(Math.random() * config.localAddress.length)
        ];
    }

    const proxy = new WebSocket(
      proxyURL,
      protocols.length ? protocols : undefined,
      options
    );

    // buffering until open…
    const buffer = [];
    if (proxy.readyState === 0) {
      cli.on("message", (d) => buffer.push(d));
    }

    cli.on("close", () => proxy.close());
    proxy.on("close", () => cli.close());
    cli.on("error", () => proxy.terminate());
    proxy.on("error", () => cli.terminate());

    proxy.on("open", () => {
      buffer.forEach((d) => proxy.send(d));
      cli.on("message", (d) => proxy.send(d));
      proxy.on("message", (d) => cli.send(d));
    });
  });
};
