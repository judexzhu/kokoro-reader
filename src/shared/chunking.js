// Splits long runaway sentences at natural punctuation marks to ensure balanced chunks
// for streaming TTS without pipeline starvation.

export function splitLong(str, offset = 0, max = 180) {
  if (!str) return [];
  if (str.length <= max) return [[offset, offset + str.length]];

  const pieces = [];
  let from = 0;
  while (str.length - from > max) {
    const window = str.slice(from, from + max);
    let cut = Math.max(...[',', ';', ':', '—', ')', '»', '”'].map((c) => window.lastIndexOf(c)));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max - 1;
    pieces.push([offset + from, offset + from + cut + 1]);
    from += cut + 1;
  }
  pieces.push([offset + from, offset + str.length]);
  return pieces;
}
