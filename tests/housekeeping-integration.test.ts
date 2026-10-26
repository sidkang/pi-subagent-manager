import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  withOfflineHarness,
  type LoggedRequest,
} from "./helpers/integrationHarness.ts";
import type { ManagerSettings } from "../src/prefs/settings.ts";
import type { ThreadView } from "../src/types.ts";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  ms = 8000,
) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

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
const toolCall = (name: string, args: Record<string, string | boolean>): AssistantMessage => ({
  ...answer(""),
  stopReason: "toolUse",
  content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
});
const isHousekeeping = (request: LoggedRequest) =>
  request.system.includes("You label what an AI agent");
const worker =
  "---\nname: worker\ndescription: Execute work\ntools:\n  allow: [read]\n---\nExecute your assigned task.\n";

/** Root spawns a detached worker that reads a file, then stays running until released. */
async function scenario(
  managerSettings: Partial<ManagerSettings>,
  housekeepingReply: (request: LoggedRequest) => AssistantMessage | Promise<AssistantMessage>,
  body: (ctx: {
    requests: LoggedRequest[];
    status(): Promise<ThreadView>;
    session: Awaited<ReturnType<Parameters<Parameters<typeof withOfflineHarness>[1]>[0]["open"]>>;
    release(): void;
    hk(): LoggedRequest[];
  }) => Promise<void>,
) {
  let release!: (message: AssistantMessage) => void;
  const finish = new Promise<AssistantMessage>((resolve) => {
    release = resolve;
  });
  await withOfflineHarness(
    {
      agentFiles: { worker },
      managerSettings,
      builtinTools: true,
      onRequest(request) {
        if (isHousekeeping(request)) return housekeepingReply(request);
        if (request.path)
          return request.pathCall === 1 ? toolCall("read", { path: "notes.txt" }) : finish;
        if (request.pathCall === 1)
          return toolCall("agent_spawn", {
            path: "reader",
            type: "worker",
            task: "Read the project notes",
            wait: false,
          });
        return answer("Delegated");
      },
    },
    async ({ cwd, errors, open, tool, requests }) => {
      await writeFile(join(cwd, "notes.txt"), "remember the milk\n");
      const session = await open(SessionManager.create(cwd));
      await session.prompt("Delegate reading the notes");
      const status = () => tool<ThreadView>(session, "agent_status", { path: "/root/reader" });
      await waitFor(
        async () =>
          (await status()).state === "running" && requests.some((r) => r.path && r.pathCall === 2),
        "worker running its second request",
      );
      await body({
        requests,
        status,
        session,
        release: () => release(answer("Notes read")),
        hk: () => requests.filter(isHousekeeping),
      });
      assert.deepEqual(errors, []);
      release(answer("Notes read"));
    },
  );
}

test(
  "enabled: the chosen model labels the running agent; the label is live-only and cleared on completion",
  { timeout: 30000 },
  async () => {
    await scenario(
      { housekeepingEnabled: true, housekeepingModel: "integration-test/offline-alt" },
      () => ({ ...answer('"Reading the project notes."'), model: "offline-alt" }),
      async ({ status, hk, session, release }) => {
        await waitFor(async () => (await status()).summary !== undefined, "summary applied", 15000);
        const view = await status();
        assert.equal(view.summary, "Reading the project notes");
        assert.equal(view.state, "running");
        assert.notEqual(
          view.status,
          view.summary,
          "raw activity status remains available alongside",
        );
        assert.equal(
          hk()[0]!.modelId,
          "offline-alt",
          "uses the selected housekeeping model, not the agent's",
        );
        assert.deepEqual(hk()[0]!.toolNames, [], "tool-less request");
        assert.match(hk()[0]!.messagesText, /Read the project notes/, "task is provided");
        assert.match(
          hk()[0]!.messagesText,
          /Tool: read notes\.txt/,
          "tool name and argument snippet are provided",
        );
        // Never persisted into the session registry.
        const entries = session.sessionManager
          .getEntries()
          .filter((e) => e.type === "custom" && String(e.customType).startsWith("pi-subagent:registry:"));
        assert.ok(entries.length > 0);
        assert.doesNotMatch(JSON.stringify(entries), /Reading the project notes/);
        release();
        await waitFor(async () => (await status()).state === "completed", "worker completed");
        const done = await status();
        assert.equal(done.summary, undefined);
        assert.equal(done.status, "Completed; session retained");
      },
    );
  },
);

