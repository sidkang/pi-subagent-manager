import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MigrationError, migrateRegistry, verifyFiles } from "../scripts/migrate-registry.ts";
import {
  REGISTRY_V1,
  REGISTRY_V2,
  applyRegistry,
  diffRegistry,
  foldRegistry,
  type RegistryState,
} from "../src/orch/registry.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/migrate-registry.ts", import.meta.url));

type Json = Record<string, any>;
const thread = (path: string, view: Json = {}, extra: Json = {}): Json => ({
  view: {
    path,
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "completed",
    task: `task of ${path} ${"x".repeat(200)}`,
    status: "Done",
    createdAt: 1,
    ...view,
  },
  definition: { name: "worker", description: "d", systemPrompt: "p".repeat(300) },
  ...extra,
});
const v1 = (root: string, threads: Json[]) => ({ version: 1, rootSessionId: root, threads });
const reg = (
  id: string,
  parentId: string | null,
  data: unknown,
  customType = REGISTRY_V1,
): Json => ({
  type: "custom",
  id,
  parentId,
  timestamp: `2026-10-26T00:00:${id.length}.000Z`,
  customType,
  data,
});
const msg = (id: string, parentId: string | null, text = "hello"): Json => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-26T00:00:00.000Z",
  message: { role: "user", content: text },
});
const header: Json = { type: "session", id: "root-1", version: 3, cwd: "/x" };
const serialize = (lines: (Json | string)[]) =>
  lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";

