# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

A Claude Code plugin, `cache-warmer`. It shows prompt-cache state under the prompt and
keeps an idle interactive session's cache warm with a bounded keepalive (`/warm`). There
is also an optional, standalone status line script. There is no build step and there
are no runtime dependencies.

## Layout

```
.claude-plugin/marketplace.json        marketplace entry (repo root = marketplace)
plugins/cache-warmer/
  .claude-plugin/plugin.json           manifest, version, userConfig options
  hooks/hooks.json                     { "modules": ["./register.ts"] }
  hooks/register.ts                    the whole plugin: one hooks module
  tests/cache-warmer.test.ts           `claude plugin test` suite (mocked clock)
statusline/cache-segment.sh            optional status line segment (bash + jq)
statusline/test.sh                     its tests
docs/indicator.svg                     README image (generated)
docs/render-indicator.py               regenerates it: python3 docs/render-indicator.py
```

## Commands

```
claude plugin validate plugins/cache-warmer   # manifest + module static checks
claude plugin test plugins/cache-warmer       # unit tests
claude plugin validate .                      # marketplace manifest
statusline/test.sh                            # status line segment tests
```

Run all four before every commit. CI runs the last two as blocking checks. The plugin
checks run in a non-blocking job because GitHub-hosted runners currently reject the
early-access hooks module (see `.github/workflows/test.yml`), so a green CI does not
cover the plugin. Run the plugin checks locally.

Type definitions for the plugin API are written by Claude Code itself when it loads the
plugin (`plugins/cache-warmer/.claude-plugin/types/`, git-ignored). Nothing to install.

## Rules the module must follow

These come from the plugin engine (`claude plugin validate` enforces them):

- Call `$` methods as `$.noun.method(...)` at the call site. Name environment variables
  as string literals (`$.env.get('HOME')`, never a variable).
- A helper that takes `$` must be a top-level `function` or `const` declaration.
- Do not hook `prompt.submit` or other gating events: an error there can block the
  user's prompt. Use `turn.start` / `turn.complete`.
- Reset module-level state at the top of `register()`, so every load starts clean.

## Invariants (do not break; each has a test)

- **Interactive sessions only.** When `isInteractive` is false, register nothing,
  draw nothing, store nothing, send nothing.
- **Nothing in the transcript.** Keepalive uses `$.model.fork` only. Never
  `$.prompt.submit`, Stop-hook turns, a proxy, `ANTHROPIC_BASE_URL`, env writes or
  credential reads.
- **Bounded.** Windows end (8h max). Auto is off by default, follows the
  `autoWindowMinutes` window, and never runs on a 5m TTL.
- **No ping when it can't help.** Never during a running turn and never on a cache
  that is already cold.
- **Self-check.** A ping that reads 0, or writes more than 10% of what it read, stops
  the session and opts it out of auto.
- **Off switches work.** `CACHE_WARMER_DISABLE=1` and `~/.claude/cache-warmer-off`
  block both auto and manual pings.

When you change a guard, mutation-test it: break it on purpose and confirm a test fails.
If no test fails, the test is too weak; strengthen it before you commit.

## Tests

- `world(on, opts)` in the test file stands in for the engine: mocked clock, store, env
  and settings, a counting `model.fork`, and recorders for status lines, toasts and
  registered commands.
- Op hooks answer `{ value }` (or `{ deny }`), event hooks answer the event's result shape.
- Plugin options go before the body: `test(name, { options: { auto: true } }, body)`.

## Releasing

1. Bump `version` in `plugins/cache-warmer/.claude-plugin/plugin.json`.
2. Add a `CHANGELOG.md` entry.
3. Run the four commands above.
4. Commit, then tag `vX.Y.Z`.

Keep the README's command table, options table and test counts in step with the code.
If the indicator's text format changes, update `LINES` in `docs/render-indicator.py`
and regenerate the image. Don't put the symbols back into a code block: most code
fonts lack them, so they render misaligned.

## Style

TypeScript, 2-space indent, no semicolons, single quotes. Comments explain *why*.
Keep the plugin a single module unless it grows past what one file explains well.
