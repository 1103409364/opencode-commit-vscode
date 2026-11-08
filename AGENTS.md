# AGENTS.md

VS Code extension that generates a commit message by piping `git diff --cached` into the `opencode` CLI and writing the result into the SCM input box.

## Layout

- `extension.js` — the entire extension (plain CommonJS, no build step). `activate`/`deactivate` plus helpers; `_test` exports exist only so the smoke test can call internals.
- `scripts/smoke-test.js` — tests without a VS Code host.
- `package.json` — manifest, commands, settings, scripts.
- `install.sh` — local install by copying files into the VS Code extensions dir.
- `README.md` — user docs, written in Chinese; keep it that way when editing.
- `.opencode/agents/commit-msg.md` — optional opencode agent template (no tools, single step); not installed by `install.sh`.

No bundler, no `node_modules`, no lockfile, no lint/typecheck/CI. Runtime deps are Node built-ins and the `vscode` module only.

## Commands

```sh
npm test                 # = node scripts/smoke-test.js
./install.sh             # copy into ~/.vscode/extensions/opencode.opencode-commit-message-<version>/
npm run package          # runs `vsce` from PATH; vsce is NOT a dependency
```

- After editing `extension.js`, re-run `./install.sh` and then `Developer: Reload Window`. The install dir is version-keyed, so a version bump leaves the old copy behind.
- `npm run package` fails unless `vsce` is installed globally (`npm i -g @vscode/vsce`) or invoked as `npx @vscode/vsce package`.
- `install.sh` copies only `package.json`, `extension.js`, `README.md`; `scripts/` is excluded via `.vscodeignore` and must not be added to the copy list. `.vscodeignore` also keeps `AGENTS.md`, `install.sh` and `*.vsix` out of the packaged VSIX.

## Testing quirks

- The test stubs `vscode` by monkey-patching `Module._load` before requiring `extension.js`. Any new top-level `require("vscode")` usage is fine, but new behavior must stay reachable through the `_test` export to be testable.
- Tests spawn fake `opencode` executables written to temp dirs (`#!/bin/sh`, mode `0o755`, driven by `$OPENCODE_ARGS_FILE`), so they are POSIX-only.
- If you change `candidateCommands` fallbacks or the `--agent`/`--model` arg order, update the corresponding assertions in `scripts/smoke-test.js`.

## Gotchas

- `opencodeCommit.agent` defaults to **empty**, so out of the box `opencode` uses its own default agent and the extension works in any repo. `.opencode/agents/commit-msg.md` in this repo is an opt-in template (agent files resolve per project, or globally from `~/.config/opencode/agent/`), so users must copy it into the repo they commit in and set the setting to `commit-msg`. Keep the two in sync if you change the prompt.
- The CLI contract is: base args from `opencodeCommit.args` (default `["run", "--archived"]`), then `--agent`, then `--model`; the prompt is sent on **stdin**, stdout is the message. Older opencode builds lack `--archived`, hence the configurable args.
- `cleanMessage` strips ANSI, fenced code blocks, and one pair of wrapping quotes — keep that behavior when touching output handling.
- Git access goes through the built-in Git extension API (`vscode.git`, API version 1); there is no `git` CLI shell-out for repo discovery, and the command is a no-op when nothing is staged.
