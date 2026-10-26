import type { SavedThread, SavedThreadView } from "../types.ts";

/**
 * Durable subagent registry codec (see docs/registry-persistence.md).
 *
 * v1 stores a full snapshot of every thread per entry. v2 stores one `base` snapshot and
 * then typed per-thread patches. State is always rebuilt from the *current session branch*
 * (parentId chain), never from file order.
 *
 * Every function here is pure and fail-closed: malformed, unknown-version or baseline-less
 * input throws instead of being interpreted as an empty registry.
 */
export const REGISTRY_V1 = "pi-subagent:registry:v1";
export const REGISTRY_V2 = "pi-subagent:registry:v2";
const REGISTRY_PREFIX = "pi-subagent:registry:";

export interface RegistryState {
  rootSessionId: string;
  threads: SavedThread[];
}

export type RegistryOp =
  /** A new thread (full SavedThread). Its path must not exist. */
  | { kind: "insert"; thread: SavedThread }
  /** Removes a thread (reap, or the first half of a definition replacement). */
  | { kind: "remove"; path: string }
  /** Sets allowlisted view keys. `null` is a value; absence is expressed by `unset`. */
  | { kind: "set"; path: string; view: Record<string, unknown> }
  | { kind: "unset"; path: string; keys: string[] }
  | { kind: "setInherited"; path: string; value: unknown[] }
  | { kind: "unsetInherited"; path: string };

export type RegistryV2Data =
  | { version: 2; rootSessionId: string; op: "base"; threads: SavedThread[] }
  | { version: 2; rootSessionId: string; op: "patch"; ops: RegistryOp[] };

const STATES = ["starting", "running", "paused", "completed", "failed", "stopped"];
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const nullableString = (value: unknown) => value === null || isString(value);
/** Allowlist of durable view keys with their value check. Anything else is rejected. */
const VIEW_KEYS: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  ["path", isString],
  ["parent", nullableString],
  ["owner", isString],
  ["type", isString],
  ["color", isString],
  ["icon", isString],
  ["model", isString],
  ["thinkingLevel", isString],
  ["state", (value) => isString(value) && STATES.includes(value)],
  ["task", isString],
  ["status", isString],
  ["output", isString],
  ["error", isString],
  ["createdAt", isNumber],
  ["sessionFile", isString],
  ["sessionLeafId", nullableString],
  ["elapsedMs", isNumber],
  ["lastStartedAt", isNumber],
  ["inputTokens", isNumber],
  ["outputTokens", isNumber],
  ["costUsd", isNumber],
  ["costId", isString],
]);
const REQUIRED_KEYS = [
  "path",
  "parent",
  "owner",
  "type",
  "state",
  "task",
  "status",
  "createdAt",
] as const;
const REQUIRED = new Set<string>(REQUIRED_KEYS);

const fail = (message: string): never => {
  throw new Error(`Invalid subagent registry: ${message}`);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Structural equality over JSON values; an `undefined` object member equals a missing one. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of Object.keys(left))
    if (left[key] !== undefined && !jsonEqual(left[key], right[key])) return false;
  for (const key of Object.keys(right))
    if (right[key] !== undefined && left[key] === undefined) return false;
  return true;
}

function checkViewValue(key: string, value: unknown): void {
  const check = VIEW_KEYS.get(key);
  if (!check) fail(`unknown view key ${JSON.stringify(key)}`);
  if (!check!(value)) fail(`bad value for view key ${JSON.stringify(key)}`);
}

/** Validates and deep-copies one thread. The result shares nothing with `raw`. */
function parseThread(raw: unknown): SavedThread {
  if (!isObject(raw) || !isObject(raw.view) || !isObject(raw.definition))
    return fail("thread must have view and definition objects");
  for (const key of Object.keys(raw))
    if (key !== "view" && key !== "definition" && key !== "inherited")
      fail(`unknown thread key ${JSON.stringify(key)}`);
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.view)) {
    if (value === undefined) continue;
    checkViewValue(key, value);
    view[key] = value;
  }
  for (const key of REQUIRED) if (!hasOwn(view, key)) fail(`thread view lacks ${key}`);
  if (!isString(raw.definition.name)) fail("definition lacks a name");
  const thread: Record<string, unknown> = {
    view,
    definition: jsonClone(raw.definition),
  };
  if (raw.inherited !== undefined) {
    if (!Array.isArray(raw.inherited)) fail("inherited must be an array");
    thread.inherited = jsonClone(raw.inherited);
  }
  return thread as unknown as SavedThread;
}

function parseThreads(raw: unknown): SavedThread[] {
  if (!Array.isArray(raw)) return fail("threads must be an array");
  const seen = new Set<string>();
  return raw.map((item) => {
    const thread = parseThread(item);
    if (seen.has(thread.view.path)) fail(`duplicate thread ${thread.view.path}`);
    seen.add(thread.view.path);
    return thread;
  });
}

