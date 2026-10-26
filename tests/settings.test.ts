import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_MANAGER_SETTINGS as DEFAULTS,
  loadManagerSettings,
  loadManagerSettingsLayers,
  saveManagerOverrides,
  setManagerProjectSettings,
  saveManagerSettings,
  SUBAGENT_MODES,
  MODEL_SELECTION_MODES,
  TOOL_FILTERING_MODES,
  WIDGET_MODES,
  type ModelSelectionMode,
  type SubagentMode,
  type ToolFilteringMode,
  type WidgetMode,
  type ManagerSettings,
} from "../src/prefs/settings.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "user");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  return {
    root,
    cwd,
    agentDir,
    globalFile: join(agentDir, "subagent-manager", "settings.json"),
    projectFile: join(cwd, ".pi", "agent", "subagent-manager", "settings.json"),
  };
}

type Paths = { cwd: string; agentDir: string };

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value));
}

const load = (paths: Paths, includeProject = true) =>
  loadManagerSettings({ ...paths, includeProject });

const save = (paths: Paths, scope: "user" | "project", settings: unknown, includeProject = true) =>
  saveManagerSettings({ ...paths, includeProject, scope, settings: settings as ManagerSettings });

const settings = (
  maxLevels: number,
  maxConcurrent: number,
  maxThreads: number,
  modelSelection: ModelSelectionMode = "pick-first-scoped",
  subagentMode: SubagentMode = "opportunistic",
  toolFiltering: ToolFilteringMode = "allowed",
  widgetMode: WidgetMode = "full",
  nerdFontIcons = false,
  finalRecap = false,
) => ({ maxLevels, maxConcurrent, maxThreads, modelSelection, subagentMode, toolFiltering, widgetMode, costDisplay: "pi-footer-status", costValue: "subagents", costIcon: "money", nerdFontIcons, loaderStyle: "circle", finalRecap, subagentExtensions: false, checklistIntegration: false, housekeepingEnabled: false, housekeepingModel: "" });

const escape = (path: string) => new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

function rejects(fn: () => unknown, pattern: RegExp, path?: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.match(String(error), pattern);
    if (path !== undefined) assert.match(String(error), escape(path));
    return true;
  });
}

function assertNoTempFiles(directory: string): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) assert.ok(!name.endsWith(".tmp"), name);
}

test("missing files return a fresh copy of defaults without diagnostics", (t) => {
  const f = fixture(t);
  const result = load({ cwd: join(f.root, "nope"), agentDir: join(f.root, "nope2") });
  assert.deepEqual(result, {
    settings: {
      maxLevels: 3,
      maxConcurrent: 16,
      maxThreads: 64,
      modelSelection: "pick-first-scoped",
      subagentMode: "opportunistic",
      toolFiltering: "allowed",
      widgetMode: "full",
      costDisplay: "pi-footer-status",
      costValue: "subagents",
      costIcon: "money",
      nerdFontIcons: false,
      loaderStyle: "circle",
      finalRecap: false,
      subagentExtensions: false,
      checklistIntegration: false,
      housekeepingEnabled: false,
      housekeepingModel: "",
    },
    diagnostics: [],
  });
  result.settings.maxLevels = 99;
  assert.equal(DEFAULTS.maxLevels, 3);
});

test("project layer overrides global per key; untrusted project and stray files are ignored", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, {
    maxLevels: 32,
    maxConcurrent: Number.MAX_SAFE_INTEGER,
    modelSelection: "pick-first-available",
  });
  writeJson(f.projectFile, { maxConcurrent: 9, maxThreads: 1_000_000 });
  // Files outside the two scope paths are never read.
  writeJson(join(f.cwd, ".pi", "subagents.json"), { maxLevels: 9 });
  writeJson(join(f.cwd, ".pi", "agent", "settings.json"), { maxLevels: 8 });
  writeJson(join(f.agentDir, "settings.json"), { maxLevels: 7 });
  assert.deepEqual(load(f), {
    settings: settings(32, 9, 1_000_000, "pick-first-available"),
    diagnostics: [],
  });
  assert.deepEqual(load(f, false), {
    settings: {
      ...DEFAULTS,
      maxLevels: 32,
      maxConcurrent: Number.MAX_SAFE_INTEGER,
      modelSelection: "pick-first-available",
    },
    diagnostics: [],
  });
  writeJson(f.projectFile, { modelSelection: "pick-first-scoped" });
  assert.equal(load(f).settings.modelSelection, "pick-first-scoped");
});

test("invalid layer content is rejected with a diagnostic naming the file", (t) => {
  const f = fixture(t);
  const cases: [string, RegExp][] = [
    ["{", /Invalid JSON/],
    ["null", /must be a JSON object/],
    ["[]", /must be a JSON object/],
    ['"text"', /must be a JSON object/],
    ['{"maxLevels":1.5}', /maxLevels must be a positive safe integer/],
    ['{"maxThreads":0}', /maxThreads must be a positive safe integer/],
    ['{"maxConcurrent":"16"}', /maxConcurrent must be a positive safe integer/],
    ['{"maxThreads":9007199254740993}', /maxThreads must be a positive safe integer/],
    ['{"maxLevels":33}', /maxLevels must be <= 32/],
    ['{"scopedModelFiltering":"true"}', /scopedModelFiltering must be a boolean/],
    ['{"scopedModelFiltering":0}', /scopedModelFiltering must be a boolean/],
    ...["automatic", "Pick First (scoped)", true, null, 1, [], {}].map((modelSelection): [string, RegExp] => [
      JSON.stringify({ modelSelection }),
      /modelSelection must be pick-first-available, pick-first-scoped or use-current/,
    ]),
    ['{"subagentMode":"automatic"}', /subagentMode must be off, opportunistic or orchestration/],
    ['{"subagentMode":"Off"}', /subagentMode must be off, opportunistic or orchestration/],
    ['{"subagentMode":false}', /subagentMode must be off, opportunistic or orchestration/],
    ['{"subagentMode":null}', /subagentMode must be off, opportunistic or orchestration/],
    ...["automatic", "Allowed", true, null, 1, [], {}].map((toolFiltering): [string, RegExp] => [
      JSON.stringify({ toolFiltering }),
      /toolFiltering must be allowed, all-except-blocked or all/,
    ]),
    ...["automatic", "Full", true, null, 1, [], {}].map((widgetMode): [string, RegExp] => [
      JSON.stringify({ widgetMode }),
      /widgetMode must be full or minimal/,
    ]),
    ['{"maxLevels":2,"extra":1}', /Unknown settings key: extra/],
  ];
  for (const [content, pattern] of cases) {
    writeJson(f.globalFile, content);
    const result = load(f, false);
    assert.deepEqual(result.settings, DEFAULTS, content);
    assert.equal(result.diagnostics.length, 1, content);
    assert.match(result.diagnostics[0], escape(f.globalFile), content);
    assert.match(result.diagnostics[0], pattern, content);
  }
});

