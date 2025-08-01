// window.js
import { proxify } from "./client/proxify.js";
import { setupAlloyLocation } from "./client/alloyLocation.js";
import { alloy } from "./client/alloy.js";

var presetTitle = "PortalByte";
var presetFavicon =
  "https://thumb.ac-illust.com/fa/fa93223f93b035d221622686e2c245e0_t.jpeg";

setupAlloyLocation(alloy, proxify);

Object.defineProperty(document, "domain", {
  get() {
    return alloy.url.hostname;
  },
  set(value) {
    return value;
  },
});

document.addEventListener("DOMContentLoaded", function () {
  document.title = presetTitle;
  var faviconLink = document.querySelector('link[rel="icon"]');
  if (!faviconLink) {
    faviconLink = document.createElement("link");
    faviconLink.rel = "icon";
    document.head.appendChild(faviconLink);
  }
  faviconLink.href = presetFavicon;

  Object.defineProperty(document, "title", {
    set(value) {
      document.title = presetTitle;
    },
    get() {
      return document.title;
    },
    configurable: true,
    enumerable: true,
  });

  new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      if (mutation.type === "attributes") {
        if (mutation.target.rel === "icon") {
          mutation.target.href = presetFavicon;
        }
      }
    });
  }).observe(document.head, {
    childList: true,
    attributes: true,
    subtree: true,
  });
});

document.currentScript.remove();
