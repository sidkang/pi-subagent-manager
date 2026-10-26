import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  REGISTRY_V1,
  REGISTRY_V2,
  applyRegistry,
  diffRegistry,
  foldRegistry,
  type RegistryState,
  type RegistryV2Data,
} from "../src/orch/registry.ts";
import type { SavedThread } from "../src/types.ts";

const ROOT = "root-session";
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const thread = (
  name: string,
  view: Record<string, unknown> = {},
  extra: Partial<SavedThread> = {},
): SavedThread =>
  ({
    view: {
      path: `/root/${name}`,
      parent: "/root",
      owner: "/root",
      type: "worker",
      state: "completed",
      task: `task ${name}`,
      status: "done",
      createdAt: 1,
      ...view,
    },
    definition: { name: "worker", description: "d", systemPrompt: `prompt ${name}` },
    ...extra,
  }) as SavedThread;
const state = (...threads: SavedThread[]): RegistryState => ({ rootSessionId: ROOT, threads });
const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data });
const v1 = (s: RegistryState) => entry(REGISTRY_V1, { version: 1, ...s });
const v2 = (data: RegistryV2Data | undefined) => entry(REGISTRY_V2, data);

/** Writes `states` through diffRegistry exactly like persist() and returns the entries. */
function writeAll(states: RegistryState[]) {
  const entries: ReturnType<typeof v2>[] = [];
  let baseline: RegistryState | undefined;
  for (const next of states) {
    const data = diffRegistry(baseline, next);
    if (data) entries.push(v2(data));
    baseline = next;
  }
  return entries;
}

test("v1-only branches fold to their last snapshot, tolerating other custom entries", () => {
  const entries = [
    { type: "message" },
    v1(state(thread("a"))),
    entry("something-else", {}),
    v1(state(thread("a"), thread("b"))),
  ];
  assert.deepEqual(
    foldRegistry(entries)!.threads.map((t) => t.view.path),
    ["/root/a", "/root/b"],
  );
  assert.equal(foldRegistry([{ type: "message" }]), undefined);
  assert.equal(foldRegistry([]), undefined);
});

test("mixed v1 then v2 patches fold from the v1 baseline", () => {
  const a = state(thread("a", { sessionLeafId: "l1" }));
  const b = state(thread("a", { sessionLeafId: "l2" }), thread("b"));
  const patch = diffRegistry(a, b)!;
  assert.equal(patch.op, "patch");
  const folded = foldRegistry([v1(a), v2(patch)])!;
  assert.deepEqual(json(folded), json(b));
});

test("branch folding ignores entries on other branches and file order", () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  const s0 = state(thread("a", { sessionLeafId: "l0" }));
  const s1 = state(thread("a", { sessionLeafId: "l1" }));
  const s2 = state(thread("a", { sessionLeafId: "l2" }), thread("b"));
  const s1b = state(thread("a", { sessionLeafId: "other" }));
  session.appendCustomEntry(REGISTRY_V2, diffRegistry(undefined, s0));
  const at0 = session.getLeafId()!;
  session.appendCustomEntry(REGISTRY_V2, diffRegistry(s0, s1));
  const at1 = session.getLeafId()!;
  session.appendCustomEntry(REGISTRY_V2, diffRegistry(s1, s2));
  const at2 = session.getLeafId()!;
  session.branch(at0); // a sibling branch from the oldest checkpoint
  session.appendCustomEntry(REGISTRY_V2, diffRegistry(s0, s1b));
  const atB = session.getLeafId()!;
  const fold = (id: string) => json(foldRegistry(session.getBranch(id))!);
  assert.deepEqual(fold(at0), json(s0));
  assert.deepEqual(fold(at1), json(s1));
  assert.deepEqual(fold(at2), json(s2));
  assert.deepEqual(fold(atB), json(s1b));
});

test("a later base or v1 supersedes earlier history", () => {
  const entries = [
    ...writeAll([state(thread("a")), state(thread("a"), thread("b"))]),
    v1(state(thread("z"))),
  ];
  assert.deepEqual(
    foldRegistry(entries)!.threads.map((t) => t.view.path),
    ["/root/z"],
  );
});

