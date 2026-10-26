import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverSubagentExtensions, selectSubagentExtensions } from "../src/orch/extensions.ts";

const managerEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("configured extension discovery respects trust, exclusions, packages and manager identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-extensions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "user");
  const cwd = path.join(root, "workspace");
  const userExtensions = path.join(agentDir, "extensions");
  const projectExtensions = path.join(cwd, ".pi", "extensions");
  await mkdir(userExtensions, { recursive: true });
  await mkdir(projectExtensions, { recursive: true });
  const user = path.join(userExtensions, "user.ts");
  const disabled = path.join(userExtensions, "disabled.ts");
  const project = path.join(projectExtensions, "project.ts");
  const configured = path.join(agentDir, "extra.ts");
  for (const file of [user, disabled, project, configured]) {
    await writeFile(file, 'throw new Error("Discovery must not execute factories")');
  }
  await symlink(managerEntry, path.join(userExtensions, "manager.ts"));
  const installedManager = path.join(agentDir, "manager-copy");
  const localPackage = path.join(agentDir, "local-package");
  for (const [directory, name] of [
    [installedManager, "pi-subagent-manager"],
    [localPackage, "example"],
  ]) {
    await mkdir(directory);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name, pi: { extensions: ["entry.ts"] } }),
    );
    await writeFile(
      path.join(directory, "entry.ts"),
      'throw new Error("Factory must not run during discovery")',
    );
  }
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: ["./extra.ts", "-extensions/disabled.ts"],
      packages: ["./manager-copy", "./local-package"],
    }),
  );
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      extensions: ["-extensions/project.ts"],
    }),
  );
  const discover = (projectTrusted: boolean) =>
    discoverSubagentExtensions({ cwd, agentDir, projectTrusted });
  const expected = [user, configured, path.join(localPackage, "entry.ts")].sort();
  assert.deepEqual((await discover(false)).sort(), expected);
  assert.deepEqual((await discover(true)).sort(), expected, "project exclusion honored");
  await writeFile(path.join(cwd, ".pi", "settings.json"), "{}");
  assert.deepEqual((await discover(true)).sort(), [...expected, project].sort());
  assert.deepEqual((await discover(false)).sort(), expected, "untrusted project files never load");
});

test("configured discovery skips missing packages rather than installing them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-missing-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "user");
  const cwd = path.join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const fakeNpm = path.join(root, "npm.cjs");
  const installMarker = path.join(root, "install-attempted");
  await writeFile(
    fakeNpm,
    `
    const fs = require("node:fs");
    if (process.argv.includes("install")) {
      fs.writeFileSync(${JSON.stringify(installMarker)}, "installation attempted");
      process.exit(1);
    }
    console.log(${JSON.stringify(path.join(root, "empty-global-root"))});
  `,
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      packages: ["npm:pi-subagent-missing-package-fixture@0.0.0"],
      npmCommand: [process.execPath, fakeNpm],
    }),
  );
  assert.deepEqual(await discoverSubagentExtensions({ cwd, agentDir, projectTrusted: false }), []);
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(installMarker), { code: "ENOENT" });
});

test("selection intersects trusted discovery and preserves legacy all/none", () => {
  const available = ["/a.ts", "/b.ts"];
  assert.deepEqual(selectSubagentExtensions(available, true), available);
  assert.deepEqual(selectSubagentExtensions(available, false), []);
  assert.deepEqual(selectSubagentExtensions(available, []), []);
  assert.deepEqual(selectSubagentExtensions(available, ["/b.ts", "/missing.ts"]), ["/b.ts"]);
});

test("auto-discovery includes standalone TS/JS and subdir entry points without configuration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-auto-extensions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Use a custom agent directory, not an assumed ~/.pi/agent location.
  const agentDir = path.join(root, "custom-agent-dir");
  const cwd = path.join(root, "workspace");
  const userDir = path.join(agentDir, "extensions");
  const projectDir = path.join(cwd, ".pi", "extensions");
  const files = [
    "standalone.ts",
    "standalone.js",
    "ts-dir/index.ts",
    "ts-dir/index.js",
    "js-dir/index.js",
  ];
  for (const base of [userDir, projectDir]) {
    for (const file of [
      ...files,
      "nested/no-entry/helper.ts",
      ".hidden.ts",
      "notes.txt",
      "ignored.ts",
    ]) {
      const target = path.join(base, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'throw new Error("Discovery must not execute factories")');
    }
    await writeFile(path.join(base, ".gitignore"), "ignored.ts\n");
    await symlink(managerEntry, path.join(base, "manager.ts"));
  }
  const entries = (base: string) =>
    ["standalone.ts", "standalone.js", "ts-dir/index.ts", "js-dir/index.js"].map((file) =>
      path.join(base, file),
    );
  const discover = (projectTrusted: boolean) =>
    discoverSubagentExtensions({ cwd, agentDir, projectTrusted });
  assert.deepEqual((await discover(false)).sort(), entries(userDir).sort());
  assert.deepEqual(
    (await discover(true)).sort(),
    [...entries(userDir), ...entries(projectDir)].sort(),
  );
  // Explicit exclusions must still win over auto-discovery.
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ extensions: ["-extensions/standalone.ts"] }),
  );
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({ extensions: ["-extensions/standalone.js"] }),
  );
  assert.deepEqual(
    (await discover(true)).sort(),
    [
      ...entries(userDir).filter((file) => file !== path.join(userDir, "standalone.ts")),
      ...entries(projectDir).filter((file) => file !== path.join(projectDir, "standalone.js")),
    ].sort(),
  );
});
