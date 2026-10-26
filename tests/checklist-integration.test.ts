import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import piSubagent from "../src/index.ts";
import {
  ChecklistMetaMirror,
  CHECKLIST_TOOL_NAMES,
  checklistGuidance,
  checklistStatus,
  checklistVersionSupported,
  detectChecklistPackage,
} from "../src/orch/checklist-integration.ts";
import { subagentPrompt } from "../src/orch/prompt.ts";
import { DEFAULT_MANAGER_SETTINGS, type ManagerSettings } from "../src/prefs/settings.ts";
import { markImportOffered } from "../src/prefs/agent-import.ts";

const CHECKLIST_ENTRY = "pi-checklist";
const snapshot = (metaEnabled: unknown) => ({ v: 1, checklist: { tasks: [] }, metaEnabled });

function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-checklist-labs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes <root>/<pkg>/{package.json,src/index.ts}; returns the registered extension file. */
function installPackage(root: string, dir: string, manifest: unknown): string {
  mkdirSync(join(root, dir, "src"), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  const file = join(root, dir, "src", "index.ts");
  writeFileSync(file, "export default function () {}\n");
  return file;
}

type FakeTool = { name: string; exposure?: string; sourceInfo?: { path?: unknown } };
function fakePi(tools: FakeTool[], active: string[] = tools.map((tool) => tool.name)) {
  return {
    getAllTools: () => tools.map((tool) => ({ exposure: "direct", ...tool })),
    getActiveTools: () => active,
  } as unknown as Pick<ExtensionAPI, "getAllTools" | "getActiveTools">;
}
const checklistTools = (file: string, overrides: Partial<Record<string, FakeTool>> = {}): FakeTool[] =>
  CHECKLIST_TOOL_NAMES.map((name) => overrides[name] ?? { name, sourceInfo: { path: file } });

test("checklist versions: only strict 3.x.y or later is supported", () => {
  for (const version of ["3.0.0", "3.4.1", "4.0.0", "10.2.3", " 3.0.0 ", "3.0.0+build", "3.0.0+build.1", "3.1.0+20130313144700", "3.0.0+001", "3.0.0+a-b.C-1"])
    assert.equal(checklistVersionSupported(version), true, version);
  for (const version of ["2.9.9", "0.3.0", "3.0.0-beta.1", "3.0.0-beta.1+build", "2.9.9+build", "3.0", "v3.0.0", "03.0.0", "3.0.0+", "3.0.0+build.", "3.0.0+.build", "3.0.0+build..1", "3.0.0+bu_ild", "3.0.0+build+1", "3.0.0+bui ld", "3.0.0+bu\u00efld", "", undefined, 3, null])
    assert.equal(checklistVersionSupported(version), false, String(version));
});

test("detection requires reachable checklist tools from the real pi-checklist package", (t) => {
  const root = temp(t);
  const good = installPackage(root, "good", { name: "pi-checklist", version: "3.0.0" });
  assert.deepEqual(detectChecklistPackage(fakePi(checklistTools(good))), { eligible: true });

  const reason = (pi: ReturnType<typeof fakePi>) => {
    const status = detectChecklistPackage(pi);
    assert.equal(status.eligible, false);
    return status.reason!;
  };
  // Missing / hidden / inactive tools.
  assert.match(reason(fakePi([])), /checklist_create is not loaded and active/);
  assert.match(reason(fakePi(checklistTools(good).slice(0, 2))), /checklist_update is not loaded/);
  assert.match(reason(fakePi(checklistTools(good, { checklist_read: { name: "checklist_read", exposure: "hidden", sourceInfo: { path: good } } }))), /checklist_read is not loaded/);
  assert.match(reason(fakePi(checklistTools(good), ["checklist_create", "checklist_read"])), /checklist_update is not loaded/);
  // Origin problems.
  assert.match(reason(fakePi(checklistTools(good, { checklist_read: { name: "checklist_read" } }))), /does not come from a pi-checklist package file/);
  assert.match(reason(fakePi(checklistTools(good, { checklist_read: { name: "checklist_read", sourceInfo: { path: "<inline:1>" } } }))), /does not come from/);
  assert.match(reason(fakePi(checklistTools(good, { checklist_read: { name: "checklist_read", sourceInfo: { path: 5 } } }))), /does not come from/);
  const other = installPackage(root, "other", { name: "pi-checklist", version: "3.0.0" });
  assert.match(reason(fakePi(checklistTools(good, { checklist_read: { name: "checklist_read", sourceInfo: { path: other } } }))), /different extensions/);
  // Look-alike tools from another package are not pi-checklist.
  const imposter = installPackage(root, "imposter", { name: "not-pi-checklist", version: "9.0.0" });
  assert.match(reason(fakePi(checklistTools(imposter))), /not provided by the pi-checklist package/);
  // Versions.
  for (const version of ["2.9.9", "3.0.0-rc.1", "3", 3, undefined]) {
    const file = installPackage(root, `v-${String(version)}`, { name: "pi-checklist", version });
    assert.match(reason(fakePi(checklistTools(file))), /unsupported; ≥3\.0\.0 is required/, String(version));
  }
  assert.match(reason(fakePi(checklistTools(installPackage(root, "bad-json", "{not json")))), /could not verify pi-checklist/);
  assert.match(reason(fakePi(checklistTools(installPackage(root, "array-json", "[]")))), /not provided by the pi-checklist package/);
  assert.match(reason({ getAllTools: () => { throw new Error("boom"); }, getActiveTools: () => [] } as never), /could not verify pi-checklist: boom/);
  assert.match(reason(fakePi(checklistTools(join(root, "missing", "index.ts")))), /could not verify pi-checklist/);
});

test("detection resolves symlinks to the owning package and newer majors pass", (t) => {
  const root = temp(t);
  const real = installPackage(root, "real", { name: "pi-checklist", version: "4.1.0" });
  mkdirSync(join(root, "linked", "src"), { recursive: true });
  symlinkSync(real, join(root, "linked", "src", "index.ts"));
  writeFileSync(join(root, "linked", "package.json"), JSON.stringify({ name: "not-it", version: "0.0.1" }));
  assert.deepEqual(detectChecklistPackage(fakePi(checklistTools(join(root, "linked", "src", "index.ts")))), { eligible: true });
});

function sessionContext(): { sessionManager: SessionManager } {
  return { sessionManager: SessionManager.inMemory("/tmp") };
}
const entries = (ctx: { sessionManager: SessionManager }) => ctx.sessionManager;
function withPrefs(t: TestContext, prefs?: unknown): string {
  const dir = temp(t);
  if (prefs !== undefined) writeFileSync(join(dir, "pi-checklist.json"), typeof prefs === "string" ? prefs : JSON.stringify(prefs));
  return dir;
}
function toolResult(toolName: string, details: unknown) {
  return {
    role: "toolResult" as const,
    toolCallId: "call",
    toolName,
    content: [{ type: "text" as const, text: "ok" }],
    details,
    isError: false,
    timestamp: 1,
  };
}

test("mirror: global preference beats branch snapshot, snapshot beats default, unknown is off", (t) => {
  const cases: [unknown, unknown, boolean][] = [
    [undefined, undefined, false],
    [undefined, true, true],
    [undefined, false, false],
    [{ metaEnabled: true }, false, true],
    [{ metaEnabled: false }, true, false], // old resumed snapshot must not override explicit global false
    [{ metaEnabled: "yes" }, true, true], // malformed pref value is ignored like pi-checklist does
    ["{broken", true, true],
    [[], true, true],
    [{}, undefined, false],
  ];
  for (const [prefs, branchMeta, expected] of cases) {
    const dir = withPrefs(t, prefs);
    const ctx = sessionContext();
    if (branchMeta !== undefined) entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, snapshot(branchMeta));
    const mirror = new ChecklistMetaMirror(() => dir);
    mirror.reset(ctx as never);
    assert.equal(mirror.metaEnabled(ctx as never), expected, JSON.stringify({ prefs, branchMeta }));
  }
});

