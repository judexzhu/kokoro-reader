// Shared by the engine (offscreen.js), scripts/fetch-model.mjs and scripts/build.mjs.
// Keep this file free of browser/Node-only APIs.

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// q8 (~92 MB) is the sweet spot on CPU/WASM.
// For WebGPU, switch to DTYPE = 'fp32' and DEVICE = 'webgpu' (325 MB model).
export const DTYPE = 'q8';
export const DEVICE = 'wasm';

const ONNX_FILE = {
  fp32: 'model.onnx',
  fp16: 'model_fp16.onnx',
  q8: 'model_quantized.onnx',
  q8f16: 'model_q8f16.onnx',
  q4: 'model_q4.onnx',
  q4f16: 'model_q4f16.onnx',
};

export const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  `onnx/${ONNX_FILE[DTYPE]}`,
];