function fixture(run: (dir: string, input: string, output: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "registry-migration-"));
  return Promise.resolve(run(dir, join(dir, "in.jsonl"), join(dir, "out.jsonl"))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readEntries = (path: string): Json[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
const branch = (entries: Json[], id: string): any[] => {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const out: Json[] = [];
  for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined)
    out.unshift(cur);
  return out;
};
/** Every registry node folds on its own branch to the same state as the original v1 data. */
function assertEquivalentEverywhere(inputPath: string, outputPath: string) {
  const before = readEntries(inputPath);
  const after = readEntries(outputPath);
  for (const entry of before.filter((e) => e.customType === REGISTRY_V1)) {
    const expected = JSON.parse(JSON.stringify(foldRegistry(branch(before, entry.id))));
    const actual = JSON.parse(JSON.stringify(foldRegistry(branch(after, entry.id))));
    assert.deepEqual(actual, expected, `state at ${entry.id}`);
  }
}

test("linear chain: ancestor-relative patches, unchanged nodes kept as empty patches, other bytes identical", () =>
  fixture((_dir, input, output) => {
    const a = thread("/root/a");
    const b = thread("/root/b");
    writeFileSync(
      input,
      serialize([
        header,
        msg("m1", null),
        reg("r1", "m1", v1("root-1", [a])),
        msg("m2", "r1"),
        reg("r2", "m2", v1("root-1", [a, b])),
        reg("r3", "r2", v1("root-1", [a, b])), // identical snapshot
        reg("r4", "r3", v1("root-1", [a, thread("/root/b", { sessionLeafId: "leaf" })])),
      ]),
    );
    const stats = migrateRegistry({ input, output });
    assert.equal(stats.registryEntries, 4);
    assert.equal(stats.bases, 1);
    assert.equal(stats.patches, 3);
    assert.equal(stats.emptyPatches, 1);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const before = readFileSync(input, "utf8").split("\n");
    const after = readFileSync(output, "utf8").split("\n");
    assert.equal(before.length, after.length);
    before.forEach((line, i) => {
      if (!line.includes(REGISTRY_V1)) assert.equal(after[i], line);
    });
    const outEntries = readEntries(output);
    const r4 = outEntries.find((e) => e.id === "r4")!;
    assert.equal(r4.customType, REGISTRY_V2);
    assert.ok(JSON.stringify(r4.data).length < 400, "leaf change must not carry large payloads");
    assert.deepEqual(
      outEntries.map((e) => [e.id, e.parentId, e.timestamp]),
      readEntries(input).map((e) => [e.id, e.parentId, e.timestamp]),
    );
    assertEquivalentEverywhere(input, output);
  }));

test("branches use the ancestor registry, not the physically previous one", () =>
  fixture((_dir, input, output) => {
    const a = thread("/root/a");
    writeFileSync(
      input,
      serialize([
        header,
        reg("r1", null, v1("root-1", [a])),
        reg("rA", "r1", v1("root-1", [a, thread("/root/onlyA")])),
        msg("mB", "r1"),
        reg("rB", "mB", v1("root-1", [a, thread("/root/onlyB")])), // physically after rA
        reg("rA2", "rA", v1("root-1", [a, thread("/root/onlyA", { state: "failed" })])),
        reg("rOld", "r1", v1("root-1", [thread("/root/a", { status: "other" })])), // old parent again
      ]),
    );
    migrateRegistry({ input, output });
    const out = readEntries(output);
    const ops = (id: string) => JSON.stringify(out.find((e) => e.id === id)!.data);
    assert.ok(!ops("rB").includes("onlyA"), "rB must not reference its physical neighbour");
    assertEquivalentEverywhere(input, output);
    verifyFiles(input, output);
  }));

test("cross-root becomes base; reap + rebuild, null vs missing and inherited survive", () =>
  fixture((_dir, input, output) => {
    const a = thread("/root/a", { sessionLeafId: null });
    const withInherited = thread("/root/c", {}, { inherited: [{ role: "user", content: "hi" }] });
    const noInherited = thread("/root/c");
    writeFileSync(
      input,
      serialize([
        header,
        reg("r1", null, v1("root-1", [a, withInherited])),
        reg("r2", "r1", v1("root-1", [thread("/root/a"), noInherited])), // leaf null -> missing
        reg("r3", "r2", v1("root-1", [])), // reaped
        reg("r4", "r3", v1("root-1", [thread("/root/a", { task: "rebuilt" })])), // same path again
        reg("r5", "r4", v1("other-root", [thread("/root/a")])), // fork copied registry
      ]),
    );
    const stats = migrateRegistry({ input, output });
    assert.equal(stats.bases, 2);
    assertEquivalentEverywhere(input, output);
  }));

test("preserves blank lines, corrupt lines, CRLF and a missing final newline", () =>
  fixture((_dir, input, output) => {
    const raw = [
      JSON.stringify(header),
      "",
      "{not json",
      JSON.stringify(msg("m1", null)) + "\r",
      JSON.stringify(reg("r1", "m1", v1("root-1", [thread("/root/a")]))) + "\r",
      '{"type":"custom","customType":"' + REGISTRY_V1 + '","data":{broken',
      JSON.stringify(reg("r2", "r1", v1("root-1", [thread("/root/a", { status: "x" })]))),
    ].join("\n");
    writeFileSync(input, raw); // no trailing newline, last line is a registry entry
    migrateRegistry({ input, output });
    const out = readFileSync(output, "utf8");
    assert.ok(!out.endsWith("\n"));
    const lines = out.split("\n");
    const original = raw.split("\n");
    for (const i of [0, 1, 2, 3, 5]) assert.equal(lines[i], original[i]);
    assert.ok(lines[4]!.endsWith("\r"));
    verifyFiles(input, output);
  }));

test("fails closed on v2 input, unknown versions, invalid state and duplicate ids; leaves nothing behind", () =>
  fixture((dir, input, output) => {
    const cases: Record<string, (string | Json)[]> = {
      v2: [
        header,
        reg(
          "r1",
          null,
          { version: 2, rootSessionId: "root-1", op: "base", threads: [] },
          REGISTRY_V2,
        ),
      ],
      v3: [header, reg("r1", null, v1("root-1", []), "pi-subagent:registry:v3")],
      badVersion: [header, reg("r1", null, { version: 9, rootSessionId: "root-1", threads: [] })],
      badState: [header, reg("r1", null, v1("root-1", [{ view: { path: "/root/a" } }]))],
      noRoot: [header, reg("r1", null, { version: 1, threads: [] })],
      duplicate: [header, msg("m1", null), msg("m1", null)],
    };
    for (const [name, lines] of Object.entries(cases)) {
      writeFileSync(input, serialize(lines));
      assert.throws(() => migrateRegistry({ input, output }), MigrationError, name);
      assert.deepEqual(readdirSync(dir), ["in.jsonl"], `${name}: no output or temp files`);
    }
  }));

test("never overwrites or aliases existing outputs; input is untouched", () =>
  fixture((dir, input, output) => {
    writeFileSync(input, serialize([header, reg("r1", null, v1("root-1", [thread("/root/a")]))]));
    const digest = sha(input);
    assert.throws(() => migrateRegistry({ input, output: input }), MigrationError);
    writeFileSync(output, "keep");
    assert.throws(() => migrateRegistry({ input, output }), MigrationError);
    assert.equal(readFileSync(output, "utf8"), "keep");
    const link = join(dir, "link.jsonl");
    symlinkSync(input, link);
    assert.throws(() => migrateRegistry({ input, output: link }), MigrationError);
    assert.equal(sha(input), digest);
    rmSync(output);
    migrateRegistry({ input, output });
    assert.equal(sha(input), digest);
  }));

test("verify-only detects a tampered output", () =>
  fixture((_dir, input, output) => {
    writeFileSync(
      input,
      serialize([
        header,
        reg("r1", null, v1("root-1", [thread("/root/a")])),
        reg("r2", "r1", v1("root-1", [thread("/root/a", { status: "new" })])),
      ]),
    );
    migrateRegistry({ input, output });
    verifyFiles(input, output);
    writeFileSync(output, readFileSync(output, "utf8").replace('"status":"new"', '"status":"bad"'));
    assert.throws(() => verifyFiles(input, output), MigrationError);
    writeFileSync(output, readFileSync(output, "utf8").replace('"Done"', '"Gone"'));
    assert.throws(() => verifyFiles(input, output), MigrationError);
  }));

test("large payloads: size scales with changes, not with retained payload", () =>
  fixture((_dir, input, output) => {
    const big = (n: number, leaf: number) =>
      Array.from({ length: n }, (_, i) =>
        thread(`/root/t${i}`, {
          task: "t".repeat(20_000),
          output: "o".repeat(20_000),
          sessionLeafId: i === 0 ? `leaf${leaf}` : "l",
        }),
      );
    const lines: Json[] = [header];
    let parent: string | null = null;
    for (let i = 0; i < 200; i++) {
      lines.push(reg(`r${i}`, parent, v1("root-1", big(20, i))));
      parent = `r${i}`;
    }
    writeFileSync(input, serialize(lines));
    const stats = migrateRegistry({ input, output });
    assert.ok(
      stats.outputBytes < stats.inputBytes / 50,
      `${stats.outputBytes} vs ${stats.inputBytes}`,
    );
    assertEquivalentEverywhere(input, output);
  }));

test("CLI: writes the output, refuses to overwrite, supports --verify-only", () =>
  fixture((_dir, input, output) => {
    writeFileSync(input, serialize([header, reg("r1", null, v1("root-1", [thread("/root/a")]))]));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8" });
    const first = run("--input", input, "--output", output);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).registryEntries, 1);
    const second = run("--input", input, "--output", output);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
    const verify = run("--input", input, "--output", output, "--verify-only");
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(run("--input", input).status, 2);
  }));