test("an invalid layer is ignored atomically while other layers still apply", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 5, maxConcurrent: 0 });
  writeJson(f.projectFile, { maxConcurrent: 11 });
  let result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULTS, maxConcurrent: 11 });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], escape(f.globalFile));

  writeJson(f.globalFile, { maxLevels: 5, modelSelection: "pick-first-available" });
  writeJson(f.projectFile, { maxLevels: 2, scopedModelFiltering: "no" });
  result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULTS, maxLevels: 5, modelSelection: "pick-first-available" });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], escape(f.projectFile));

  writeJson(f.globalFile, "{");
  writeJson(f.projectFile, "[]");
  assert.equal(load(f).diagnostics.length, 2);
});

test("all subagent modes save and load with trusted-project precedence", (t) => {
  const f = fixture(t);
  for (const mode of SUBAGENT_MODES) {
    const user = { ...DEFAULTS, subagentMode: mode };
    save(f, "user", user);
    assert.deepEqual(load(f, false), { settings: user, diagnostics: [] });
    assert.equal(JSON.parse(readFileSync(f.globalFile, "utf8")).subagentMode, mode);
    for (const projectMode of SUBAGENT_MODES) {
      writeJson(f.projectFile, { subagentMode: projectMode });
      assert.deepEqual(load(f), { settings: { ...user, subagentMode: projectMode }, diagnostics: [] });
      assert.equal(load(f, false).settings.subagentMode, mode);
    }
  }
});

test("invalid mode rejects the entire layer and preserves preceding settings", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { subagentMode: "off", maxLevels: 5 });
  writeJson(f.projectFile, { subagentMode: "automatic", maxLevels: 2 });
  const result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULTS, subagentMode: "off", maxLevels: 5 });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], escape(f.projectFile));
  assert.match(result.diagnostics[0], /subagentMode must be off, opportunistic or orchestration/);

  writeJson(f.globalFile, { subagentMode: "orchestration", maxLevels: 0 });
  writeJson(f.projectFile, { maxThreads: 8 });
  assert.deepEqual(load(f).settings, { ...DEFAULTS, maxThreads: 8 });
});

test("unreadable settings file is ignored", (t) => {
  if (process.getuid?.() === 0) return t.skip("root bypasses mode 000");
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 4 });
  chmodSync(f.globalFile, 0o000);
  try {
    const result = load(f, false);
    assert.deepEqual(result.settings, DEFAULTS);
    assert.match(result.diagnostics[0], /EACCES|permission/i);
  } finally {
    chmodSync(f.globalFile, 0o600);
  }
});

test("symlinks anywhere in an owned scope path are refused on load and save", (t) => {
  type Case = { scope: "user" | "project"; link: (f: ReturnType<typeof fixture>) => string };
  const cases: Case[] = [
    { scope: "user", link: (f) => f.globalFile },
    { scope: "user", link: (f) => dirname(f.globalFile) },
    { scope: "user", link: (f) => f.agentDir },
    { scope: "project", link: (f) => f.cwd },
    { scope: "project", link: (f) => join(f.cwd, ".pi") },
    { scope: "project", link: (f) => join(f.cwd, ".pi", "agent") },
    { scope: "project", link: (f) => dirname(f.projectFile) },
    { scope: "project", link: (f) => f.projectFile },
  ];
  for (const { scope, link: pick } of cases) {
    const f = fixture(t);
    const link = pick(f);
    const file = scope === "user" ? f.globalFile : f.projectFile;
    const isFile = link === file;
    const target = join(f.root, "outside");
    const targetFile = isFile ? target : join(target, relative(link, file));
    writeJson(targetFile, { maxLevels: 9 });
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);

    const result = load(f);
    assert.equal(result.settings.maxLevels, DEFAULTS.maxLevels, link);
    assert.match(result.diagnostics[0], /Unsafe symlink path/, link);
    assert.match(result.diagnostics[0], escape(link), link);

    rejects(() => save(f, scope, settings(1, 1, 1)), /Unsafe symlink path/, link);
    assert.equal(readFileSync(targetFile, "utf8"), '{"maxLevels":9}', link);
    if (!isFile) assert.deepEqual(readdirSync(dirname(targetFile)), ["settings.json"], link);
    assert.ok(lstatSync(link).isSymbolicLink(), link);
  }
});

test("symlinked ancestors above the owned scope directories are accepted", (t) => {
  const f = fixture(t);
  const linked = join(f.root, "linked-parent");
  mkdirSync(join(f.root, "real-parent"));
  symlinkSync(join(f.root, "real-parent"), linked);
  const paths = { cwd: join(linked, "project"), agentDir: join(linked, "user") };
  mkdirSync(paths.cwd);
  mkdirSync(paths.agentDir);
  save(paths, "user", settings(4, 5, 6));
  save(paths, "project", settings(2, 7, 8));
  assert.deepEqual(load(paths), { settings: settings(2, 7, 8), diagnostics: [] });
});

test("wrong file types at scope paths are refused on load and save", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "subagent-manager"), "not a directory");
  assert.match(load(f, false).diagnostics[0], /Settings directory must be a directory/);
  rejects(() => save(f, "user", settings(1, 1, 1)), /Settings directory must be a directory/);

  mkdirSync(f.projectFile, { recursive: true });
  assert.match(load(f).diagnostics[1], /Settings must be a regular file/);
  rejects(
    () => save(f, "project", settings(1, 1, 1)),
    /Settings must be a regular file/,
    f.projectFile,
  );
  assert.ok(lstatSync(f.projectFile).isDirectory());

  for (const [paths, missing] of [
    [{ ...f, agentDir: join(f.root, "missing-user") }, join(f.root, "missing-user")],
    [{ ...f, cwd: join(f.root, "missing-project") }, join(f.root, "missing-project")],
  ] as const) {
    const scope = missing.endsWith("user") ? "user" : "project";
    rejects(
      () => save(paths, scope, settings(1, 1, 1)),
      /Settings directory must be a directory/,
      missing,
    );
    assert.equal(existsSync(missing), false);
  }
});

