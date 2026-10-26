/**
 * Offline migration of a Pi session file from `pi-subagent:registry:v1` snapshots to
 * `pi-subagent:registry:v2` incremental records. See docs/registry-migration.md.
 *
 * The tool never modifies its input and never replaces an existing file. It writes a new
 * output file (mode 0600) that is fully re-read and verified before it is published.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  REGISTRY_V1,
  REGISTRY_V2,
  applyRegistry,
  diffRegistry,
  type RegistryState,
} from "../src/orch/registry.ts";

const REGISTRY_PREFIX = "pi-subagent:registry:";
const READ_CHUNK = 1 << 20;
const FLUSH_BYTES = 4 << 20;
const STATE_CACHE = 4;

export class MigrationError extends Error {}

export interface MigrationStats {
  lines: number;
  entries: number;
  registryEntries: number;
  bases: number;
  patches: number;
  emptyPatches: number;
  inputBytes: number;
  outputBytes: number;
}

interface Line {
  offset: number;
  bytes: Buffer;
  newline: boolean;
}

/** Split a file into lines by byte; memory is O(longest line). Lines keep exact bytes. */
function* readLines(fd: number): Generator<Line> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  let pending: Buffer[] = [];
  let lineOffset = 0;
  let position = 0;
  for (;;) {
    const count = readSync(fd, chunk, 0, chunk.length, position);
    if (count === 0) break;
    const base = position;
    position += count;
    const view = chunk.subarray(0, count);
    let start = 0;
    for (;;) {
      const newline = view.indexOf(10, start);
      if (newline < 0) break;
      const piece = view.subarray(start, newline);
      const bytes = pending.length ? Buffer.concat([...pending, piece]) : Buffer.from(piece);
      pending = [];
      yield { offset: lineOffset, bytes, newline: true };
      lineOffset = base + newline + 1;
      start = newline + 1;
    }
    if (start < count) pending.push(Buffer.from(view.subarray(start)));
  }
  if (pending.length) yield { offset: lineOffset, bytes: Buffer.concat(pending), newline: false };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseLine = (bytes: Buffer): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface RegInfo {
  line: number;
  id: string;
  parentId: string | null;
  offset: number;
  length: number;
  customType: string;
}

interface Index {
  lines: number;
  parents: Map<string, string | null>;
  registries: Map<number, RegInfo>;
  byId: Map<string, RegInfo>;
  memo: Map<string, RegInfo | null>;
}

/** Pass 1: tree shape and the byte range of every registry entry. */
function buildIndex(fd: number, allowed: string, label: string): Index {
  const index: Index = {
    lines: 0,
    parents: new Map(),
    registries: new Map(),
    byId: new Map(),
    memo: new Map(),
  };
  for (const line of readLines(fd)) {
    const lineNo = index.lines++;
    const entry = parseLine(line.bytes);
    if (!entry || typeof entry.id !== "string") continue; // Pi skips these; we copy them raw.
    if (index.parents.has(entry.id))
      throw new MigrationError(`${label}: duplicate entry id at line ${lineNo + 1}`);
    const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
    index.parents.set(entry.id, parentId);
    const customType = entry.customType;
    if (
      entry.type !== "custom" ||
      typeof customType !== "string" ||
      !customType.startsWith(REGISTRY_PREFIX)
    )
      continue;
    if (customType !== allowed)
      throw new MigrationError(
        `${label}: unsupported registry entry type ${customType} at line ${lineNo + 1} (expected ${allowed})`,
      );
    if (entry.parentId !== null && typeof entry.parentId !== "string")
      throw new MigrationError(`${label}: invalid parentId at line ${lineNo + 1}`);
    const info: RegInfo = {
      line: lineNo,
      id: entry.id,
      parentId,
      offset: line.offset,
      length: line.bytes.length,
      customType,
    };
    index.registries.set(lineNo, info);
    index.byId.set(info.id, info);
  }
  assertAcyclic(index, label);
  return index;
}

/** Reject any cycle in the whole parent graph (including self-parents); O(entries). */
function assertAcyclic(index: Index, label: string): void {
  const done = new Set<string>();
  for (const start of index.parents.keys()) {
    if (done.has(start)) continue;
    const walking = new Set<string>();
    let current: string | null | undefined = start;
    while (current != null && index.parents.has(current) && !done.has(current)) {
      if (walking.has(current)) throw new MigrationError(`${label}: cycle in parentId graph`);
      walking.add(current);
      current = index.parents.get(current);
    }
    for (const id of walking) done.add(id);
  }
}

