import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "../env";

// Private object storage. V1 = local filesystem under STORAGE_DIR. Never web-served directly.
export interface StorageProvider {
  // Store bytes under an opaque key. Returns the key.
  put(key: string, data: Buffer): Promise<string>;
  // Open a read stream for an authorized download endpoint.
  getStream(key: string): ReadStream;
  // Hard-remove the object (rare — schema keeps history; storage GC is separate concern).
  delete(key: string): Promise<void>;
}

class LocalPrivateStorage implements StorageProvider {
  constructor(private baseDir: string) {}

  // Resolve + guard against path traversal — key must stay inside baseDir.
  private pathFor(key: string): string {
    const full = resolve(this.baseDir, key);
    const base = resolve(this.baseDir);
    if (full !== base && !full.startsWith(base + "/")) {
      throw new Error("invalid storage key");
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<string> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    return key;
  }

  getStream(key: string): ReadStream {
    return createReadStream(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export const storage: StorageProvider = new LocalPrivateStorage(env.STORAGE_DIR);

// Build a per-registration object key. Keeps files namespaced + collision-free.
export function buildObjectKey(registrationId: string, fieldKey: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(registrationId, fieldKey, `${Date.now()}_${safe}`);
}

// Per-event poster key, namespaced under events/. Private storage; served via authorized endpoint.
export function buildEventPosterKey(eventId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join("events", eventId, "poster", `${Date.now()}_${safe}`);
}