test("save writes canonical 0600 files, creates owned directories, and reloads with precedence", (t) => {
  const f = fixture(t);
  const user = settings(4, 5, 6, "pick-first-available");
  assert.equal(save(f, "user", user, false), f.globalFile);
  assert.equal(readFileSync(f.globalFile, "utf8"), `${JSON.stringify(user, null, 2)}\n`);
  assert.equal(lstatSync(f.globalFile).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.cwd, ".pi")), false);
  assert.deepEqual(load(f, false), { settings: user, diagnostics: [] });

  chmodSync(f.globalFile, 0o644);
  save(f, "user", user);
  assert.equal(lstatSync(f.globalFile).mode & 0o777, 0o600, "overwrite restores 0600");

  const reordered = {
    widgetMode: "full",
      costDisplay: "pi-footer-status",
      costValue: "subagents",
      costIcon: "money",
    nerdFontIcons: false,
    loaderStyle: "circle",
    finalRecap: false,
    subagentExtensions: false,
    checklistIntegration: false,
    housekeepingEnabled: false,
    housekeepingModel: "",
    subagentMode: "opportunistic",
    toolFiltering: "allowed",
    modelSelection: "pick-first-scoped",
    maxThreads: 9,
    maxLevels: 3,
    maxConcurrent: 11,
  };
  assert.equal(save(f, "project", reordered), f.projectFile);
  assert.equal(
    readFileSync(f.projectFile, "utf8"),
    `${JSON.stringify(settings(3, 11, 9), null, 2)}\n`,
  );
  for (const dir of [join(f.cwd, ".pi"), join(f.cwd, ".pi", "agent"), dirname(f.projectFile)])
    assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), dir);
  assert.deepEqual(readdirSync(dirname(f.projectFile)), ["settings.json"]);
  assert.deepEqual(load(f).settings, settings(3, 11, 9));
  assert.deepEqual(load(f, false).settings, user);
  assertNoTempFiles(dirname(f.globalFile));
});

test("invalid save input never creates or mutates files", (t) => {
  const f = fixture(t);
  rejects(() => save(f, "user", settings(0, 1, 1)), /maxLevels must be a positive safe integer/);
  assert.equal(existsSync(dirname(f.globalFile)), false);

  save(f, "user", settings(4, 5, 6));
  save(f, "project", settings(2, 3, 4));
  const before = [f.globalFile, f.projectFile].map((p) => [readFileSync(p), lstatSync(p).ino]);
  const invalid: [unknown, RegExp][] = [
    [settings(33, 1, 1), /maxLevels must be <= 32/],
    [settings(1, 1.5, 1), /maxConcurrent must be a positive safe integer/],
    [
      { ...settings(1, 1, 1), maxThreads: 9007199254740993 },
      /maxThreads must be a positive safe integer/,
    ],
    [
      { maxLevels: 1, maxConcurrent: 1, modelSelection: "pick-first-scoped" },
      /maxThreads must be a positive safe integer/,
    ],
    [{ maxLevels: 1, maxConcurrent: 1, maxThreads: 1 }, /modelSelection must be/],
    [
      { ...settings(1, 1, 1), modelSelection: "invalid" },
      /modelSelection must be/,
    ],
    ...["automatic", "Pick First (scoped)", true, null, 1, [], {}].map((modelSelection): [unknown, RegExp] => [
      { ...settings(1, 1, 1), modelSelection },
      /modelSelection must be pick-first-available, pick-first-scoped or use-current/,
    ]),
    [
      { ...settings(1, 1, 1), subagentMode: "automatic" },
      /subagentMode must be off, opportunistic or orchestration/,
    ],
    [
      { maxLevels: 1, maxConcurrent: 1, maxThreads: 1, modelSelection: "pick-first-scoped" },
      /subagentMode must be off, opportunistic or orchestration/,
    ],
    ...["automatic", "Allowed", false, null, 1, [], {}].map((toolFiltering): [unknown, RegExp] => [
      { ...settings(1, 1, 1), toolFiltering },
      /toolFiltering must be allowed, all-except-blocked or all/,
    ]),
    [
      {
        maxLevels: 1,
        maxConcurrent: 1,
        maxThreads: 1,
        modelSelection: "pick-first-scoped",
        subagentMode: "off",
      },
      /toolFiltering must be allowed, all-except-blocked or all/,
    ],
    ...["automatic", "Full", false, null, 1, [], {}].map((widgetMode): [unknown, RegExp] => [
      { ...settings(1, 1, 1), widgetMode },
      /widgetMode must be full or minimal/,
    ]),
    [{ ...settings(1, 1, 1), widgetMode: undefined }, /widgetMode must be full or minimal/],
    [{ ...settings(1, 1, 1), extra: 1 }, /Unknown settings key: extra/],
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
  ];
  for (const [value, pattern] of invalid) {
    rejects(() => save(f, "user", value), pattern);
    rejects(() => save(f, "project", value), pattern);
  }
  assert.deepEqual(
    [f.globalFile, f.projectFile].map((p) => [readFileSync(p), lstatSync(p).ino]),
    before,
  );
  assertNoTempFiles(dirname(f.globalFile));
  assertNoTempFiles(dirname(f.projectFile));
});

test("untrusted project saves and unknown scopes are rejected without touching disk", (t) => {
  const f = fixture(t);
  rejects(() => save(f, "project", settings(1, 1, 1), false), /not enabled\/trusted/);
  assert.equal(existsSync(join(f.cwd, ".pi")), false);
  rejects(() => save(f, "global" as "user", settings(1, 1, 1)), /Invalid settings scope/);
  assert.equal(existsSync(join(f.agentDir, "subagent-manager")), false);
});

test("all tool filtering modes save and load with trusted-project precedence", (t) => {
  const f = fixture(t);
  for (const mode of TOOL_FILTERING_MODES) {
    const user = { ...DEFAULTS, toolFiltering: mode };
    save(f, "user", user);
    assert.deepEqual(load(f, false), { settings: user, diagnostics: [] });
    assert.equal(JSON.parse(readFileSync(f.globalFile, "utf8")).toolFiltering, mode);
    for (const projectMode of TOOL_FILTERING_MODES) {
      const project = { ...user, toolFiltering: projectMode };
      save(f, "project", project);
      assert.deepEqual(load(f), { settings: project, diagnostics: [] });
      assert.equal(JSON.parse(readFileSync(f.projectFile, "utf8")).toolFiltering, projectMode);
      assert.equal(load(f, false).settings.toolFiltering, mode);
    }
  }
});

test("invalid tool filtering rejects its entire layer and preserves preceding settings", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { toolFiltering: "all", maxLevels: 5 });
  writeJson(f.projectFile, { toolFiltering: "invalid", maxLevels: 2 });
  const result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULTS, toolFiltering: "all", maxLevels: 5 });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], escape(f.projectFile));
  assert.match(result.diagnostics[0], /toolFiltering must be allowed, all-except-blocked or all/);
});

