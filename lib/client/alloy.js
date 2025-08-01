export const alloy = JSON.parse(
  atob(document.currentScript.getAttribute("data-config"))
);
alloy.url = new URL(alloy.url);
