/**
 * OpenTimestamps anchoring.
 *
 *  - OtsCalendar (live): submits the 32-byte Merkle root to public OTS calendars
 *    (POST /digest), merges their timestamp trees into a standard `.ots` file,
 *    and can later *upgrade* pending attestations by asking each calendar for
 *    the Bitcoin-confirmed path (GET /timestamp/<commitment>).
 *  - LocalCalendar (sim): immediate fake "Bitcoin" confirmation for offline demos.
 *
 * Only the subset of the OTS binary format that calendars emit is implemented:
 * sha256/sha1/ripemd160 hashing ops, append/prepend/reverse/hexlify, and
 * pending/bitcoin attestations (unknown attestations are preserved as opaque).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../crypto/merkle.js";

export const DEFAULT_OTS_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
];

export interface TimestampReceipt {
  receipt_id: string;
  digest_hex: string;
  calendar_url: string;
  submitted_at: number;
  confirmed_at: number | null;
  bitcoin_block_height: number | null;
  bitcoin_block_hash: string | null;
  status: "pending" | "confirmed" | "submitted";
  operations: string[];
  mode: "live_ots" | "sim";
  ots_file: string | null;
  pending_calendars: string[];
}

export interface Calendar {
  submit(digestHex: string): Promise<TimestampReceipt>;
  verify(receipt: TimestampReceipt): Promise<boolean>;
  status(): Record<string, unknown>;
  /** Try to turn a pending receipt into a Bitcoin-confirmed one. */
  upgrade?(receipt: TimestampReceipt): Promise<TimestampReceipt>;
}

// ---------------------------------------------------------------------------
// Binary format
// ---------------------------------------------------------------------------

const HEADER_MAGIC = Buffer.from(
  "004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294",
  "hex",
);
const PENDING_TAG = "83dfe30d2ef90c8e";
const BITCOIN_TAG = "0588960d73d71901";

type Att =
  | { kind: "pending"; uri: string }
  | { kind: "bitcoin"; height: number }
  | { kind: "unknown"; tag: string };

interface TsNode {
  msg: Buffer;
  /** Raw serialized items at this node (each: tag + body), used for merging. */
  items: Buffer[];
  attestations: Att[];
  children: { op: string; node: TsNode }[];
}

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("ots: unexpected end of data");
    return this.buf[this.pos++]!;
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error("ots: unexpected end of data");
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
      shift += 7;
    }
  }
  varbytes(max = 8192): Buffer {
    const n = this.varuint();
    if (n > max) throw new Error("ots: varbytes too long");
    return this.bytes(n);
  }
  slice(from: number, to: number) {
    return this.buf.subarray(from, to);
  }
}

const varuint = (n: number): Buffer => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
};

const hash = (alg: string, m: Buffer) => createHash(alg).update(m).digest();

function applyOp(tag: number, r: Reader, msg: Buffer): { name: string; out: Buffer } {
  switch (tag) {
    case 0x08:
      return { name: "sha256", out: hash("sha256", msg) };
    case 0x02:
      return { name: "sha1", out: hash("sha1", msg) };
    case 0x03:
      return { name: "ripemd160", out: hash("ripemd160", msg) };
    case 0xf0: {
      const arg = r.varbytes(4096);
      return { name: `append:${arg.toString("hex")}`, out: Buffer.concat([msg, arg]) };
    }
    case 0xf1: {
      const arg = r.varbytes(4096);
      return { name: `prepend:${arg.toString("hex")}`, out: Buffer.concat([arg, msg]) };
    }
    case 0xf2:
      return { name: "reverse", out: Buffer.from(msg).reverse() };
    case 0xf3:
      return { name: "hexlify", out: Buffer.from(msg.toString("hex"), "ascii") };
    default:
      throw new Error(`ots: unsupported op 0x${tag.toString(16)}`);
  }
}