test("mirror follows later local snapshots but ignores later cross-session global edits", (t) => {
  const dir = withPrefs(t);
  const ctx = sessionContext();
  const mirror = new ChecklistMetaMirror(() => dir);
  mirror.reset(ctx as never);
  assert.equal(mirror.metaEnabled(ctx as never), false);
  // Another session writes global true: the local pi-checklist closure does not change.
  writeFileSync(join(dir, "pi-checklist.json"), JSON.stringify({ metaEnabled: true }));
  assert.equal(mirror.metaEnabled(ctx as never), false);
  // Local /checklist settings meta appends a snapshot.
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, snapshot(true));
  assert.equal(mirror.metaEnabled(ctx as never), true);
  // Tool results carry snapshots too; unrelated tools, bad schemas and other custom types do not.
  entries(ctx).appendMessage(toolResult("other_tool", snapshot(false)) as never);
  entries(ctx).appendCustomEntry("other", snapshot(false));
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, { v: 2, checklist: {}, metaEnabled: false });
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, { v: 1, metaEnabled: false });
  assert.equal(mirror.metaEnabled(ctx as never), true);
  entries(ctx).appendMessage(toolResult("checklist_update", snapshot(false)) as never);
  assert.equal(mirror.metaEnabled(ctx as never), false);
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, snapshot("true"));
  assert.equal(mirror.metaEnabled(ctx as never), false, "only boolean true enables");
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, snapshot(true));
  assert.equal(mirror.metaEnabled(ctx as never), true);
  // Session lifecycle reseeds with the same precedence: now global true wins over a stale false.
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, snapshot(false));
  mirror.reset(ctx as never);
  assert.equal(mirror.metaEnabled(ctx as never), true);
});

