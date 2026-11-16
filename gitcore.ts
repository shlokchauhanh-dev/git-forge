// In-memory git object database, pkt-line codec, and packfile read/write.
// SHA-1 object ids, zlib packs, and the smart-HTTP framing the suite speaks.
// No git binary and no packages: Node's crypto and zlib only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = ['', 'commit', 'tree', 'blob', 'tag'] as const;

export interface GitObj {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'));
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Pull pkt-lines out of a buffer. `rest` is the unparsed tail (a pack may follow the flush). */
export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const n = parseInt(hex, 16);
    if (n === 0) {
      packets.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (n === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (n === 2) {
      packets.push({ kind: 'end' });
      i += 4;
      continue;
    }
    if (n < 4 || i + n > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + n) });
    i += n;
  }
  return { packets, rest: buf.subarray(i) };
}

export function textOf(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8') : '';
}

interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

function gitName(item: TreeItem): string {
  return item.mode === '40000' ? `${item.name}/` : item.name;
}

export function buildTree(items: TreeItem[]): Buffer {
  const sorted = [...items].sort((a, b) => {
    const x = gitName(a);
    const y = gitName(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const item of sorted) {
    parts.push(Buffer.from(`${item.mode} ${item.name}\0`));
    parts.push(Buffer.from(item.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.toString('ascii', i, sp);
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    items.push({ mode, name, oid });
    i = nul + 21;
  }
  return items;
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  const who = (ident: string) => `${ident} ${input.timestamp} +0000`;
  lines.push(`author ${who(input.author)}`);
  lines.push(`committer ${who(input.committer)}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`);
}

function encodeSize(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 15);
  size >>>= 4;
  if (size) first |= 0x80;
  bytes.push(first);
  while (size) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObj[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const chunks: Buffer[] = [header];
  for (const object of objects) {
    const code = TYPE_CODE[object.type];
    if (!code) throw new Error(`unknown object type ${object.type}`);
    chunks.push(encodeSize(code, object.data.length), deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Smallest prefix of `buf` starting at `offset` that is one zlib stream. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const limit = buf.length - offset;
  let lo = 2;
  let hi = limit;
  let best = -1;
  let data: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, offset + mid));
      best = mid;
      data = out;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best < 0 || data === null) throw new Error('pack zlib stream does not inflate');
  return { data, consumed: best };
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const c = buf[i];
    if (c === undefined) throw new Error('truncated delta header');
    i += 1;
    value |= (c & 0x7f) << shift;
    if ((c & 0x80) === 0) return { value, next: i };
    shift += 7;
  }
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readVarint(delta, 0);
  const target = readVarint(delta, source.next);
  if (source.value !== base.length) throw new Error('delta base size does not match');
  const out = Buffer.allocUnsafe(target.value);
  let wrote = 0;
  let i = target.next;
  while (i < delta.length) {
    const cmd = delta[i];
    i += 1;
    if (cmd === undefined) break;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) offset |= delta[i++]!;
      if (cmd & 0x02) offset |= delta[i++]! << 8;
      if (cmd & 0x04) offset |= delta[i++]! << 16;
      if (cmd & 0x08) offset |= delta[i++]! << 24;
      if (cmd & 0x10) size |= delta[i++]!;
      if (cmd & 0x20) size |= delta[i++]! << 8;
      if (cmd & 0x40) size |= delta[i++]! << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, wrote, offset, offset + size);
      wrote += size;
    } else if (cmd !== 0) {
      delta.copy(out, wrote, i, i + cmd);
      i += cmd;
      wrote += cmd;
    } else {
      throw new Error('reserved delta opcode');
    }
  }
  if (wrote !== target.value) throw new Error('delta did not fill the target');
  return out;
}

interface RawEntry {
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  start: number;
}

