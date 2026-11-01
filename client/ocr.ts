export async function ocrImage(
  file: File,
  onProgress: (progress: number, status: string) => void,
): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/core",
    langPath: "/tesseract",
    gzip: true,
    logger: (message) => {
      onProgress(message.progress ?? 0, message.status ?? "");
    },
  });
  try {
    const result = await worker.recognize(file);
    return result.data.text;
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