/** Nearest registry entry on the parentId chain strictly above `startId` (Pi's getBranch order). */
function nearestRegistry(index: Index, startId: string | null): RegInfo | undefined {
  const path: string[] = [];
  let found: RegInfo | null = null;
  let current = startId;
  while (current !== null) {
    const memo = index.memo.get(current);
    if (memo !== undefined) {
      found = memo;
      break;
    }
    const registry = index.byId.get(current);
    if (registry) {
      found = registry;
      break;
    }
    if (!index.parents.has(current)) break; // Unknown parent ends the branch, as in Pi.
    if (path.length > index.parents.size) throw new MigrationError("cycle in parentId chain");
    path.push(current);
    current = index.parents.get(current) ?? null;
  }
  for (const id of path) index.memo.set(id, found);
  return found ?? undefined;
}

function readExact(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const count = readSync(fd, buffer, done, length - done, offset + done);
    if (count === 0) throw new MigrationError("unexpected end of file while re-reading an entry");
    done += count;
  }
  return buffer;
}

/** Reconstructs registry state at an entry by folding its ancestor chain, with a tiny cache. */
class StateResolver {
  private cache = new Map<string, RegistryState>();
  /** Number of applyRegistry calls made; lets tests assert linear cost. */
  applied = 0;
  constructor(
    private fd: number,
    private index: Index,
    private label: string,
  ) {}

  entry(info: RegInfo): Record<string, unknown> {
    const entry = parseLine(readExact(this.fd, info.offset, info.length));
    if (!entry || entry.id !== info.id)
      throw new MigrationError(`${this.label}: entry ${info.id} changed between passes`);
    return entry;
  }

  stateAt(info: RegInfo): RegistryState {
    const hit = this.cache.get(info.id);
    if (hit) return hit;
    const chain: RegInfo[] = [];
    let base: RegistryState | undefined;
    let current: RegInfo | undefined = info;
    while (current) {
      const cached = this.cache.get(current.id);
      if (cached) {
        base = cached;
        break;
      }
      chain.push(current);
      if (chain.length > this.index.registries.size)
        throw new MigrationError(`${this.label}: registry ancestor chain loops`);
      if (current.customType === REGISTRY_V1) break; // A v1 snapshot is a baseline by itself.
      current = nearestRegistry(this.index, current.parentId);
    }
    let state = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const item = chain[i]!;
      const entry = this.entry(item);
      state = normalize(applyRegistry(state, item.customType, entry.data));
      this.applied++;
      this.remember(item.id, state);
    }
    return state!;
  }

  remember(id: string, state: RegistryState): void {
    this.cache.delete(id);
    this.cache.set(id, state);
    while (this.cache.size > STATE_CACHE) this.cache.delete(this.cache.keys().next().value!);
  }
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

const snapshot = (fd: number, path?: string): FileSnapshot => {
  const stat = fstatSync(fd);
  if (path !== undefined) {
    const named = statSync(path);
    if (named.dev !== stat.dev || named.ino !== stat.ino)
      throw new MigrationError("input path no longer refers to the opened file");
  }
  if (!stat.isFile()) throw new MigrationError("input is not a regular file");
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
};

const assertUnchanged = (fd: number, before: FileSnapshot, path?: string) => {
  if (!isDeepStrictEqual(snapshot(fd, path), before))
    throw new MigrationError(
      "input changed while migrating (inode, size or mtime differ); stop Pi and retry",
    );
};

class Writer {
  private chunks: Buffer[] = [];
  private pending = 0;
  written = 0;
  constructor(private fd: number) {}
  write(buffer: Buffer): void {
    this.chunks.push(buffer);
    this.pending += buffer.length;
    if (this.pending >= FLUSH_BYTES) this.flush();
  }
  flush(): void {
    if (!this.pending) return;
    const data = Buffer.concat(this.chunks);
    this.chunks = [];
    this.pending = 0;
    let done = 0;
    while (done < data.length) done += writeSync(this.fd, data, done, data.length - done);
    this.written += data.length;
  }
}

