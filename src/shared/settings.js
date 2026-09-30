export const DEFAULTS = {
  voice: 'af_heart',
  speed: 1,
  clickToRead: true,
  autoScroll: true,
  highlightColor: '#F2B544',
  maxChars: 180, // balanced ~8-10s chunks; prevents monster chunks and buffer underrun
};

export function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}
