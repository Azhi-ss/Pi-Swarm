# Installed runtime and recovery

Pi-Swarm is a Pi extension with a companion CLI. It requires Node.js 22.19 or later and a compatible Pi Host. The tested host and TUI versions are `@earendil-works/pi-coding-agent@0.87.0` and `@earendil-works/pi-tui@0.87.0`; the peer dependency contract is `0.87.x`.

A reproducible installation from a release tarball, without a source checkout or development dependencies (replace the tarball and target-project paths):

```sh
export PI_SWARM_INSTALL="$HOME/.local/share/pi-swarm"
mkdir -p "$PI_SWARM_INSTALL"
# Supply a compatible Host first, then install the release alongside it.
npm install --prefix "$PI_SWARM_INSTALL" --omit=dev --ignore-scripts=false --save-exact \
  @earendil-works/pi-coding-agent@0.87.0 @earendil-works/pi-tui@0.87.0
npm install --prefix "$PI_SWARM_INSTALL" --omit=dev --ignore-scripts=false \
  /absolute/path/pi-messenger-swarm-0.26.3.tgz
export PATH="$PI_SWARM_INSTALL/node_modules/.bin:$PATH"

cd /absolute/path/to/target-git-project
# Pi discovers pi.extensions from the installed package manifest.
pi --extension "$PI_SWARM_INSTALL/node_modules/pi-messenger-swarm"
# In another terminal with the same PATH, exercise the companion service:
pi-messenger-swarm --start
pi-messenger-swarm --project /absolute/path/to/target-git-project join
pi-messenger-swarm --project /absolute/path/to/target-git-project status
pi-messenger-swarm --stop
```

Put this installation's `node_modules/.bin` on PATH when starting the companion CLI/service so spawned peers use the same Pi Host. A global `pi` executable by itself does not satisfy Node runtime imports. The package declares the Pi libraries as peers, so npm resolves them in the installation tree. Development remains `pnpm install`, `pnpm run build`.

For maintainers, produce that tarball with `pnpm run build` followed by `npm pack`; `npm pack` alone does not compile the release. The supported peer range is `0.87.x`, with the smoke scenario pinned to Host/TUI `0.87.0`. Pi-Swarm does not bootstrap a standalone Pi environment. Normal installation scripts remain enabled; users do not need TypeScript, Vitest, or Git-hook tooling in the runtime installation.

## Project and run selection

A command selects one Project and uses it immediately, with no confirmation prompt:

1. `--project <path>`
2. `PI_SWARM_PROJECT_ROOT`, the owning Project supplied to a peer
3. The Project that owns the working directory. Ownership walks through parent directories and includes a Git repository, a directory containing `.pi`, and a managed detached Sandbox at `.swarm/workspaces/worker-<id>/`

A nested directory and a Sandbox both resolve to that owning Project. When none of the three selectors identify a Project, project-scoped commands exit with `Missing Project Context: run inside a Project or use --project <path>.` They do not select a last-used Project, the package installation directory, `PI_MESSENGER_CWD`, or the directory where the service process started, and they do not change or stop any other Project.

`PI_MESSENGER_DIR` and `PI_MESSENGER_GLOBAL=1` select a storage root, not the Project. The Project records that selection locally; registration, discovery, channels, and inboxes below shared roots are partitioned by canonical Project path and run ID. A peer started in an assigned Sandbox resolves that owning Project, finds the originating task, and claims it. Task and recovery evidence remains under the owning Project. Changing an established storage root requires an explicit migration; the runtime refuses a silent switch. Read ordinary messages with `pi-messenger-swarm inbox`; a spawned peer's inbox file is `$PI_SWARM_INBOX`. Ordinary messages stay pull-based.

```sh
pi-messenger-swarm run start --goal "Implement the accepted specification" --max-steps 50 --concurrency 3 --verify "npm run acceptance"
pi-messenger-swarm run join
pi-messenger-swarm run status
```

