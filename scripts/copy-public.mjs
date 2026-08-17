import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/src/public", { recursive: true });
await cp("src/public", "dist/src/public", { recursive: true, force: true });
