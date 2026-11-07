import "server-only";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Storage abstraction. Local disk for development; swap for Supabase Storage / S3 by
 * implementing the same interface (see docs/ARCHITECTURE.md, Phase 8).
 */
export interface StorageProvider {
  put(key: string, data: Buffer, mime: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const ROOT = process.env.STORAGE_DIR ?? path.join(process.cwd(), ".data", "files");

function safe(key: string) {
  const p = path.resolve(ROOT, key);
  if (!p.startsWith(path.resolve(ROOT) + path.sep)) throw new Error("Invalid storage key");
  return p;
}

export const storage: StorageProvider = {
  async put(key, data) {
    const p = safe(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return key;
  },
  async get(key) {
    return fs.readFile(safe(key));
  },
  async remove(key) {
    await fs.rm(safe(key), { force: true });
  },
};

export function extFor(mime: string): string {
  return (
    { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "image/svg+xml": "svg" }[
      mime
    ] ?? "bin"
  );
}
