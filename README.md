# pi-use-last-selected-thinking-level

Per-model thinking-level memory for [pi](https://pi.dev): remembers the thinking level each model was last used at, and re-applies it when you switch back to that model. No pins, no settings edits, nothing to configure.

## The problem

pi has two ways of deciding a thinking level:

- **Pinned levels** — `enabledModels` patterns in `settings.json`, e.g. `"opencode-go/deepseek-v4-flash:max"` or `"*luna*:max"`. These always apply when that model is selected.
- **A single session-global level** — when you switch to a model *without* a pin, pi just carries the current session level over and clamps it to the new model's capabilities.

There is no "what did I last use with this model" memory. Switch from a model you ran at `max` to one you ran at `low`, and back — the second model's `low` follows you, and your first model silently loses its `max`. With a global default of `high`, a model you always run at `max` needs the pin — or you must remember to bump it every single time. This extension removes that whole class of friction.

## How selection and the thinking-level picker work (nothing changes for you)

Model selection and thinking levels work exactly like stock pi. The extension only *listens* to events pi already fires:

- **Selecting a model** — use any way you normally do: the model picker, `/model`, or cycling. The selection process is completely unchanged; nothing about it is intercepted or modified.
- **Setting a thinking level** — in the same place you always set it: the **thinking-level picker in the model selector** (the `off / minimal / low / medium / high / xhigh / max` list shown for the selected model). Pick a level while a model is active and that is the level pi runs the model at.
- **What gets remembered** — the effective level of the model that was active when the level changed. Set model X to `high` in the picker → the extension records `X → high` and re-applies it automatically whenever you come back to X (model switch or new session).
- **What is NOT remembered** — levels pi applies by itself during a switch (inheritance and capability clamping) and settings pins. These are attributed to the model being left, so they can never pollute the memory.

Because of that, models you never level manually behave **exactly as before**: they inherit the current session level (seeded from `defaultThinkingLevel` at a new session) — stock behavior, untouched.

> **Note:** setting levels only by editing `defaultThinkingLevel` in `settings.json` seeds the session-start default but does *not* feed the memory (it doesn't fire pi's level-change event). Set per-model levels in the picker — that is where the memory is captured.

## What this extension does

- **Remembers** the effective thinking level of every model you use, persisted in `~/.pi/agent/thinking-memory.json`.
- **Re-applies** it when you switch to that model again (model picker or `/model` cycling) — so each model snaps back to the level you actually used with it.
- **Applies at session start** (`startup` and `/new`) for the session's active model, so your default model also starts at its remembered level.
- **Leaves `/resume` and `/fork` alone** — those keep the session's own stored level.
- **Settings pins always win** — a model pinned in `enabledModels` (e.g. `*luna*:max`) keeps its pinned level; its memory stays dormant until the pin is removed. Remove the pin later and the memory takes over automatically.
- **Notifies** briefly when a remembered level is applied on a model switch (and only when it actually changes the level).

## How it works

The extension subscribes to three events, all handled synchronously so ordering is deterministic:

- `thinking_level_select` — records the level for the active model. When the change comes from a model switch (pi updates `ctx.model` *before* firing this event, while `previousLevel` is still the outgoing model's level), it records the **outgoing** model's level instead, so switch clamps/pins never pollute the memory.
- `model_select` — looks up the incoming model's remembered level, skips pinned models, and applies it via `pi.setThinkingLevel()` (which clamps to model capabilities automatically).
- `session_start` (reason `startup`/`new`) — applies the remembered level of the active model, silently.

The state file is written atomically (temp file + rename) and tolerates missing/corrupt files.

## Installation

```bash
# everyone (published package):
pi install npm:pi-use-last-selected-thinking-level

# or straight from GitHub:
pi install git:github.com/DraconDev/pi-use-last-selected-thinking-level

# or a local checkout, for development:
pi install /path/to/pi-use-last-selected-thinking-level
```

Then `/reload` (or restart pi). To uninstall: `pi remove pi-use-last-selected-thinking-level`.

## Usage

There is nothing to configure — switching models and changing thinking levels in the picker records and applies memory automatically.

- `/thinking-memory` — list remembered levels (`provider/model: level`), with `(current)` and `[pinned by settings — dormant]` markers, plus the state file path.
- `/thinking-memory clear` — forget everything.
- `/thinking-memory clear <fragment>` — forget only models whose `provider/model` contains the fragment (e.g. `/thinking-memory clear luna`).

Forget a single model's level to make it fall back to pi's default behavior again.

## Examples

With `enabledModels: ["opencode-go/deepseek-v4-flash:max", "*luna*:max", "**"]`:

1. Start pi — deepseek-v4-flash is active. It's pinned at `max`, so nothing changes.
2. Switch to an unpinned model, set it to `low` in the picker, use it for a while.
3. Switch back to deepseek-v4-flash — the pin applies `max` (memory dormant). Switch to the unpinned model again — `low` is applied automatically, no manual re-selection.
4. Remove `*luna*:max` from `enabledModels` later — every luna model you used before now gets its remembered level instead of the pin.

## Troubleshooting

- **Nothing is remembered** — check that the extension is loaded (`pi list` / `/reload`), then change a thinking level once in the picker; the memory file appears at `~/.pi/agent/thinking-memory.json`.
- **A model always gets a level you don't want** — run `/thinking-memory clear <fragment>` for it. If it's pinned in `enabledModels`, remember pins win by design; remove the pin to let the memory apply.
- **State file corrupt** — delete `~/.pi/agent/thinking-memory.json`; the extension starts fresh and logs a warning.
