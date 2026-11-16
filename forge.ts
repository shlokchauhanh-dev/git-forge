// In-memory GitHub-shaped forge: smart HTTP, REST v3, GraphQL and MCP.
// The bearer token's login is the suite's fixed viewer. Clocks are a counter,
// so two identical trials take the same branches.

import type { IncomingMessage } from 'node:http';
import {
  DELIM,
  FLUSH,
  ZERO_OID,
  buildCommit,
  decodePackets,
  hashObject,
  parseCommit,
  parseTree,
  pktLine,
  readPack,
  sidebandPack,
  sidebandReport,
  textOf,
  writePack,
  type GitObj,
  type Packet,
  ObjectDb,
} from './gitcore.ts';

const VIEWER = 'adaiversen';
const AUTHOR = 'ada iversen <adaiversen@example.invalid>';
const DEFAULT_BRANCH = 'main';

export interface Outcome {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

interface Note {
  id: number;
  issue: number;
  body: string;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string;
  mergeSha: string;
}

interface Repo {
  id: number;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  db: ObjectDb;
  refs: Map<string, string>;
  messages: Map<string, string>;
  labels: Map<string, string>;
  issues: Issue[];
  notes: Note[];
  pulls: Pull[];
  nextIssue: number;
  nextNote: number;
  nextPull: number;
  stamp: number;
  packs: Map<string, Buffer>;
}

function tokenOk(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function jsonOut(status: number, value: unknown, headers: Record<string, string> = {}): Outcome {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: Buffer.from(JSON.stringify(value)),
  };
}

function rawOut(status: number, body: Buffer, contentType: string): Outcome {
  return { status, headers: { 'content-type': contentType }, body };
}

function emptyOut(status: number): Outcome {
  return { status, headers: {}, body: null };
}

function message(status: number, text: string): Outcome {
  return jsonOut(status, { message: text });
}

function gid(kind: string, rest: string): string {
  return Buffer.from(`${kind}:${rest}`, 'utf8').toString('base64url');
}

function ungid(value: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const cut = text.indexOf(':');
    if (cut <= 0) return null;
    return { kind: text.slice(0, cut), rest: text.slice(cut + 1) };
  } catch {
    return null;
  }
}

function linesOf(data: Buffer | null): number {
  if (!data || data.length === 0) return 0;
  let count = 1;
  for (const byte of data) if (byte === 10) count += 1;
  if (data[data.length - 1] === 10) count -= 1;
  return count;
}

export class Forge {
  private repos: Repo[] = [];
  private nextId = 1;
  private stamp = 1_700_000_000;

  handle(method: string, path: string, query: URLSearchParams, req: IncomingMessage, body: Buffer): Outcome {
    if (path === '/mcp' || path === '/mcp/') return this.mcp(method, req, body);
    if (path === '/api/graphql' || path === '/api/graphql/') return this.graphql(method, req, body);
    const git = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
    if (git) return this.git(method, decodeURIComponent(git[1] ?? ''), decodeURIComponent(git[2] ?? ''), git[3] ?? '', query, req, body);
    if (path === '/api/v3' || path.startsWith('/api/v3/')) return this.rest(method, path, query, req, body);
    return message(404, 'Not Found');
  }

  private repoByName(name: string): Repo | undefined {
    return this.repos.find((repo) => repo.name === name);
  }

  private makeRepo(name: string, description: string, priv: boolean): Repo {
    const repo: Repo = {
      id: this.nextId++,
      name,
      description,
      priv,
      defaultBranch: DEFAULT_BRANCH,
      db: new ObjectDb(),
      refs: new Map(),
      messages: new Map(),
      labels: new Map(),
      issues: [],
      notes: [],
      pulls: [],
      nextIssue: 1,
      nextNote: 1,
      nextPull: 1,
      stamp: 0,
      packs: new Map(),
    };
    this.repos.push(repo);
    return repo;
  }

  private nextStamp(): number {
    this.stamp += 1;
    return this.stamp;
  }

  private tip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  private headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  private forgetPacks(repo: Repo): void {
    repo.packs.clear();
  }

