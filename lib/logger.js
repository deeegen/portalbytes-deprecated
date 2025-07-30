const fs = require("fs");
const path = require("path");

const logFile = path.join(__dirname, "server.log");

// Regex patterns for filtering out noisy info logs
const infoLogBlacklistPatterns = [
  /^Received request: GET \/$/, // root requests
  /^Received request: GET \/assets\/.*$/, // anything under /assets/
  /_[_A-Za-z0-9+=]+_\/$/, // proxified URL pattern (like /_xxxxx_/)
  /\.(css|js|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)(\?.*)?$/i, // static assets extensions
];

// Decode base64 proxified URLs matching "_base64_/" pattern
function decodeProxifiedUrl(url) {
  try {
    if (typeof url !== "string") return url;
    // Remove leading slash if present
    if (url.startsWith("/")) url = url.substring(1);

    // Match pattern _<base64>_/
    const match = url.match(/^_(.+)_\/$/);
    if (match && match[1]) {
      return Buffer.from(match[1], "base64").toString("utf-8");
    }
  } catch {}
  return url;
}

// Check if the info message matches any blacklist pattern
function isInfoBlacklisted(message) {
  return infoLogBlacklistPatterns.some((pattern) => pattern.test(message));
}

// Core async log write function to file
function logToFile(level, message) {
  const time = new Date().toISOString();
  const logMessage = `[${time}] [${level}] ${message}\n`;
  fs.appendFile(logFile, logMessage, (err) => {
    if (err) {
      // If file write fails, output error to console
      console.error(`[logger] Failed to write to log file: ${err}`);
    }
  });
}

module.exports = {
  info: (msg) => {
    if (isInfoBlacklisted(msg)) return; // Skip noisy info logs

    console.log(`[INFO] ${msg}`);
    logToFile("INFO", msg);
  },

  warn: (msg) => {
    console.warn(`[WARN] ${msg}`);
    logToFile("WARN", msg);
  },

  error: (msg) => {
    console.error(`[ERROR] ${msg}`);
    logToFile("ERROR", msg);
  },

  // Info log variant that decodes proxified URLs when present
  infoWithUrl: (msg, url) => {
    const decodedUrl = decodeProxifiedUrl(url);
    const finalMsg = `${msg} - URL: ${decodedUrl}`;
    if (isInfoBlacklisted(finalMsg)) return;

    console.log(`[INFO] ${finalMsg}`);
    logToFile("INFO", finalMsg);
  },

  // Generic logger with context support for structured logs
  log: ({ level = "INFO", message = "", context = "" } = {}) => {
    const finalMsg = context ? `[${context}] ${message}` : message;

    // You can customize filtering per context or level here if needed
    if (level.toUpperCase() === "INFO" && isInfoBlacklisted(finalMsg)) return;

    const consoleFunc =
      {
        INFO: console.log,
        WARN: console.warn,
        ERROR: console.error,
      }[level.toUpperCase()] || console.log;

    consoleFunc(`[${level.toUpperCase()}] ${finalMsg}`);
    logToFile(level.toUpperCase(), finalMsg);
  },

  // Expose decode function if needed externally
  decodeProxifiedUrl,
};