test("all model selection modes save and load with trusted-project precedence", (t) => {
  const f = fixture(t);
  for (const mode of MODEL_SELECTION_MODES) {
    const user = { ...DEFAULTS, modelSelection: mode };
    save(f, "user", user);
    assert.deepEqual(load(f, false), { settings: user, diagnostics: [] });
    const stored = JSON.parse(readFileSync(f.globalFile, "utf8"));
    assert.equal(stored.modelSelection, mode);
    assert.equal(Object.hasOwn(stored, "scopedModelFiltering"), false);
    for (const projectMode of MODEL_SELECTION_MODES) {
      writeJson(f.projectFile, { modelSelection: projectMode });
      assert.deepEqual(load(f), { settings: { ...user, modelSelection: projectMode }, diagnostics: [] });
      assert.equal(load(f, false).settings.modelSelection, mode);
    }
  }
});

test("legacy filtering migrates per layer; explicit model selection wins and saves canonically", (t) => {
  const f = fixture(t);
  for (const [legacy, mode] of [[true, "pick-first-scoped"], [false, "pick-first-available"]] as const) {
    writeJson(f.globalFile, { scopedModelFiltering: legacy });
    const migrated = load(f, false);
    assert.deepEqual(migrated, { settings: { ...DEFAULTS, modelSelection: mode }, diagnostics: [] });
    save(f, "user", migrated.settings);
    const stored = JSON.parse(readFileSync(f.globalFile, "utf8"));
    assert.equal(stored.modelSelection, mode);
    assert.equal(Object.hasOwn(stored, "scopedModelFiltering"), false);
    for (const explicit of MODEL_SELECTION_MODES) {
      writeJson(f.globalFile, { scopedModelFiltering: legacy, modelSelection: explicit });
      assert.equal(load(f, false).settings.modelSelection, explicit);
    }
  }
  writeJson(f.globalFile, { modelSelection: "use-current" });
  writeJson(f.projectFile, { scopedModelFiltering: false });
  assert.equal(load(f).settings.modelSelection, "pick-first-available");
  assert.equal(load(f, false).settings.modelSelection, "use-current");
  writeJson(f.globalFile, { scopedModelFiltering: false });
  writeJson(f.projectFile, { modelSelection: "use-current" });
  assert.equal(load(f).settings.modelSelection, "use-current");
});

test("invalid model selection rejects its entire layer and does not fall back to legacy filtering", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { modelSelection: "use-current", maxLevels: 5 });
  writeJson(f.projectFile, { modelSelection: "invalid", scopedModelFiltering: true, maxLevels: 2 });
  const result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULTS, modelSelection: "use-current", maxLevels: 5 });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], escape(f.projectFile));
  assert.match(result.diagnostics[0], /modelSelection must be pick-first-available, pick-first-scoped or use-current/);
});

test("both widget modes save and load with trusted-project precedence", (t) => {
  const f = fixture(t);
  for (const mode of WIDGET_MODES) {
    const user = { ...DEFAULTS, widgetMode: mode };
    save(f, "user", user);
    assert.deepEqual(load(f, false), { settings: user, diagnostics: [] });
    assert.equal(JSON.parse(readFileSync(f.globalFile, "utf8")).widgetMode, mode);
    for (const projectMode of WIDGET_MODES) {
      const project = { ...user, widgetMode: projectMode };
      save(f, "project", project);
      assert.deepEqual(load(f), { settings: project, diagnostics: [] });
      assert.equal(JSON.parse(readFileSync(f.projectFile, "utf8")).widgetMode, projectMode);
      assert.equal(load(f, false).settings.widgetMode, mode);
    }
  }
});

test("legacy settings without widgetMode keep full mode; invalid mode ignores its entire layer", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 5 });
  assert.equal(load(f).settings.widgetMode, "full");
  writeJson(f.globalFile, { widgetMode: "minimal", maxLevels: 5 });
  writeJson(f.projectFile, { widgetMode: "invalid", maxLevels: 2 });
  const result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULTS, widgetMode: "minimal", maxLevels: 5 });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], escape(f.projectFile));
  assert.match(result.diagnostics[0], /widgetMode must be full or minimal/);
});

test("Final Recap defaults off, layers by key, and saves in both scopes", (t) => {
  const f = fixture(t);
  assert.equal(load(f).settings.finalRecap, false);
  writeJson(f.globalFile, { maxLevels: 5 });
  assert.equal(load(f).settings.finalRecap, false, "legacy files keep the default");
  save(f, "user", { ...DEFAULTS, finalRecap: true, nerdFontIcons: true });
  assert.equal(JSON.parse(readFileSync(f.globalFile, "utf8")).finalRecap, true);
  writeJson(f.projectFile, { maxLevels: 4 });
  assert.equal(load(f).settings.finalRecap, true, "missing project key inherits global");
  writeJson(f.projectFile, { finalRecap: false });
  assert.deepEqual(load(f), { settings: { ...DEFAULTS, nerdFontIcons: true }, diagnostics: [] });
  assert.equal(load(f, false).settings.finalRecap, true, "untrusted project does not override global");
  save(f, "project", { ...DEFAULTS, finalRecap: true });
  assert.equal(JSON.parse(readFileSync(f.projectFile, "utf8")).finalRecap, true);
  assert.equal(load(f).settings.finalRecap, true);
  save(f, "project", { ...DEFAULTS, finalRecap: false });
  assert.equal(load(f).settings.finalRecap, false);
});

test("Final Recap rejects non-booleans atomically when loading and saving", (t) => {
  const f = fixture(t);
  save(f, "user", { ...DEFAULTS, finalRecap: true, maxLevels: 5 });
  const before = readFileSync(f.globalFile, "utf8");
  for (const invalid of ["true", "false", 0, 1, null, [], {}]) {
    writeJson(f.projectFile, { finalRecap: invalid, maxLevels: 2 });
    const result = load(f);
    assert.deepEqual(result.settings, { ...DEFAULTS, finalRecap: true, maxLevels: 5 });
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0], escape(f.projectFile));
    assert.match(result.diagnostics[0], /finalRecap must be a boolean/);
    rejects(() => save(f, "user", { ...DEFAULTS, finalRecap: invalid }), /finalRecap must be a boolean/);
    assert.equal(readFileSync(f.globalFile, "utf8"), before);
  }
});