test("mirror reseeds when the branch checkpoint disappears and fails closed on errors", (t) => {
  const dir = withPrefs(t);
  const ctx = sessionContext();
  const mirror = new ChecklistMetaMirror(() => dir);
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, snapshot(true));
  mirror.reset(ctx as never);
  assert.equal(mirror.metaEnabled(ctx as never), true);
  // A different session/branch lacking the checkpoint: reseed instead of keeping stale state.
  const other = sessionContext();
  entries(other).appendCustomEntry(CHECKLIST_ENTRY, snapshot(false));
  assert.equal(mirror.metaEnabled(other as never), false);
  // Without an explicit reset the mirror seeds lazily on first use.
  const lazy = new ChecklistMetaMirror(() => dir);
  assert.equal(lazy.metaEnabled(ctx as never), true);
  const broken = { sessionManager: { getBranch: () => { throw new Error("no session"); } } };
  mirror.reset(broken as never);
  assert.equal(mirror.metaEnabled(broken as never), false);
  assert.equal(new ChecklistMetaMirror(() => dir).metaEnabled(broken as never), false);
  // An empty branch has no checkpoint and still follows the first snapshot.
  const empty = sessionContext();
  const fromEmpty = new ChecklistMetaMirror(() => dir);
  fromEmpty.reset(empty as never);
  assert.equal(fromEmpty.metaEnabled(empty as never), false);
  entries(empty).appendCustomEntry(CHECKLIST_ENTRY, snapshot(true));
  assert.equal(fromEmpty.metaEnabled(empty as never), true);
});

test("checklistStatus needs both the package and live meta", (t) => {
  const root = temp(t);
  const file = installPackage(root, "pkg", { name: "pi-checklist", version: "3.0.0" });
  const dir = withPrefs(t);
  const ctx = sessionContext();
  const mirror = new ChecklistMetaMirror(() => dir);
  mirror.reset(ctx as never);
  const withMetaOff = checklistStatus(fakePi(checklistTools(file)), mirror, ctx as never);
  assert.equal(withMetaOff.eligible, false);
  assert.match(withMetaOff.reason!, /\/checklist settings meta/);
  entries(ctx).appendCustomEntry(CHECKLIST_ENTRY, snapshot(true));
  assert.deepEqual(checklistStatus(fakePi(checklistTools(file)), mirror, ctx as never), { eligible: true });
  assert.equal(checklistStatus(fakePi([]), mirror, ctx as never).eligible, false, "meta alone is not enough");
});

