import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Provider-independent object storage (ADR-004 in docs/ARCHITECTURE_DECISIONS.md).
 *
 * Every persistent file (brand assets, creative visuals, renders) goes through this interface.
 * Nothing else in the app touches the filesystem for persistent data. Drivers are chosen with
 * STORAGE_DRIVER:
 *   local  files under STORAGE_DIR (development, tests, single-instance pilots). In
 *          staging/production it needs an explicit ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true, enforced
 *          at boot by src/server/config.ts.
 *   s3     S3-compatible object storage (Cloudflare R2 or AWS S3). Arrives in PR 4.2 with
 *          presigned URLs, tenant key layout and the render cache. Selecting it before then fails
 *          loudly instead of silently falling back to disk.
 *
 * Keys are relative, slash-separated paths built server-side from authorised database IDs. A
 * client never supplies a key.
 */
export interface StorageProvider {
  readonly driver: "local" | "s3";
  put(key: string, data: Buffer, mime: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Cheap round-trip used by the readiness check: write, read back, delete a probe object. */
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class StorageKeyError extends Error {}

/** Reject keys that could escape the storage root or that aren't plain relative paths. */
export function assertKey(key: string) {
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("\\") || key.includes("\0") || key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new StorageKeyError("Invalid storage key");
  }
}

export function localDisk(root = process.env.STORAGE_DIR ?? path.join(process.cwd(), ".data", "files")): StorageProvider {
  const base = path.resolve(root);
  const resolve = (key: string) => {
    assertKey(key);
    const p = path.resolve(base, key);
    if (!p.startsWith(base + path.sep)) throw new StorageKeyError("Invalid storage key");
    return p;
  };
  return {
    driver: "local",
    async put(key, data) {
      const p = resolve(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      // Write to a temp file, then rename: readers never see a half-written file.
      // Unique per write: concurrent puts of the same key (e.g. one photo copied for several
      // carousel slides at once) must not share a temp file.
      const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, p);
      return key;
    },
    async get(key) {
      return fs.readFile(resolve(key));
    },
    async remove(key) {
      await fs.rm(resolve(key), { force: true });
    },
    async exists(key) {
      try {
        await fs.access(resolve(key));
        return true;
      } catch {
        return false;
      }
    },
    async health() {
      const key = `_health/${process.pid}-${Date.now()}.probe`;
      try {
        const data = Buffer.from("ok");
        await this.put(key, data, "text/plain");
        const back = await this.get(key);
        await this.remove(key);
        return back.equals(data) ? { ok: true } : { ok: false, detail: "read-back mismatch" };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.name : "error" };
      }
    },
  };
}

function create(): StorageProvider {
  const driver = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();
  if (driver === "local") return localDisk();
  if (driver === "s3") throw new Error("STORAGE_DRIVER=s3 is not available yet: the S3/R2 adapter arrives in PR 4.2.");
  throw new Error(`Unknown STORAGE_DRIVER "${driver}".`);
}

let current: StorageProvider | null = null;
const impl = () => (current ??= create());

/** The configured storage. Resolved on first use, so tests can set STORAGE_DIR beforehand. */
export const storage: StorageProvider = {
  get driver() {
    return impl().driver;
  },
  put: (key, data, mime) => impl().put(key, data, mime),
  get: (key) => impl().get(key),
  remove: (key) => impl().remove(key),
  exists: (key) => impl().exists(key),
  health: () => impl().health(),
};

export function extFor(mime: string): string {
  return (
    { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "image/svg+xml": "svg" }[
      mime
    ] ?? "bin"
  );
}
