/// <reference lib="webworker" />

import { decodeReceiptQrFrame, rgbaToGray } from "./receipt-qr.js";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let grayBuffer: Uint8ClampedArray | undefined;
worker.onmessage = ({ data }: MessageEvent<ImageData>) => {
  const frame = rgbaToGray(data.data, data.width, data.height, grayBuffer);
  grayBuffer = frame.gray;
  worker.postMessage(decodeReceiptQrFrame(frame));
};
