export class OffWriteError extends Error {
  retryable: boolean;
  remoteStatus: string | null;
  constructor(message: string, options: { retryable?: boolean; remoteStatus?: string | null } = {}) {
    super(message);
    this.name = "OffWriteError";
    this.retryable = options.retryable ?? false;
    this.remoteStatus = options.remoteStatus ?? null;
  }
}