  private commitFiles(repo: Repo, branch: string, parent: string | null, files: Map<string, Buffer>, messageText: string): string {
    const tree = repo.db.treeFromFiles(files);
    const stamp = this.nextStamp();
    const data = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      author: AUTHOR,
      committer: AUTHOR,
      timestamp: stamp,
      message: messageText,
    });
    const oid = repo.db.put('commit', data);
    repo.messages.set(oid, messageText);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.stamp = stamp;
    this.forgetPacks(repo);
    return oid;
  }

  private filesOf(repo: Repo, commit: string | null): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    if (!commit) return files;
    for (const [path, oid] of repo.db.filesAt(commit)) {
      const object = repo.db.get(oid);
      if (object) files.set(path, object.data);
    }
    return files;
  }

  private shownMessage(repo: Repo, oid: string): string {
    const exact = repo.messages.get(oid);
    if (exact !== undefined) return exact;
    const object = repo.db.get(oid);
    if (!object || object.type !== 'commit') return '';
    const text = parseCommit(object.data).message;
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }

  private history(repo: Repo, oid: string | undefined): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    let current = oid;
    while (current && !seen.has(current) && out.length < 300) {
      seen.add(current);
      const object = repo.db.get(current);
      if (!object || object.type !== 'commit') break;
      out.push({ sha: current, message: this.shownMessage(repo, current) });
      current = parseCommit(object.data).parents[0];
    }
    return out;
  }

  private mergeBase(repo: Repo, left: string, right: string): string | null {
    const seenLeft = new Set<string>();
    const seenRight = new Set<string>();
    const queueLeft = [left];
    const queueRight = [right];
    while (queueLeft.length || queueRight.length) {
      const fromLeft = queueLeft.shift();
      if (fromLeft) {
        if (seenRight.has(fromLeft)) return fromLeft;
        if (!seenLeft.has(fromLeft)) {
          seenLeft.add(fromLeft);
          for (const parent of repo.db.parents(fromLeft)) queueLeft.push(parent);
        }
      }
      const fromRight = queueRight.shift();
      if (fromRight) {
        if (seenLeft.has(fromRight)) return fromRight;
        if (!seenRight.has(fromRight)) {
          seenRight.add(fromRight);
          for (const parent of repo.db.parents(fromRight)) queueRight.push(parent);
        }
      }
    }
    return null;
  }

  private mergedFiles(repo: Repo, baseOid: string, headOid: string): Map<string, Buffer> | null {
    const base = repo.db.filesAt(baseOid);
    const head = repo.db.filesAt(headOid);
    const ancestorOid = this.mergeBase(repo, baseOid, headOid);
    const ancestor = ancestorOid ? repo.db.filesAt(ancestorOid) : new Map<string, string>();
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out = new Map<string, Buffer>();
    for (const path of paths) {
      const baseOidPath = base.get(path);
      const headOidPath = head.get(path);
      const ancestorOidPath = ancestor.get(path);
      if (baseOidPath === headOidPath) {
        if (baseOidPath) {
          const object = repo.db.get(baseOidPath);
          if (object) out.set(path, object.data);
        }
        continue;
      }
      if (baseOidPath === ancestorOidPath) {
        if (headOidPath) {
          const object = repo.db.get(headOidPath);
          if (object) out.set(path, object.data);
        }
        continue;
      }
      if (headOidPath === ancestorOidPath) {
        if (baseOidPath) {
          const object = repo.db.get(baseOidPath);
          if (object) out.set(path, object.data);
        }
        continue;
      }
      return null;
    }
    return out;
  }

  private squash(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
    if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull Request is not open' };
    const baseOid = this.tip(repo, pull.base);
    const headOid = this.tip(repo, pull.head);
    if (!baseOid || !headOid) return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
    const files = this.mergedFiles(repo, baseOid, headOid);
    if (!files) return { ok: false, status: 405, message: 'Merge conflict' };
    const sha = this.commitFiles(repo, pull.base, baseOid, files, pull.title);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = sha;
    pull.mergedAt = new Date(this.stamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return { ok: true, sha };
  }

  private pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
    const baseOid = this.tip(repo, pull.base);
    const headOid = this.tip(repo, pull.head);
    const base = baseOid ? repo.db.filesAt(baseOid) : new Map<string, string>();
    const head = headOid ? repo.db.filesAt(headOid) : new Map<string, string>();
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const files: Array<Record<string, unknown>> = [];
    for (const path of [...paths].sort()) {
      const before = base.get(path);
      const after = head.get(path);
      if (before === after) continue;
      const beforeData = before ? (repo.db.get(before)?.data ?? null) : null;
      const afterData = after ? (repo.db.get(after)?.data ?? null) : null;
      const status = before ? 'modified' : 'added';
      const additions = Math.max(after && !before ? 1 : 0, linesOf(afterData));
      const deletions = linesOf(before && after ? beforeData : before ? beforeData : null);
      files.push({
        filename: path,
        status,
        additions: before ? Math.max(additions, 1) : Math.max(additions, afterData && afterData.length > 0 ? 1 : 0),
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  // -------------------------------------------------------------------------------------------
  // smart HTTP
  // -------------------------------------------------------------------------------------------

  private git(method: string, owner: string, name: string, suffix: string, query: URLSearchParams, req: IncomingMessage, body: Buffer): Outcome {
    if (!tokenOk(req)) return message(401, 'Requires authentication');
    const repo = owner === VIEWER ? this.repoByName(name) : undefined;
    if (!repo) return message(404, 'Not Found');
    try {
      if (method === 'GET' && suffix === '/info/refs') return this.advertise(repo, query.get('service') ?? '', wantsV2(req));
      if (method === 'POST' && suffix === '/git-upload-pack') return this.upload(repo, body);
      if (method === 'POST' && suffix === '/git-receive-pack') return this.receive(repo, body);
    } catch {
      return rawOut(400, Buffer.from('bad request'), 'text/plain; charset=utf-8');
    }
    return message(404, 'Not Found');
  }

  private advertise(repo: Repo, service: string, v2: boolean): Outcome {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return message(403, 'Unsupported service');
    if (service === 'git-upload-pack' && v2) {
      const lines = ['version 2\n', 'agent=git-forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
      return rawOut(200, Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]), `application/x-${service}-advertisement`);
    }
    const caps = service === 'git-receive-pack'
      ? ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'ofs-delta', 'quiet', 'agent=git-forge/1']
      : ['ofs-delta', 'side-band-64k', 'thin-pack', 'no-progress', 'include-tag', 'agent=git-forge/1'];
    const head = repo.refs.get(this.headRef(repo));
    if (head) caps.push(`symref=HEAD:${this.headRef(repo)}`);
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const preamble = pktLine(`# service=${service}\n`);
    const lines: Buffer[] = [preamble, FLUSH];
    if (!refs.length) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`), FLUSH);
    } else {
      if (head) refs.unshift(['HEAD', head]);
      refs.forEach(([name, oid], index) => {
        const suffix = index === 0 ? `\0${caps.join(' ')}` : '';
        lines.push(pktLine(`${oid} ${name}${suffix}\n`));
      });
      lines.push(FLUSH);
    }
    return rawOut(200, Buffer.concat(lines), `application/x-${service}-advertisement`);
  }

  private upload(repo: Repo, body: Buffer): Outcome {
    const { packets } = decodePackets(body);
    const data = packets.filter((packet) => packet.kind === 'data').map((packet) => textOf(packet).replace(/\n$/, ''));
    if (!data.length) return rawOut(400, Buffer.from('bad request'), 'text/plain; charset=utf-8');
    const command = data[0] ?? '';
    if (command.startsWith('command=ls-refs')) return rawOut(200, this.lsRefs(repo, data), 'application/x-git-upload-pack-result');
    if (command.startsWith('command=fetch')) return rawOut(200, this.fetch(repo, data), 'application/x-git-upload-pack-result');
    return rawOut(400, Buffer.from('bad request'), 'text/plain; charset=utf-8');
  }

  private lsRefs(repo: Repo, lines: readonly string[]): Buffer {
    const args = lines.slice(lines.findIndex((line) => line === 'command=ls-refs') + 1);
    const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const unborn = args.includes('unborn');
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const out: Buffer[] = [];
    const headName = this.headRef(repo);
    const head = repo.refs.get(headName);
    if (prefixes.length === 0) {
      if (head) {
        const extra = symrefs ? ` symref-target:${headName}` : '';
        out.push(pktLine(`${head} HEAD${extra}\n`));
      } else if (unborn) {
        const extra = symrefs ? ` symref-target:${headName}` : '';
        out.push(pktLine(`unborn HEAD${extra}\n`));
      }
    }
    for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!keep(name)) continue;
      let extra = '';
      if (peel) {
        const object = repo.db.get(oid);
        if (object?.type === 'tag') extra = ` peeled:${repo.db.peel(oid)}`;
      }
      out.push(pktLine(`${oid} ${name}${extra}\n`));
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  private fetch(repo: Repo, lines: readonly string[]): Buffer {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    const frames: Buffer[] = [pktLine('acknowledgments\n')];
    const known = haves.find((oid) => repo.db.get(oid));
    frames.push(pktLine(known ? `ACK ${known}\n` : 'NAK\n'), FLUSH);
    if (!wants.length) return Buffer.concat(frames);
    const skip = this.clientHas(repo, haves, new Set(shallow));
    const key = skip.size === 0 && (depth === 1 || depth === null) ? `${depth ?? 'all'}:${[...wants].sort().join(',')}` : '';
    let pack = key ? repo.packs.get(key) : undefined;
    let objects: GitObj[];
    if (pack) objects = [];
    else {
      objects = repo.db.collect(wants, depth, skip);
      pack = objects.length ? writePack(objects) : Buffer.alloc(0);
      if (key && objects.length) repo.packs.set(key, pack);
    }
    if (depth !== null || shallow.length) {
      const included = new Set(objects.filter((object) => object.type === 'commit').map((object) => hashObject('commit', object.data)));
      if (!objects.length && pack && pack.length) {
        // cached pack: the depth-1 boundary is the wanted tip when it still has a parent
      }
      const boundaries = this.boundaries(repo, wants, depth, skip, included, pack);
      const unshallow = shallow.filter((oid) => {
        const parents = repo.db.parents(oid);
        return parents.length > 0 && parents.every((parent) => boundaries.included.has(parent));
      });
      if (boundaries.shallow.length || unshallow.length) {
        frames.push(pktLine('shallow-info\n'));
        for (const oid of boundaries.shallow) frames.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) frames.push(pktLine(`unshallow ${oid}\n`));
        frames.push(FLUSH);
      }
    }
    if (pack.length) {
      frames.push(pktLine('packfile\n'), ...sidebandPack(pack), FLUSH);
    }
    return Buffer.concat(frames);
  }

  private clientHas(repo: Repo, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
    const skip = new Set<string>();
    const walk = (oid: string, parents: boolean): void => {
      if (!oid || skip.has(oid)) return;
      const object = repo.db.get(oid);
      if (!object) return;
      skip.add(oid);
      if (object.type === 'commit') {
        walk(parseCommit(object.data).tree, false);
        if (parents && !shallow.has(oid)) {
          for (const parent of parseCommit(object.data).parents) walk(parent, true);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) walk(entry.oid, false);
      } else if (object.type === 'tag') walk(repo.db.peel(oid), parents);
    };
    for (const have of haves) walk(have, true);
    return skip;
  }

  private boundaries(
    repo: Repo,
    wants: readonly string[],
    depth: number | null,
    skip: ReadonlySet<string>,
    includedFromObjects: Set<string>,
    pack: Buffer,
  ): { shallow: string[]; included: Set<string> } {
    const included = new Set(includedFromObjects);
    if (!included.size && pack.length) {
      for (const want of wants) {
        const object = repo.db.get(want);
        if (object?.type === 'commit') included.add(want);
      }
    }
    if (!included.size && depth !== null) {
      for (const object of repo.db.collect(wants, depth, skip)) {
        if (object.type === 'commit') included.add(hashObject('commit', object.data));
      }
    }
    const shallow: string[] = [];
    for (const oid of included) {
      const parents = repo.db.parents(oid);
      if (parents.some((parent) => !included.has(parent))) shallow.push(oid);
    }
    return { shallow, included };
  }

  private receive(repo: Repo, body: Buffer): Outcome {
    const decoded = decodePackets(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of decoded.packets) {
      if (packet.kind !== 'data') continue;
      const line = textOf(packet).replace(/\n$/, '').split('\0')[0] ?? '';
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] ?? '', newOid: parts[1] ?? '', ref: parts[2] ?? '' });
    }
    let unpack = 'ok';
    if (decoded.rest.length) {
      try {
        repo.db.absorb(readPack(decoded.rest, (oid) => repo.db.get(oid)));
        this.forgetPacks(repo);
      } catch {
        unpack = 'index-pack failed';
      }
    }
    const reports: string[] = [`unpack ${unpack}`];
    if (unpack === 'ok') {
      for (const command of commands) {
        const reason = this.applyRef(repo, command);
        reports.push(reason ? `ng ${command.ref} ${reason}` : `ok ${command.ref}`);
      }
    } else {
      for (const command of commands) reports.push(`ng ${command.ref} unpack failed`);
    }
    return rawOut(200, sidebandReport(`${reports.join('\n')}\n`), 'application/x-git-receive-pack-result');
  }

  private applyRef(repo: Repo, command: { oldOid: string; newOid: string; ref: string }): string | null {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (!current || current !== command.oldOid) return 'non-fast-forward';
      repo.refs.delete(command.ref);
      this.forgetPacks(repo);
      return null;
    }
    if (!repo.db.get(command.newOid)) return 'non-fast-forward';
    if (command.oldOid === ZERO_OID) {
      if (current) return 'non-fast-forward';
      repo.refs.set(command.ref, command.newOid);
      this.forgetPacks(repo);
      return null;
    }
    if (current !== command.oldOid || !repo.db.isAncestor(command.oldOid, command.newOid)) return 'non-fast-forward';
    repo.refs.set(command.ref, command.newOid);
    this.forgetPacks(repo);
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // REST
  // -------------------------------------------------------------------------------------------

  private rest(method: string, path: string, query: URLSearchParams, req: IncomingMessage, raw: Buffer): Outcome {
    if (!tokenOk(req)) return message(401, 'Requires authentication');
    const host = req.headers.host ?? '127.0.0.1';
    let payload: unknown = {};
    if (raw.length) {
      try {
        payload = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        return message(400, 'Problems parsing JSON');
      }
    }
    const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const parts = path.replace(/\/+$/, '').split('/').filter(Boolean).map(decodeURIComponent);
    // parts: api v3 ...
    const route = parts.slice(2);
    if (route.length === 0) return jsonOut(200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo' });
    if (route[0] === 'meta' && route.length === 1 && method === 'GET') return jsonOut(200, { installed_version: '1.0.0' });
    if (route[0] === 'user' && route[1] === undefined && method === 'GET') {
      return jsonOut(200, { login: VIEWER, id: 1000, name: 'ada iversen' });
    }
    if (route[0] === 'user' && route[1] === 'repos' && route.length === 2) {
      if (method === 'POST') return this.createRepo(body);
      if (method === 'GET') return this.listRepos(query, host);
    }
    if (route[0] === 'repos' && route.length >= 3) {
      const owner = route[1] ?? '';
      const name = route[2] ?? '';
      const rest = route.slice(3);
      if (owner !== VIEWER) return message(404, 'Not Found');
      return this.repoRoute(method, name, rest, query, body);
    }
    return message(404, 'Not Found');
  }

  private createRepo(body: Record<string, unknown>): Outcome {
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) return message(422, 'name is required');
    if (this.repoByName(name)) return message(422, 'Repository already exists');
    const repo = this.makeRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
    return jsonOut(201, { name: repo.name, private: repo.priv, default_branch: repo.defaultBranch, description: repo.description });
  }

  private listRepos(query: URLSearchParams, host: string): Outcome {
    const perPage = clamp(Number(query.get('per_page') ?? 30), 1, 100);
    const page = clamp(Number(query.get('page') ?? 1), 1, 10000);
    const ordered = [...this.repos].sort((a, b) => a.id - b.id);
    const start = (page - 1) * perPage;
    const slice = ordered.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    if (start + perPage < ordered.length) {
      const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${next}>; rel="next"`;
    }
    return jsonOut(200, slice.map((repo) => this.repoJson(repo)), headers);
  }

  private repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      private: repo.priv,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: { login: VIEWER },
    };
  }

  private repoRoute(method: string, name: string, rest: string[], query: URLSearchParams, body: Record<string, unknown>): Outcome {
    const repo = this.repoByName(name);
    if (rest.length === 0) {
      if (!repo) return message(404, 'Not Found');
      if (method === 'GET') return jsonOut(200, this.repoJson(repo));
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.priv = body.private;
        return jsonOut(200, this.repoJson(repo));
      }
      if (method === 'DELETE') {
        this.repos = this.repos.filter((item) => item !== repo);
        return emptyOut(204);
      }
    }
    if (!repo) return message(404, 'Not Found');
    if (rest[0] === 'contents') return this.contents(repo, method, rest.slice(1).join('/'), query, body);
    if (rest[0] === 'git' && rest[1] === 'refs') return this.gitRefs(repo, method, rest.slice(2), body);
    if (rest[0] === 'branches') return this.branches(repo, method, rest[1]);
    if (rest[0] === 'commits' && method === 'GET') return this.commits(repo, query);
    if (rest[0] === 'labels' && method === 'POST') return this.makeLabel(repo, body);
    if (rest[0] === 'issues') return this.issues(repo, method, rest.slice(1), query, body);
    if (rest[0] === 'pulls') return this.pulls(repo, method, rest.slice(1), query, body);
    return message(404, 'Not Found');
  }

  private contents(repo: Repo, method: string, filePath: string, query: URLSearchParams, body: Record<string, unknown>): Outcome {
    const branch = typeof body.branch === 'string' ? body.branch : query.get('ref') ?? repo.defaultBranch;
    const resolved = this.resolveRef(repo, query.get('ref') ?? branch);
    if (method === 'GET') {
      if (!resolved) return message(404, 'Not Found');
      const listing = repo.db.listDir(resolved, filePath);
      const file = repo.db.blobAt(resolved, filePath);
      if (file && !filePath.endsWith('/')) {
        return jsonOut(200, {
          type: 'file',
          name: filePath.split('/').pop(),
          path: filePath,
          encoding: 'base64',
          content: file.data.toString('base64'),
          sha: file.oid,
          size: file.data.length,
        });
      }
      if (!listing) return message(404, 'Not Found');
      return jsonOut(200, listing.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: filePath ? `${filePath}/${entry.name}` : entry.name,
        sha: entry.oid,
      })));
    }
    const messageText = typeof body.message === 'string' ? body.message : 'update';
    const target = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    let parent = this.tip(repo, target) ?? null;
    if (!parent && target !== repo.defaultBranch) parent = this.tip(repo, repo.defaultBranch) ?? null;
    if (method === 'DELETE') {
      if (!parent) return message(404, 'Not Found');
      const current = repo.db.blobAt(parent, filePath);
      if (!current) return message(404, 'Not Found');
      if (typeof body.sha === 'string' && body.sha !== current.oid) return message(409, 'sha does not match');
      const files = this.filesOf(repo, parent);
      files.delete(filePath);
      const sha = this.commitFiles(repo, target, parent, files, messageText);
      return jsonOut(200, { commit: { sha } });
    }
    if (method !== 'PUT') return message(404, 'Not Found');
    const encoded = typeof body.content === 'string' ? body.content : '';
    const bytes = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
    const existing = parent ? repo.db.blobAt(parent, filePath) : null;
    if (typeof body.sha === 'string' && (!existing || existing.oid !== body.sha)) return message(409, 'sha does not match');
    const files = this.filesOf(repo, parent);
    const created = !files.has(filePath);
    files.set(filePath, bytes);
    const sha = this.commitFiles(repo, target, parent, files, messageText);
    const blob = hashObject('blob', bytes);
    return jsonOut(created ? 201 : 200, { content: { sha: blob, encoding: 'base64' }, commit: { sha } });
  }

  private resolveRef(repo: Repo, ref: string | null): string | undefined {
    if (!ref) return this.tip(repo, repo.defaultBranch);
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return this.tip(repo, ref);
  }

  private gitRefs(repo: Repo, method: string, rest: string[], body: Record<string, unknown>): Outcome {
    if (method === 'POST' && rest.length === 0) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.db.get(sha)) return message(422, 'Invalid reference');
      if (repo.refs.has(ref)) return message(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      this.forgetPacks(repo);
      return jsonOut(201, { ref, object: { sha, type: repo.db.get(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET') {
      const ref = `refs/${rest.join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return message(404, 'Not Found');
      return jsonOut(200, { ref, object: { sha, type: repo.db.get(sha)?.type ?? 'commit' } });
    }
    return message(404, 'Not Found');
  }

  private branches(repo: Repo, method: string, name: string | undefined): Outcome {
    if (method !== 'GET') return message(404, 'Not Found');
    const list = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
    if (!name) return jsonOut(200, list);
    const found = list.find((branch) => branch.name === name);
    if (!found) return message(404, 'Not Found');
    return jsonOut(200, found);
  }

  private commits(repo: Repo, query: URLSearchParams): Outcome {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const oid = this.resolveRef(repo, ref);
    return jsonOut(200, this.history(repo, oid).map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })));
  }

  private makeLabel(repo: Repo, body: Record<string, unknown>): Outcome {
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) return message(422, 'name is required');
    if (repo.labels.has(name)) return message(422, 'Label already exists');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    repo.labels.set(name, color);
    return jsonOut(201, { name, color });
  }

  private issueJson(issue: Issue): Record<string, unknown> {
    return {
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
    };
  }

  private issues(repo: Repo, method: string, rest: string[], query: URLSearchParams, body: Record<string, unknown>): Outcome {
    if (rest.length === 0 && method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) return message(422, 'title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
      if (labels.some((label) => !repo.labels.has(label))) return message(422, 'Label does not exist');
      const issue: Issue = {
        number: repo.nextIssue++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        seq: repo.issues.length + 1,
      };
      repo.issues.push(issue);
      return jsonOut(201, this.issueJson(issue));
    }
    if (rest.length === 0 && method === 'GET') return jsonOut(200, this.issueList(repo, query).map((issue) => this.issueJson(issue)));
    const number = Number(rest[0]);
    const issue = repo.issues.find((item) => item.number === number);
    if (!issue || !Number.isInteger(number)) return message(404, 'Not Found');
    if (rest.length === 1 && method === 'GET') return jsonOut(200, this.issueJson(issue));
    if (rest.length === 1 && method === 'PATCH') {
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return jsonOut(200, this.issueJson(issue));
    }
    if (rest[1] === 'comments' && method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      const note: Note = { id: repo.nextNote++, issue: issue.number, body: text };
      repo.notes.push(note);
      return jsonOut(201, { id: note.id, body: note.body });
    }
    if (rest[1] === 'comments' && method === 'GET') {
      return jsonOut(200, repo.notes.filter((note) => note.issue === issue.number).map((note) => ({ id: note.id, body: note.body })));
    }
    return message(404, 'Not Found');
  }

  private issueList(repo: Repo, query: URLSearchParams): Issue[] {
    const state = query.get('state') ?? 'open';
    let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const direction = query.get('direction') ?? 'desc';
    items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    const perPage = clamp(Number(query.get('per_page') ?? 30), 1, 100);
    const page = clamp(Number(query.get('page') ?? 1), 1, 10000);
    return items.slice((page - 1) * perPage, page * perPage);
  }

  private pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      merged: pull.merged,
      merged_at: pull.merged ? pull.mergedAt : null,
      merge_commit_sha: pull.merged ? pull.mergeSha : null,
      head: { ref: pull.head, sha: this.tip(repo, pull.head) ?? ZERO_OID },
      base: { ref: pull.base, sha: this.tip(repo, pull.base) ?? ZERO_OID },
    };
  }

  private pulls(repo: Repo, method: string, rest: string[], query: URLSearchParams, body: Record<string, unknown>): Outcome {
    if (rest.length === 0 && method === 'POST') {
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (!this.tip(repo, head) || !this.tip(repo, base)) return message(422, 'Head or base does not exist');
      const pull: Pull = {
        number: repo.nextPull++,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        head,
        base,
        merged: false,
        mergedAt: '',
        mergeSha: '',
      };
      repo.pulls.push(pull);
      return jsonOut(201, this.pullJson(repo, pull));
    }
    if (rest.length === 0 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return jsonOut(200, items.map((pull) => this.pullJson(repo, pull)));
    }
    const number = Number(rest[0]);
    const pull = repo.pulls.find((item) => item.number === number);
    if (!pull || !Number.isInteger(number)) return message(404, 'Not Found');
    if (rest.length === 1 && method === 'GET') return jsonOut(200, this.pullJson(repo, pull));
    if (rest[1] === 'files' && method === 'GET') return jsonOut(200, this.pullFiles(repo, pull));
    if (rest[1] === 'merge' && method === 'PUT') {
      const merged = this.squash(repo, pull);
      if (!merged.ok) return message(merged.status, merged.message);
      return jsonOut(200, { sha: merged.sha, merged: true, message: pull.title });
    }
    return message(404, 'Not Found');
  }

  // -------------------------------------------------------------------------------------------
  // GraphQL
  // -------------------------------------------------------------------------------------------

  private graphql(method: string, req: IncomingMessage, raw: Buffer): Outcome {
    if (method !== 'POST') return message(405, 'Method Not Allowed');
    if (!tokenOk(req)) return message(401, 'Requires authentication');
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      return message(400, 'Problems parsing JSON');
    }
    if (Array.isArray(payload)) return jsonOut(200, payload.map((item) => this.oneQuery(item)));
    return jsonOut(200, this.oneQuery(payload));
  }

  private oneQuery(item: unknown): { data: unknown; errors?: Array<{ message: string }> } {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = record.variables && typeof record.variables === 'object' ? (record.variables as Record<string, unknown>) : {};
    try {
      const doc = parseDocument(query);
      const errors: string[] = [];
      const data = execute(this, doc, variables, errors);
      if (!errors.length) return { data };
      return { data, errors: errors.map((messageText) => ({ message: messageText })) };
    } catch (err) {
      const messageText = err instanceof Error ? err.message : 'GraphQL parse error';
      return { data: null, errors: [{ message: messageText }] };
    }
  }

  // -------------------------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------------------------

  private mcp(method: string, req: IncomingMessage, raw: Buffer): Outcome {
    if (!tokenOk(req)) return message(401, 'Requires authentication');
    if (method !== 'POST') return jsonOut(405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      return jsonOut(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const msg = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (!('id' in msg)) return emptyOut(202);
    const id = msg.id as string | number | null;
    const rpcMethod = typeof msg.method === 'string' ? msg.method : '';
    const params = msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};
    try {
      const result = this.mcpMethod(rpcMethod, params);
      return jsonOut(200, { jsonrpc: '2.0', id, result });
    } catch (err) {
      const coded = err as { code?: number; message?: string };
      return jsonOut(200, { jsonrpc: '2.0', id, error: { code: coded.code ?? -32603, message: coded.message ?? 'error' } });
    }
  }

  private mcpMethod(name: string, params: Record<string, unknown>): unknown {
    if (name === 'server/discover') {
      return {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge', version: '1.0.0' },
      };
    }
    if (name === 'tools/list') return { tools: TOOLS };
    if (name === 'tools/call') return this.mcpCall(params);
    const error = new Error(`Method not found: ${name}`) as Error & { code: number };
    error.code = -32601;
    throw error;
  }

  private mcpCall(params: Record<string, unknown>): unknown {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((item) => item.name === name);
    if (!tool) {
      const error = new Error(`Unknown tool: ${name}`) as Error & { code: number };
      error.code = -32602;
      throw error;
    }
    const required = tool.inputSchema.required;
    const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length) {
      return toolResult(`missing required arguments: ${missing.join(', ')}`, { missing }, true);
    }
    if (name === 'create_repo') {
      const repoName = String(args.name);
      if (this.repoByName(repoName)) return toolResult('Repository already exists', { message: 'Repository already exists' }, true);
      const repo = this.makeRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolResult(`created ${repo.name}`, { name: repo.name, private: repo.priv, default_branch: repo.defaultBranch }, false);
    }
    const owner = typeof args.owner === 'string' ? args.owner : VIEWER;
    const repoName = typeof args.repo === 'string' ? args.repo : '';
    const repo = owner === VIEWER ? this.repoByName(repoName) : undefined;
    if (name === 'get_repo') {
      if (!repo) return toolResult('Not Found', { message: 'Not Found' }, true);
      return toolResult(`${owner}/${repo.name}`, { name: repo.name, owner, default_branch: repo.defaultBranch, private: repo.priv }, false);
    }
    if (!repo) return toolResult('Not Found', { message: 'Not Found' }, true);
    if (name === 'create_issue') {
      const issue: Issue = {
        number: repo.nextIssue++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        seq: repo.issues.length + 1,
      };
      repo.issues.push(issue);
      return toolResult(issue.title, { number: issue.number, title: issue.title, state: 'open' }, false);
    }
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult(JSON.stringify(items.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }))), { issues: items.map((issue) => this.issueJson(issue)) }, false);
    }
    if (name === 'create_pull_request') {
      const head = String(args.head);
      const base = String(args.base);
      if (!this.tip(repo, head) || !this.tip(repo, base)) return toolResult('Head or base does not exist', { message: 'Head or base does not exist' }, true);
      const pull: Pull = {
        number: repo.nextPull++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        head,
        base,
        merged: false,
        mergedAt: '',
        mergeSha: '',
      };
      repo.pulls.push(pull);
      return toolResult(pull.title, { number: pull.number, title: pull.title, head, base, state: 'open' }, false);
    }
    if (name === 'merge_pull_request') {
      const pull = repo.pulls.find((item) => item.number === Number(args.pull_number));
      if (!pull) return toolResult('Not Found', { message: 'Not Found' }, true);
      const merged = this.squash(repo, pull);
      if (!merged.ok) return toolResult(merged.message, { message: merged.message }, true);
      return toolResult(`merged #${pull.number}`, { number: pull.number, merged: true, sha: merged.sha }, false);
    }
    const error = new Error(`Unknown tool: ${name}`) as Error & { code: number };
    error.code = -32602;
    throw error;
  }
}

function toolResult(text: string, structured: unknown, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: structured, isError };
}

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  const value = Array.isArray(header) ? header.join(' ') : (header ?? '');
  return value.includes('version=2');
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const TOOLS = [
  schemaTool('create_repo', 'Create a repository owned by the authenticated user.', { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, ['name']),
  schemaTool('get_repo', 'Read one repository by owner and name.', { owner: { type: 'string' }, repo: { type: 'string' } }, ['owner', 'repo']),
  schemaTool('create_issue', 'Open an issue on a repository.', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, ['owner', 'repo', 'title']),
  schemaTool('list_issues', 'List issues in a repository.', { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, ['owner', 'repo']),
  schemaTool('create_pull_request', 'Open a pull request from head into base.', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, ['owner', 'repo', 'title', 'head', 'base']),
  schemaTool('merge_pull_request', 'Squash-merge a pull request.', { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, ['owner', 'repo', 'pull_number']),
];

function schemaTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] } } {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

// ---------------------------------------------------------------------------------------------
// a small GraphQL reader, enough for the documents the suite sends
// ---------------------------------------------------------------------------------------------

interface Sel {
  kind: 'field' | 'inline';
  alias: string;
  name: string;
  args: Record<string, unknown>;
  on: string;
  selection: Sel[] | null;
  rawArgs: ArgMap;
}

type ArgMap = Record<string, Ast>;
type Ast =
  | { k: 'var'; name: string }
  | { k: 'lit'; value: unknown }
  | { k: 'list'; items: Ast[] }
  | { k: 'obj'; fields: Array<{ name: string; value: Ast }> };

interface Doc {
  selection: Sel[];
}

const SCHEMA: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', 'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login', 'id', 'name']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description']),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files']),
  PullRequestConnection: new Set(['nodes', 'pageInfo']),
  PullRequestFileConnection: new Set(['nodes']),
  PullRequestChangedFile: new Set(['path']),
  PageInfo: new Set(['hasNextPage', 'endCursor']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  CommentEdge: new Set(['node']),
  Comment: new Set(['id', 'body']),
  __Type: new Set(['name', 'fields', 'enumValues', 'kind']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

function execute(forge: Forge, doc: Doc, variables: Record<string, unknown>, errors: string[]): unknown {
  const root = { __typename: 'Query' };
  return project(forge, root, doc.selection, variables, errors);
}

function project(forge: Forge, source: Record<string, unknown> | null, fields: Sel[] | null, variables: Record<string, unknown>, errors: string[]): unknown {
  if (!fields) return source;
  if (Array.isArray(source)) return source.map((item) => project(forge, item as Record<string, unknown>, fields, variables, errors));
  const type = source ? String(source.__typename ?? '') : '';
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'inline') {
      if (source && (!field.on || field.on === type)) {
        const nested = project(forge, source, field.selection, variables, errors);
        if (nested && typeof nested === 'object') Object.assign(out, nested as Record<string, unknown>);
      }
      continue;
    }
    const allowed = SCHEMA[type];
    if (source && allowed && !allowed.has(field.name)) {
      errors.push(`Cannot query field "${field.name}" on type "${type}".`);
      out[field.alias] = null;
      continue;
    }
    if (!source) {
      out[field.alias] = null;
      continue;
    }
    const args = materializeArgs(field.rawArgs, variables);
    const value = resolve(forge, type, source, field.name, args, errors);
    if (value === null || value === undefined) {
      out[field.alias] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[field.alias] = value.map((item) => project(forge, item as Record<string, unknown>, field.selection, variables, errors));
      continue;
    }
    out[field.alias] = project(forge, value as Record<string, unknown>, field.selection, variables, errors);
  }
  return out;
}