test("rejects parent cycles, including registries that are each other's parent", () =>
  fixture((dir, input, output) => {
    const data = v1("root-1", [thread("/root/a")]);
    const cases: Record<string, (string | Json)[]> = {
      mutual: [header, reg("A", "B", data), reg("B", "A", data)],
      self: [header, reg("A", "A", data)],
      three: [header, reg("A", "C", data), reg("B", "A", data), reg("C", "B", data)],
      viaMessages: [header, reg("A", "m2", data), msg("m1", "A"), msg("m2", "m1")],
      plainCycle: [header, msg("m1", "m2"), msg("m2", "m1")],
    };
    for (const [name, lines] of Object.entries(cases)) {
      writeFileSync(input, serialize(lines));
      assert.throws(() => migrateRegistry({ input, output }), /cycle/, name);
      assert.deepEqual(readdirSync(dir), ["in.jsonl"], name);
    }
    // A hand-made output with a registry cycle must not hang verification.
    writeFileSync(input, serialize([header, reg("A", null, data), reg("B", "A", data)]));
    migrateRegistry({ input, output });
    const cyclic = readFileSync(output, "utf8").replace(
      '"id":"A","parentId":null',
      '"id":"A","parentId":"B"',
    );
    writeFileSync(output, cyclic);
    assert.throws(() => verifyFiles(input, output), /cycle|differ/);
  }));

