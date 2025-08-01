// alloyLocation.js
export function setupAlloyLocation(alloy, proxify) {
  window.alloyLocation = new Proxy(
    {},
    {
      set(obj, prop, value) {
        if (["assign", "reload", "replace", "toString"].includes(prop)) return;
        const newHref = alloy.url.href.replace(alloy.url[prop], value);
        return (location[prop] = proxify.url(newHref));
      },
      get(obj, prop) {
        if (
          alloy.url.origin === atob("aHR0cHM6Ly9kaXNjb3JkLmNvbQ==") &&
          alloy.url.pathname === "/app"
        )
          return window.location[prop];

        if (["assign", "reload", "replace", "toString"].includes(prop)) {
          return {
            assign: (arg) => window.location.assign(proxify.url(arg)),
            replace: (arg) => window.location.replace(proxify.url(arg)),
            reload: () => window.location.reload(),
            toString: () => alloy.url.href,
          }[prop];
        }

        return alloy.url[prop];
      },
    }
  );

  window.document.alloyLocation = window.alloyLocation;

  Object.defineProperty(document, "domain", {
    get() {
      return alloy.url.hostname;
    },
    set(value) {
      return value;
    },
  });
}