function materializeArgs(args: ArgMap, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = materialize(value, variables);
  return out;
}

function materialize(ast: Ast, variables: Record<string, unknown>): unknown {
  if (ast.k === 'var') return variables[ast.name] ?? null;
  if (ast.k === 'lit') return ast.value;
  if (ast.k === 'list') return ast.items.map((item) => materialize(item, variables));
  const obj: Record<string, unknown> = {};
  for (const field of ast.fields) obj[field.name] = materialize(field.value, variables);
  return obj;
}

function resolve(forge: Forge, type: string, source: Record<string, unknown>, name: string, args: Record<string, unknown>, errors: string[]): unknown {
  if (type === 'Query') return resolveRoot(forge, name, args, errors);
  if (type === 'Repository') return resolveRepo(forge, source, name, args);
  if (type === '__Type') return resolveType(source, name, args);
  if (name === 'nodes' || name === 'fields' || name === 'enumValues') return source[name];
  return source[name] ?? null;
}

function resolveRoot(forge: Forge, name: string, args: Record<string, unknown>, errors: string[]): unknown {
  if (name === 'viewer') return { __typename: 'User', login: VIEWER, id: '1000', name: 'ada iversen' };
  if (name === 'repository') return repositoryNode(forge, args.owner, args.name);
  if (name === 'node') return nodeById(forge, args.id);
  if (name === '__type') return typeNode(args.name);
  if (name === 'createIssue') return mutateIssue(forge, args.input, errors);
  if (name === 'closeIssue') return mutateClose(forge, args.input, errors);
  if (name === 'createPullRequest') return mutatePull(forge, args.input, errors);
  if (name === 'mergePullRequest') return mutateMerge(forge, args.input, errors);
  if (name === 'addComment') return mutateComment(forge, args.input, errors);
  return null;
}

