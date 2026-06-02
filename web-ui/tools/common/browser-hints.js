/** @returns {boolean} Brave 브라우저(동기 휴리스틱 — navigator.brave API) */
export function isBraveBrowser() {
  return typeof navigator !== "undefined" && navigator.brave != null;
}
