import { describe, expect, it } from "vitest";
import { HarnessFailure, harnessFailure } from "../src/domain/harness-failure.js";
import { classifyInfrastructureFailure, isProviderAuthorizationBlock, isRecoverableIncompleteOutput } from "../src/execution/failure-policy.js";
import { openCodeFailure } from "../src/harness/opencode/failures.js";

describe("adapter-neutral execution failures", () => {
  it("uses metadata even when presentation text suggests a different policy", () => {
    const error = new HarnessFailure("invalid_api_key / fetch failed / finish=unknown", {
      kind: "infrastructure", scope: "provider", retryable: true,
    });
    expect(classifyInfrastructureFailure(error)).toBe("provider");
    expect(isProviderAuthorizationBlock(error)).toBe(false);
    expect(isRecoverableIncompleteOutput(error)).toBe(false);
    expect(classifyInfrastructureFailure(new Error(error.message))).toBeNull();
  });

  it("does not turn a nonretryable failure into an automatic infrastructure retry", () => {
    expect(classifyInfrastructureFailure(new HarnessFailure("opaque engine failure", {
      kind: "infrastructure", scope: "engine", retryable: false,
    }))).toBeNull();
    expect(isRecoverableIncompleteOutput(new HarnessFailure("opaque incomplete output", {
      kind: "incomplete", retryable: false,
    }))).toBe(false);
  });

  it("requires the infrastructure fault domain and retains an existing typed failure", () => {
    expect(() => new HarnessFailure("missing scope", { kind: "infrastructure", retryable: true })).toThrow(TypeError);
    const error = new HarnessFailure("deadline expired", { kind: "timeout", retryable: true });
    expect(harnessFailure(error)).toBe(error);
    expect(openCodeFailure(error)).toBe(error);
  });
});

describe("OpenCode adapter diagnostic translation", () => {
  it.each([
    ["fetch failed", "infrastructure", "engine"],
    ["OpenCode 状态连接连续失败 3 次", "infrastructure", "engine"],
    ["upstream_error: HTTP 503", "infrastructure", "provider"],
    ["unknown certificate verification", "infrastructure", "provider"],
    ["insufficient_user_quota", "authorization", "provider"],
    ["OpenCode 上游响应连续断尾：finish=unknown，已在原会话续作 1 次", "incomplete", undefined],
    ["OpenCode 上游响应连续异常结束：finish=length", "incomplete", undefined],
    ["生成结果无效：脚本语法错误", "artifact", undefined],
    ["some unclassified problem", "execution", undefined],
  ])("translates %s only at the adapter boundary", (message, kind, scope) => {
    const original = new Error(message);
    const translated = openCodeFailure(original);
    expect(translated).toMatchObject({ message, kind, scope, cause: original });
    expect(translated.retryable).toBe(kind !== "authorization");
  });
});