function parseTimestamp(r: Reader, msg: Buffer, depth = 0): TsNode {
  if (depth > 256) throw new Error("ots: recursion limit");
  const node: TsNode = { msg, items: [], attestations: [], children: [] };
  const readItem = (tag: number) => {
    const start = r.pos - 1;
    if (tag === 0x00) {
      const attTag = r.bytes(8).toString("hex");
      const payload = new Reader(r.varbytes());
      if (attTag === PENDING_TAG) node.attestations.push({ kind: "pending", uri: payload.varbytes(1000).toString("utf8") });
      else if (attTag === BITCOIN_TAG) node.attestations.push({ kind: "bitcoin", height: payload.varuint() });
      else node.attestations.push({ kind: "unknown", tag: attTag });
    } else {
      const { name, out } = applyOp(tag, r, msg);
      node.children.push({ op: name, node: parseTimestamp(r, out, depth + 1) });
    }
    node.items.push(Buffer.from(r.slice(start, r.pos)));
  };
  let tag = r.byte();
  while (tag === 0xff) {
    readItem(r.byte());
    tag = r.byte();
  }
  readItem(tag);
  return node;
}

function serializeItems(items: Buffer[]): Buffer {
  return Buffer.concat(items.map((it, i) => (i < items.length - 1 ? Buffer.concat([Buffer.from([0xff]), it]) : it)));
}

function walk(node: TsNode, visit: (n: TsNode, path: string[]) => void, p: string[] = []) {
  visit(node, p);
  for (const c of node.children) walk(c.node, visit, [...p, c.op]);
}

export function buildOtsFile(digest: Buffer, items: Buffer[]): Buffer {
  return Buffer.concat([HEADER_MAGIC, varuint(1), Buffer.from([0x08]), digest, serializeItems(items)]);
}

export function parseOtsFile(buf: Buffer): { digest: Buffer; root: TsNode } {
  if (!buf.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC)) throw new Error("ots: bad magic");
  const r = new Reader(buf.subarray(HEADER_MAGIC.length));
  if (r.varuint() !== 1) throw new Error("ots: unsupported version");
  if (r.byte() !== 0x08) throw new Error("ots: only sha256 file hashes supported");
  const digest = Buffer.from(r.bytes(32));
  return { digest, root: parseTimestamp(r, digest) };
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export class LocalCalendar implements Calendar {
  private blockHeight = 850_000;
  constructor(private storeDir: string) {}

  status() {
    return {
      mode: "sim",
      calendar_url: "local://ots-calendar-sim",
      note: "Set OTS_MODE=live for public OpenTimestamps calendars",
    };
  }

  async submit(digestHex: string): Promise<TimestampReceipt> {
    if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error("digest must be 32-byte hex (sha256)");
    const receipt_id = randomUUID();
    const now = Date.now() / 1000;
    const nonce = sha256Hex(`${receipt_id}:${now}`).slice(0, 16);
    this.blockHeight += 1;
    const receipt: TimestampReceipt = {
      receipt_id,
      digest_hex: digestHex,
      calendar_url: "local://ots-calendar-sim",
      submitted_at: now,
      confirmed_at: now + 0.01,
      bitcoin_block_height: this.blockHeight,
      bitcoin_block_hash: sha256Hex(`block:${this.blockHeight}:${digestHex}`),
      status: "confirmed",
      operations: [`append:${nonce}`, "sha256", `bitcoin_attest:sim_block_${this.blockHeight}`],
      mode: "sim",
      ots_file: null,
      pending_calendars: [],
    };
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(path.join(this.storeDir, `${receipt_id}.json`), JSON.stringify(receipt, null, 2));
    return receipt;
  }

  async verify(r: TimestampReceipt) {
    if (r.status !== "confirmed" || !r.bitcoin_block_hash || r.bitcoin_block_height == null) return false;
    return sha256Hex(`block:${r.bitcoin_block_height}:${r.digest_hex}`) === r.bitcoin_block_hash;
  }
}

