// Copies the OCR runtime and English language data into public/ so the app
// works offline and in Docker without reaching a CDN.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "public", "tesseract");
const core = path.join(out, "core");
fs.mkdirSync(core, { recursive: true });

function copy(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.copyFileSync(from, to);
  return true;
}

let copied = 0;
if (copy(path.join(root, "node_modules/tesseract.js/dist/worker.min.js"), path.join(out, "worker.min.js"))) copied++;

const coreDir = path.join(root, "node_modules/tesseract.js-core");
if (fs.existsSync(coreDir)) {
  for (const file of fs.readdirSync(coreDir)) {
    if (!/^tesseract-core.*\.(js|wasm)$/.test(file)) continue;
    if (copy(path.join(coreDir, file), path.join(core, file))) copied++;
  }
}

const langCandidates = [
  "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  "node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz",
];
for (const candidate of langCandidates) {
  if (copy(path.join(root, candidate), path.join(out, "eng.traineddata.gz"))) {
    copied++;
    break;
  }
}

if (copied === 0) {
  console.warn("[vendor-ocr] OCR assets not found — scanner OCR will fall back to CDN loading.");
} else {
  console.log(`[vendor-ocr] Prepared ${copied} OCR asset(s) in public/tesseract`);
}
