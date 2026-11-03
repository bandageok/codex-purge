# codex-purge

**A reversible jailbreak layer for OpenAI Codex CLI**: replace the built-in base instructions wholesale, drop the approval and sandbox gates, and pin the flags into the launcher.

No patching of the 341 MB native binary. Everything rides on Codex's own supported config surfaces: `model_instructions_file`, `developer_instructions`, `approval_policy`, `sandbox_mode`, `include_*_instructions`, and `-p <profile>`.

```bash
codex-purge --apply     # install all layers
codex-purge --verify    # capture the real request the model sees
codex-purge --revert    # byte-exact restore
```

## Why not patch the binary

In `@openai/codex` 0.163.0 the base prompt is a ~40 KB constant embedded in `codex.exe` (12 `You are Codex` hits in `.rdata`). Rewriting it means dealing with fat pointers, length tables and signatures. Codex already exposes a file that *replaces* the base instructions — so codex-purge flips official switches instead of forging binaries.

## Layers and patches (14)

| # | patch | layer | effect |
| --- | --- | --- | --- |
| 1 | INSTRUCTIONS_FILE | prompt | writes `$CODEX_HOME/codex-purge/instructions.md` |
| 2 | MODEL_INSTRUCTIONS_FILE | prompt | base instructions replaced entirely |
| 3 | DEVELOPER_INSTRUCTIONS | prompt | injected at the top of the developer block |
| 4 | APPROVAL_POLICY_NEVER | engine | `approval_policy = "never"` |
| 5 | SANDBOX_DANGER_FULL_ACCESS | engine | `sandbox_mode = "danger-full-access"` |
| 6 | PERMISSIONS_INSTRUCTIONS_OFF | engine | removes the sandbox instructions block |
| 7 | APPS_INSTRUCTIONS_OFF | engine | removes the apps instructions block |
| 8 | COLLABORATION_MODE_OFF | engine | removes the collaboration-mode block |
| 9 | PROFILE_FILE | config | `codex-purge.config.toml`, layered via `-p`, user config untouched |
| 10 | CONFIG_MANAGED_BLOCK | config | marker block in `config.toml` (before the first table) for GUI/app-server sessions |
| 11 | AGENTS_MD_BLOCK | agents | mirror block in `AGENTS.md` |
| 12-14 | SHIM_* | shim | `codex.cmd` / `codex.ps1` / `codex` launchers pin `-p codex-purge --dangerously-bypass-approvals-and-sandbox` |

## Verified behaviour

`node scripts/verify.mjs` starts a capture-only Responses endpoint, points a temp `CODEX_HOME` at it, runs a real `codex exec`, and asserts on the captured request:

```
✓ request captured
✓ instructions layer is input[0]
✓ built-in base prompt gone        ("You are Codex" absent)
✓ developer layer injected
✓ sandbox: danger-full-access
✓ permissions instructions block removed
```

16/16 selftest assertions run without codex or network (`node scripts/selftest.mjs`).

## Reversibility

- `config.toml`, `AGENTS.md`, launchers: original kept as `<file>.codexpurge.bak`, restored byte-exactly (asserted in selftest, cross-checked with `md5sum`).
- Timestamped snapshots under `$CODEX_HOME/codex-purge/backup/`.
- Re-applying never poisons the backup: files already carrying our markers are not treated as originals.

## Layout

```
bin/codex-purge.js   CLI          lib/prompt.js    instructions resolution
lib/core.js          patches      lib/prompt-inject.md  default instructions
lib/config.js        TOML         lib/agents.js    AGENTS.md block
lib/shim.js          launchers    lib/verify.js    end-to-end capture
lib/paths.js         platform     presets/         strict, soft, ctf, research
```

## Compatibility

Tested against `@openai/codex` 0.163.0 on Windows x64; POSIX uses the `codex` sh shim. If a build lacks `model_instructions_file`, patch #2 stays `pending` and the `developer_instructions` / `AGENTS.md` layers still apply.

MIT. Keep the `codex-purge:*` markers if you fork — the status machine and revert depend on them.