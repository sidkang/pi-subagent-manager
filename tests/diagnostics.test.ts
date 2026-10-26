import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticSink } from "../src/orch/diagnostics.ts";
import type { ChildDiagnostic } from "../src/types.ts";

test("diagnostics validate, sanitize, bound, dedupe and rate-limit without stderr", () => {
  const reports: ChildDiagnostic[] = [];
  let time = 0;
  const sink = diagnosticSink(
    (report) => reports.push(report),
    () => time,
  );
  for (const invalid of [
    null,
    {},
    { level: "fatal", message: "x" },
    { level: "error", message: "" },
    { level: "error", message: "x", source: {} },
  ])
    sink(invalid);
  assert.doesNotThrow(() =>
    sink(
      new Proxy(
        {},
        {
          get() {
            throw new Error("bad getter");
          },
        },
      ),
    ),
  );
  assert.equal(reports.length, 0);
  const payload = {
    level: "warning",
    source: "src\x00\n",
    message: "\x1b]0;title\x07\x1b[31mError\n\u202etest\x00",
  };
  sink(payload);
  sink(payload);
  assert.deepEqual(reports, [{ level: "warning", source: "src", message: "Error test" }]);
  sink({ level: "info", source: "s".repeat(100), message: "m".repeat(2000) });
  assert.equal(reports[1]!.message.length, 1000);
  assert.equal(reports[1]!.source!.length, 80);
  for (let i = 0; i < 10; i++) sink({ level: "error", message: `burst ${i}` });
  assert.equal(reports.length, 5);
  for (let i = 0; i < 30; i++) {
    time += 10000;
    sink({ level: "error", message: `later ${i}` });
  }
  assert.equal(reports.length, 20);
  assert.doesNotThrow(() =>
    diagnosticSink(() => {
      throw new Error("host failed");
    })({ level: "error", message: "report" }),
  );
});

test("diagnostics remove every Unicode Bidi_Control character from message and source", () => {
  const reports: ChildDiagnostic[] = [];
  const controls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  diagnosticSink((report) => reports.push(report))({
    level: "error",
    message: `a${controls}b`,
    source: `c${controls}d`,
  });
  assert.equal(reports.length, 1);
  assert.doesNotMatch(reports[0]!.message, /\p{Bidi_Control}/u);
  assert.doesNotMatch(reports[0]!.source!, /\p{Bidi_Control}/u);
});


test("diagnostic capability is explicit, versioned from the manifest and callback-safe", async () => {
  const { respondDiagnosticCapability } = await import("../src/orch/diagnostics.ts");
  const { createRequire } = await import("node:module");
  let reply: unknown;
  respondDiagnosticCapability({ respond(value: unknown) { reply = value; } });
  assert.deepEqual(reply, { version: createRequire(import.meta.url)("../package.json").version, protocol: 1 });
  for (const payload of [undefined, {}, { respond() { throw new Error("private"); } }])
    assert.doesNotThrow(() => respondDiagnosticCapability(payload));
});