export class OtsCalendar implements Calendar {
  constructor(
    private storeDir: string,
    readonly calendarUrls: string[] = DEFAULT_OTS_CALENDARS,
    private timeoutMs = 15_000,
    private minCalendars = 1,
  ) {}

  status() {
    return {
      mode: "live_ots",
      calendars: this.calendarUrls,
      min_calendars: this.minCalendars,
      note: "PendingAttestation until Bitcoin inclusion (often hours)",
    };
  }

  private async fetchBytes(url: string, init: RequestInit = {}): Promise<Buffer> {
    const res = await fetch(url, {
      ...init,
      headers: { Accept: "application/vnd.opentimestamps.v1", "User-Agent": "vehicle-por/2.0", ...init.headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async submit(digestHex: string): Promise<TimestampReceipt> {
    if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error("digest must be 32-byte hex (sha256)");
    const digest = Buffer.from(digestHex, "hex");
    const results = await Promise.allSettled(
      this.calendarUrls.map(async (url) => {
        const body = await this.fetchBytes(`${url.replace(/\/$/, "")}/digest`, { method: "POST", body: digest });
        return { url, node: parseTimestamp(new Reader(body), digest) };
      }),
    );
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const errors = results.flatMap((r, i) =>
      r.status === "rejected" ? [`${this.calendarUrls[i]}: ${(r.reason as Error).message}`] : [],
    );
    if (ok.length < this.minCalendars) {
      throw new Error(`OTS calendar submit failed (${ok.length}/${this.minCalendars}): ${errors.slice(-3).join("; ")}`);
    }

    const items = ok.flatMap((o) => o.node.items);
    const receipt_id = randomUUID();
    const otsPath = path.join(this.storeDir, `${receipt_id}.ots`);
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(otsPath, buildOtsFile(digest, items));

    const receipt = this.summarize(
      { msg: digest, items, attestations: [], children: ok.flatMap((o) => o.node.children) },
      {
        receipt_id,
        digest_hex: digestHex,
        calendar_url: ok[0]!.url,
        submitted_at: Date.now() / 1000,
        ots_file: otsPath,
        operations: ok.map((o) => `submit:${o.url}`),
      },
    );
    await writeFile(
      path.join(this.storeDir, `${receipt_id}.json`),
      JSON.stringify({ receipt, submitted_calendars: ok.map((o) => o.url), errors }, null, 2),
    );
    return receipt;
  }

  private summarize(
    root: TsNode,
    base: Pick<TimestampReceipt, "receipt_id" | "digest_hex" | "calendar_url" | "submitted_at" | "ots_file" | "operations">,
  ): TimestampReceipt {
    const ops = [...base.operations];
    const pending: string[] = [];
    let height: number | null = null;
    walk(root, (n) => {
      for (const a of n.attestations) {
        if (a.kind === "pending") {
          pending.push(a.uri);
          ops.push(`pending:${a.uri}`);
        } else if (a.kind === "bitcoin") {
          height = height == null ? a.height : Math.min(height, a.height);
          ops.push(`bitcoin_attest:height_${a.height}`);
        }
      }
    });
    const confirmed = height != null;
    return {
      ...base,
      operations: ops,
      confirmed_at: confirmed ? Date.now() / 1000 : null,
      bitcoin_block_height: height,
      bitcoin_block_hash: null,
      status: confirmed ? "confirmed" : "pending",
      mode: "live_ots",
      pending_calendars: pending.length ? pending : [base.calendar_url],
    };
  }

  async verify(r: TimestampReceipt): Promise<boolean> {
    if (!r.ots_file || !existsSync(r.ots_file) || !/^[0-9a-f]{64}$/.test(r.digest_hex)) return false;
    try {
      return parseOtsFile(await readFile(r.ots_file)).digest.toString("hex") === r.digest_hex;
    } catch {
      return false;
    }
  }

  /**
   * Ask each pending calendar for the completed (Bitcoin-attested) path and
   * splice it into the .ots file. Returns the updated receipt.
   */
  async upgrade(r: TimestampReceipt): Promise<TimestampReceipt> {
    if (r.status === "confirmed" || !r.ots_file || !existsSync(r.ots_file)) return r;
    const file = await readFile(r.ots_file);
    const { digest, root } = parseOtsFile(file);

    let changed = false;
    const upgradeNode = async (n: TsNode): Promise<Buffer[]> => {
      // Rebuild this node's items, replacing pending attestations with calendar answers.
      const newItems: Buffer[] = [];
      let childIdx = 0;
      let attIdx = 0;
      for (const item of n.items) {
        if (item[0] === 0x00) {
          const att = n.attestations[attIdx++];
          if (att?.kind === "pending") {
            try {
              const body = await this.fetchBytes(`${att.uri.replace(/\/$/, "")}/timestamp/${n.msg.toString("hex")}`);
              const upgraded = parseTimestamp(new Reader(body), n.msg);
              let hasBtc = false;
              walk(upgraded, (x) => (hasBtc ||= x.attestations.some((a) => a.kind === "bitcoin")));
              if (hasBtc) {
                newItems.push(...upgraded.items);
                changed = true;
                continue;
              }
            } catch {
              /* still pending at this calendar */
            }
          }
          newItems.push(item);
        } else {
          const child = n.children[childIdx++]!;
          const opLen = item.length - serializeItems(child.node.items).length;
          const childItems = await upgradeNode(child.node);
          newItems.push(Buffer.concat([item.subarray(0, opLen), serializeItems(childItems)]));
        }
      }
      return newItems;
    };

    const items = await upgradeNode(root);
    if (!changed) return r;
    await writeFile(r.ots_file, buildOtsFile(digest, items));
    const reparsed = parseOtsFile(await readFile(r.ots_file));
    return this.summarize(reparsed.root, {
      receipt_id: r.receipt_id,
      digest_hex: r.digest_hex,
      calendar_url: r.calendar_url,
      submitted_at: r.submitted_at,
      ots_file: r.ots_file,
      operations: r.operations.filter((o) => o.startsWith("submit:")),
    });
  }
}

/** OTS_MODE: live | sim | auto (default — live calendars, sim if they are unreachable). */
export function loadCalendar(storeDir: string, mode: string, urls: string[]): Calendar {
  if (["sim", "local", "simulator"].includes(mode)) return new LocalCalendar(storeDir);
  const live = new OtsCalendar(storeDir, urls.length ? urls : DEFAULT_OTS_CALENDARS);
  if (mode === "live" || mode === "ots") return live;
  return new FallbackCalendar(live, new LocalCalendar(storeDir));
}

/** auto mode: try public calendars, fall back to the simulator when offline. */
class FallbackCalendar implements Calendar {
  private lastMode: "live_ots" | "sim" = "live_ots";
  constructor(
    private live: OtsCalendar,
    private sim: LocalCalendar,
  ) {}
  status() {
    return this.lastMode === "live_ots"
      ? { ...this.live.status(), fallback: "sim when calendars unreachable" }
      : { ...this.sim.status(), note: "auto: public calendars unreachable on last submit — used simulator" };
  }
  async submit(d: string) {
    try {
      const r = await this.live.submit(d);
      this.lastMode = "live_ots";
      return r;
    } catch (e) {
      console.warn(`[ots] live calendars failed (${(e as Error).message}); using simulator`);
      this.lastMode = "sim";
      return this.sim.submit(d);
    }
  }
  verify(r: TimestampReceipt) {
    return r.mode === "sim" ? this.sim.verify(r) : this.live.verify(r);
  }
  upgrade(r: TimestampReceipt) {
    return r.mode === "sim" ? Promise.resolve(r) : this.live.upgrade(r);
  }
}