function repositoryNode(forge: Forge, owner: unknown, name: unknown): Record<string, unknown> | null {
  if (owner !== VIEWER || typeof name !== 'string') return null;
  const repo = forge['repoByName'](name);
  if (!repo) return null;
  return repoNode(repo);
}

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: gid('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${VIEWER}/${repo.name}`,
    owner: { __typename: 'User', login: VIEWER, id: '1000' },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    __repo: repo,
  };
}

function nodeById(forge: Forge, id: unknown): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const parsed = ungid(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const repo = forge['repos'].find((item) => String(item.id) === parsed.rest);
  return repo ? repoNode(repo) : null;
}

function typeNode(name: unknown): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'].map((item) => ({ __typename: '__EnumValue', name: item })) };
  }
  const fields = TYPE_FIELDS[String(name)];
  if (!fields) return null;
  return { __typename: '__Type', name: String(name), kind: 'OBJECT', fields: fields.map((item) => ({ __typename: '__Field', name: item })), enumValues: [] };
}

function resolveType(source: Record<string, unknown>, name: string, _args: Record<string, unknown>): unknown {
  if (name === 'fields') return source.fields;
  if (name === 'enumValues') return source.enumValues;
  return source[name] ?? null;
}

function resolveRepo(forge: Forge, source: Record<string, unknown>, name: string, args: Record<string, unknown>): unknown {
  const repo = source.__repo as Repo;
  if (name === 'issue') {
    const issue = repo.issues.find((item) => item.number === Number(args.number));
    return issue ? issueNode(repo, issue) : null;
  }
  if (name === 'issues') return issueConnection(repo, args);
  if (name === 'pullRequest') {
    const pull = repo.pulls.find((item) => item.number === Number(args.number));
    return pull ? pullNode(forge, repo, pull) : null;
  }
  if (name === 'pullRequests') return pullConnection(forge, repo, args);
  return source[name] ?? null;
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: gid('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  let items = repo.issues.filter((issue) => {
    if (!states) return true;
    const label = issue.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(label);
  });
  const order = args.orderBy && typeof args.orderBy === 'object' ? (args.orderBy as Record<string, unknown>).direction : 'DESC';
  items = [...items].sort((a, b) => (order === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const first = clamp(Number(args.first ?? items.length), 0, 100);
  const after = typeof args.after === 'string' ? Number(Buffer.from(args.after, 'base64url').toString('utf8')) : 0;
  const start = Number.isInteger(after) && after > 0 ? after : 0;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  return {
    __typename: 'IssueConnection',
    nodes: slice.map((issue) => issueNode(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor: hasNextPage ? Buffer.from(String(start + slice.length), 'utf8').toString('base64url') : null },
  };
}

function pullNode(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = forge['tip'](repo, pull.base);
  const head = forge['tip'](repo, pull.head);
  const mergeable = base && head && forge['mergedFiles'](repo, base, head) ? 'MERGEABLE' : 'CONFLICTING';
  const files = forge['pullFiles'](repo, pull).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }));
  return {
    __typename: 'PullRequest',
    id: gid('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pull.state === 'open' ? mergeable : 'UNKNOWN',
    merged: pull.merged,
    files: { __typename: 'PullRequestFileConnection', nodes: files },
  };
}

function pullConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const first = clamp(Number(args.first ?? 30), 0, 100);
  const items = repo.pulls.filter((pull) => pull.state === 'open').slice(0, first);
  return { __typename: 'PullRequestConnection', nodes: items.map((pull) => pullNode(forge, repo, pull)), pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null } };
}

function inputOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function findRepoId(forge: Forge, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const parsed = ungid(id);
  if (!parsed || parsed.kind !== 'Repository') return undefined;
  return forge['repos'].find((repo) => String(repo.id) === parsed.rest);
}

function mutateIssue(forge: Forge, input: unknown, errors: string[]): Record<string, unknown> | null {
  const data = inputOf(input);
  const repo = findRepoId(forge, data.repositoryId);
  if (!repo || typeof data.title !== 'string') {
    errors.push('createIssue could not find the repository');
    return null;
  }
  const issue: Issue = {
    number: repo.nextIssue++,
    title: data.title,
    body: typeof data.body === 'string' ? data.body : '',
    state: 'open',
    labels: [],
    seq: repo.issues.length + 1,
  };
  repo.issues.push(issue);
  return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
}

function mutateClose(forge: Forge, input: unknown, errors: string[]): Record<string, unknown> | null {
  const data = inputOf(input);
  const found = findIssue(forge, data.issueId);
  if (!found) {
    errors.push('closeIssue could not find the issue');
    return null;
  }
  found.issue.state = 'closed';
  return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
}

