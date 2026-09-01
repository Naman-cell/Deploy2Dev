# Heimdall — Claude Code Working Agreement

Heimdall is a deployment center for controlled ECS deployments across dev, stage, and prod.
It's a TypeScript / Node monorepo using npm workspaces:

- `apps/api` — `@heimdall/api`
- `apps/web` — `@heimdall/web`
- `packages/shared` — `@heimdall/shared` (shared types/utilities consumed by both)

Toolchain: TypeScript (ESM, `"type": "module"`), vitest, eslint + prettier.

Root scripts:

- `npm test` — vitest across `@heimdall/shared` and `@heimdall/api`
- `npm run typecheck` — `tsc` across shared/api/web
- `npm run lint` — eslint across shared/api/web
- `npm run build` — build all workspaces
- `npm run validate` — typecheck → lint → test → build (full gate)

Scope any command to a workspace with `-w`, e.g. `npm run typecheck -w @heimdall/api`.

---

## Coder → Reviewer Loop (REQUIRED for non-trivial code changes)

This repo defines two subagents in `.claude/agents/`:

- **`coder`** (runs on Sonnet) — implements code changes.
- **`reviewer`** (runs on Opus) — verifies the changes by running tests, tracing callers, and writing edge-case probes.

For any non-trivial coding task (a feature, refactor, or bug fix — more than a one-line/typo change), you (the main assistant) act as the **orchestrator** and drive this loop automatically. Do not implement non-trivial code changes yourself; delegate to the loop.

### The loop

1. **Scope** the task. Break a large request into independently reviewable coding tasks. Clarify genuinely ambiguous requirements with the user *before* entering the loop.
2. **Delegate to `coder`.** Spawn the `coder` agent (Agent tool, `subagent_type: "coder"`) with a precise task description: what to build/change, the files or workspaces involved, constraints, and acceptance criteria.
3. **Delegate to `reviewer`.** As soon as the coder reports back, spawn the `reviewer` agent (`subagent_type: "reviewer"`) to verify. Pass along what changed and the coder's summary. The reviewer runs `npm test`, `npm run typecheck`, `npm run lint`, traces callers, and writes probe tests.
4. **Branch on the verdict:**
   - **APPROVED** → the loop is done for this task. Report the outcome to the user, quoting the reviewer's evidence (tests/typecheck/lint status).
   - **CHANGES_REQUESTED** → send the reviewer's exact fix list (file:line + failing output) back to the `coder` agent as a new task. Then return to step 3 to re-review. Repeat.
   - **NEEDS_DISCUSSION** → stop the loop and surface the reviewer's question to the user for a decision. Do not guess past an architectural concern.
5. **Iterate until APPROVED or NEEDS_DISCUSSION.** Guardrail: if the same task is still not APPROVED after **3 coder→reviewer rounds**, stop looping and escalate to the user with a summary of what's stuck and the reviewer's outstanding findings — don't loop indefinitely.

### Rules for the loop

- **Auto-spawn, don't ask.** Once the task is scoped and unambiguous, run the loop without asking the user for permission between coder and reviewer — that hand-off is the whole point.
- **The reviewer is authoritative on "done."** Never declare code complete on your own say-so; a task is complete only when the `reviewer` returns APPROVED (or the user accepts a NEEDS_DISCUSSION resolution).
- **Feed evidence forward.** When routing CHANGES_REQUESTED back to the coder, include the reviewer's concrete findings verbatim (file paths, line numbers, failing test output) so the coder can act immediately.
- **Keep the user informed, not blocked.** Narrate each hand-off briefly ("coder implemented X → reviewer found Y → sending back to coder"), but don't pause for approval mid-loop unless the reviewer returns NEEDS_DISCUSSION.
- **Trivial changes skip the loop.** A typo, comment, or truly one-line fix can be done directly — but still run `npm run typecheck`/`npm run lint` before calling it done.
