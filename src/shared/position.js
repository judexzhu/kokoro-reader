// Reading positions are saved per page in chrome.storage.local.
// The URL hash is ignored so in-page anchors resume the same article.
export function posKey(url) {
  try {
    const u = new URL(url);
    return `pos:${u.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

export const MAX_SAVED_POSITIONS = 300;