function findIssue(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = ungid(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.rest.split(':');
  const repo = forge['repos'].find((item) => String(item.id) === repoId);
  const issue = repo?.issues.find((item) => String(item.number) === number);
  if (!repo || !issue) return null;
  return { repo, issue };
}

function mutatePull(forge: Forge, input: unknown, errors: string[]): Record<string, unknown> | null {
  const data = inputOf(input);
  const repo = findRepoId(forge, data.repositoryId);
  const head = typeof data.headRefName === 'string' ? data.headRefName : '';
  const base = typeof data.baseRefName === 'string' ? data.baseRefName : '';
  if (!repo || !forge['tip'](repo, head) || !forge['tip'](repo, base)) {
    errors.push('createPullRequest could not find the branches');
    return null;
  }
  const pull: Pull = {
    number: repo.nextPull++,
    title: typeof data.title === 'string' ? data.title : '',
    body: typeof data.body === 'string' ? data.body : '',
    state: 'open',
    head,
    base,
    merged: false,
    mergedAt: '',
    mergeSha: '',
  };
  repo.pulls.push(pull);
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(forge, repo, pull) };
}

function mutateMerge(forge: Forge, input: unknown, errors: string[]): Record<string, unknown> | null {
  const data = inputOf(input);
  const found = findPull(forge, data.pullRequestId);
  if (!found) {
    errors.push('mergePullRequest could not find the pull request');
    return null;
  }
  const merged = forge['squash'](found.repo, found.pull);
  if (!merged.ok) {
    errors.push(merged.message);
    return null;
  }
  return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(forge, found.repo, found.pull) };
}

