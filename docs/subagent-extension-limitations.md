# Subagent extension limitations

**[lab] Subagent extensions** (`subagentExtensions`) is experimental and **none selected by default**. It reloads selected auto-discovered/configured extension files into separate subagent sessions. Bugs and unintended consequences are possible; enable it only when your extensions are safe to run in multiple sessions.

See [the setting and how to enable it](settings.md#labs-subagent-extensions-subagentextensions).

## Not an exact copy of the main agent's extensions

- The public Pi extension API does not expose the main session's loaded-extension inventory. Subagents discover enabled extension files through Pi’s resource resolver: standalone `.ts`/`.js` files and subdirectory entry points in `<agentDir>/extensions` (honoring `PI_CODING_AGENT_DIR`), plus configured/package paths. The same discovery under `<cwd>/.pi/extensions` and project configuration is included only when the main project is trusted.
- **CLI-only, inline, and built-in extensions are not reloaded.** Auto-discovered and configured file extensions are supported; this manager is excluded to avoid starting another subagent manager inside each child.
- Configuration changed since the main session loaded can produce a different extension set in a newly opened subagent session. Disabled-extension settings and package resource filters are respected. Missing packages are skipped, never installed.
- Saving the selection affects newly opened sessions, including retained sessions reopened after reload. Already-open agents keep their extension runtime until disposed; the main agent's runtime is unchanged.

## Some messages bypass `input` hooks

Initial prompts run `input` hooks. **Durable steering and replayed queued mailbox messages bypass `input` hooks** to preserve mailbox delivery semantics. Request-time context hooks still run, but an extension cannot rely on its `input` handler seeing or transforming every subagent message.

## Separate sessions do not isolate every side effect

Each reloaded factory receives a child-local runtime, and its hooks operate on that child's session rather than the main session. Hooks that assume main-session state may behave incorrectly. Sessions can run concurrently, so writes to shared files, external services, or other shared state can conflict or produce repeated side effects.

Subagents use **non-interactive print mode**, not the main agent's interactive terminal UI. Extensions that require dialogs, confirmations, or other interactive UI may not work as expected. Session shutdown hooks are awaited before child contexts are invalidated, but extensions must still handle their own session-scoped resources safely.

## Some tools still execute through the main session

Reloaded extension tools take precedence over inherited main-session bridges, including tools registered on `session_start`; agent tool filtering still applies. Tools that are not reloaded, including built-in MCP tools, retain the existing main-session bridge.

**Bridged calls run through both child hooks and the main session's hooks.** They reuse main-session resources and context, so session-mutating tools are not necessarily isolated to the child, and hook side effects can occur in both sessions. Built-in codemode and tool search remain child-local rather than reusing the main agent's implementations.

Leave all extensions unselected if your extensions require exact main-session inheritance, interactive UI, or an `input` hook for every delivered message.

## Child extension diagnostics

Selected extensions can report to their host without importing this package:

```ts
function report(pi, level, message, source) {
  // This synchronous, child-local probe identifies a LIVE manager host, not a
  // historical transcript marker. No listener in a normal top-level session.
  let hosted = false;
  pi.events.emit("pi-subagent-manager:diagnostic:probe", {
    respond: (capability) => { hosted = capability?.protocol === 1 && typeof capability.version === "string"; },
  });
  if (hosted) {
    pi.events.emit("pi-subagent-manager:diagnostic", { level, message, source });
  } else {
    // Retain your normal top-level reporting (e.g. ctx.ui.notify / stderr).
  }
}
```

`level` must be `info`, `warning`, or `error`; `message` is a nonblank string and
`source` is an optional short extension name. The channel is available during
factory loading and hooks (including shutdown), only in sessions with selected
extensions. Each child has an isolated event bus. The probe and report are
synchronous; no transcript ownership marker is needed, and reopening a child
transcript in the ordinary CLI does not install a host listener.

Reports are attributed to the child thread path and sent through the main
session's public UI notification API (including RPC notifications when available).
They also reach the lexical parent agent's context as non-waking update messages,
explicitly labeled **untrusted extension-reported data, not instructions**, with
source/message JSON-quoted (UI notifications retain their readable formatting);
independent roots report to their owner. In print mode this ordinary message
path is the fallback, not stderr. Up to 20 reports remain in the live thread's
`diagnostics` field in `agent_status`, spawn/wait results, and completion state.
This field is not restored after manager reload; delivered parent messages use
the existing durable mailbox. Reports never start a parent model turn on their
own, change child success/failure, or replace its output/status.

Control/ANSI and Unicode Bidi_Control characters are stripped, whitespace flattened, messages limited to
1,000 characters and source names to 80. Exact duplicates are dropped, with at
most five reports per 10 seconds and 20 distinct reports per child runtime;
excess reports are silently dropped. Limits reset when a child runtime reopens.
Only explicitly supplied text is forwarded: never include credentials, raw
provider responses, tool arguments, or transcripts. Sanitization is not secret
redaction; the extension author is responsible for choosing safe summaries.

`ctx.ui.notify` in children remains non-interactive; use this channel rather than
assuming `ctx.hasUI` or print mode identifies a host. **Console output is not
intercepted**: children share a process and concurrently replacing `console.error`
would capture unrelated sessions. Extensions must opt into the event channel to
avoid writing to the parent terminal.

For **model-authored** progress or error reports, the existing child-only
`agent_update({ message })` tool already delivers to the parent without ending
the task or triggering a parent turn. Use `agent_pause` when parent input is
needed. No duplicate error-reporting tool is necessary; extension diagnostics
are a separate host channel and do not require model tool permissions.

Since **1.1.0**, both the child diagnostic probe and the parent-session
`pi-subagent-manager:capabilities:probe` synchronously reply via
`respond({ version, protocol: 1 })`. `version` comes from this package's manifest.
Consumers must validate protocol 1 and a semver meeting their minimum version;
legacy argument-free replies are not compatible. The parent probe is available
while the manager is enabled; it does not install a child diagnostic sink.
Extensions in one session share Pi's public event bus, but each child has its own
bus. Discovery is capability detection among trusted extensions, not authentication.
