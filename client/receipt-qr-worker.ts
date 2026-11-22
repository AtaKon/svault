/// <reference lib="webworker" />

import { decodeReceiptQrFrame, rgbaToGray } from "./receipt-qr.js";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let grayBuffer: Uint8ClampedArray | undefined;
worker.onmessage = ({ data }: MessageEvent<ImageData>) => {
  let text: string | null = null;
  try {
    if (data.data.length === data.width * data.height * 4) {
      const frame = rgbaToGray(data.data, data.width, data.height, grayBuffer);
      grayBuffer = frame.gray;
      text = decodeReceiptQrFrame(frame);
    }
  } catch {
    // A bad frame should not end a live scan.
  }
  worker.postMessage(text);
};
