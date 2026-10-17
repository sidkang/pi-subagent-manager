# Write your own agent

A full agent type is a Markdown file: YAML frontmatter on top, system prompt below.
A settings-only customization is a sparse YAML overlay.

## 1. Pick a location

| Scope   | Directory                                                                                   |
| ------- | ------------------------------------------------------------------------------------------- |
| User    | `<pi-agent-dir>/subagent-manager/agents/` (normally `~/.pi/agent/subagent-manager/agents/`) |
| Project | `<cwd>/.pi/agent/subagent-manager/agents/` — loaded only when pi trusts the project         |

Precedence: **project > user > bundled**. Markdown definitions replace lower-layer
definitions; YAML overlays inherit any fields they do not specify.

## Tweak settings or fork the agent?

Two ways to customize a bundled agent. Pick one per agent — a scope (user or
project) cannot hold both a `.md` and a `.yml` for the same name.

| | Tweak settings (`<name>.yml`) | Fork agent (`<name>.md`) |
|---|---|---|
| What it is | Settings-only override merged on top of the bundled definition | Full copy that replaces the bundled definition |
| System prompt | Stays bundled; you keep receiving prompt updates | Copied; you own it, bundled prompt updates no longer apply |
| Editable | Settings (models, tools, thinking, color, icon, description) | Everything, including name and system prompt |
| File | Plain YAML mapping, no frontmatter, no Markdown body | YAML frontmatter on top, system prompt below |

`~/.pi/agent/subagent-manager/agents/coder.yml`:

```yaml
thinkingLevel: low
tools:
  allow:
    - read
    - grep
    - agent_update
    - agent_pause
```

Only listed fields override; everything else follows the lower-layer definition,
so untouched models, settings, descriptions, and prompts keep tracking extension
updates. `tools.allow` and `tools.block` merge independently: changing one does
not pin the other. Lists replace the corresponding list, rather than appending.
An empty tool list (`[]`) is an explicit empty list.

Omit a field to inherit it. Set an optional field to `null` to **remove** it from
the effective definition, not to restore the bundled value: `models: null` uses
the parent/default model; `icon: null` hides the icon; `tools.allow: null` removes
the allow list while keeping the inherited block list; `tools: null` removes the
whole policy. To restore inheritance, delete that setting from the YAML file.
`name` is optional and, when present, must match the filename. `.yml` and `.yaml`
are both supported. An override needs a matching lower-layer agent — an orphan
YAML file is rejected. Prompt fields/bodies are not allowed in YAML overlays.

In `/agents types`, editing a bundled agent asks you to pick one mode first,
and settings stay locked until you choose. **Tweak settings** starts with an
empty overlay (`{}` when saved unchanged), not a copy of the definition. Saving
writes only changed settings and retains existing explicit overrides, even if
an override currently matches a default. Saving to another scope writes the
edits into that scope without copying unchanged values from the displayed
scope. Project overlays inherit user customizations; user overlays inherit
bundled definitions. Overrides cannot rename the agent or edit the system
prompt — fork it instead. Full Markdown forks remain full copies.

To undo a fork or override, choose **Reset to bundled** (after Save) in the editor.
It deletes the customization file after confirmation and the lower-layer agent
applies again (the user customization, if any, or the shipped definition).

These are the only locations read. Other packages' `~/.pi/agent/agents` or `.pi/agents` are ignored — use [`/agents import`](importing-agents.md) for those.

## 2. Write the file

`~/.pi/agent/subagent-manager/agents/api-scout.md`:

```markdown
---
name: api-scout
description: Investigate APIs and find evidence before implementation
thinkingLevel: high
icon: "\uf002"
models:
  - anthropic/claude-sonnet-4-6
  - openai/gpt-5
tools:
  allow: [read, grep, find, ls, agent_update, agent_pause]
---

You are an API scout. Read the relevant source and docs,
report concrete findings with file paths, and do not modify files.
```

## 3. Load it

Run `/agents reload`. Diagnostics show any errors. Or just start a new turn — definitions reload after model turns.

