import { setTimeout as sleep } from "node:timers/promises";
import { SafeError } from "./errors.js";

export function aborted(signal: AbortSignal): SafeError {
  return new SafeError(
    signal.reason?.name === "TimeoutError" ? "timeout" : "aborted",
    signal.reason?.name === "TimeoutError"
      ? "Délai dépassé. Refaites /login si nécessaire."
      : "Opération annulée.",
  );
}
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted(signal);
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
export async function withDeadline<T>(
  seconds: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Timeout", "TimeoutError")),
    seconds * 1000,
  );
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    checkSignal(combined);
    // All blocking operations inside run honor this signal. Await their finally blocks,
    // notably callback listener cleanup, before reporting cancellation to Pi.
    return await run(combined);
  } finally {
    clearTimeout(timeout);
  }
}
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    throw aborted(signal);
  }
}