export function readPack(buf: Buffer, have?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = buf.readUInt32BE(8);
  const checksum = buf.subarray(buf.length - 20).toString('hex');
  const expected = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (checksum !== expected) throw new Error('pack checksum mismatch');
  let offset = 12;
  const raw: RawEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    const start = offset;
    let c = buf[offset++];
    if (c === undefined) throw new Error('truncated pack object');
    const typeCode = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = buf[offset++];
      if (c === undefined) throw new Error('truncated pack size');
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let b = buf[offset++];
      if (b === undefined) throw new Error('truncated ofs-delta');
      let rel = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset++];
        if (b === undefined) throw new Error('truncated ofs-delta');
        rel = ((rel + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - rel;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(buf, offset);
    offset += inflated.consumed;
    if (inflated.data.length !== size && typeCode !== 6 && typeCode !== 7) {
      // size is the inflated object size; deltas carry the delta size
    }
    raw.push({ typeCode, data: inflated.data, baseOffset, baseOid, start });
  }
  const byStart = new Map<number, GitObj>();
  const out = new Map<string, GitObj>();
  const resolve = (entry: RawEntry): GitObj => {
    const cached = byStart.get(entry.start);
    if (cached) return cached;
    let object: GitObj;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObj | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = raw.find((item) => item.start === entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base is missing');
        base = resolve(baseEntry);
      } else if (entry.baseOid) {
        base = out.get(entry.baseOid) ?? have?.(entry.baseOid);
      }
      if (!base) throw new Error('delta base is not in the pack');
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
        throw new Error(`unsupported pack type ${entry.typeCode}`);
      }
      object = { type, data: entry.data };
    }
    byStart.set(entry.start, object);
    const oid = hashObject(object.type, object.data);
    out.set(oid, object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return out;
}