test("cost display defaults to a discoverable status key and validates all modes", (t) => {
  const f = fixture(t);
  assert.equal(load(f).settings.costDisplay, "pi-footer-status");
  for (const costDisplay of ["pi-footer-event", "pi-footer-status", "pi-status"] as const) {
    save(f, "user", { ...DEFAULTS, costDisplay });
    assert.equal(load(f, false).settings.costDisplay, costDisplay);
    save(f, "project", { ...DEFAULTS, costDisplay });
    assert.equal(load(f).settings.costDisplay, costDisplay);
  }
  for (const invalid of ["auto", "", true, 0, null, [], {}]) {
    writeJson(f.projectFile, { costDisplay: invalid });
    const result = load(f);
    assert.equal(result.settings.costDisplay, "pi-status");
    assert.match(result.diagnostics[0], /costDisplay must be/);
    rejects(() => save(f, "user", { ...DEFAULTS, costDisplay: invalid }), /costDisplay must be/);
  }
});


test("cost value and icon settings round-trip independently with per-key precedence", (t) => {
  const f = fixture(t);
  assert.equal(load(f).settings.costValue, "subagents");
  assert.equal(load(f).settings.costIcon, "money");
  for (const costValue of ["subagents", "total"] as const) {
    for (const costIcon of ["money", "coins", "wallet"] as const) {
      for (const scope of ["user", "project"] as const) {
        save(f, scope, { ...DEFAULTS, costValue, costIcon });
        const loaded = load(f, scope === "project");
        assert.equal(loaded.settings.costValue, costValue);
        assert.equal(loaded.settings.costIcon, costIcon);
        assert.deepEqual(loaded.diagnostics, []);
      }
    }
  }
  writeJson(f.globalFile, { costValue: "total", costIcon: "coins" });
  writeJson(f.projectFile, { costIcon: "wallet" });
  assert.equal(load(f).settings.costValue, "total");
  assert.equal(load(f).settings.costIcon, "wallet");
});

test("invalid cost values and icons reject the entire layer and refuse saving", (t) => {
  const f = fixture(t);
  for (const key of ["costValue", "costIcon"] as const) {
    for (const invalid of ["", "unknown", true, 0, null, [], {}]) {
      writeJson(f.projectFile, { [key]: invalid, maxThreads: 1 });
      const loaded = load(f);
      assert.deepEqual(loaded.settings, DEFAULTS);
      assert.match(loaded.diagnostics[0], new RegExp(key + " must be"));
      rejects(() => save(f, "user", { ...DEFAULTS, [key]: invalid }), new RegExp(key + " must be"));
    }
  }
});

test("subagent extensions preserve legacy booleans and reject invalid scalar settings", (t) => {
  const f = fixture(t);
  assert.equal(load(f).settings.subagentExtensions, false);
  save(f, "user", { ...DEFAULTS, subagentExtensions: true });
  assert.equal(load(f).settings.subagentExtensions, true);
  save(f, "project", { ...DEFAULTS, subagentExtensions: false });
  assert.equal(load(f).settings.subagentExtensions, false);
  assert.equal(load(f, false).settings.subagentExtensions, true);
  writeJson(f.projectFile, { subagentExtensions: "true" });
  const invalid = load(f);
  assert.equal(invalid.settings.subagentExtensions, true);
  assert.match(invalid.diagnostics.join("\n"), /subagentExtensions must be a boolean/);
  rejects(() => save(f, "user", { ...DEFAULTS, subagentExtensions: 1 }), /must be a boolean/);
});

test("layer snapshots preserve validated provenance, precedence and legacy normalization", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  assert.deepEqual(loadManagerSettingsLayers(options), {
    settings: DEFAULTS, diagnostics: [], global: {}, project: {}, scope: "user",
  });
  writeJson(f.globalFile, { maxLevels: 5, scopedModelFiltering: false, finalRecap: true });
  writeJson(f.projectFile, { maxLevels: 2, finalRecap: false });
  const loaded = loadManagerSettingsLayers(options);
  assert.deepEqual(loaded.global, {
    maxLevels: 5, modelSelection: "pick-first-available", finalRecap: true,
  });
  assert.deepEqual(loaded.project, { maxLevels: 2, finalRecap: false });
  assert.deepEqual(loaded.settings, {
    ...DEFAULTS, maxLevels: 2, modelSelection: "pick-first-available",
  });
  assert.equal(loaded.scope, "project");
  assert.deepEqual(loaded.diagnostics, []);
  loaded.global.maxLevels = 20;
  loaded.project.finalRecap = true;
  assert.equal(loaded.settings.maxLevels, 2);
  assert.equal(loaded.settings.finalRecap, false);
  assert.equal(loadManagerSettingsLayers(options).global.maxLevels, 5);
});

test("layer scope follows this project's file rather than legacy cross-project UI preference", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  const uiStateFile = join(f.agentDir, "subagent-manager", "ui-state.json");
  writeJson(uiStateFile, { saveScope: "project" });
  assert.equal(loadManagerSettingsLayers(options).scope, "user");
  writeJson(f.projectFile, {});
  writeJson(uiStateFile, { saveScope: "user" });
  assert.equal(loadManagerSettingsLayers(options).scope, "project");
  const otherCwd = join(f.root, "other-project");
  mkdirSync(otherCwd);
  assert.equal(loadManagerSettingsLayers({ ...options, cwd: otherCwd }).scope, "user");
  assert.deepEqual(loadManagerSettingsLayers({ ...options, includeProject: false }), {
    settings: DEFAULTS, diagnostics: [], global: {}, project: {}, scope: "user",
  });
});

test("invalid regular layers have no provenance but project files still select Project", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 5 });
  for (const invalid of ["{broken", [], { maxLevels: 2, unknown: true }]) {
    writeJson(f.projectFile, invalid);
    const loaded = loadManagerSettingsLayers({ ...f, includeProject: true });
    assert.equal(loaded.scope, "project");
    assert.deepEqual(loaded.project, {});
    assert.deepEqual(loaded.global, { maxLevels: 5 });
    assert.equal(loaded.settings.maxLevels, 5);
    assert.equal(loaded.diagnostics.length, 1);
    assert.match(loaded.diagnostics[0], escape(f.projectFile));
  }
  writeJson(f.globalFile, { maxLevels: 2, finalRecap: "invalid" });
  writeJson(f.projectFile, { maxConcurrent: 7 });
  const loaded = loadManagerSettingsLayers({ ...f, includeProject: true });
  assert.deepEqual(loaded.global, {});
  assert.deepEqual(loaded.project, { maxConcurrent: 7 });
  assert.deepEqual(loaded.settings, { ...DEFAULTS, maxConcurrent: 7 });
});

