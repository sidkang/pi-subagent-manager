# Tools and UI

Use [commands](#commands) to manage agents yourself, or let the main agent use the [tools](#model-facing-tools) below. For context inheritance, saved sessions, and resuming work, see [Threads and lifecycle](threads.md).

## Tool picker

The allow/block tool picker lists session tools flat, except MCP tools named `mcp__<mcp>__<tool>`: those are grouped under one `mcp__<mcp>` row, collapsed by default. The row shows `[x]`, `[ ]` or `[-]` (mixed) and Enter toggles every tool in the group. Right expands the group, Left collapses it (Left on a child also collapses and selects the group). While searching, matching groups are expanded automatically.

## Model-facing tools

| Tool           | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `agent_types`  | Names, descriptions, resolved models and thinking    |
| `agent_spawn`  | Start `{path, type, task, model?, wait?, timeoutMs?}`. Waits by default. |
| `agent_wait`   | Wait for settlement; optional `timeoutMs`            |
| `agent_steer`  | Send `{path, message?, timeoutMs?}`; queues/resumes and/or re-arms timeout|
| `agent_status` | Inspect one path or list visible threads             |
| `agent_update` | Child: report progress                               |
| `agent_pause`  | Child: pause without an answer                       |
| `agent_stop`   | Cancel a descendant and its subtree                  |
| `agent_output` | Page through long final answers by character offset  |

`agent_types` returns one compact line per type, with the model and effective thinking level
that a new child of the caller would use under current settings. Unresolvable types are
marked unavailable with a reason. A type whose `models` list has several entries also lists them,
because `agent_spawn` may choose among them. Advisory model suggestions and UI metadata are
omitted. Spawning under another parent path can change inherited settings.

`agent_spawn` accepts an optional `model` in pi's `provider/model-id[:thinking]` form, such as
`claude/opus-5.5:xhigh`. The model must be an entry of the type's `models` list. An exact entry wins;
otherwise a trailing thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) is
split off and sets this agent's thinking level. The choice is kept with the agent, so resuming it
after a reload uses the same model. Model Picking still applies, so a scoped mode refuses a model
outside `/scoped-models`, and **Use Current** refuses any choice.

```json
{
  "path": "controller-security-research",
  "type": "architect",
  "task": "Investigate controller security and plan the change",
  "wait": false
}
```

Then `agent_wait` or `agent_status` on `/root/controller-security-research`.