function findPull(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = ungid(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.rest.split(':');
  const repo = forge['repos'].find((item) => String(item.id) === repoId);
  const pull = repo?.pulls.find((item) => String(item.number) === number);
  if (!repo || !pull) return null;
  return { repo, pull };
}

function mutateComment(forge: Forge, input: unknown, errors: string[]): Record<string, unknown> | null {
  const data = inputOf(input);
  const found = findIssue(forge, data.subjectId);
  if (!found) {
    errors.push('addComment could not find the subject');
    return null;
  }
  const text = typeof data.body === 'string' ? data.body : '';
  const note: Note = { id: found.repo.nextNote++, issue: found.issue.number, body: text };
  found.repo.notes.push(note);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: gid('Comment', `${found.repo.id}:${note.id}`), body: note.body } },
  };
}

class Reader {
  private i = 0;
  private s: string;
  constructor(source: string) {
    this.s = source;
  }
  peek(): string {
    this.skip();
    return this.s[this.i] ?? '';
  }
  private skip(): void {
    for (;;) {
      while (/\s/.test(this.s[this.i] ?? '')) this.i += 1;
      if (this.s[this.i] === '#') {
        while (this.s[this.i] && this.s[this.i] !== '\n') this.i += 1;
        continue;
      }
      if (this.s[this.i] === ',') {
        this.i += 1;
        continue;
      }
      return;
    }
  }
  take(word: string): boolean {
    this.skip();
    if (this.s.startsWith(word, this.i) && !/[A-Za-z0-9_]/.test(this.s[this.i + word.length] ?? '')) {
      this.i += word.length;
      return true;
    }
    return false;
  }
  punct(ch: string): boolean {
    if (this.peek() !== ch) return false;
    this.i += 1;
    return true;
  }
  name(): string {
    this.skip();
    const start = this.i;
    if (!/[A-Za-z_]/.test(this.s[this.i] ?? '')) throw new Error('expected a name');
    while (/[A-Za-z0-9_]/.test(this.s[this.i] ?? '')) this.i += 1;
    return this.s.slice(start, this.i);
  }
  number(): number {
    this.skip();
    let text = '';
    if (this.s[this.i] === '-') {
      text = '-';
      this.i += 1;
    }
    if (!/[0-9]/.test(this.s[this.i] ?? '')) throw new Error('expected a number');
    while (/[0-9]/.test(this.s[this.i] ?? '')) {
      text += this.s[this.i];
      this.i += 1;
    }
    return Number(text);
  }
  string(): string {
    this.skip();
    if (this.s[this.i] !== '"') throw new Error('expected a string');
    this.i += 1;
    let out = '';
    while (this.s[this.i] && this.s[this.i] !== '"') {
      if (this.s[this.i] === '\\') {
        this.i += 1;
        out += this.s[this.i] ?? '';
      } else out += this.s[this.i];
      this.i += 1;
    }
    this.i += 1;
    return out;
  }
}