Only one active run is admitted per Project. New sessions explicitly join it; observers can inspect it without joining. An unfinished run with no live workers is `Awaiting Handoff`, retaining its slot. The `--verify` overall acceptance command is optional at startup. If supplied, verified solution evidence plus the overall check automatically completes and archives the run; pruned alternative hypotheses do not block acceptance. The evaluator runs asynchronously so other Projects retain responsive emergency control. Without an evaluator, overall acceptance remains visibly incomplete. `run accept` retries the recorded evaluator; it never substitutes a verbal sign-off. A task passing is not itself overall success.

Run identity, accounting, handoff history and acceptance evidence are persisted. `abort` affects the selected Project only and prevents replacement. A later run has a new identity and cannot consume old-run messages. `--stop` stops the shared service; use project-scoped `abort` for emergency control of a run.

## Critical delivery and handoff

Verification failures and merge conflicts are queued for the responsible peer. All-dead evidence and handoff suspension are queued for the Delegator. The Pi extension admits these as steer messages with a triggered turn. `notifications` exposes recipient, Project, run, task and incident plus pending/enqueued/handled state. Enqueueing alone is not successful handling; the host acknowledges after a model turn consumes the message. Pending evidence remains available when no receiver is present.

Automatic Handoff starts a successor only for an exited peer's eligible unfinished task. The successor retains its run budget, verification history and concurrency limit. Successful takeover means a successful task claim, not process creation. A successor that exits or fails to claim within 3 minutes counts as a startup/takeover failure. A claimed peer with no tool call and no in-flight tool for 10 minutes is idle and is handed off; a running evaluation is progress. There is no 10-minute process-age kill. Three consecutive failures suspend that task, without pruning its hypothesis. After repairing the environment, use `handoff resume <taskId>`; other tasks can proceed while it is suspended.

Before unexpected-exit cleanup, tracked changes and new files are saved as an explicitly **unverified** Handoff Candidate. Runtime data and dependency directories are excluded. If preservation fails, the Sandbox is retained. In a successor's own Sandbox:

```sh
pi-messenger-swarm candidate list --task task-1
pi-messenger-swarm candidate show latest --task task-1
pi-messenger-swarm task claim task-1
pi-messenger-swarm candidate restore latest --task task-1
# Optionally restore selected paths with --include <pattern>.
# Inspect, resolve conflicts, and run normal verification:
pi-messenger-swarm task done task-1 "Verified recovery" --verify "npm test"
```

Restoring never modifies the host or makes a Verified fact. Conflicts remain in the successor Sandbox for normal resolution and reverification. Emergency abort keeps its existing cleanup semantics.

## Runtime acceptance tests

`npx vitest run tests/runtime/installed.test.ts` builds and packs the release, installs with `--omit=dev` and normal scripts, and exercises the installed CLI/service in independent Git repositories. Real installed Pi processes use a deterministic local model-provider fixture at the external model API boundary; delivery and recovery are not replaced by mocked internal callbacks. This is runtime-hardening evidence, not evidence of the separate Bohrium scientific benchmark's score or ranking.

`npx vitest run tests/runtime/project-context.test.ts` drives the generated command wrapper and CLI through the service with the workspace's already-installed Pi runtime. It covers a separate target Project, a nested directory, a detached Sandbox, explicit and peer-supplied context, and a missing context that leaves other Projects unchanged. Clean dependency installation remains the installed-suite scenario above.

To run only the installation smoke scenario (no model credentials required):

```sh
npx vitest run tests/runtime/installed.test.ts -t 'loads the production extension'
```

The shared setup first installs the supplied Host/TUI, then the actual tarball in a temporary directory outside the checkout. The smoke probe uses Pi's public resource loader to discover the manifest's extension and checks that `/messenger` is registered without load errors. It verifies the installed peer versions and ranges, resolves ESM imports from both the extension and Host to compatible versions inside that installation, and checks that development tools are absent. `NODE_PATH` and `NODE_OPTIONS` are cleared for child processes. The installed CLI starts the real service; an HTTP health response proves readiness before `join` and `status` run with an explicit target project. The same installation and service are reused by the later runtime scenarios.

