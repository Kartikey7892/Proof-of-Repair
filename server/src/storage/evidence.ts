/**
 * Content-addressed evidence store (IPFS-compatible abstraction).
 * Blobs live on disk under sha256 content ids; metadata lives in PostgreSQL.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalDumps, POR_FLOAT_KEYS } from "../crypto/canonical.js";
import { sha256Hex } from "../crypto/merkle.js";
import type { Db } from "../db/index.js";

const CID_RE = /^[0-9a-f]{64}$/;

export class EvidenceStore {
  constructor(
    readonly root: string,
    private db: Db,
  ) {}

  private pathFor(cid: string): string {
    if (!CID_RE.test(cid)) throw new Error("invalid cid");
    return path.join(this.root, cid);
  }

  async putBytes(data: Buffer, meta: Record<string, unknown> = {}): Promise<string> {
    const cid = sha256Hex(data);
    const file = this.pathFor(cid);
    if (!existsSync(file)) {
      await mkdir(this.root, { recursive: true });
      await writeFile(file, data);
    }
    await this.db.query(
      `INSERT INTO evidence (cid, size_bytes, meta) VALUES ($1, $2, $3)
       ON CONFLICT (cid) DO UPDATE SET meta = EXCLUDED.meta`,
      [cid, data.length, JSON.stringify(meta)],
    );
    return cid;
  }

  /** Serialized like Python's json.dumps(obj, sort_keys=True, indent=2). */
  putJson(obj: unknown, meta: Record<string, unknown> = {}): Promise<string> {
    const raw = canonicalDumps(obj, { indent: 2, floatKeys: POR_FLOAT_KEYS });
    return this.putBytes(Buffer.from(raw, "utf8"), meta);
  }

  async getBytes(cid: string): Promise<Buffer> {
    return readFile(this.pathFor(cid));
  }

  async getJson<T = unknown>(cid: string): Promise<T> {
    return JSON.parse((await this.getBytes(cid)).toString("utf8")) as T;
  }

  async verify(cid: string): Promise<boolean> {
    try {
      return sha256Hex(await this.getBytes(cid)) === cid;
    } catch {
      return false;
    }
  }
}