function parseDocument(source: string): Doc {
  const reader = new Reader(source);
  if (reader.take('query') || reader.take('mutation') || reader.take('subscription')) {
    if (/[A-Za-z_]/.test(reader.peek())) reader.name();
    if (reader.punct('(')) skipVars(reader);
  }
  return { selection: parseSelection(reader) };
}

function skipVars(reader: Reader): void {
  while (!reader.punct(')')) {
    if (!reader.punct('$')) throw new Error('expected a variable');
    reader.name();
    if (!reader.punct(':')) throw new Error('expected a type');
    skipType(reader);
  }
}

function skipType(reader: Reader): void {
  if (reader.punct('[')) {
    skipType(reader);
    if (!reader.punct(']')) throw new Error('expected ]');
  } else reader.name();
  reader.punct('!');
}

function parseSelection(reader: Reader): Sel[] {
  if (!reader.punct('{')) throw new Error('expected a selection set');
  const fields: Sel[] = [];
  while (!reader.punct('}')) fields.push(parseSel(reader));
  return fields;
}

function parseSel(reader: Reader): Sel {
  if (reader.take('...')) {
    if (!reader.take('on')) throw new Error('expected an inline fragment');
    const on = reader.name();
    return { kind: 'inline', alias: '', name: '', args: {}, on, selection: parseSelection(reader), rawArgs: {} };
  }
  let name = reader.name();
  let alias = name;
  if (reader.punct(':')) {
    alias = name;
    name = reader.name();
  }
  const rawArgs = reader.punct('(') ? parseArgs(reader) : {};
  const selection = reader.peek() === '{' ? parseSelection(reader) : null;
  return { kind: 'field', alias, name, args: {}, on: '', selection, rawArgs };
}

function parseArgs(reader: Reader): ArgMap {
  const args: ArgMap = {};
  while (!reader.punct(')')) {
    const name = reader.name();
    if (!reader.punct(':')) throw new Error('expected :');
    args[name] = parseValue(reader);
  }
  return args;
}

function parseValue(reader: Reader): Ast {
  const ch = reader.peek();
  if (ch === '$') {
    reader.punct('$');
    return { k: 'var', name: reader.name() };
  }
  if (ch === '"') return { k: 'lit', value: reader.string() };
  if (ch === '[') {
    reader.punct('[');
    const items: Ast[] = [];
    while (!reader.punct(']')) items.push(parseValue(reader));
    return { k: 'list', items };
  }
  if (ch === '{') {
    reader.punct('{');
    const fields: Array<{ name: string; value: Ast }> = [];
    while (!reader.punct('}')) {
      const name = reader.name();
      if (!reader.punct(':')) throw new Error('expected :');
      fields.push({ name, value: parseValue(reader) });
    }
    return { k: 'obj', fields };
  }
  if (ch === '-' || /[0-9]/.test(ch)) return { k: 'lit', value: reader.number() };
  const word = reader.name();
  if (word === 'true') return { k: 'lit', value: true };
  if (word === 'false') return { k: 'lit', value: false };
  if (word === 'null') return { k: 'lit', value: null };
  return { k: 'lit', value: word };
}