test(
  "disabled (default) or without a model: no housekeeping request is ever made",
  { timeout: 30000 },
  async () => {
    for (const settings of [
      {},
      { housekeepingModel: "integration-test/offline-alt" },
      { housekeepingEnabled: true },
      { housekeepingEnabled: true, housekeepingModel: "integration-test/missing" },
    ]) {
      await scenario(
        settings,
        () => ({ ...answer("Should not appear"), model: "offline-alt" }),
        async ({ status, hk }) => {
          // Give the debounce window ample time to elapse.
          await new Promise((resolve) => setTimeout(resolve, 1900));
          const view = await status();
          assert.equal(hk().length, 0, JSON.stringify(settings));
          assert.equal(view.summary, undefined);
          assert.match(view.status, /Tool/, "original activity status preserved");
        },
      );
    }
  },
);

test(
  "a failing housekeeping model leaves normal status in place and never disturbs the agent",
  { timeout: 30000 },
  async () => {
    await scenario(
      { housekeepingEnabled: true, housekeepingModel: "integration-test/offline-alt" },
      () => {
        throw new Error("provider exploded");
      },
      async ({ status, hk, release }) => {
        await waitFor(() => hk().length > 0, "housekeeping attempted", 15000);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const view = await status();
        assert.equal(view.summary, undefined);
        assert.equal(view.state, "running");
        assert.match(view.status, /Tool/);
        release();
        await waitFor(async () => (await status()).state === "completed", "worker still completes");
      },
    );
  },
);

test(
  "an explicit agent_update cancels in-flight housekeeping so older activity cannot reapply; fresh activity reschedules",
  { timeout: 30000 },
  async () => {
    let releaseWorkerUpdate!: () => void;
    const workerUpdate = new Promise<void>((resolve) => {
      releaseWorkerUpdate = resolve;
    });
    let releaseStale!: () => void;
    const staleReply = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let finish!: (message: AssistantMessage) => void;
    const done = new Promise<AssistantMessage>((resolve) => {
      finish = resolve;
    });
    const updating =
      "---\nname: worker\ndescription: Execute work\ntools:\n  allow: [read, agent_update]\n---\nExecute your assigned task.\n";
    let housekeepingCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: { worker: updating },
        managerSettings: {
          housekeepingEnabled: true,
          housekeepingModel: "integration-test/offline-alt",
        },
        builtinTools: true,
        async onRequest(request) {
          if (isHousekeeping(request)) {
            if (++housekeepingCalls === 1) {
              await staleReply;
              return answer("Stale label");
            }
            return answer("Fresh label");
          }
          if (request.path) {
            if (request.pathCall === 1) return toolCall("read", { path: "notes.txt" });
            if (request.pathCall === 2) {
              await workerUpdate;
              return toolCall("agent_update", { message: "Explicit progress report" });
            }
            return done;
          }
          if (request.pathCall === 1)
            return toolCall("agent_spawn", {
              path: "reader",
              type: "worker",
              task: "Read the project notes",
              wait: false,
            });
          return answer("Delegated");
        },
      },
      async ({ cwd, errors, open, tool, requests }) => {
        await writeFile(join(cwd, "notes.txt"), "remember the milk\n");
        const session = await open(SessionManager.create(cwd));
        await session.prompt("Delegate reading the notes");
        const status = () => tool<ThreadView>(session, "agent_status", { path: "/root/reader" });
        // A housekeeping call for the first run's activity is in flight...
        await waitFor(
          () => requests.some(isHousekeeping),
          "first housekeeping request in flight",
          15000,
        );
        // ...when the worker sends an explicit progress report.
        releaseWorkerUpdate();
        await waitFor(
          async () =>
            (await status()).status === "Explicit progress report" ||
            requests.filter((r) => r.path).length >= 3,
          "agent_update processed",
        );
        releaseStale();
        // The stale answer must never be displayed; observe until fresh activity yields a new label.
        const seen = new Set<string | undefined>();
        await waitFor(
          async () => {
            seen.add((await status()).summary);
            return (await status()).summary === "Fresh label";
          },
          "fresh activity produces a new label",
          15000,
        );
        assert.ok(!seen.has("Stale label"), "stale summary was never shown");
        assert.ok(housekeepingCalls >= 2, "fresh activity scheduled a new request");
        assert.deepEqual(errors, []);
        finish(answer("Notes read"));
      },
    );
  },
);