Issue #8 smoke validation on 2026-09-29 used Node `24.13.0`, npm `11.6.2`, and explicitly supplied Host/TUI `0.87.0`. Both extension runtime imports resolved to the supplied top-level Host/TUI under the declared `0.87.x` peer contract. The Host's own TUI resolves to a nested `0.87.0` copy within the same installation; a shared TUI file is not required. Pi loaded `dist/index.js` with no errors and registered `/messenger`; the service returned HTTP 200 with `ok: true` and a live PID, `join` returned `Delegator`, and `status` returned the Goal view. The smoke test exited 0. The package contract itself was already present in the #7 changes; #8 strengthens the reproducible installation evidence and instructions.

### Verification record — 2026-09-29

The installed-runtime suite passed all 13 scenarios using Node 24.13.0 and Pi Host/TUI 0.87.0. The release tarball was installed with `npm install --omit=dev` and normal scripts enabled in a separate temporary installation.

- The installed extension loaded, and the service accepted commands from independent target repositories; missing Project Context failed explicitly.
- Same-name peers in shared storage retained separate tasks and inboxes. Concurrent run starts admitted one owner, and restart retained its identity and budget.
- Real Pi recipients produced `HANDLED_VERIFICATION` and `HANDLED_ALL_DEAD`. A model error after receiving an incident left it enqueued until a later successful response; ordinary mail did not trigger a turn.
- A real successor recovered tracked and new source files after a peer crash and service restart. Failed reverification left the host unchanged; an evolved-host conflict required resolution and successful reverification before integration.
- Three replacement startup failures suspended only the affected task. Independent services shared admission limits for ordinary spawns and automatic recovery; exhausted budgets and abort prevented replacement.
- All-pruned tasks remained unfinished. A verified alternative passed asynchronous overall acceptance and archived the run. Another Project's abort remained responsive, and aborting the evaluator's own run stopped its delayed writes before a later run began.

### Verification record — 2026-09-30

This record covered only the installed suite, not a full test run. The 2026-10-01 record below supersedes it. Node `24.13.0`, npm `11.6.2`, package `pi-messenger-swarm@0.26.3`, Host/TUI `@earendil-works/pi-coding-agent@0.87.0` and `@earendil-works/pi-tui@0.87.0`. The suite still builds a tarball and installs it with `npm install --omit=dev` outside the checkout. This record is installed-runtime evidence only. It is not a Bohrium benchmark score, submission, or change to that benchmark's acceptance criteria.

- Readiness: the installed extension loaded, the service health check returned a live PID, and `join`/`status` ran against an explicit target Project.
- Critical delivery: a live Pi recipient handled a verification failure (`HANDLED_VERIFICATION`, exit code 7, task/run/project/incident). A second poll did not repeat it. With no live recipient the CLI exited non-zero and the notification stayed `pending`. A merge conflict produced `HANDLED_CONFLICT` and still rebased before a later successful verify. An all-dead brief produced `HANDLED_ALL_DEAD` for the Delegator. The same peer name in another Project, and again in a later run, did not receive the incident. Ordinary messages stayed pull-based.
- Candidates: unexpected exit preserved a tracked edit and a new file as `unverified`, then removed the original Sandbox. An explicit successor restored only the selected file. Exit code 9 did not integrate and did not reset verification attempts. A later exit 0 followed Direct Verified Merge. A broken worktree kept the Sandbox and saved no candidate. Abort saved no candidate and left `node_modules/keep.txt` in place. Restore did not revive a pruned task.
- Automatic handoff: one successor recovered a preserved candidate, failed reverification left the host unchanged, and successful reverification plus overall acceptance archived the run before another run could start. Three missing-provider startup failures, before any tool ran, suspended only that task (`failures: 3`, `takenOver` not true, verification attempts 0, not `dead_end`). A live Delegator handled `HANDLED_SUSPENSION`. History did not gain a fourth attempt until `handoff resume`. Another task in the same run and a task in another Project continued. Abort marked the run `aborted` and did not spawn another successor. A live lease was not stolen. Exhausted budget and a second service still did not create overlapping replacements.
- Isolation: missing Project Context failed closed. Concurrent starts admitted one run. Shared storage kept same-named peers apart. Host dependencies survived cleanup.