test("unreadable registries fail closed", () => {
  const good = state(thread("a"));
  const base = diffRegistry(undefined, good)!;
  const fails = (entries: unknown[], message?: RegExp) =>
    assert.throws(() => foldRegistry(entries as never), message ?? /Invalid subagent registry/);
  fails([entry("pi-subagent:registry:v3", {})], /unknown registry version/);
  fails([entry(REGISTRY_V1, { version: 2, rootSessionId: ROOT, threads: [] })]);
  fails([entry(REGISTRY_V1, { version: 1, rootSessionId: ROOT })]);
  fails([entry(REGISTRY_V1, null)]);
  fails([v2({ version: 2, rootSessionId: ROOT, op: "patch", ops: [] })], /no baseline/);
  fails([v2(base), entry(REGISTRY_V2, { version: 2, rootSessionId: ROOT, op: "mystery" })]);
  fails([v2(base), entry(REGISTRY_V2, { version: 3, rootSessionId: ROOT, op: "patch", ops: [] })]);
  fails([v2(base), v2({ version: 2, rootSessionId: "other", op: "patch", ops: [] })], /crosses/);
  const patch = (op: unknown) => [
    v2(base),
    entry(REGISTRY_V2, { version: 2, rootSessionId: ROOT, op: "patch", ops: [op] }),
  ];
  fails(patch({ kind: "remove", path: "/root/missing" }), /unknown thread/);
  fails(patch({ kind: "set", path: "/root/missing", view: { status: "x" } }), /unknown thread/);
  fails(patch({ kind: "insert", thread: thread("a") }), /duplicate/);
  fails(patch({ kind: "set", path: "/root/a", view: { bogus: 1 } }), /unknown view key/);
  fails(patch({ kind: "set", path: "/root/a", view: { __proto__x: 1 } }), /unknown view key/);
  fails(patch({ kind: "set", path: "/root/a", view: { path: "/root/b" } }), /identity/);
  fails(patch({ kind: "set", path: "/root/a", view: { state: "weird" } }), /bad value/);
  fails(patch({ kind: "set", path: "/root/a", view: { costUsd: "1" } }), /bad value/);
  fails(patch({ kind: "unset", path: "/root/a", keys: ["state"] }), /required/);
  fails(patch({ kind: "unset", path: "/root/a", keys: ["toString"] }), /unknown view key/);
  fails(patch({ kind: "remove", path: "/root/a", extra: 1 }), /unknown field/);
  fails(patch({ kind: "teleport", path: "/root/a" }), /unknown op/);
  fails(patch("remove"), /bad op/);
  fails(patch({ kind: "setInherited", path: "/root/a", value: {} }), /bad setInherited/);
  fails(
    [v2({ version: 2, rootSessionId: ROOT, op: "base", threads: [thread("a"), thread("a")] })],
    /duplicate/,
  );
  fails([
    v2({
      version: 2,
      rootSessionId: ROOT,
      op: "base",
      threads: [{ view: {}, definition: {} } as never],
    }),
  ]);
  fails(
    [
      v2({
        version: 2,
        rootSessionId: ROOT,
        op: "base",
        threads: [{ ...thread("a"), extra: 1 } as never],
      }),
    ],
    /unknown thread key/,
  );
});

test("an empty patch is valid and changes nothing", () => {
  const base = state(thread("a"));
  const next = applyRegistry(base, REGISTRY_V2, {
    version: 2,
    rootSessionId: ROOT,
    op: "patch",
    ops: [],
  });
  assert.deepEqual(json(next), json(base));
  assert.notEqual(next, base);
});

test("applyRegistry never mutates its baseline or aliases the entry data", () => {
  const base = state(thread("a", {}, { inherited: [{ role: "user", content: "x" }] as never }));
  const frozen = json(base);
  const data = diffRegistry(
    base,
    state(
      thread("a", { status: "changed" }, { inherited: [{ role: "user", content: "x" }] as never }),
      thread("b"),
    ),
  )!;
  const snapshot = json(data);
  const next = applyRegistry(base, REGISTRY_V2, data);
  assert.deepEqual(json(base), frozen);
  (next.threads[1] as SavedThread).view.status = "tampered";
  (next.threads[1] as SavedThread).definition.systemPrompt = "tampered";
  assert.deepEqual(json(data), snapshot, "entry data is independent of the folded state");
});

test("diff: first write is a base, even when empty; no change writes nothing", () => {
  const empty = diffRegistry(undefined, state())!;
  assert.equal(empty.op, "base");
  assert.deepEqual(foldRegistry([v2(empty)]), state());
  const s = state(thread("a", { sessionLeafId: null, costUsd: undefined }));
  assert.equal(diffRegistry(s, structuredClone(s)), undefined);
  assert.equal(diffRegistry(s, state(thread("a", { sessionLeafId: null }))), undefined);
});

test("diff: a different root session starts over with a base", () => {
  const data = diffRegistry(state(thread("a")), { rootSessionId: "forked", threads: [] })!;
  assert.deepEqual(data, { version: 2, rootSessionId: "forked", op: "base", threads: [] });
});

