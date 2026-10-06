# Security policy

## Reporting a vulnerability

Please report security issues privately via GitHub: **Security → Report a
vulnerability** on this repository. Don't open a public issue. You can expect a first
reply within a week.

## What the plugin can access

`cache-warmer` runs inside Claude Code's plugin engine. Everything it does is listed by
`claude plugin validate plugins/cache-warmer`:

- **Reads environment variables:**
  - `HOME`
  - `CACHE_WARMER_DISABLE`
  - `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M`, `ENABLE_PROMPT_CACHING_1H`
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
    `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`

  It reads the last six only to check whether they are *set*, so it can guess the cache
  TTL. Their values are discarded at once; they are never stored, logged or sent.
- **Reads** Claude Code settings (for `promptCacheTtl`) and checks whether
  `~/.claude/cache-warmer-off` exists.
- **Stores** per-session timing and token counts, the auto on/off choice and the learned
  TTL in the plugin's own Claude Code store. There is no prompt or response text in it.
- **Sends** only `$.model.fork` requests: Claude Code's own request over the current
  session, with the fixed prompt "Reply with the single word: ok". Nothing goes to any
  other host.

It writes no environment variables or files and runs no host commands.

`statusline/cache-segment.sh` reads the JSON that Claude Code pipes to status line
commands and prints text. If you pass it an inner command, it runs that command.