function parseOp(raw: unknown): RegistryOp {
  if (!isObject(raw) || !isString(raw.kind) || !isString(raw.path ?? "")) return fail("bad op");
  const keysOf = (allowed: string[]) => {
    for (const key of Object.keys(raw))
      if (!allowed.includes(key)) fail(`unknown field ${JSON.stringify(key)} in ${raw.kind} op`);
  };
  switch (raw.kind) {
    case "insert":
      keysOf(["kind", "thread"]);
      return { kind: "insert", thread: parseThread(raw.thread) };
    case "remove":
    case "unsetInherited":
      keysOf(["kind", "path"]);
      if (!isString(raw.path)) return fail("op lacks path");
      return { kind: raw.kind, path: raw.path };
    case "set": {
      keysOf(["kind", "path", "view"]);
      if (!isString(raw.path) || !isObject(raw.view)) return fail("bad set op");
      const view: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw.view)) {
        if (key === "path") fail("path is the thread identity and cannot be set");
        checkViewValue(key, value);
        view[key] = value;
      }
      return { kind: "set", path: raw.path, view };
    }
    case "unset": {
      keysOf(["kind", "path", "keys"]);
      if (!isString(raw.path) || !Array.isArray(raw.keys)) return fail("bad unset op");
      for (const key of raw.keys) {
        if (!isString(key) || !VIEW_KEYS.has(key)) fail("unknown view key in unset");
        if (REQUIRED.has(key)) fail(`required view key ${key} cannot be unset`);
      }
      return { kind: "unset", path: raw.path, keys: [...raw.keys] as string[] };
    }
    case "setInherited":
      keysOf(["kind", "path", "value"]);
      if (!isString(raw.path) || !Array.isArray(raw.value)) return fail("bad setInherited op");
      return { kind: "setInherited", path: raw.path, value: jsonClone(raw.value) };
    default:
      return fail(`unknown op ${JSON.stringify(raw.kind)}`);
  }
}

function applyOps(previous: RegistryState, ops: readonly RegistryOp[]): RegistryState {
  // Copy-on-write: untouched threads (and their large definition/inherited) are shared.
  const threads = new Map(previous.threads.map((thread) => [thread.view.path, thread]));
  const existing = (path: string) => threads.get(path) ?? fail(`unknown thread ${path}`);
  for (const op of ops) {
    if (op.kind === "insert") {
      if (threads.has(op.thread.view.path)) fail(`duplicate thread ${op.thread.view.path}`);
      threads.set(op.thread.view.path, op.thread);
    } else if (op.kind === "remove") {
      existing(op.path);
      threads.delete(op.path);
    } else {
      const thread = existing(op.path);
      const view = { ...thread.view } as Record<string, unknown>;
      const next: Record<string, unknown> = { ...thread, view };
      if (op.kind === "set") Object.assign(view, op.view);
      else if (op.kind === "unset") for (const key of op.keys) delete view[key];
      else if (op.kind === "setInherited") next.inherited = op.value;
      else delete next.inherited;
      threads.set(op.path, next as unknown as SavedThread);
    }
  }
  return { rootSessionId: previous.rootSessionId, threads: [...threads.values()] };
}

/**
 * Applies one registry entry to the state of its branch ancestors. v1 and v2 `base` replace
 * the state; a v2 `patch` requires a baseline from the same root. Never mutates `previous`.
 */
export function applyRegistry(
  previous: RegistryState | undefined,
  customType: string,
  data: unknown,
): RegistryState {
  if (customType !== REGISTRY_V1 && customType !== REGISTRY_V2)
    return fail(`unsupported registry entry type ${JSON.stringify(customType)}`);
  if (!isObject(data) || !isString(data.rootSessionId) || !data.rootSessionId)
    return fail("entry lacks rootSessionId");
  const rootSessionId = data.rootSessionId;
  if (customType === REGISTRY_V1) {
    if (data.version !== 1) return fail(`v1 entry has version ${String(data.version)}`);
    return { rootSessionId, threads: parseThreads(data.threads) };
  }
  if (data.version !== 2) return fail(`v2 entry has version ${String(data.version)}`);
  if (data.op === "base") return { rootSessionId, threads: parseThreads(data.threads) };
  if (data.op !== "patch") return fail(`unknown v2 op ${String(data.op)}`);
  if (!previous) return fail("patch without a baseline");
  if (previous.rootSessionId !== rootSessionId) return fail("patch crosses root sessions");
  if (!Array.isArray(data.ops)) return fail("patch lacks ops");
  return applyOps(previous, data.ops.map(parseOp));
}