test("rejects states the shared codec refuses instead of dropping fields", () =>
  fixture((dir, input, output) => {
    const bad: Json[] = [
      thread("/root/a", { state: "bogus" }),
      thread("/root/a", { constructor: 1 }),
      { ...thread("/root/a"), definition: "nope" },
      { ...thread("/root/a"), inherited: "nope" },
    ];
    for (const entry of bad) {
      writeFileSync(input, serialize([header, reg("r1", null, v1("root-1", [entry]))]));
      assert.throws(() => migrateRegistry({ input, output }), MigrationError);
      assert.deepEqual(readdirSync(dir), ["in.jsonl"]);
    }
  }));

test("migration output equals what the runtime writes for the same state sequence", () =>
  fixture((_dir, input, output) => {
    const a = thread("/root/a");
    const states: Json[][] = [
      [a],
      [a, thread("/root/b", { state: "running" })],
      [a, thread("/root/b", { state: "running", sessionLeafId: "l1" })],
      [a, thread("/root/b", { state: "running", sessionLeafId: "l1" })], // no change
      [a, thread("/root/b", { state: "completed", sessionLeafId: null, output: "done" })],
      [thread("/root/b", { state: "completed", sessionLeafId: null, output: "done" })],
      [thread("/root/b", { state: "completed", task: "rebuilt" }, { inherited: [] })],
      [thread("/root/b", { state: "completed", task: "rebuilt" })],
    ];
    const lines: Json[] = [header];
    const runtime: unknown[] = [];
    let previous: RegistryState | undefined;
    let parent: string | null = null;
    states.forEach((threads, i) => {
      const next = { rootSessionId: "root-1", threads } as unknown as RegistryState;
      lines.push(reg(`r${i}`, parent, v1("root-1", threads)));
      runtime.push(diffRegistry(previous, next) ?? null); // runtime skips unchanged states
      previous = applyRegistry(previous, REGISTRY_V1, v1("root-1", threads));
      parent = `r${i}`;
    });
    writeFileSync(input, serialize(lines));
    migrateRegistry({ input, output });
    const migrated = readEntries(output)
      .filter((e) => e.customType === REGISTRY_V2)
      .map((e) => (e.data.op === "patch" && e.data.ops.length === 0 ? null : e.data));
    assert.deepEqual(migrated, JSON.parse(JSON.stringify(runtime)));
    assert.equal(migrated.filter((d) => d === null).length, 1);
  }));

test("verification cost is linear in interleaved branches", () =>
  fixture((_dir, input, output) => {
    const BRANCHES = 6;
    const PER = 200;
    const lines: Json[] = [header, reg("root", null, v1("root-1", [thread("/root/a")]))];
    const tips: string[] = Array(BRANCHES).fill("root");
    for (let i = 0; i < PER; i++)
      for (let b = 0; b < BRANCHES; b++) {
        const id = `b${b}-${i}`;
        lines.push(reg(id, tips[b]!, v1("root-1", [thread("/root/a", { status: `s${b}-${i}` })])));
        tips[b] = id;
      }
    writeFileSync(input, serialize(lines));
    const nodes = BRANCHES * PER + 1;
    const stats = migrateRegistry({ input, output });
    assert.equal(stats.registryEntries, nodes);
    const { applies } = verifyFiles(input, output);
    assert.ok(applies <= 3 * nodes, `${applies} applies for ${nodes} nodes`);
    assertEquivalentEverywhere(input, output);
  }));
