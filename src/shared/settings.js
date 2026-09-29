export const DEFAULTS = {
  voice: 'af_heart',
  speed: 1,
  clickToRead: true,
  autoScroll: true,
  highlightColor: '#F2B544',
  maxChars: 500, // keep complete natural sentences intact; only split monster runaways
};

export function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}