/**
 * Rebuilds the registry from branch entries (root → leaf). Starts at the last full snapshot
 * (v1 or v2 base) and folds the patches after it. Returns undefined only when the branch has
 * no registry entry; any malformed or unknown-version entry throws.
 */
export function foldRegistry(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
): RegistryState | undefined {
  const registry: { customType: string; data: unknown }[] = [];
  let start = -1;
  for (const entry of entries) {
    if (entry.type !== "custom" || !entry.customType?.startsWith(REGISTRY_PREFIX)) continue;
    if (entry.customType !== REGISTRY_V1 && entry.customType !== REGISTRY_V2)
      fail(`unknown registry version ${JSON.stringify(entry.customType)}`);
    const full =
      entry.customType === REGISTRY_V1 || (isObject(entry.data) && entry.data.op === "base");
    registry.push({ customType: entry.customType, data: entry.data });
    if (full) start = registry.length - 1;
  }
  if (!registry.length) return undefined;
  if (start < 0) return fail("no baseline snapshot on this branch");
  let state: RegistryState | undefined;
  for (const item of registry.slice(start))
    state = applyRegistry(state, item.customType, item.data);
  return state;
}

/**
 * Drops optional members that JSON would drop (undefined). Anything unreadable on the way back
 * fails here, before a write: non-finite numbers, invalid values, or a missing/invalid required key.
 */
function cleanView(view: SavedThreadView): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    if (value === undefined) continue;
    checkViewValue(key, value);
    clean[key] = value;
  }
  for (const key of REQUIRED_KEYS)
    if (!hasOwn(clean, key)) fail(`thread view lacks required ${key}`);
  return clean;
}

/**
 * The entry data that turns `previous` into `next`, or undefined when nothing changed.
 * Without a baseline, or across root sessions, a full `base` is returned. The result never
 * aliases `next`. Large `definition`/`inherited` values are compared by reference first.
 */
export function diffRegistry(
  previous: RegistryState | undefined,
  next: RegistryState,
): RegistryV2Data | undefined {
  const base = (): RegistryV2Data => ({
    version: 2,
    rootSessionId: next.rootSessionId,
    op: "base",
    threads: parseThreads(next.threads.map((t) => ({ ...t, view: cleanView(t.view) }))),
  });
  if (!previous || previous.rootSessionId !== next.rootSessionId) return base();
  const before = new Map(previous.threads.map((thread) => [thread.view.path, thread]));
  const after = new Map(next.threads.map((thread) => [thread.view.path, thread]));
  const sameDefinition = (a: SavedThread, b: SavedThread) =>
    a.definition === b.definition || jsonEqual(a.definition, b.definition);
  const replaced = (thread: SavedThread) => {
    const old = before.get(thread.view.path);
    return old !== undefined && !sameDefinition(old, thread);
  };

  const ops: RegistryOp[] = [];
  const expectedOrder: string[] = [];
  for (const old of previous.threads) {
    const path = old.view.path;
    const now = after.get(path);
    if (!now || replaced(now)) ops.push({ kind: "remove", path });
    else expectedOrder.push(path);
  }
  for (const thread of next.threads) {
    const path = thread.view.path;
    const old = before.get(path);
    const view = cleanView(thread.view);
    if (!old || replaced(thread)) {
      ops.push({ kind: "insert", thread: parseThread({ ...thread, view }) });
      expectedOrder.push(path);
      continue;
    }
    const oldView = cleanView(old.view);
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [key, value] of Object.entries(view)) {
      if (!hasOwn(oldView, key) || oldView[key] !== value) set[key] = value;
    }
    for (const key of Object.keys(oldView)) if (!hasOwn(view, key)) unset.push(key);
    if (hasOwn(set, "path")) fail("thread path changed");
    if (Object.keys(set).length) ops.push({ kind: "set", path, view: set });
    if (unset.length) ops.push({ kind: "unset", path, keys: unset });
    if (thread.inherited === undefined) {
      if (old.inherited !== undefined) ops.push({ kind: "unsetInherited", path });
    } else if (old.inherited !== thread.inherited && !jsonEqual(old.inherited, thread.inherited)) {
      if (!Array.isArray(thread.inherited)) fail("inherited must be an array");
      ops.push({ kind: "setInherited", path, value: jsonClone(thread.inherited) });
    }
  }
  // Patches cannot reorder survivors; fall back to a full snapshot rather than lose order.
  const order = next.threads.map((thread) => thread.view.path);
  if (order.length !== expectedOrder.length || order.some((p, i) => p !== expectedOrder[i]))
    return base();
  if (!ops.length) return undefined;
  return { version: 2, rootSessionId: next.rootSessionId, op: "patch", ops };
}
