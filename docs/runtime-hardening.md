# Installed runtime and recovery

Pi-Swarm is a Pi extension with a companion CLI. It requires Node.js 22.19 or later and a compatible Pi Host. The tested host and TUI versions are `@earendil-works/pi-coding-agent@0.87.0` and `@earendil-works/pi-tui@0.87.0`; the peer dependency contract is `0.87.x`.

A reproducible local installation, without a source checkout or development dependencies:

```sh
npm install --omit=dev @earendil-works/pi-coding-agent@0.87.0 @earendil-works/pi-tui@0.87.0 pi-messenger-swarm
npx pi --extension ./node_modules/pi-messenger-swarm/dist/index.js
```

Put this installation's `node_modules/.bin` on PATH when starting the companion CLI/service so spawned peers use the same Pi Host. A global `pi` executable by itself does not satisfy Node runtime imports. The package declares the Pi libraries as peers, so npm resolves them in the installation tree. Development remains `pnpm install`, `pnpm run build`.

## Project and run selection

Run the CLI from the target Git repository, from a directory with `.pi`, or use `--project /absolute/project`. A managed detached Sandbox resolves to its owning Project. A directory without a Project fails instead of borrowing the service's last Project. Installation paths never select the target.

`PI_MESSENGER_DIR` and `PI_MESSENGER_GLOBAL=1` select a storage root. The Project records that selection locally; messaging below shared roots is partitioned by canonical Project path and run ID. Task and recovery evidence remains under the owning Project. Changing an established storage root requires an explicit migration; the runtime refuses a silent switch. Read ordinary messages with `pi-messenger-swarm inbox`.

```sh
pi-messenger-swarm run start --goal "Implement the accepted specification" --max-steps 50 --concurrency 3 --verify "npm run acceptance"
pi-messenger-swarm run join
pi-messenger-swarm run status
```

Only one active run is admitted per Project. New sessions explicitly join it; observers can inspect it without joining. An unfinished run with no live workers is `Awaiting Handoff`, retaining its slot. The `--verify` overall acceptance command is optional at startup. If supplied, verified solution evidence plus the overall check automatically completes and archives the run; pruned alternative hypotheses do not block acceptance. The evaluator runs asynchronously so other Projects retain responsive emergency control. Without an evaluator, overall acceptance remains visibly incomplete. `run accept` retries the recorded evaluator; it never substitutes a verbal sign-off. A task passing is not itself overall success.

Run identity, accounting, handoff history and acceptance evidence are persisted. `abort` affects the selected Project only and prevents replacement. A later run has a new identity and cannot consume old-run messages. `--stop` stops the shared service; use project-scoped `abort` for emergency control of a run.

## Critical delivery and handoff

Verification failures and merge conflicts are queued for the responsible peer. All-dead evidence and handoff suspension are queued for the Delegator. The Pi extension admits these as steer messages with a triggered turn. `notifications` exposes recipient, Project, run, task and incident plus pending/enqueued/handled state. Enqueueing alone is not successful handling; the host acknowledges after a model turn consumes the message. Pending evidence remains available when no receiver is present.

Automatic Handoff starts a successor only for an exited peer's eligible unfinished task. The successor retains its run budget, verification history and concurrency limit. Successful takeover means a successful task claim, not process creation. A successor that exits or fails to claim within 30 seconds counts as a startup/takeover failure. Three consecutive failures suspend that task, without pruning its hypothesis. After repairing the environment, use `handoff resume <taskId>`; other tasks can proceed while it is suspended.

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

### Verification record — 2026-09-29

The installed-runtime suite passed all 13 scenarios using Node 24.13.0 and Pi Host/TUI 0.87.0. The release tarball was installed with `npm install --omit=dev` and normal scripts enabled in a separate temporary installation.

- The installed extension loaded, and the service accepted commands from independent target repositories; missing Project Context failed explicitly.
- Same-name peers in shared storage retained separate tasks and inboxes. Concurrent run starts admitted one owner, and restart retained its identity and budget.
- Real Pi recipients produced `HANDLED_VERIFICATION` and `HANDLED_ALL_DEAD`. A model error after receiving an incident left it enqueued until a later successful response; ordinary mail did not trigger a turn.
- A real successor recovered tracked and new source files after a peer crash and service restart. Failed reverification left the host unchanged; an evolved-host conflict required resolution and successful reverification before integration.
- Three replacement startup failures suspended only the affected task. Independent services shared admission limits for ordinary spawns and automatic recovery; exhausted budgets and abort prevented replacement.
- All-pruned tasks remained unfinished. A verified alternative passed asynchronous overall acceptance and archived the run. Another Project's abort remained responsive, and aborting the evaluator's own run stopped its delayed writes before a later run began.