Child progress and completion notifications are retained in the main agent's context without adding visible chat messages. When a detached (`wait: false`) agent completes, fails or is stopped, the main agent receives a message event that starts a new turn if it is idle (or right after its current turn settles), so it never has to poll. Progress updates and foreground results do not start a turn. The opt-in **[labs] Final Recap** setting changes this: completion messages for async agents are recorded without waking the main agent, and once **all outstanding async agents have reported**, one recap turn summarizes them. Enabling it uses more tokens and context. Use the Agents widget, `/agents tree`, or `agent_output` to inspect child status and answers. With the opt-in **[labs] Housekeeping model**, `/agents tree` shows a model-written one-line summary of each running agent's current work in place of its raw tool-call line (see [settings](settings.md#labs-housekeeping-model-housekeepingenabled-housekeepingmodel)).

`agent_spawn` accepts an optional `timeoutMs` (30000–300000, i.e. 30s–5min; out-of-range values are rejected; no timeout when omitted). If the child is still running when it elapses, the parent receives an event (always waking an idle main agent, even in recap mode) with the child's state, status, elapsed time, tokens and recent output. The child is **not** stopped; the parent decides to wait, steer or stop it. The timer is cleared when the child completes, fails, stops or is cancelled, and on session shutdown. It is not re-armed when a child is later resumed with `agent_steer`. `agent_steer` also accepts `timeoutMs` (same 30s–5min range) and `message` is then optional: `timeoutMs` alone only re-arms a running child's timer from now (no steering or resume; error if the child is not running), e.g. after a timeout event shows it is still progressing; with both, the child is steered/resumed and the timer re-armed. At least one of the two is required.

## Parallel and nested work

- Launch **all independent siblings with `wait: false`, then wait**. Spawning one foreground child and waiting before the next is sequential.
- Nesting works the same way: `/root` launches `team-a` and `team-b`; each launches its own workers.
- Only `architect` delegates among bundled types. A custom coordinator needs `agent_spawn` and `agent_wait` in `tools.allow`.
- Limits are shared across the tree — see [settings](settings.md#max-levels-maxlevels).

## Commands

| Command                       | Does |
| ----------------------------- | ---- |
| `/agents`, `/agents settings` | Open [settings](settings.md). **Agent definitions** opens the type editor. |
| `/agents types`               | Browse and edit [agent types](custom-agents.md#editing-in-the-tui). |
| `/agents tree [path]`         | Open the live tree; an optional path selects an agent. |
| `/agents fork:<agent> <task>`  | Start an agent with your current conversation as context. |
| `/agents fresh:<agent> <task>` | Start an agent without inherited conversation context. |
| `/agents import`              | Open the [import picker](importing-agents.md). |
| `/agents reload`              | Reload definitions and settings; show diagnostics. |
| `/agents reap`                | Confirm removal of eligible completed agents from the retained tree. |

Both `fork:` and `fresh:` autocomplete available agent types and start detached agents: you can keep working in the main conversation while they run.

`reap` shows how many agents are eligible before asking you to confirm. It frees retained-thread slots but preserves active parents and ancestors of retained threads. Reaped agents cannot be resumed; their session files are not deleted.

### `/agents tree` keys

| Key         | Action                                            |
| ----------- | ------------------------------------------------- |
| ↑↓          | Select                                            |
| ←→          | Collapse / expand                                 |
| PgUp / PgDn | Scroll                                            |
| Enter       | Watch thread; Main returns to the editor          |
| i           | Existing actions: steer, stop, output, transcript |
| Esc         | Watcher → saved tree → Main                       |
| Ctrl+Q      | Return directly to Main                           |

Refreshes every second and keeps your selection, collapse state and scroll position.

### Live agent navigation

The fullscreen watcher renders steer and agent messages (including thinking) as Markdown, same as pi's main transcript. Tool calls and their results share pi's native `ToolExecutionComponent`, with built-in renderers for shell commands, reads, highlighted writes, edit diffs and search tools. Pending, successful and failed executions use pi's active theme colors. Unknown tools use pi's safe generic renderer; nested executions appear beneath their parent. **Ctrl+O** cycles all three detail levels in both steer and browse mode: **preview** (default: pi's native tool previews, first three rendered thinking and custom-message lines), **compact** (one line per call, custom-message headings only, thinking hidden), **full** (complete tool output, custom messages and thinking). Custom messages from extensions follow this cycle, including messages inherited from the main session or produced by extensions loaded in subagents; truncated previews show **Ctrl+O to expand**. User and assistant text stays complete at every detail level. Successful reads are collapsed by default, just like pi; expand them with **Ctrl+O**. Inherited context is initially collapsed (**c** toggles it with transcript controls focused). Watching alone never starts a turn, switches sessions, or changes model/tool/resource ownership. Extension renderers are never invoked, raw terminal controls are stripped, and images use safe text placeholders. Legacy sessions without reliable inherited-prefix metadata show their whole transcript.

- The bottom **Steer** input is focused initially. Type and press **Enter** to send to the inspected agent, including nested descendants, through the same service as `agent_steer`: running agents receive queued input; paused/completed/stopped agents resume their retained session. Empty input is ignored. Sending leaves the viewer open; failures are shown and preserve the draft for retry.
- **Tab** switches between steering input and transcript controls. While typing, **c/t/l/r** are ordinary text and **Home/End** move the input cursor. Pasting never submits by itself.
- **Up/Down, PageUp/PageDown** scroll and pause following in either mode. In pi fullscreen mode (`tuiMode: "fullscreen"`) the **mouse wheel** scrolls the transcript the same way as Up/Down (using pi's `fullscreenWheelScrollLines`; Alt+wheel moves further) when the pointer is over the viewer. With transcript controls focused, **Home** scrolls to the start; **End** or **l** resumes following the live tail. Scroll/follow state is remembered per agent.
- **Ctrl+R** (or **r** with transcript controls focused) retries an unavailable observation without starting a turn. Starting threads are watchable; stopped/completed threads remain readable.
- Frames are sanitized, viewport-bounded and coalesced during bursts. Exit, root replacement and shutdown release observers/timers. Streaming deltas never enter persisted thread events.

#### Arrow-key shortcuts

While any subagent is **starting or running**, press physical **Left (←)** at the beginning of the main draft (or in an empty input) to open the subagent browser. With no active subagents, or elsewhere in the draft, Left retains normal cursor movement. `/agents tree` remains available regardless of agent activity. Down is always native editing/history navigation. Autocomplete, jumps, paste and configured shortcuts take precedence. Navigating preserves the main draft/cursor and does not require the root to be idle.

Press physical **Right (→)** at the end of the main draft (or in an empty input) to collapse the full widget to a single status line for this session. This does not save settings or change the configured **Status Widget** mode. Refreshes, agent resumes, new main turns and session-tree navigation keep it collapsed; starting, switching or reloading a session restores the configured mode. Left from that collapsed line first returns to the full widget; Left again opens the full dialog while subagents are active. In the fullscreen tree, Right on a leaf row closes the tree and returns to the full widget, so the keys always walk **tree ← full ← minimal**. When **Status Widget** is set to Minimal, the walk is **tree ← minimal**: Left opens the tree directly, Right in the tree returns to the minimal line, and Right at the draft does nothing. Elsewhere in the draft Right retains normal cursor movement; autocomplete, jumps, paste and shortcuts take precedence.

Arrow-key shortcuts are enabled by default in the TUI; `/agents tree` remains available everywhere. Pi has one custom-editor slot: installation is skipped if another factory owns it or an existing draft is nonempty, since the host cannot transfer cursor/undo/expanded-paste state. Load order can still let a later editor replace ours. Initial startup uses Pi's history hydration; replacement installations seed history once. Session-tree rebuilds keep the existing editor instance.

While navigation is open, the host fullscreen search shortcut is temporarily disabled through public keybindings to avoid stacking a second host overlay. The prior binding owner is restored only if no other extension replaced it. **Known host limitation:** if an unrelated extension stacks another overlay above navigation, Pi's custom-UI completion can close the newer overlay instead. Avoid concurrent extension-owned overlays; a host identity-targeted completion API is needed to remove this limitation. No private host access or unsupported overlay-lifecycle workaround is used.

Run `python3 scripts/live-agent-navigation-smoke.py` after `npm install` for credential-free, offline POSIX PTY checks in regular/fullscreen mode (idle Left gating, explicit command entry, root return, resize and host-search suppression). No model prompts are submitted. Broader manual acceptance covers concurrent live turns, autocomplete/paste/undo interactions, remapped shortcuts and rich custom content.

## Agents widget

The widget above the input editor has two display modes, selected with **Status Widget** in `/agents` settings:

- **Full** (default): the existing compact tree, at most twelve lines.
- **Minimal**: a summary line such as `3 running, 2 stopped, 1 failed, 1 paused    ↑12k ↓3k`, with semantic theme colors. Starting agents count as running; completed agents are counted when present. Token totals include only currently starting/running agents, not the main conversation or settled threads. Use `/agents tree` for details.

Once the main turn has ended and no subagents are starting or running, either mode collapses to a single status-count line without the browser hint. The full tree remains available via `/agents tree`; **Left** at the start of the draft opens it only while subagents are starting or running. A fresh main prompt hides agents that were already settled (completed, failed, stopped or paused); they remain in `/agents tree` and reappear in the widget only when resumed. Agents still starting or running remain visible, and new agents appear normally. Automatic Final Recap turns keep the current task's results visible. Visible agents use the configured display mode unless Right has collapsed the widget for this session (Left expands it again).

In full mode:

- One row per agent: colored type pill, path, state, task, active time, input `↑` / output `↓` tokens. With **[labs] Housekeeping model** enabled, a nonblank summary replaces the task while the agent is starting/running; otherwise the task remains.
- Activity and lifecycle messages (such as `Completed; session retained`) are omitted to save space; detailed status remains available in `/agents tree` and `agent_status`.
- Agents are ordered newest-started first (spawn or resume); a branch ranks by its most recently started agent. The most recently started agents are preferred when previews overflow. Overflow is counted, not listed.
- Time freezes while paused and resumes on continue.
- A small status strip below the previews shows the running count (including starting agents) and **Press ← to open subagent browser**, including when agents overflow. The full footer also shows **→ collapse**. Minimal mode keeps **← browser** inline so it stays one line (**← expand** when it is a session collapse of full). Browser hints appear only while subagents are starting or running; RPC output omits keyboard hints.
- With **[labs] Nerd Font icons** enabled, the selected Circle, Braille, or Hourglass loader appears before the preserved role icon in the widget and fullscreen tree/live-view headers. Each family provides completed, paused, failed, and stopped state icons. The minimal summary uses the same indicators for its status counts. Preview all families and states under **[labs] Loader style**. Animation timers stop on settlement or disposal; RPC output stays static.

### Interrupts and stopping agents

With the main input focused (default keybindings):

- **Esc** aborts the main turn (including a pending `agent_wait` or foreground spawn wait), **not the subagents**. Already-started subagents keep running.
- **Ctrl+C** clears the input; it does not stop the main turn or subagents.
- **Ctrl+C twice quickly** (within 500 ms) exits Pi. Session shutdown cooperatively stops all agents, retaining their sessions.

Inside the tree/watcher, **Esc** returns to the previous view without stopping an agent. To stop one subtree without exiting Pi, open **`/agents tree`**, select an agent, press **i**, and choose **Stop**. This stops that agent and its working descendants; other branches continue. Cancellation is cooperative, not a guarantee of killing external processes.
