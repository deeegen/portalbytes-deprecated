const { btoa, atob, proxifyRequestURL } = require("./utils");
const handleHttp = require("./requestHandler");
const handleWs = require("./wsHandler");

module.exports = class ProxyServer {
  constructor(prefix = "/web/", config = {}) {
    this.prefix = prefix;
    this.config = config;

    // reuse our single shared util
    this.proxifyRequestURL = proxifyRequestURL;

    if (!this.prefix.startsWith("/")) this.prefix = "/" + this.prefix;
    if (!this.prefix.endsWith("/")) this.prefix = this.prefix + "/";
  }

  http(req, res, next) {
    // default next
    if (!next) next = () => res.end("");
    return handleHttp.call(this, req, res, next);
  }

  ws(server) {
    return handleWs.call(this, server);
  }
};
