import { HarnessFailure } from "../domain/harness-failure.js";

export function createDeadline(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason ?? new Error("运行已取消"));
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      controller.abort(new HarnessFailure(`轮次执行超过硬超时 ${timeoutMs}ms`, { kind: "timeout", retryable: true }));
    }, timeoutMs)
    : null;
  timer?.unref();
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}