const GUIDANCE = /## pi-checklist integration/;
test("prompt gating: guidance only when opt-in AND eligible, never in off mode", () => {
  for (const subagentMode of ["off", "opportunistic", "orchestration"] as const)
    for (const checklistIntegration of [false, true])
      for (const eligible of [false, true]) {
        const settings: ManagerSettings = { ...DEFAULT_MANAGER_SETTINGS, subagentMode, checklistIntegration };
        const prompt = subagentPrompt(settings, eligible);
        if (subagentMode === "off") assert.equal(prompt, undefined);
        else if (checklistIntegration && eligible) assert.match(prompt!, GUIDANCE);
        else assert.equal(prompt, subagentPrompt({ ...settings, checklistIntegration: false }), "unchanged when gated");
      }
  assert.equal(
    subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: "orchestration" }),
    subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: "orchestration" }, true),
    "eligibility alone without the Labs opt-in adds nothing",
  );
});

test("guidance text: root orchestration must use the checklist, opportunistic is optional, both tag meta.agent", () => {
  const orchestration = checklistGuidance("orchestration");
  assert.match(orchestration, /MUST use checklist_create, checklist_read and checklist_update/);
  assert.match(orchestration, /meta: \{ agent: "\/root\/task-slug" \}/);
  assert.match(orchestration, /at most 10 keys, keys ≤40 characters, strings ≤200 characters/);
  const opportunistic = checklistGuidance("opportunistic");
  assert.doesNotMatch(opportunistic, /MUST/);
  assert.match(opportunistic, /optional in opportunistic mode/);
  assert.match(opportunistic, /meta\.agent|agent: "\/root\/task-slug"/);
  const base = subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: "orchestration" })!;
  const full = subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: "orchestration", checklistIntegration: true }, true)!;
  assert.ok(full.startsWith(base), "existing prompt is preserved verbatim; guidance is appended");
  assert.ok(Object.keys({ agent: "/root/research-checklist-integration" }).every((key) => key.length <= 40));
});

type Harness = {
  hooks: Map<string, Function>;
  ctx: ExtensionContext;
  dir: string;
  session: SessionManager;
  prompt(): Promise<string | undefined>;
  start(): Promise<void>;
};
async function withExtension(
  t: TestContext,
  options: { settings: Partial<ManagerSettings>; tools?: (file: string) => FakeTool[]; version?: string; prefs?: unknown },
): Promise<Harness> {
  const dir = temp(t);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(join(dir, "subagent-manager"), { recursive: true });
  writeFileSync(join(dir, "subagent-manager", "settings.json"), JSON.stringify(options.settings));
  if (options.prefs !== undefined) writeFileSync(join(dir, "pi-checklist.json"), JSON.stringify(options.prefs));
  markImportOffered(dir);
  const file = installPackage(dir, "ext", { name: "pi-checklist", version: options.version ?? "3.0.0" });
  const toolList = (options.tools ?? ((f) => checklistTools(f)))(file);
  const session = SessionManager.inMemory(dir);
  const hooks = new Map<string, Function>();
  const pi = {
    getCommands: () => [],
    events: { emit() {}, on() { return () => {}; } },
    registerTool() {},
    registerCommand() {},
    on: (name: string, handler: Function) => hooks.set(name, handler),
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    sendMessage() {},
    ...fakePi(toolList),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: dir,
    sessionManager: session,
    hasUI: false,
    mode: "print",
    isProjectTrusted: () => false,
    ui: { setStatus() {}, setWidget() {}, notify() {} },
  } as unknown as ExtensionContext;
  piSubagent(pi);
  t.after(async () => {
    await hooks.get("session_shutdown")?.({}, ctx);
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  });
  const start = async () => void (await hooks.get("session_start")!({ reason: "startup" }, ctx));
  await start();
  return {
    hooks, ctx, dir, session, start,
    prompt: async () => (await hooks.get("before_agent_start")!({ systemPrompt: "Main", prompt: "Work" }, ctx))?.systemPrompt,
  };
}