### Verification record — 2026-10-01 (final, b2084b8)

This record supersedes the one below. At `b2084b8`, `npx tsc --noEmit` and `pnpm run build` both exited 0. Two consecutive full runs of `npx vitest run` each passed 74 files and 575 tests, exit 0 (242.59s and 234.13s). Node `24.13.0`, npm `11.6.2`, package `pi-messenger-swarm@0.26.3`, Host/TUI `@earendil-works/pi-coding-agent@0.87.0` and `@earendil-works/pi-tui@0.87.0`. After each run there were no `while(true)` processes. Three `sleep` commands from installed-scenario Pi bash tools (60s, 90s, 120s) briefly outlived their stopped peers with deleted Sandbox directories as cwd, and exited on their own; that is a known open issue, not covered here.

- Overlapping successors: the two-service scenario holds the real `run.lock` across the Original's exit, so both services queue their admission with a snapshot taken before either spawned. Removing the two post-lock rechecks in `swarm/recovery.ts` failed it 3 of 3 times; restored, it passed 3 of 3.
- Restart reconciliation: a real Pi peer adopted across a service restart dies with a broken Sandbox gitdir. `spawn list` immediately stops listing it, `spawn history` shows `Candidate preservation failed; Sandbox retained`, and the Sandbox stays on disk. Previously the adopted runtime kept listing the dead peer as running for up to 5s.
- A spawn whose `pi` binary cannot start (no pid) publishes no peer record and counts as one takeover failure.
- Candidate preservation and Sandbox removal share one function; retention is a structured `sandboxRetained` field, and older records are still recognized by their error text.
- Test service ports use per-pid lock files, so a stale lock cannot be removed from under a new owner, and lock contents are never read.

### Verification record — 2026-10-01

Two consecutive full runs of `npx vitest run` each passed 71 files and 568 tests, exit 0 (455.47s and 446.98s). `npx vitest run tests/runtime/installed.test.ts --maxWorkers 1` passed 25 scenarios, exit 0, in 538.36s. `npx tsc --noEmit` and `pnpm run build` both exited 0. Node `24.13.0`, npm `11.6.2`, package `pi-messenger-swarm@0.26.3`, Host/TUI `0.87.0`. Each new or changed installed scenario failed when its guard was broken locally, and passed when the guard was restored.

- Delivery: a model error delays a verification incident, a merge conflict arrives while a tool is running, and all-dead and suspension incidents are enqueued again on every recovery tick and after a service restart. The real Pi receiver's output contains each `HANDLED_*` reply exactly once. During an active run, the host watchdog no longer sends a second, unacknowledged all-dead message.
- Recovery: if one peer's candidate cannot be saved, its Sandbox is kept and the failure appears in spawn history. Another task in the same tick still hands off. Pruned tasks, finished tasks and completed runs get no successor, including after late exits and a restart. Two services and a restart start exactly one successor. Its claim sets `takenOver`. It receives the failure output and verification history, and the step budget and verification attempts carry over. A successor that makes no claim within 3 minutes counts as one failure.
- Candidates: another Project or a later run cannot use `show` or `restore` with an explicit candidate id. `task done` fails, and nothing is merged, when intent-to-add fails because `index.lock` is held.
- Journey: two Projects share storage with same-named peers. The run handles a real verification failure, preserves the crashed peer's candidate, and starts a successor with unchanged accounting. Reverification fails and then passes, only verified work is integrated, acceptance archives the run, and the next run is admitted. After a service restart, host `node_modules`, untracked files and the other Project's live peer remain.
- Test stability: service ports are reserved below the ephemeral range with a lock file, so no `listen(0)`/close window remains. A spawn record is published only together with its pid, so another service cannot reclaim a Sandbox that is still starting.
