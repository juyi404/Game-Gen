import type { PackyCatalog } from "./contracts.js";
import { PACKY_CATALOG_CACHE_MS, PACKY_CATALOG_URL, PACKY_MODEL_LIST_URL } from "./contracts.js";
import { parsePackyCatalog, parsePackyModelList } from "./packy.js";

export class PackyCatalogService {
  private packyCatalogCache: PackyCatalog | null = null;
  private packyCatalogLoading: Promise<PackyCatalog> | null = null;
  async listPackyCatalog(force = false): Promise<PackyCatalog> {
    if (!force && this.packyCatalogCache
      && Date.now() - this.packyCatalogCache.fetchedAt < PACKY_CATALOG_CACHE_MS) {
      return this.packyCatalogCache;
    }
    if (!this.packyCatalogLoading) {
      this.packyCatalogLoading = this.fetchPackyCatalog().finally(() => {
        this.packyCatalogLoading = null;
      });
    }
    try {
      return await this.packyCatalogLoading;
    } catch (error) {
      if (this.packyCatalogCache) return this.packyCatalogCache;
      throw error;
    }
  }

  async listPackyAuthorizedModels(apiKey: string): Promise<string[]> {
    const response = await fetch(PACKY_MODEL_LIST_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        throw new Error("PackyAPI Key 无效，或该 Key 没有模型目录权限");
      }
      throw new Error(`PackyAPI Key 检查失败: HTTP ${response.status}`);
    }
    return parsePackyModelList(await response.json());
  }

  private async fetchPackyCatalog(): Promise<PackyCatalog> {
    const response = await fetch(PACKY_CATALOG_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`PackyAPI 模型目录读取失败: HTTP ${response.status}`);
    }
    const catalog = parsePackyCatalog(await response.json());
    this.packyCatalogCache = catalog;
    return catalog;
  }
}
