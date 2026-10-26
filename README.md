# pi-subagent-manager

[![npm version](https://img.shields.io/npm/v/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![npm downloads](https://img.shields.io/npm/dm/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![GitHub stars](https://img.shields.io/github/stars/championswimmer/pi-subagent-manager?style=social)](https://github.com/championswimmer/pi-subagent-manager/stargazers)
[![CI](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml)
[![codecov](https://codecov.io/gh/championswimmer/pi-subagent-manager/branch/main/graph/badge.svg)](https://codecov.io/gh/championswimmer/pi-subagent-manager)

Let pi hand work to helper agents in parallel. Watch what they're doing, give them more direction, or pick up a finished agent's conversation.

![Pi running parallel agents, browsing a nested agent tree, steering a writer, and watching passing tests](docs/assets/subagent-manager-demo.gif)

A real Pi session with a customized footer and Nerd Font: parallel work, nested delegation, watching, and steering. [Recording details](docs/demo.md) (37 seconds; pauses shortened).

## Install

Requires pi **0.99.2+**.

```sh
pi install npm:pi-subagent-manager
```

## Start using it

Ask pi to delegate in plain language:

> Have a reviewer check my last commit while a researcher looks up how this repo handles retries.

Or start an agent yourself:

```text
/agents fork:coder fix the failing auth test
```

`fork:` includes your current conversation. Use `fresh:` instead for a task that needs no conversation history.

The **Agents** widget above the input shows what's running. Open `/agents tree`, select an agent, and press **Enter** to watch it. Type in the **Steer** input to give it more direction or resume it after it finishes. Results also return to the main agent.

## Bundled agents

| Agent        | Use it for                              |
| ------------ | --------------------------------------- |
| `architect`  | Plans, tradeoffs, coordinating helpers   |
| `coder`      | Implementation and debugging            |
| `researcher` | Codebase and web research                |
| `reviewer`   | Finding correctness and security issues  |
| `tasker`     | Small jobs and quick lookups             |
| `writer`     | Drafting and editing prose              |

They use your current model until you configure preferences. Open `/agents types` to change a role's model, tools, or instructions, or [add your own agent](docs/custom-agents.md).

## Settings and safety

Open `/agents` to change delegation mode, limits, and display settings; save with **Ctrl+S**. Experimental options are marked **[labs]** in their help. **[lab] Subagent extensions** opens a per-extension chooser (Space/Enter toggles, Esc returns); **Save and apply** persists the selection for new subagent sessions. It lists auto-discovered `.ts`/`.js` files and subdirectory entry points in Pi’s agent-dir `extensions/` (honoring `PI_CODING_AGENT_DIR`), trusted project `.pi/extensions/`, and configured/package files—not CLI-only/inline/built-in extensions; see [limitations](docs/subagent-extension-limitations.md).

Agents share your working directory and OS permissions: **tool policies are not a sandbox**. Don't run multiple subagent extensions together — they clash on `/agents`.

## Documentation

- [Commands and navigation](docs/tools-and-ui.md#commands) — watching, steering, stopping, and keyboard shortcuts
- [Settings](docs/settings.md) — models, tool access, limits, and experimental features
- [Custom agents](docs/custom-agents.md) · [Bundled roles](docs/default-agents.md)
- [Importing agents](docs/importing-agents.md) from other subagent packages
- [Development](docs/development.md) · [Changelog](CHANGELOG.md)

[MIT license](LICENSE)
