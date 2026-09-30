// Curated emotional voice blends that combine warm baselines with expressive inflections
export const VOICE_BLENDS = {
  blend_heart_bella: {
    name: 'Heart + Bella (Warm & Animated)',
    lang: 'en-us',
    gender: 'Female',
    grade: 'A+',
    components: [
      { id: 'af_heart', weight: 0.60 },
      { id: 'af_bella', weight: 0.40 },
    ],
  },
  blend_heart_nicole: {
    name: 'Heart + Nicole (Warm & Gentle)',
    lang: 'en-us',
    gender: 'Female',
    grade: 'A',
    components: [
      { id: 'af_heart', weight: 0.65 },
      { id: 'af_nicole', weight: 0.35 },
    ],
  },
  blend_fenrir_michael: {
    name: 'Fenrir + Michael (Expressive Narrator)',
    lang: 'en-us',
    gender: 'Male',
    grade: 'A-',
    components: [
      { id: 'am_fenrir', weight: 0.55 },
      { id: 'am_michael', weight: 0.45 },
    ],
  },
  blend_fable_george: {
    name: 'Fable + George (British Storyteller)',
    lang: 'en-gb',
    gender: 'Male',
    grade: 'A-',
    components: [
      { id: 'bm_fable', weight: 0.50 },
      { id: 'bm_george', weight: 0.50 },
    ],
  },
};

// Mirrors the voice table in kokoro-js 1.2.1 (English voices only; kokoro-js rejects others).
// Kept separate so the popup doesn't need to import the TTS library.
export const VOICES = {
  af_heart: { name: 'Heart', lang: 'en-us', gender: 'Female', grade: 'A' },
  af_bella: { name: 'Bella', lang: 'en-us', gender: 'Female', grade: 'A-' },
  af_nicole: { name: 'Nicole', lang: 'en-us', gender: 'Female', grade: 'B-' },
  af_aoede: { name: 'Aoede', lang: 'en-us', gender: 'Female', grade: 'C+' },
  af_kore: { name: 'Kore', lang: 'en-us', gender: 'Female', grade: 'C+' },
  af_sarah: { name: 'Sarah', lang: 'en-us', gender: 'Female', grade: 'C+' },
  af_alloy: { name: 'Alloy', lang: 'en-us', gender: 'Female', grade: 'C' },
  af_nova: { name: 'Nova', lang: 'en-us', gender: 'Female', grade: 'C' },
  af_sky: { name: 'Sky', lang: 'en-us', gender: 'Female', grade: 'C-' },
  af_jessica: { name: 'Jessica', lang: 'en-us', gender: 'Female', grade: 'D' },
  af_river: { name: 'River', lang: 'en-us', gender: 'Female', grade: 'D' },
  am_fenrir: { name: 'Fenrir', lang: 'en-us', gender: 'Male', grade: 'C+' },
  am_michael: { name: 'Michael', lang: 'en-us', gender: 'Male', grade: 'C+' },
  am_puck: { name: 'Puck', lang: 'en-us', gender: 'Male', grade: 'C+' },
  am_echo: { name: 'Echo', lang: 'en-us', gender: 'Male', grade: 'D' },
  am_eric: { name: 'Eric', lang: 'en-us', gender: 'Male', grade: 'D' },
  am_liam: { name: 'Liam', lang: 'en-us', gender: 'Male', grade: 'D' },
  am_onyx: { name: 'Onyx', lang: 'en-us', gender: 'Male', grade: 'D' },
  am_santa: { name: 'Santa', lang: 'en-us', gender: 'Male', grade: 'D-' },
  am_adam: { name: 'Adam', lang: 'en-us', gender: 'Male', grade: 'F+' },
  bf_emma: { name: 'Emma', lang: 'en-gb', gender: 'Female', grade: 'B-' },
  bf_isabella: { name: 'Isabella', lang: 'en-gb', gender: 'Female', grade: 'C' },
  bf_alice: { name: 'Alice', lang: 'en-gb', gender: 'Female', grade: 'D' },
  bf_lily: { name: 'Lily', lang: 'en-gb', gender: 'Female', grade: 'D' },
  bm_fable: { name: 'Fable', lang: 'en-gb', gender: 'Male', grade: 'C' },
  bm_george: { name: 'George', lang: 'en-gb', gender: 'Male', grade: 'C' },
  bm_lewis: { name: 'Lewis', lang: 'en-gb', gender: 'Male', grade: 'D+' },
  bm_daniel: { name: 'Daniel', lang: 'en-gb', gender: 'Male', grade: 'D' },
};