test("sparse saves inherit lower layers and do not snapshot unrelated values", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  assert.equal(saveManagerOverrides({ ...options, scope: "user", settings: {
    ...DEFAULTS, maxLevels: 5, finalRecap: true,
  } }), f.globalFile);
  assert.deepEqual(JSON.parse(readFileSync(f.globalFile, "utf8")), {
    maxLevels: 5, finalRecap: true,
  });
  const globalBefore = readFileSync(f.globalFile, "utf8");
  saveManagerOverrides({ ...options, scope: "project", settings: {
    ...load(f).settings, maxConcurrent: 7,
  } });
  assert.deepEqual(JSON.parse(readFileSync(f.projectFile, "utf8")), { maxConcurrent: 7 });
  assert.equal(readFileSync(f.globalFile, "utf8"), globalBefore);
  writeJson(f.globalFile, { maxLevels: 8, finalRecap: false, costValue: "total" });
  assert.deepEqual(load(f).settings, {
    ...DEFAULTS, maxLevels: 8, maxConcurrent: 7, costValue: "total",
  });
  saveManagerOverrides({ ...options, scope: "project", settings: load(f, false).settings });
  assert.equal(readFileSync(f.projectFile, "utf8"), "{}\n");
  assert.equal(loadManagerSettingsLayers(options).scope, "project", "empty layer preserves scope");
  assert.equal(lstatSync(f.projectFile).mode & 0o777, 0o600);
  assertNoTempFiles(dirname(f.projectFile));
});

test("saving built-in defaults in Project explicitly overrides changed global values", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 5, finalRecap: true, costIcon: "wallet" });
  saveManagerOverrides({ ...f, includeProject: true, scope: "project", settings: DEFAULTS });
  assert.deepEqual(JSON.parse(readFileSync(f.projectFile, "utf8")), {
    maxLevels: DEFAULTS.maxLevels, costIcon: DEFAULTS.costIcon, finalRecap: false,
  });
  assert.deepEqual(load(f).settings, DEFAULTS);
  saveManagerOverrides({ ...f, includeProject: true, scope: "user", settings: DEFAULTS });
  assert.equal(readFileSync(f.globalFile, "utf8"), "{}\n");
});

test("sparse saves validate complete drafts and trust before any filesystem changes", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  for (const scope of ["user", "project"] as const) {
    for (const value of [null, [], {}, { ...DEFAULTS, maxLevels: 33 }, { ...DEFAULTS, extra: true }]) {
      assert.throws(() => saveManagerOverrides({ ...options, scope, settings: value as ManagerSettings }));
      assert.equal(existsSync(dirname(f.globalFile)), false);
      assert.equal(existsSync(join(f.cwd, ".pi")), false);
    }
  }
  rejects(() => saveManagerOverrides({ ...options, includeProject: false, scope: "project", settings: DEFAULTS }), /not enabled\/trusted/);
  rejects(() => saveManagerOverrides({ ...options, scope: "global" as "user", settings: DEFAULTS }), /Invalid settings scope/);
  saveManagerOverrides({ ...options, scope: "user", settings: { ...DEFAULTS, maxLevels: 4 } });
  const before = readFileSync(f.globalFile, "utf8");
  rejects(() => saveManagerOverrides({ ...options, scope: "user", settings: { ...DEFAULTS, finalRecap: "bad" } as unknown as ManagerSettings }), /boolean/);
  assert.equal(readFileSync(f.globalFile, "utf8"), before);
});

test("project activation creates only an empty private layer and preserves existing contents", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  writeJson(f.globalFile, { maxLevels: 8 });
  const globalBefore = readFileSync(f.globalFile, "utf8");
  assert.equal(setManagerProjectSettings({ ...options, enabled: true }), f.projectFile);
  assert.equal(readFileSync(f.projectFile, "utf8"), "{}\n");
  assert.equal(lstatSync(f.projectFile).mode & 0o777, 0o600);
  assert.equal(load(f).settings.maxLevels, 8);
  assert.deepEqual(readdirSync(dirname(f.projectFile)), ["settings.json"]);
  for (const content of ['{"maxLevels":2}', "malformed settings JSON"]) {
    writeFileSync(f.projectFile, content);
    const ino = lstatSync(f.projectFile).ino;
    setManagerProjectSettings({ ...options, enabled: true });
    assert.equal(readFileSync(f.projectFile, "utf8"), content);
    assert.equal(lstatSync(f.projectFile).ino, ino);
  }
  assert.equal(readFileSync(f.globalFile, "utf8"), globalBefore);
});

test("project deactivation removes even malformed JSON but leaves directories and unrelated files", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  setManagerProjectSettings({ ...options, enabled: false });
  assert.equal(existsSync(join(f.cwd, ".pi")), false, "absence does not create folders");
  writeJson(f.globalFile, { maxLevels: 5 });
  writeJson(f.projectFile, "malformed JSON");
  const otherFile = join(dirname(f.projectFile), "keep.json");
  writeFileSync(otherFile, "keep");
  const directoryIno = lstatSync(dirname(f.projectFile)).ino;
  const globalBefore = readFileSync(f.globalFile, "utf8");
  assert.equal(setManagerProjectSettings({ ...options, enabled: false }), f.projectFile);
  assert.equal(existsSync(f.projectFile), false);
  assert.equal(lstatSync(dirname(f.projectFile)).ino, directoryIno);
  assert.equal(readFileSync(otherFile, "utf8"), "keep");
  assert.equal(readFileSync(f.globalFile, "utf8"), globalBefore);
  assert.equal(load(f).settings.maxLevels, 5);
  assert.equal(loadManagerSettingsLayers(options).scope, "user");
  setManagerProjectSettings({ ...options, enabled: false });
});

test("scope transitions require trust and a boolean without touching disk", (t) => {
  const f = fixture(t);
  for (const enabled of [false, true]) {
    rejects(() => setManagerProjectSettings({ ...f, includeProject: false, enabled }), /not enabled\/trusted/);
  }
  rejects(() => setManagerProjectSettings({ ...f, includeProject: true, enabled: "yes" as unknown as boolean }), /Invalid project settings state/);
  assert.equal(existsSync(join(f.cwd, ".pi")), false);
  assert.equal(existsSync(dirname(f.globalFile)), false);
});

