import { timingSafeEqual } from "node:crypto";

export function isLoopbackHost(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(hostname.toLowerCase());
}

export class RequestGuardError extends Error { }

export function isStateChangingMethod(method: string | undefined): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method ?? "");
}

export function sameRequestOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === host;
  } catch {
    return false;
  }
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function securityHeaders(mode: "dashboard" | "artifact"): Record<string, string> {
  const common = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  if (mode === "artifact") {
    return {
      ...common,
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": [
        "sandbox allow-scripts allow-pointer-lock",
        "default-src 'self' data: blob:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
        "style-src 'self' 'unsafe-inline' data: blob:",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'self' data: blob:",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    };
  }
  return {
    ...common,
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
}
