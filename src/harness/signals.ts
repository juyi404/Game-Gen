

export function controlSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("生成已取消");
}

export function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, durationMs);
    const onAbort = () => finish(signal.reason ?? new Error("生成已取消"));
    function finish(error?: unknown): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
