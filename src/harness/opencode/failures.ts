import { HarnessFailure, harnessFailure } from "../../domain/harness-failure.js";

/** Translate OpenCode and upstream diagnostics once, at the adapter boundary. */
export function openCodeFailure(error: unknown): HarnessFailure {
  if (error instanceof HarnessFailure) return error;
  const message = error instanceof Error ? error.message : String(error ?? "未知错误");
  if (/insufficient_user_quota|insufficient[_ -]?quota|quota[_ -]?exceeded|(?:用户|账户|账号)?额度不足|余额不足|billing.*(?:disabled|limit|quota)|invalid[_ -]?api[_ -]?key|authentication.*(?:failed|required)|unauthorized.*(?:api|key|account)/i.test(message)) {
    return new HarnessFailure(message, { kind: "authorization", retryable: false, scope: "provider" }, { cause: error });
  }
  if (/OpenCode 上游响应连续(?:异常结束|断尾)：finish=(?:unknown|length)/i.test(message)) {
    return new HarnessFailure(message, { kind: "incomplete", retryable: true }, { cause: error });
  }
  if (message.trimStart().startsWith("生成结果无效：")) {
    return new HarnessFailure(message, { kind: "artifact", retryable: true }, { cause: error });
  }
  if (/unknown certificate verification|certificate verify failed|\b429\b|rate.?limit|too many requests|\b50[234]\b|service unavailable|temporarily unavailable|stream_read_error|upstream_error|server_error|upstream.*(?:error|timeout)|overloaded/i.test(message)) {
    return new HarnessFailure(message, { kind: "infrastructure", retryable: true, scope: "provider" }, { cause: error });
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR|socket hang up|before secure TLS connection|operation was aborted due to timeout|OpenCode 状态连接连续失败/i.test(message)) {
    return new HarnessFailure(message, { kind: "infrastructure", retryable: true, scope: "engine" }, { cause: error });
  }
  return harnessFailure(error);
}
