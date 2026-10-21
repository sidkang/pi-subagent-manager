# README demo

[Watch the GIF](assets/subagent-manager-demo.gif).

## What it shows

An actual interactive Pi session: six parallel agent roles, two nested taskers,
the live Agents widget, the fullscreen tree, watching a thread, steering a completed
writer back into action, passing API checks, and the final recap. A preparatory
reader makes nine agents in total.

The fictional **Orbit** project lived in a private temporary demo folder, outside
this repository. Its documents and Python checks were synthetic and local; the
agents still used live model providers. The deliberately slow checks left time to
browse live activity. No production code or data was used.

## Recording

- Pi **1.3.0**, pi-subagent-manager **0.29.3**.
- Started **plain `pi`**, with the user's existing configuration and all configured
  extensions. No `-ne`, replacement agent directory, or stripped-down configuration.
- The colorful footer and checklist come from the author's configured extensions;
  they are not installed by pi-subagent-manager.
- **Maple Mono NF**, 17 px, 112 × 34 terminal cells. Reused this installed Nerd Font
  rather than installing JetBrains Mono. Chromium confirmed MapleMono-NF-Regular
  for every footer icon; the rendered footer and role glyphs were visually checked.
- Used the [ttyd-testing skill](../.agents/skills/ttyd-testing/SKILL.md): a real PTY
  in localhost-only authenticated ttyd, rendered by isolated headless Chrome 154
  through Playwright. Reused system Chrome; capture-only Playwright lived in a
  private temporary directory. No project dependencies or Pi settings changed.
- Sampled actual screenshots at approximately 4 fps. Idle intervals were cut, a
  short tree section runs at 2×, and selected frames are held for readability.
  No UI content was synthesized, redrawn, or overlaid.
- Encoded with FFmpeg's `palettegen` / `paletteuse` filters, no dithering, variable
  frame timing, and infinite looping: **1150 × 759 px**, **37.28 seconds**,
  **1,332,767 bytes** (about 1.27 MiB).
- Decoded the finished GIF and inspected representative frames for text, borders,
  glyphs, footer, and transitions. Stopped the recording, Pi, ttyd, and browser.
  Private session logs, control credentials, and raw captures are not committed.

To record another session, read the skill first, run its `doctor` with an installed
Nerd Font, and start a fresh session in a disposable folder:

```sh
SKILL="$PWD/.agents/skills/ttyd-testing"
WORK="$(mktemp -d)"
node "$SKILL/scripts/terminal.mjs" doctor --font 'Maple Mono NF'
node "$SKILL/scripts/terminal.mjs" start \
  --session readme-demo --cwd "$WORK" --cols 112 --rows 34 \
  --font 'Maple Mono NF' --font-size 17 -- pi
```

Populate the disposable folder with a small fictional project and task brief before
submitting a prompt. This recording asked Pi to fan out six named roles and have the
architect delegate two more, staying offline and inside the demo folder. Open the
tree with **←**, select a thread and press **Enter**, send a message in **Steer**,
and use **Ctrl+Q** to return to the main editor. Capture named screenshots after
meaningful actions and inspect them. For continuous sampling, avoid a long `wait`
action on the same session: the harness serializes controls, so it blocks captures.
Always finish with `terminal.mjs stop --session readme-demo`.

The GIF is an edited demonstration, not a timing benchmark or a guarantee that
other fonts, themes, terminal sizes, or agent models render identically.