/** Pass 2: convert each registry entry relative to its nearest ancestor registry. */
function convert(
  inputFd: number,
  readFd: number,
  writer: Writer,
  index: Index,
): Omit<MigrationStats, "inputBytes" | "outputBytes"> {
  const stats = {
    lines: index.lines,
    entries: index.parents.size,
    registryEntries: index.registries.size,
    bases: 0,
    patches: 0,
    emptyPatches: 0,
  };
  const resolver = new StateResolver(readFd, index, "input");
  let lineNo = 0;
  for (const line of readLines(inputFd)) {
    const info = index.registries.get(lineNo++);
    const suffix = line.newline ? "\n" : "";
    if (!info) {
      writer.write(line.newline ? Buffer.concat([line.bytes, Buffer.from("\n")]) : line.bytes);
      continue;
    }
    const entry = parseLine(line.bytes);
    if (!entry || entry.id !== info.id)
      throw new MigrationError(`input changed between passes at line ${info.line + 1}`);
    const ancestor = nearestRegistry(index, info.parentId);
    const previous = ancestor ? resolver.stateAt(ancestor) : undefined;
    let next: RegistryState;
    try {
      next = resolver.stateAt(info);
    } catch (error) {
      throw new MigrationError(`invalid registry at line ${info.line + 1}: ${String(error)}`);
    }
    const diff = diffRegistry(previous, next);
    const data = normalize(
      diff ?? {
        version: 2 as const,
        rootSessionId: next.rootSessionId,
        op: "patch" as const,
        ops: [],
      },
    );
    const rebuilt = normalize(applyRegistry(previous, REGISTRY_V2, data));
    if (!isDeepStrictEqual(rebuilt, next))
      throw new MigrationError(
        `v2 record does not reproduce the v1 state at line ${info.line + 1}`,
      );
    if (data.op === "base") stats.bases++;
    else {
      stats.patches++;
      if (data.ops.length === 0) stats.emptyPatches++;
    }
    entry.customType = REGISTRY_V2;
    entry.data = data;
    const cr = line.bytes[line.bytes.length - 1] === 13 ? "\r" : "";
    writer.write(Buffer.from(JSON.stringify(entry) + cr + suffix));
  }
  return stats;
}

const sameMap = <K, V>(a: Map<K, V>, b: Map<K, V>) =>
  a.size === b.size &&
  [...a].every(([key, value]) => b.has(key) && isDeepStrictEqual(b.get(key), value));

/**
 * Independent verification: re-read both files, compare tree shape, non-registry bytes, every
 * non-payload field of every registry entry, and the registry state at every node.
 */
export function verifyFiles(inputPath: string, outputPath: string): { applies: number } {
  const inFd = openSync(inputPath, "r");
  const inReadFd = openSync(inputPath, "r");
  const outFd = openSync(outputPath, "r");
  try {
    const before = snapshot(inFd, inputPath);
    const inIndex = buildIndex(inFd, REGISTRY_V1, "input");
    const outIndex = buildIndex(outFd, REGISTRY_V2, "output");
    if (inIndex.lines !== outIndex.lines) throw new MigrationError("verify: line count differs");
    if (!sameMap(inIndex.parents, outIndex.parents))
      throw new MigrationError("verify: entry ids or parentId tree differ");
    const inRegs = [...inIndex.registries.keys()];
    const outRegs = [...outIndex.registries.keys()];
    if (!isDeepStrictEqual(inRegs, outRegs))
      throw new MigrationError("verify: registry lines differ");
    const inStates = new StateResolver(inReadFd, inIndex, "input");
    let applies = 0;
    const outLines = readLines(outFd);
    let lineNo = 0;
    for (const inLine of readLines(inFd)) {
      const outLine = outLines.next();
      if (outLine.done) throw new MigrationError("verify: output ended early");
      const out = outLine.value;
      const inInfo = inIndex.registries.get(lineNo);
      const outInfo = outIndex.registries.get(lineNo);
      lineNo++;
      if (inLine.newline !== out.newline)
        throw new MigrationError(`verify: line ${lineNo} newline differs`);
      if (!inInfo || !outInfo) {
        if (inInfo || outInfo || !inLine.bytes.equals(out.bytes))
          throw new MigrationError(`verify: line ${lineNo} is not byte-identical`);
        continue;
      }
      const a = parseLine(inLine.bytes);
      const b = parseLine(out.bytes);
      if (!a || !b) throw new MigrationError(`verify: line ${lineNo} unreadable`);
      const { customType: ac, data: _ad, ...restA } = a;
      const { customType: bc, data: _bd, ...restB } = b;
      void _ad;
      void _bd;
      if (ac !== REGISTRY_V1 || bc !== REGISTRY_V2)
        throw new MigrationError(`verify: line ${lineNo} has unexpected registry types`);
      if (!isDeepStrictEqual(Object.keys(a), Object.keys(b)) || !isDeepStrictEqual(restA, restB))
        throw new MigrationError(`verify: line ${lineNo} envelope fields differ`);
      // Each output record is applied once, to the true state of its nearest ancestor (taken
      // from the v1 input). If every edge reproduces the v1 state, folding any branch does too.
      const inAncestor = nearestRegistry(inIndex, inInfo.parentId);
      if (inAncestor?.id !== nearestRegistry(outIndex, outInfo.parentId)?.id)
        throw new MigrationError(`verify: registry ancestor differs at line ${lineNo}`);
      let rebuilt: RegistryState;
      try {
        rebuilt = normalize(
          applyRegistry(inAncestor ? inStates.stateAt(inAncestor) : undefined, REGISTRY_V2, b.data),
        );
      } catch (error) {
        throw new MigrationError(
          `verify: unreadable v2 record at line ${lineNo}: ${String(error)}`,
        );
      }
      applies++;
      if (!isDeepStrictEqual(inStates.stateAt(inInfo), rebuilt))
        throw new MigrationError(`verify: registry state differs at line ${lineNo}`);
    }
    if (!outLines.next().done) throw new MigrationError("verify: output has extra lines");
    assertUnchanged(inFd, before, inputPath);
    return { applies: applies + inStates.applied };
  } finally {
    for (const fd of [inFd, inReadFd, outFd]) closeSync(fd);
  }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* Directory fsync is best effort on filesystems that do not support it. */
  }
}