test("new layer and persistence APIs reject project symlinks at every owned path", (t) => {
  for (const segments of [[], [".pi"], [".pi", "agent"], [".pi", "agent", "subagent-manager"], [".pi", "agent", "subagent-manager", "settings.json"]]) {
    const f = fixture(t);
    const link = join(f.cwd, ...segments);
    const target = join(f.root, "outside");
    const targetFile = link === f.projectFile ? target : join(target, relative(link, f.projectFile));
    writeJson(targetFile, { maxLevels: 9 });
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    const options = { ...f, includeProject: true };
    const loaded = loadManagerSettingsLayers(options);
    assert.equal(loaded.scope, "user");
    assert.deepEqual(loaded.project, {});
    assert.match(loaded.diagnostics[0], /Unsafe symlink path/);
    for (const enabled of [true, false]) {
      rejects(() => setManagerProjectSettings({ ...options, enabled }), /Unsafe symlink path/, link);
    }
    rejects(() => saveManagerOverrides({ ...options, scope: "project", settings: DEFAULTS }), /Unsafe symlink path/, link);
    assert.equal(readFileSync(targetFile, "utf8"), '{"maxLevels":9}');
    assert.ok(lstatSync(link).isSymbolicLink());
  }
});

test("new persistence APIs reject nonregular files and invalid owned directories", (t) => {
  for (const fileInsteadOfDirectory of [false, true]) {
    const f = fixture(t);
    const unsafe = fileInsteadOfDirectory ? join(f.cwd, ".pi") : f.projectFile;
    if (fileInsteadOfDirectory) writeFileSync(unsafe, "not a directory");
    else mkdirSync(unsafe, { recursive: true });
    const options = { ...f, includeProject: true };
    const pattern = fileInsteadOfDirectory ? /Settings directory must be a directory/ : /Settings must be a regular file/;
    assert.match(loadManagerSettingsLayers(options).diagnostics[0], pattern);
    for (const enabled of [true, false]) rejects(() => setManagerProjectSettings({ ...options, enabled }), pattern, unsafe);
    rejects(() => saveManagerOverrides({ ...options, scope: "project", settings: DEFAULTS }), pattern, unsafe);
    assert.ok(existsSync(unsafe));
  }
});

test("sparse Project saves normalize legacy values but reject malformed global baselines", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true, scope: "project" as const };
  writeJson(f.globalFile, { scopedModelFiltering: false, costValue: "total" });
  saveManagerOverrides({ ...options, settings: {
    ...DEFAULTS, modelSelection: "pick-first-available", costValue: "total", maxThreads: 90,
  } });
  assert.deepEqual(JSON.parse(readFileSync(f.projectFile, "utf8")), { maxThreads: 90 });
  writeJson(f.globalFile, { maxLevels: 5, finalRecap: "invalid" });
  const before = readFileSync(f.projectFile, "utf8");
  rejects(() => saveManagerOverrides({ ...options, settings: { ...DEFAULTS, maxConcurrent: 7 } }), /global settings are invalid/);
  assert.equal(readFileSync(f.projectFile, "utf8"), before);
  assert.equal(load(f).settings.maxLevels, DEFAULTS.maxLevels);
  assert.equal(load(f).settings.maxThreads, 90);
});

test("sparse Global saves reject unsafe global paths without reading untrusted Project", (t) => {
  const f = fixture(t);
  const target = join(f.root, "outside.json");
  writeJson(target, { maxLevels: 9 });
  mkdirSync(dirname(f.globalFile), { recursive: true });
  symlinkSync(target, f.globalFile);
  mkdirSync(dirname(f.projectFile), { recursive: true });
  symlinkSync(target, f.projectFile);
  const options = { ...f, includeProject: false };
  const loaded = loadManagerSettingsLayers(options);
  assert.equal(loaded.diagnostics.length, 1);
  assert.match(loaded.diagnostics[0], escape(f.globalFile));
  assert.deepEqual(loaded.global, {});
  assert.deepEqual(loaded.project, {});
  assert.equal(loaded.scope, "user");
  rejects(() => saveManagerOverrides({ ...options, scope: "user", settings: DEFAULTS }), /Unsafe symlink path/, f.globalFile);
  assert.equal(readFileSync(target, "utf8"), '{"maxLevels":9}');
  rmSync(f.globalFile);
  saveManagerOverrides({ ...options, scope: "user", settings: { ...DEFAULTS, maxLevels: 4 } });
  assert.deepEqual(JSON.parse(readFileSync(f.globalFile, "utf8")), { maxLevels: 4 });
  assert.equal(readFileSync(target, "utf8"), '{"maxLevels":9}');
});

test("expected layers prevent stale inherited drafts from snapshotting changed globals", (t) => {
  for (const scope of ["user", "project"] as const) {
    const f = fixture(t);
    const options = { ...f, includeProject: true };
    writeJson(f.globalFile, { maxLevels: 5 });
    if (scope === "project") writeJson(f.projectFile, { maxThreads: 90 });
    const expectedLayers = loadManagerSettingsLayers(options);
    const draft = { ...expectedLayers.settings, maxConcurrent: 7 };
    writeJson(f.globalFile, { maxLevels: 8 });
    const before = readFileSync(f.globalFile, "utf8");
    const projectBefore = scope === "project" ? readFileSync(f.projectFile, "utf8") : undefined;
    rejects(() => saveManagerOverrides({ ...options, scope, settings: draft, expectedLayers }), /changed on disk.*Reopen settings/);
    assert.equal(readFileSync(f.globalFile, "utf8"), before);
    if (projectBefore !== undefined) assert.equal(readFileSync(f.projectFile, "utf8"), projectBefore);
    else assert.equal(existsSync(join(f.cwd, ".pi")), false);
  }
});

test("snapshot comparison ignores property order while preserving known layer changes", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  writeJson(f.globalFile, { maxLevels: 5, finalRecap: true });
  writeJson(f.projectFile, { maxThreads: 90, costValue: "total" });
  const expectedLayers = loadManagerSettingsLayers(options);
  writeFileSync(f.globalFile, ' { "finalRecap": true, "maxLevels": 5 }\n');
  writeJson(f.projectFile, { costValue: "total", maxThreads: 90 });
  saveManagerOverrides({ ...options, scope: "project", settings: {
    ...expectedLayers.settings, maxConcurrent: 7,
  }, expectedLayers });
  assert.deepEqual(JSON.parse(readFileSync(f.projectFile, "utf8")), {
    maxConcurrent: 7, maxThreads: 90, costValue: "total",
  });
});

test("snapshot guards notice project edits, scope changes and diagnostic changes", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  for (const mutation of ["project-key", "project-created", "diagnostic", "trust"] as const) {
    rmSync(join(f.cwd, ".pi"), { recursive: true, force: true });
    writeJson(f.globalFile, { maxLevels: 5 });
    if (mutation === "project-key" || mutation === "trust") writeJson(f.projectFile, { maxThreads: 90 });
    const expectedLayers = loadManagerSettingsLayers(options);
    if (mutation === "project-key") writeJson(f.projectFile, { maxThreads: 100 });
    else if (mutation === "project-created") writeJson(f.projectFile, {});
    else if (mutation === "diagnostic") writeJson(f.globalFile, "{malformed");
    const currentOptions = { ...options, includeProject: mutation !== "trust" };
    rejects(() => saveManagerOverrides({ ...currentOptions, scope: "user", settings: expectedLayers.settings, expectedLayers }), /Reopen settings/);
  }
});