test("root prompt: checklist guidance tracks live eligibility every turn", async (t) => {
  const h = await withExtension(t, { settings: { subagentMode: "orchestration", checklistIntegration: true } });
  assert.doesNotMatch((await h.prompt())!, GUIDANCE, "meta disabled: no guidance");
  h.session.appendCustomEntry(CHECKLIST_ENTRY, snapshot(true));
  const enabled = (await h.prompt())!;
  assert.match(enabled, GUIDANCE);
  assert.match(enabled, /MUST use checklist_create/);
  assert.ok(enabled.startsWith("Main\n\n"), "existing system prompt preserved");
  h.session.appendCustomEntry(CHECKLIST_ENTRY, snapshot(false));
  assert.doesNotMatch((await h.prompt())!, GUIDANCE, "local /checklist settings no-meta removes it next turn");
});

test("root prompt: no guidance without opt-in, wrong version, missing tools or off mode", async (t) => {
  const optedOut = await withExtension(t, { settings: { subagentMode: "orchestration" }, prefs: { metaEnabled: true } });
  assert.doesNotMatch((await optedOut.prompt())!, GUIDANCE);
  const old = await withExtension(t, { settings: { subagentMode: "orchestration", checklistIntegration: true }, version: "2.9.0", prefs: { metaEnabled: true } });
  assert.doesNotMatch((await old.prompt())!, GUIDANCE);
  const missing = await withExtension(t, { settings: { subagentMode: "orchestration", checklistIntegration: true }, tools: () => [], prefs: { metaEnabled: true } });
  assert.doesNotMatch((await missing.prompt())!, GUIDANCE);
  const inactiveOnly = await withExtension(t, {
    settings: { subagentMode: "opportunistic", checklistIntegration: true },
    tools: (file) => checklistTools(file, { checklist_read: { name: "checklist_read", exposure: "hidden", sourceInfo: { path: file } } }),
    prefs: { metaEnabled: true },
  });
  assert.doesNotMatch((await inactiveOnly.prompt())!, GUIDANCE);
  const off = await withExtension(t, { settings: { subagentMode: "off", checklistIntegration: true }, prefs: { metaEnabled: true } });
  assert.equal(await off.prompt(), undefined);
});

test("root prompt: opportunistic gets optional wording; reseeding follows global > branch > off", async (t) => {
  const h = await withExtension(t, { settings: { subagentMode: "opportunistic", checklistIntegration: true }, prefs: { metaEnabled: true } });
  const prompt = (await h.prompt())!;
  assert.match(prompt, GUIDANCE);
  assert.doesNotMatch(prompt, /MUST use checklist/);
  // Cross-session write of global false is not live: the local closure keeps true until reseed.
  writeFileSync(join(h.dir, "pi-checklist.json"), JSON.stringify({ metaEnabled: false }));
  assert.match((await h.prompt())!, GUIDANCE);
  await h.hooks.get("session_tree")!({}, h.ctx);
  assert.doesNotMatch((await h.prompt())!, GUIDANCE, "navigation reseeds from explicit global false, ignoring snapshots");
  // Global removed: latest branch snapshot decides.
  rmSync(join(h.dir, "pi-checklist.json"));
  h.session.appendCustomEntry(CHECKLIST_ENTRY, snapshot(true));
  await h.start();
  assert.match((await h.prompt())!, GUIDANCE);
});

test("worker prompts never receive the root checklist requirement", async () => {
  const { readFileSync } = await import("node:fs");
  const runtime = readFileSync(new URL("../src/orch/runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtime, /checklistGuidance|checklistIntegration|subagentPrompt\(/);
  const prompt = readFileSync(new URL("../src/orch/prompt.ts", import.meta.url), "utf8");
  assert.match(prompt, /Root-only guidance/);
});