test("diff: leaf and counter changes are tiny per-thread sets", () => {
  const before = state(thread("a", { sessionLeafId: "l1", inputTokens: 1 }), thread("b"));
  const after = state(thread("a", { sessionLeafId: "l2", inputTokens: 2 }), thread("b"));
  assert.deepEqual(diffRegistry(before, after), {
    version: 2,
    rootSessionId: ROOT,
    op: "patch",
    ops: [{ kind: "set", path: "/root/a", view: { sessionLeafId: "l2", inputTokens: 2 } }],
  });
});

test("diff keeps null and missing distinct", () => {
  const missing = state(thread("a"));
  const nulled = state(thread("a", { sessionLeafId: null }));
  const set = diffRegistry(missing, nulled)!;
  assert.deepEqual((set as { ops: unknown[] }).ops, [
    { kind: "set", path: "/root/a", view: { sessionLeafId: null } },
  ]);
  const unset = diffRegistry(nulled, missing)!;
  assert.deepEqual((unset as { ops: unknown[] }).ops, [
    { kind: "unset", path: "/root/a", keys: ["sessionLeafId"] },
  ]);
  const folded = foldRegistry(writeAll([missing, nulled, missing]))!;
  assert.equal(Object.hasOwn(folded.threads[0]!.view, "sessionLeafId"), false);
  const folded2 = foldRegistry(writeAll([missing, nulled]))!;
  assert.equal(folded2.threads[0]!.view.sessionLeafId, null);
});

test("diff keeps empty inherited distinct from absent inherited", () => {
  const none = state(thread("a"));
  const empty = state(thread("a", {}, { inherited: [] }));
  const full = state(
    thread("a", {}, { inherited: [{ role: "user", content: "c", timestamp: 1 }] as never }),
  );
  for (const sequence of [
    [none, empty],
    [empty, none],
    [none, full],
    [full, empty],
    [full, none],
    [empty, full],
  ]) {
    const folded = foldRegistry(writeAll(sequence))!;
    assert.deepEqual(json(folded), json(sequence.at(-1)));
    assert.equal(
      Object.hasOwn(folded.threads[0]!, "inherited"),
      Object.hasOwn(sequence.at(-1)!.threads[0]!, "inherited"),
    );
  }
});

test("diff expresses reap as remove and recreation under the same path as remove+insert", () => {
  const a = thread("a");
  const b = thread("b");
  const reaped = diffRegistry(state(a, b), state(b))!;
  assert.deepEqual((reaped as { ops: unknown[] }).ops, [{ kind: "remove", path: "/root/a" }]);
  const recreated = thread("a", { task: "new task", createdAt: 9 }, {});
  recreated.definition = { name: "other", description: "d", systemPrompt: "different" } as never;
  const states = [state(a, b), state(b), state(b, recreated)];
  const folded = foldRegistry(writeAll(states))!;
  assert.deepEqual(json(folded), json(states[2]));
  // A definition replaced in place is remove+insert; since that reorders, it falls back to a base.
  const replaced = state(recreated, b);
  assert.deepEqual(json(foldRegistry(writeAll([state(a, b), replaced]))), json(replaced));
});

test("diff preserves thread order, falling back to a base when a patch cannot", () => {
  const states = [
    state(thread("a"), thread("b"), thread("c")),
    state(thread("c"), thread("a"), thread("b")),
  ];
  const data = diffRegistry(states[0]!, states[1]!)!;
  assert.equal(data.op, "base");
  assert.deepEqual(json(foldRegistry(writeAll(states))), json(states[1]));
});

test("diff drops undefined optional members so the data is storable JSON", () => {
  const next = state(thread("a", { color: undefined, elapsedMs: 5, error: undefined }));
  const data = diffRegistry(undefined, next)!;
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
  assert.deepEqual(Object.keys((data as { threads: SavedThread[] }).threads[0]!.view).sort(), [
    "createdAt",
    "elapsedMs",
    "owner",
    "parent",
    "path",
    "state",
    "status",
    "task",
    "type",
  ]);
});

test("diff refuses to write views that would be unreadable, in base and patch form", () => {
  const good = state(thread("a"));
  const withView = (change: (view: Record<string, unknown>) => void) => {
    const bad = state(thread("a"));
    change(bad.threads[0]!.view as unknown as Record<string, unknown>);
    return bad;
  };
  const bads = [
    withView((v) => (v.costUsd = Number.NaN)),
    withView((v) => (v.elapsedMs = Number.POSITIVE_INFINITY)),
    withView((v) => (v.task = undefined)),
    withView((v) => delete v.status), // raw missing key, not just an undefined member
    withView((v) => delete v.createdAt),
    withView((v) => (v.parent = undefined)),
    withView((v) => (v.createdAt = Number.NaN)),
    withView((v) => (v.state = "exploded")),
  ];
  for (const bad of bads) {
    assert.throws(() => diffRegistry(undefined, bad), /Invalid subagent registry/);
    assert.throws(() => diffRegistry(good, bad), /Invalid subagent registry/);
    // A baseline that is itself unreadable also refuses rather than computing a patch from it.
    assert.throws(() => diffRegistry(bad, good), /Invalid subagent registry/);
  }
});

