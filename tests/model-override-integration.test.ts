import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const ALT = "integration-test/offline-alt";
const BASE = "integration-test/offline";
const definition = (name: string, models: string[]) =>
  `---\nname: ${name}\ndescription: Override test\nmodels:\n${models.map((model) => `  - ${model}`).join("\n")}\nthinkingLevel: low\ntools:\n  allow: []\n---\nFinish the task.\n`;
const answer = (model: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  provider: "integration-test",
  model,
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
type Listed = { name: string; models?: string[] }[];

test(
  "a per-spawn model choice reaches the real driver, is persisted narrowed, and survives reopen",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: { picker: definition("picker", [BASE, ALT]) },
        onRequest: (request) => answer(request.modelId),
      },
      async ({ cwd, directory, open, close, tool, requests, errors }) => {
        const root = SessionManager.create(cwd, `${directory}/parents`);
        // Pi writes a session file only once it holds an assistant message.
        root.appendMessage({ role: "user", content: "Parent context", timestamp: 1 });
        root.appendMessage(answer("offline"));
        let session = await open(root);
        const childModels = () =>
          requests.filter((request) => request.path !== null).map((request) => request.modelId);
        const types = await tool<Listed>(session, "agent_types", {});
        assert.deepEqual(types.find((t) => t.name === "picker")?.models, [BASE, ALT]);

        await assert.rejects(
          tool(session, "agent_spawn", {
            path: "bad",
            type: "picker",
            task: "Work",
            model: "integration-test/other",
          }),
          /allows models/,
        );
        assert.deepEqual(await tool(session, "agent_status", {}), [], "no thread was reserved");

        const worker = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "picker",
          task: "Work",
          model: `${ALT}:high`,
        });
        assert.equal(worker.state, "completed");
        assert.equal(childModels().at(-1), "offline-alt");

        // The narrowed definition (one model, thinking suffix applied) is what v2 persisted.
        const saved = registry(root).threads.find((t) => t.view.path === "/root/worker")!;
        assert.deepEqual(saved.definition.models, [ALT]);
        assert.equal(saved.definition.thinkingLevel, "high");
        await close(session);

        const reopened = SessionManager.open(root.getSessionFile()!);
        const restored = registry(reopened).threads.find((t) => t.view.path === "/root/worker")!;
        assert.deepEqual(restored.definition.models, [ALT]);
        assert.equal(restored.definition.thinkingLevel, "high");
        session = await open(reopened);
        await tool(session, "agent_steer", { path: "/root/worker", message: "again" });
        await tool(session, "agent_wait", { path: "/root/worker" });
        assert.equal(childModels().at(-1), "offline-alt", "resume keeps the chosen model");

        // A fresh spawn of the same type is unaffected by the earlier choice.
        await tool(session, "agent_spawn", { path: "other", type: "picker", task: "Work" });
        assert.equal(childModels().at(-1), "offline");
        await close(session);
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "a chosen model outside the parent's scoped models is not authorized",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: { picker: definition("picker", [BASE, ALT]) },
        scopedModels: [BASE],
        onRequest: (request) => answer(request.modelId),
      },
      async ({ cwd, open, close, tool, requests }) => {
        const session = await open(SessionManager.create(cwd));
        let outcome: ThreadView | undefined;
        try {
          outcome = await tool<ThreadView>(session, "agent_spawn", {
            path: "scoped",
            type: "picker",
            task: "Work",
            model: ALT,
          });
        } catch {
          /* rejection is an acceptable refusal */
        }
        assert.ok(
          outcome === undefined || outcome.state !== "completed",
          "the out-of-scope model must not complete",
        );
        assert.ok(
          !requests.some((request) => request.path !== null && request.modelId === "offline-alt"),
          "no provider request was made on the unscoped model",
        );
        await close(session);
      },
    );
  },
);

test(
  "Use Current lists no choosable models and refuses an override",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: { picker: definition("picker", [BASE, ALT]) },
        managerSettings: { modelSelection: "use-current" },
        onRequest: (request) => answer(request.modelId),
      },
      async ({ cwd, open, close, tool }) => {
        const session = await open(SessionManager.create(cwd));
        const types = await tool<Listed>(session, "agent_types", {});
        assert.equal(types.find((t) => t.name === "picker")?.models, undefined);
        await assert.rejects(
          tool(session, "agent_spawn", { path: "w", type: "picker", task: "Work", model: ALT }),
          /Use Current/,
        );
        await close(session);
      },
    );
  },
);