test("malformed global refuses Project saves without creating files, while Global can repair", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  writeJson(f.globalFile, "{malformed");
  const expectedLayers = loadManagerSettingsLayers(options);
  const settings = { ...DEFAULTS, maxConcurrent: 7 };
  const before = readFileSync(f.globalFile, "utf8");
  rejects(() => saveManagerOverrides({ ...options, scope: "project", settings, expectedLayers }), /global settings are invalid/);
  assert.equal(existsSync(join(f.cwd, ".pi")), false);
  assert.equal(readFileSync(f.globalFile, "utf8"), before);
  saveManagerOverrides({ ...options, scope: "user", settings, expectedLayers });
  assert.deepEqual(JSON.parse(readFileSync(f.globalFile, "utf8")), { maxConcurrent: 7 });
  assert.deepEqual(load(f).diagnostics, []);
});

test("snapshot guards prevent changed global values during both scope confirmations", (t) => {
  for (const enabled of [true, false]) {
    const f = fixture(t);
    const options = { ...f, includeProject: true };
    writeJson(f.globalFile, { maxLevels: 5 });
    if (!enabled) writeJson(f.projectFile, { maxThreads: 90 });
    const expectedLayers = loadManagerSettingsLayers(options);
    writeJson(f.globalFile, { maxLevels: 8 });
    rejects(() => setManagerProjectSettings({ ...options, enabled, expectedLayers }), /changed on disk.*Reopen settings/);
    if (enabled) assert.equal(existsSync(join(f.cwd, ".pi")), false);
    else assert.deepEqual(JSON.parse(readFileSync(f.projectFile, "utf8")), { maxThreads: 90 });
  }
});

test("scope guard permits equivalent property order and deletion with invalid global", (t) => {
  const f = fixture(t);
  const options = { ...f, includeProject: true };
  writeJson(f.globalFile, { maxLevels: 5, finalRecap: true });
  let expectedLayers = loadManagerSettingsLayers(options);
  writeJson(f.globalFile, { finalRecap: true, maxLevels: 5 });
  setManagerProjectSettings({ ...options, enabled: true, expectedLayers });
  assert.equal(readFileSync(f.projectFile, "utf8"), "{}\n");
  writeJson(f.globalFile, "{malformed");
  expectedLayers = loadManagerSettingsLayers(options);
  setManagerProjectSettings({ ...options, enabled: false, expectedLayers });
  assert.equal(existsSync(f.projectFile), false);
  assert.equal(readFileSync(f.globalFile, "utf8"), "{malformed");
  assert.equal(load(f).diagnostics.length, 1);
});

test("checklistIntegration is an opt-in boolean validated on load and save", (t) => {
  const f = fixture(t);
  assert.equal(load(f).settings.checklistIntegration, false);
  save(f, "user", { ...DEFAULTS, checklistIntegration: true });
  assert.equal(load(f).settings.checklistIntegration, true);
  writeJson(f.projectFile, { checklistIntegration: "yes" });
  const invalid = load(f);
  assert.equal(invalid.settings.checklistIntegration, true);
  assert.match(invalid.diagnostics.join("\n"), /checklistIntegration must be a boolean/);
  rejects(() => save(f, "user", { ...DEFAULTS, checklistIntegration: 1 }), /must be a boolean/);
});

test("housekeeping is an opt-in labs pair validated on load and save, persisting per scope", (t) => {
  const f = fixture(t);
  const defaults = load(f).settings;
  assert.equal(defaults.housekeepingEnabled, false);
  assert.equal(defaults.housekeepingModel, "");
  save(f, "user", { ...DEFAULTS, housekeepingEnabled: true, housekeepingModel: "anthropic/claude-haiku-5-5" });
  const saved = load(f).settings;
  assert.equal(saved.housekeepingEnabled, true);
  assert.equal(saved.housekeepingModel, "anthropic/claude-haiku-5-5");
  writeJson(f.projectFile, { housekeepingModel: "openai/gpt-5-mini" });
  const layered = load(f);
  assert.equal(layered.settings.housekeepingModel, "openai/gpt-5-mini");
  assert.equal(layered.settings.housekeepingEnabled, true, "unset project key inherits global");
  assert.equal(load(f, false).settings.housekeepingModel, "anthropic/claude-haiku-5-5", "untrusted project ignored");
  // Ids may contain slashes; only the first separates provider.
  writeJson(f.projectFile, { housekeepingModel: "openrouter/anthropic/claude-haiku" });
  assert.equal(load(f).settings.housekeepingModel, "openrouter/anthropic/claude-haiku");
  for (const bad of ["haiku", "a b/c", "/x", "x/"]) {
    writeJson(f.projectFile, { housekeepingModel: bad });
    assert.match(load(f).diagnostics.join("\n"), /housekeepingModel must be empty or provider\/model-id/, bad);
    rejects(() => save(f, "user", { ...DEFAULTS, housekeepingModel: bad }), /housekeepingModel must be empty or provider\/model-id/);
  }
  writeJson(f.projectFile, { housekeepingEnabled: "yes" });
  assert.match(load(f).diagnostics.join("\n"), /housekeepingEnabled must be a boolean/);
  rejects(() => save(f, "user", { ...DEFAULTS, housekeepingEnabled: 1 }), /must be a boolean/);
});


test("extension selections round-trip, override layers and compare structurally", (t) => {
  const f = fixture(t);
  const files = [join(f.agentDir, "a.ts"), join(f.agentDir, "b.ts")].sort();
  const options = { ...f, includeProject: true };
  save(f, "user", { ...DEFAULTS, subagentExtensions: files });
  assert.deepEqual(load(f).settings.subagentExtensions, files);
  const snapshot = loadManagerSettingsLayers(options);
  saveManagerOverrides({ ...options, scope: "project", settings: { ...snapshot.settings, subagentExtensions: [...files] }, expectedLayers: snapshot });
  assert.deepEqual(JSON.parse(readFileSync(f.projectFile, "utf8")), {});
  saveManagerOverrides({ ...options, scope: "project", settings: { ...snapshot.settings, subagentExtensions: [] } });
  assert.deepEqual(load(f).settings.subagentExtensions, []);
  for (const invalid of [["relative.ts"], [1], [null], {}]) {
    rejects(() => save(f, "user", { ...DEFAULTS, subagentExtensions: invalid }), /subagentExtensions must be/);
  }
});
