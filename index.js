// index.js

const http = require("http");
const https = require("https");
const fs = require("fs");
const { URL } = require("url");
const logger = require("./lib/logger");

const ProxyServer = require("./lib/ProxyServer");

// CONFIGURATION
const prefix = "/web/";
const localAddresses = [];
const blockedHostnames = ["https://bad-website.com"];
const ssl = false;
const port = 6969;
const index_file = "index.html";
// END OF CONFIGURATION

const proxy = new ProxyServer(prefix, {
  localAddress: localAddresses,
  blacklist: blockedHostnames,
});

const atob = (str) => Buffer.from(str, "base64").toString("utf-8");

const app = (req, res) => {
  logger.info(`Received request: ${req.method} ${req.url}`);

  if (req.url.startsWith(prefix)) {
    proxy.http(req, res);
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  req.pathname = parsedUrl.pathname;
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());

  if (
    req.query.url &&
    ["/prox", "/prox/", "/session", "/session/"].includes(req.pathname)
  ) {
    let url = atob(req.query.url);

    if (url.startsWith("//")) url = "http:" + url;
    else if (!url.startsWith("http://") && !url.startsWith("https://"))
      url = "http://" + url;

    res.writeHead(301, { location: prefix + proxy.proxifyRequestURL(url) });
    res.end();
    return;
  }

  const publicPath = __dirname + "/public" + req.pathname;

  const error = () => {
    res.statusCode = 404;
    res.end(
      fs
        .readFileSync(__dirname + "/lib/error.html", "utf-8")
        .replace("%ERR%", `Cannot ${req.method} ${req.pathname}`)
    );
  };

  fs.lstat(publicPath, (err, stats) => {
    if (err) return error();

    if (stats.isDirectory()) {
      const indexPath = publicPath + index_file;
      fs.stat(indexPath, (err, stats) => {
        if (err || !stats.isFile()) return error();
        fs.createReadStream(indexPath).pipe(res);
      });
    } else if (stats.isFile()) {
      fs.createReadStream(publicPath).pipe(res);
    } else {
      error();
    }
  });
};

const server = ssl
  ? https.createServer(
      {
        key: fs.readFileSync("ssl/default.key"),
        cert: fs.readFileSync("ssl/default.crt"),
      },
      app
    )
  : http.createServer(app);

proxy.ws(server);

server.listen(process.env.PORT || port, () =>
  console.log(
    `${ssl ? "https://" : "http://"}0.0.0.0:${process.env.PORT || port}`
  )
);
