// Shared prosody enrichment module for Kokoro TTS.
// Enriches raw web text with prosodic cues (natural breath pauses, clause cadence,
// em-dash parentheticals) so Kokoro's phonetic & pitch model delivers human emotion.

const INTRO_ADVERBS = [
  'however', 'furthermore', 'moreover', 'meanwhile', 'nevertheless',
  'nonetheless', 'therefore', 'consequently', 'subsequently', 'alternatively',
  'in fact', 'for example', 'for instance', 'of course', 'as a result',
  'on the other hand', 'in addition', 'first of all', 'interestingly',
  'surprisingly', 'naturally', 'obviously', 'admittedly', 'ultimately',
  'incidentally', 'similarly', 'conversely', 'importantly', 'essentially',
];

const INTRO_REGEX = new RegExp(
  `^([\\s"“'‘]*)(` +
  INTRO_ADVERBS
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/\s+/g, '\\s+'))
    .join('|') +
  `)(?![,;:.!?"”'’])(\\s+)([a-zA-Z0-9])`,
  'i'
);

export function enhanceProsody(text) {
  if (!text || typeof text !== 'string') return text || '';

  let s = text.trim();

  // 1. Normalize spaces
  s = s.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');

  // 2. Expand common shorthand symbols that sound robotic when read verbatim
  s = s.replace(/\bw\/(?=\s+\w)/gi, 'with ');
  s = s.replace(/\bw\/o(?=\s+\w)/gi, 'without ');
  s = s.replace(/\bvs\.(?=\s+\w)/gi, 'versus ');
  s = s.replace(/\bapprox\.(?=\s+\d)/gi, 'approximately ');
  s = s.replace(/\be\.g\.,?\s*/gi, 'for example, ');
  s = s.replace(/\bi\.e\.,?\s*/gi, 'that is, ');

  // 3. Normalize dashes to em-dashes for natural parenthetical intonation in StyleTTS2
  s = s.replace(/\s*--\s*/g, ' — ');
  s = s.replace(/\s+–\s+/g, ' — ');
  s = s.replace(/\s+-\s+(?=[a-zA-Z])/g, ' — ');

  // 4. Normalize ellipses for trailing, thoughtful pauses
  s = s.replace(/…/g, '...');
  s = s.replace(/\.{4,}/g, '...');
  s = s.replace(/\.\.\.(?=[a-zA-Z])/g, '... ');

  // 5. Add breath comma after introductory transition phrases if missing
  s = s.replace(INTRO_REGEX, (match, prefix, word, space, nextChar) => {
    return `${prefix}${word},${space}${nextChar}`;
  });

  // 6. Ensure breathing space after colon/semicolon
  s = s.replace(/([;:])(?=[a-zA-Z0-9])/g, '$1 ');

  // 7. Clean repeated punctuation
  s = s.replace(/!{2,}/g, '!');
  s = s.replace(/\?{2,}/g, '?');

  return s.replace(/\s+/g, ' ').trim();
}
