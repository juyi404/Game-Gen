import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AggregatorAddressResolver } from "./contracts.js";

export function retryDelayMs(retryAfter: string | null): number {
  if (!retryAfter) return 1_000;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(250, seconds * 1_000));
  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return 1_000;
  return Math.min(10_000, Math.max(250, date - Date.now()));
}

export function readableFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown } | undefined;
  if (cause?.code === "UND_ERR_CONNECT_TIMEOUT") return "连接供应商超时";
  if (error.name === "TimeoutError") return "模型调用超时";
  return error.message === "fetch failed" ? "无法连接供应商" : error.message;
}

export async function defaultAggregatorAddressResolver(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

export async function assertSafeAggregatorEndpoint(
  value: string,
  resolveAddresses: AggregatorAddressResolver = defaultAggregatorAddressResolver,
): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("聚合供应商地址必须是无账号、查询参数和片段的 HTTPS 地址");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new Error("聚合供应商地址不能指向本机或内网");
  }

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolveAddresses(hostname);
    } catch (error) {
      throw new Error(`聚合供应商域名解析失败: ${readableFetchError(error)}`);
    }
  }
  if (addresses.length === 0) throw new Error("聚合供应商域名没有可用 IP 地址");
  const forbidden = addresses.find((address) => isForbiddenAggregatorAddress(address));
  if (forbidden) {
    throw new Error(`聚合供应商地址解析到非公网 IP，已拒绝连接: ${forbidden}`);
  }
}

export function isForbiddenAggregatorAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family !== 6) return true;
  const words = parseIpv6Words(address);
  if (!words) return true;

  // IPv4-mapped IPv6 and the well-known NAT64 prefix must inherit the
  // embedded IPv4 address classification.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isForbiddenIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  if (words[0] === 0x64 && words[1] === 0xff9b
    && words.slice(2, 6).every((word) => word === 0)) {
    return isForbiddenIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  // Only globally-routable IPv6 unicast is accepted. This rejects loopback,
  // ULA, link-local, multicast and other special-use address space.
  if ((words[0]! & 0xe000) !== 0x2000) return true;
  if (words[0] === 0x2001 && (words[1] === 0 || words[1] === 0x0db8)) return true;
  if (words[0] === 0x2002) {
    return isForbiddenIpv4(wordsToIpv4(words[1]!, words[2]!));
  }
  return false;
}

export function isForbiddenIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)
    || octet < 0 || octet > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

export function parseIpv6Words(value: string): number[] | null {
  let source = value.toLowerCase();
  if (source.includes(".")) {
    const colon = source.lastIndexOf(":");
    if (colon < 0) return null;
    const octets = source.slice(colon + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)
      || octet < 0 || octet > 255)) return null;
    source = `${source.slice(0, colon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}`
      + `:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const values = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (values.length !== 8 || values.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return values.map((word) => Number.parseInt(word, 16));
}

export function wordsToIpv4(high: number, low: number): string {
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export async function readBoundedResponseText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`聚合供应商响应超过 ${limit} 字节上限`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`聚合供应商响应超过 ${limit} 字节上限`);
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
