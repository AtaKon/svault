async function prepareOcrImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(4, 1600 / bitmap.width, Math.sqrt(18_000_000 / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return file;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    // Receipt text is small and often low-contrast. Grayscale + a little extra
    // contrast gives Tesseract cleaner input without any server round-trip.
    const image = context.getImageData(0, 0, width, height);
    const data = image.data;
    const contrast = 1.25;
    const intercept = 128 * (1 - contrast);
    for (let index = 0; index < data.length; index += 4) {
      const gray = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      const value = Math.max(0, Math.min(255, gray * contrast + intercept));
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    return new File([blob], "ocr.png", { type: "image/png" });
  } catch {
    return file;
  }
}

export async function ocrImage(
  file: File,
  onProgress: (progress: number, status: string) => void,
): Promise<string> {
  const { createWorker, PSM } = await import("tesseract.js");
  // English and Greek: recipes and shop receipts are often Greek, while
  // product names and barcodes are frequently printed in Latin script.
  const worker = await createWorker("eng+ell", 1, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/core",
    langPath: "/tesseract",
    gzip: true,
    logger: (message) => {
      onProgress(message.progress ?? 0, message.status ?? "");
    },
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const result = await worker.recognize(await prepareOcrImage(file));
    return result.data.text;
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
