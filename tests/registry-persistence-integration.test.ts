import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { REGISTRY_V1, REGISTRY_V2, foldRegistry } from "../src/orch/registry.ts";
import type { ThreadView } from "../src/types.ts";
import { registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const agent = "---\nname: offline\ndescription: Offline worker\n---\nOFFLINE CHILD\n";

test("real sessions write one v2 base then small patches, and reopen to the same registry", async () => {
  await withOfflineHarness(
    { agentFiles: { offline: agent }, onRequest: (request) => answer(`answer ${request.call}`) },
    async ({ directory, cwd, errors, open, close, tool }) => {
      const root = SessionManager.create(cwd, path.join(directory, "parents"));
      root.appendMessage({ role: "user", content: "context ".repeat(500), timestamp: 1 });
      let session = await open(root);
      for (const name of ["one", "two", "three"]) {
        const done = await tool<ThreadView>(session, "agent_spawn", {
          path: name,
          type: "offline",
          task: `task ${name} ${"x".repeat(2000)}`,
        });
        assert.equal(done.state, "completed");
      }
      await tool(session, "agent_steer", { path: "/root/one", message: "again" });
      await tool(session, "agent_wait", { path: "/root/one" });
      await close(session);

      const entries = root
        .getEntries()
        .filter((e) => e.type === "custom" && e.customType.startsWith("pi-subagent:registry:"))
        .map((e) => e as { customType: string; data: any });
      assert.ok(entries.length > 6);
      assert.ok(
        entries.every((e) => e.customType === REGISTRY_V2),
        `no ${REGISTRY_V1} writes`,
      );
      assert.equal(entries.filter((e) => e.data.op === "base").length, 1);
      const patches = entries.filter((e) => e.data.op === "patch");
      const taskBytes = 3 * 2000;
      for (const e of patches) {
        const bytes = Buffer.byteLength(JSON.stringify(e.data));
        const inserts = e.data.ops.some((op: { kind: string }) => op.kind === "insert");
        if (!inserts) assert.ok(bytes < taskBytes, `non-insert patch of ${bytes} bytes`);
      }

      const reopened = SessionManager.open(root.getSessionFile()!);
      assert.deepEqual(
        registry(reopened).threads.map((t) => t.view.path),
        ["/root/one", "/root/two", "/root/three"],
      );
      session = await open(reopened);
      const listed = await tool<ThreadView[]>(session, "agent_status", {});
      assert.equal(listed.length, 3);
      assert.ok(listed.every((t) => t.state === "completed"));
      await close(session);
      assert.deepEqual(foldRegistry(reopened.getBranch())!.threads.length, 3);
      assert.deepEqual(errors, []);
    },
  );
});