Ask the main model to use it: _"spawn an api-scout at `stripe-webhooks` to check how retries work"_.

## Fields

| Field              | Required | What it does                                                                                                                                                        |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | yes      | Type name used in `agent_spawn`                                                                                                                                     |
| `description`      | yes      | Shown to the parent model so it knows when to pick this type                                                                                                        |
| `models`           | no       | Ordered `provider/model-id` preferences. How they're used depends on [Model Picking](settings.md#model-picking-modelselection). `agent_spawn` may also choose any entry per call. Omit to inherit the parent's model. |
| `thinkingLevel`    | no       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Clamped to what the model supports.                                                                      |
| `tools`            | no       | `allow` / `block` lists of exact tool names. Applied per [Tool Filtering](settings.md#tool-filtering-toolfiltering).                                                |
| `color`            | no       | pi semantic color (`accent`, `success`, `warning`, `error`, `muted`, `dim`) for the type pill and path. Default `accent`.                                           |
| `icon`             | no       | Single literal Nerd Font glyph. Displayed only with **[labs] Nerd Font icons** enabled; omit for text-only labels.                                                |
| `modelSuggestions` | no       | Plain model names (e.g. `sonnet-5.5`) that rank the model picker's search. **Never** select a model at runtime.                                                     |
| `model`            | no       | Deprecated single-model alias. Still parsed; saved back as `models`.                                                                                                |

The Markdown body is the system prompt.

## Icons [labs]

The optional `icon` field works for any custom or bundled agent type. Choose a glyph from the [Nerd Fonts cheat sheet](https://www.nerdfonts.com/cheat-sheet) and copy the actual character into quoted YAML, for example:

```yaml
icon: "\uf002" # nf-fa-search, U+F002
```

Use one Unicode private-use character, not an icon name (`nf-fa-search`), codepoint text (`U+F002`), emoji, or multiple glyphs. Both BMP and supplementary Nerd Font glyphs are supported. Omit the field to remove an icon; empty `icon:` values are invalid.

In `/agents types`, select **[labs] Icon** and paste the glyph, then save the agent. Leave the editor blank to remove it. You can configure icons while the feature is off; enable **[labs] Nerd Font icons** in `/agents` settings to see them. A Nerd Font must also be selected in your terminal. Icons supplement names, never replace them.

## Tips

- **Tools default to none.** With default filtering, an empty or missing `allow` list means the agent gets no tools. List what it needs.
- **To delegate**, a type needs `agent_spawn` and `agent_wait` in `allow`.
- **Include `agent_update` / `agent_pause`** so the agent can report progress or hand back early.
- **Model matching is exact.** If no preference is available (or scoped, in scoped mode), spawn fails — no silent fallback.
- **The list bounds per-call choices.** `agent_spawn`'s `model` must name an entry of `models`; a choice outside the list fails.
- **Unknown tool names fail** rather than widening access.
- **Edits affect new threads only.** Running and retained threads keep the definition they started with.

## Editing in the TUI

`/agents types` opens a browser and two-column editor.

| Key      | Action                                         |
| -------- | ---------------------------------------------- |
| ↑↓ / Tab | Select field                                   |
| Enter    | Edit field                                     |
| Ctrl+S   | Save (or apply a multiline field to the draft) |
| Esc      | Discard draft                                  |

The model picker lists selected models first, in fallback order. **Enter** toggles a model; **w/s** moves a selected model up/down in browse mode. **/** or **Tab** enters search, where typing (including w/s) filters; **Tab** returns to browsing while keeping the filter. Other typed letters also start search. Unselected models are ranked by fuzzy match against `modelSuggestions`, scoped models first.

**External editor** opens the whole Markdown definition in `$VISUAL`, `$EDITOR`,
or `vi` in fork mode. For an overlay, edit its YAML file directly and reload.

## Errors

- Malformed files and duplicate names in the same scope show diagnostics and disable only the affected type.
- An unavailable tool or model fails the spawn with a clear message.