/** Create `outputPath` as a verified v2 copy of `inputPath`. Existing outputs are never touched. */
export function migrateRegistry(options: { input: string; output: string }): MigrationStats {
  const inputPath = resolve(options.input);
  const outputPath = resolve(options.output);
  const outDir = dirname(outputPath);
  if (exists(outputPath)) throw new MigrationError(`output already exists: ${outputPath}`);
  if (!statSync(outDir).isDirectory())
    throw new MigrationError(`output directory missing: ${outDir}`);
  if (join(realpathSync(outDir), basename(outputPath)) === realpathSync(inputPath))
    throw new MigrationError("output must differ from input");

  const temp = join(
    outDir,
    `.${basename(outputPath)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const inFd = openSync(inputPath, "r");
  const readFd = openSync(inputPath, "r");
  let outFd: number | undefined;
  try {
    const before = snapshot(inFd, inputPath);
    outFd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const outStat = fstatSync(outFd);
    if (outStat.dev === before.dev && outStat.ino === before.ino)
      throw new MigrationError("output is the same file as input");
    const index = buildIndex(inFd, REGISTRY_V1, "input");
    assertUnchanged(inFd, before, inputPath);
    const writer = new Writer(outFd);
    const counts = convert(inFd, readFd, writer, index);
    writer.flush();
    fsyncSync(outFd);
    closeSync(outFd);
    outFd = undefined;
    assertUnchanged(inFd, before, inputPath);
    verifyFiles(inputPath, temp);
    assertUnchanged(inFd, before, inputPath);
    linkSync(temp, outputPath); // Fails if the output appeared meanwhile; never overwrites.
    fsyncDirectory(outDir);
    return { ...counts, inputBytes: before.size, outputBytes: writer.written };
  } finally {
    if (outFd !== undefined) closeSync(outFd);
    closeSync(inFd);
    closeSync(readFd);
    try {
      unlinkSync(temp);
    } catch {
      /* The temp file may not exist yet. */
    }
  }
}

function main(argv: string[]): number {
  const args = new Map<string, string>();
  let verifyOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--verify-only") verifyOnly = true;
    else if ((arg === "--input" || arg === "--output") && argv[i + 1] !== undefined)
      args.set(arg, argv[++i]!);
    else {
      console.error(`unknown or incomplete argument: ${arg}`);
      return 2;
    }
  }
  const input = args.get("--input");
  const output = args.get("--output");
  if (!input || !output) {
    console.error(
      "usage: migrate-registry.ts --input <session.jsonl> --output <new.jsonl> [--verify-only]\n" +
        "Stop Pi first: the input must not be written during the run (checked by stat, not locked).\n" +
        "--verify-only compares an existing output with the input and writes nothing.",
    );
    return 2;
  }
  try {
    if (verifyOnly) {
      verifyFiles(resolve(input), resolve(output));
      console.log("verified");
    } else console.log(JSON.stringify(migrateRegistry({ input, output }), null, 2));
    return 0;
  } catch (error) {
    console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
