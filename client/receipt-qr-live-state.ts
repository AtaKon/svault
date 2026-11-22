/**
 * The pure state rules behind the live QR scanner (client/receipt-qr-live.ts):
 * how the torch button resolves the state a camera reply reports, and how
 * consecutive decode failures count toward retiring a decoder. They live
 * apart from the scanner module so the scanner can stay lazily loaded and
 * each rule can be tested on its own (see scripts/receipt-qr-live.test.mjs).
 */

export type TorchState = { requested: boolean; reported: boolean | undefined };

/** The torch target the Light button asks for next: whatever is not in effect. */
export function nextTorchTarget(state: TorchState): boolean {
  return !(state.reported ?? state.requested);
}

/** A failed or canceled request keeps the last state; a reply replaces it. */
export function resolveTorchState(previous: TorchState, outcome: TorchState | null): TorchState {
  return outcome ?? previous;
}

/**
 * Consecutive-failure counter for the frame decoders: any reply, including
 * "no code found", proves a decoder is alive and resets the count, while
 * each counted failure steps it toward the threshold that retires the
 * decoder for the rest of the session.
 */
export function nextDecodeFailureCount(previous: number, failed: boolean): number {
  return failed ? previous + 1 : 0;
}
