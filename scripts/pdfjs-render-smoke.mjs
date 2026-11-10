import assert from "node:assert/strict";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
assert.ok(nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13), `PDF.js requires Node.js >=22.13.0; found ${process.versions.node}`);

let canvasApi;
try {
  canvasApi = await import("@napi-rs/canvas");
} catch (error) {
  const code = error && typeof error === "object" ? error.code : null;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_DLOPEN_FAILED") throw error;
  if (process.env.SV_PDFJS_SMOKE_REQUIRED === "1") throw error;
  console.log("Skipped PDF.js render smoke: optional @napi-rs/canvas is unavailable.");
  process.exit(0);
}
const { createCanvas, DOMMatrix, ImageData, Path2D } = canvasApi;

// This exercises only PDF.js v6's Node legacy entry point. The browser bundle
// and worker used by client/bill-scan.ts need a separate Vite browser check.
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
  (() => {
    const content = "0 0 0 rg 20 20 80 50 re f\n";
    return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  })(),
];
let source = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, index) => {
  offsets.push(Buffer.byteLength(source));
  source += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = Buffer.byteLength(source);
source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

const task = pdfjs.getDocument({ data: new Uint8Array(Buffer.from(source)), isEvalSupported: false });
try {
  const document = await task.promise;
  assert.equal(document.numPages, 1);
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, viewport }).promise;
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let darkPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 32 && pixels[index + 1] < 32 && pixels[index + 2] < 32 && pixels[index + 3] > 200) darkPixels++;
  }
  assert.ok(darkPixels > 100, "rendered output should contain the PDF's black rectangle");
  console.log("PDF.js v6 rendered a one-page PDF successfully.");
} finally {
  await task.destroy();
}