test("diff output never aliases the state it was computed from", () => {
  const inherited = [{ role: "user", content: "x", timestamp: 1 }];
  const next = state(thread("a", {}, { inherited: inherited as never }));
  const data = diffRegistry(undefined, next) as Extract<RegistryV2Data, { op: "base" }>;
  const snapshot = json(data);
  next.threads[0]!.definition.systemPrompt = "mutated";
  inherited[0]!.content = "mutated";
  next.threads[0]!.view.task = "mutated";
  assert.deepEqual(json(data), snapshot);
});

test("diff rejects states it cannot persist rather than writing unreadable data", () => {
  const bad = state(thread("a", { state: "exploded" }));
  assert.throws(() => diffRegistry(undefined, bad), /bad value/);
  const extra = state(thread("a", { surprise: 1 }));
  assert.throws(() => diffRegistry(undefined, extra), /unknown view key/);
});

test("randomized event sequences fold back to exactly what was saved", () => {
  let seed = 12345;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const states: RegistryState[] = [state()];
  let current = state();
  let counter = 0;
  for (let step = 0; step < 400; step++) {
    const threads = current.threads.map((t) => structuredClone(t));
    const pick = random(7);
    if (pick === 0 || !threads.length) {
      threads.push(
        thread(
          `t${counter++}`,
          {},
          random(2) ? { inherited: [{ role: "user", content: `c${step}` }] as never } : {},
        ),
      );
    } else if (pick === 1) {
      threads.splice(random(threads.length), 1);
    } else {
      const t = threads[random(threads.length)]!;
      const view = t.view as unknown as Record<string, unknown>;
      if (pick === 2) view.sessionLeafId = random(4) ? `leaf${step}` : null;
      if (pick === 3) {
        view.inputTokens = step;
        view.costUsd = step / 10;
      }
      if (pick === 4) {
        view.state = ["running", "paused", "completed"][random(3)];
        view.output = random(2) ? `out${step}` : undefined;
      }
      if (pick === 5) {
        if (random(2)) delete view.sessionLeafId;
        else view.error = `e${step}`;
      }
      if (pick === 6) t.inherited = random(2) ? [] : undefined;
      if (t.inherited === undefined) delete t.inherited;
    }
    current = state(...threads);
    states.push(current);
  }
  const entries = writeAll(states);
  assert.ok(entries.length > 100);
  // Every prefix of the written log folds to the state saved at that point.
  let written = 0;
  let baseline: RegistryState | undefined;
  for (const saved of states) {
    if (diffRegistry(baseline, saved)) written++;
    baseline = saved;
    assert.deepEqual(json(foldRegistry(entries.slice(0, written))), json(saved));
  }
});

test("size: leaf and counter churn costs bytes independent of retained payload", () => {
  const sizes = new Map<number, { total: number; max: number }>();
  for (const payload of [1_000, 100_000]) {
    const threads = Array.from({ length: 49 }, (_, index) =>
      thread(
        `agent-${index}`,
        {
          task: "t".repeat(payload),
          output: "o".repeat(payload),
          sessionLeafId: "leaf-0",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        },
        { inherited: [] },
      ),
    );
    for (const item of threads) item.definition.systemPrompt = "p".repeat(payload);
    let baseline = state(...threads);
    let total = 0;
    let max = 0;
    for (let step = 1; step <= 5000; step++) {
      const next = state(...baseline.threads.map((t) => ({ ...t, view: { ...t.view } })));
      const target = next.threads[step % 49]!.view;
      target.sessionLeafId = `01a1760f-9358-7161-b2de-${String(step).padStart(12, "0")}`;
      if (step % 2) {
        target.inputTokens = step;
        target.outputTokens = step * 2;
        target.costUsd = step / 1000;
      }
      const data = diffRegistry(baseline, next)!;
      assert.equal(data.op, "patch");
      const bytes = Buffer.byteLength(JSON.stringify(data));
      total += bytes;
      max = Math.max(max, bytes);
      baseline = next;
    }
    sizes.set(payload, { total, max });
  }
  const small = sizes.get(1_000)!;
  const large = sizes.get(100_000)!;
  assert.ok(large.total < 5 * 1024 * 1024, `total ${large.total}`);
  assert.ok(large.max < 512, `max ${large.max}`);
  assert.equal(large.total, small.total, "bytes do not depend on retained task/definition/output");
});