/** Split a buffer into sideband band-1 pkt-lines. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const chunk = 60000;
  for (let i = 0; i < pack.length; i += chunk) {
    const slice = pack.subarray(i, Math.min(pack.length, i + chunk));
    const payload = Buffer.allocUnsafe(slice.length + 1);
    payload[0] = 1;
    slice.copy(payload, 1);
    frames.push(pktLine(payload));
  }
  return frames;
}

export function sidebandReport(report: string, progress = ''): Buffer {
  const lines = report.split('\n').filter((line) => line.length > 0);
  const pkt = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  const band = Buffer.allocUnsafe(pkt.length + 1);
  band[0] = 1;
  pkt.copy(band, 1);
  const parts = [pktLine(band)];
  if (progress) {
    const note = Buffer.from(progress);
    const prog = Buffer.allocUnsafe(note.length + 1);
    prog[0] = 2;
    note.copy(prog, 1);
    parts.push(pktLine(prog));
  }
  return Buffer.concat(parts);
}

export interface StoredRef {
  oid: string;
}

export class ObjectDb {
  readonly objects = new Map<string, GitObj>();

  put(type: GitObj['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  absorb(found: Map<string, GitObj>): void {
    for (const [oid, object] of found) {
      if (!this.objects.has(oid)) this.objects.set(oid, object);
    }
  }

  parents(oid: string): string[] {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return [];
    return parseCommit(object.data).parents;
  }

  /** True when `older` is `newer` or an ancestor of it. */
  isAncestor(older: string, newer: string): boolean {
    if (older === newer) return true;
    const seen = new Set<string>();
    const stack = [newer];
    while (stack.length) {
      const oid = stack.pop();
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);
      if (oid === older) return true;
      for (const parent of this.parents(oid)) stack.push(parent);
    }
    return false;
  }

  peel(oid: string): string {
    let current = oid;
    for (let hop = 0; hop < 8; hop += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      const text = object.data.toString('utf8');
      const line = text.split('\n').find((item) => item.startsWith('object '));
      if (!line) return current;
      current = line.slice(7).trim();
    }
    return current;
  }

  /** Files at `commit` as full path -> blob oid. */
  filesAt(commitOid: string): Map<string, string> {
    const files = new Map<string, string>();
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return files;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const item of parseTree(tree.data)) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.mode === '40000') walk(item.oid, path);
        else files.set(path, item.oid);
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return files;
  }

  blobAt(commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const parts = path.split('/').filter(Boolean);
    let oid = parseCommit(commit.data).tree;
    for (let i = 0; i < parts.length; i += 1) {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return null;
      const item = parseTree(object.data).find((entry) => entry.name === parts[i]);
      if (!item) return null;
      if (i === parts.length - 1) {
        if (item.mode === '40000') return null;
        const blob = this.objects.get(item.oid);
        if (!blob) return null;
        return { oid: item.oid, data: blob.data };
      }
      oid = item.oid;
    }
    return null;
  }

  listDir(commitOid: string, dir: string): TreeItem[] | null {
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let oid = parseCommit(commit.data).tree;
    if (dir) {
      for (const name of dir.split('/').filter(Boolean)) {
        const object = this.objects.get(oid);
        if (!object || object.type !== 'tree') return null;
        const item = parseTree(object.data).find((entry) => entry.name === name);
        if (!item || item.mode !== '40000') return null;
        oid = item.oid;
      }
    }
    const tree = this.objects.get(oid);
    if (!tree || tree.type !== 'tree') return null;
    return parseTree(tree.data);
  }

  /** Replace or delete one path and return the new root tree. */
  editTree(baseCommit: string | null, path: string, blob: Buffer | null): string {
    const current = new Map<string, Buffer>();
    if (baseCommit) {
      for (const [file, oid] of this.filesAt(baseCommit)) {
        const object = this.objects.get(oid);
        if (object) current.set(file, object.data);
      }
    }
    if (blob === null) current.delete(path);
    else current.set(path, blob);
    return this.treeFromFiles(current);
  }

  treeFromFiles(files: Map<string, Buffer>): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, data] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, data);
    }
    const build = (node: Node): string => {
      const items: TreeItem[] = [];
      for (const [name, data] of node.files) items.push({ mode: '100644', name, oid: this.put('blob', data) });
      for (const [name, child] of node.dirs) items.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(items));
    };
    return build(root);
  }

  /**
   * Objects a fetch should send for `roots`.
   * `depth` counts commits along ancestry (1 = the tip only). Null means the whole history.
   * `skip` holds objects the client already has; a skipped commit is not sent, but a remaining
   * depth still walks through it so a deepen can deliver the parent.
   */
  collect(roots: readonly string[], depth: number | null, skip: ReadonlySet<string>): GitObj[] {
    const wantCommits = new Set<string>();
    const best = new Map<string, number>();
    const queue: Array<{ oid: string; left: number }> = [];
    const enqueue = (oid: string, left: number): void => {
      if (left <= 0) return;
      queue.push({ oid, left });
    };
    for (const root of roots) {
      const object = this.objects.get(root);
      if (object?.type === 'tag') enqueue(this.peel(root), depth ?? 1_000_000);
      else enqueue(root, depth ?? 1_000_000);
    }
    while (queue.length) {
      const item = queue.pop();
      if (!item) continue;
      const seenLeft = best.get(item.oid) ?? 0;
      if (item.left <= seenLeft) continue;
      best.set(item.oid, item.left);
      const object = this.objects.get(item.oid);
      if (!object || object.type !== 'commit') continue;
      if (!skip.has(item.oid)) wantCommits.add(item.oid);
      if (item.left > 1) {
        for (const parent of parseCommit(object.data).parents) enqueue(parent, item.left - 1);
      }
    }
    const seen = new Set<string>();
    const out: GitObj[] = [];
    const add = (oid: string): void => {
      if (seen.has(oid) || skip.has(oid)) return;
      const object = this.objects.get(oid);
      if (!object) return;
      seen.add(oid);
      out.push(object);
      if (object.type === 'commit') add(parseCommit(object.data).tree);
      else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) add(entry.oid);
      } else if (object.type === 'tag') add(this.peel(oid));
    };
    for (const oid of wantCommits) add(oid);
    for (const root of roots) {
      const object = this.objects.get(root);
      if (object?.type === 'tag') add(root);
    }
    return out;
  }
}
