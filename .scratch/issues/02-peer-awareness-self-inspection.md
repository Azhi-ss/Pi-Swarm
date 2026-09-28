# 02 — Peer Awareness and Self-Inspection Toolbox

**What to build:** Provides peer workers with targeted CLI and protocol tools: `peers --task <id>` to discover who else is working on related problems, `status --self` to introspect lease TTL countdown, allocated port slots, and remaining retry budget, and `send <peer> <msg>` for direct contract coordination. Updates `buildSwarmProtocol()` system prompt so spawned workers naturally use these tools.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent (GitHub #3)

- [ ] `pi-messenger-swarm status --self` returns JSON/ANSI card with `agentId`, `sandboxPath`, `currentTask` (id, status, leaseExpiresIn, verificationAttempts, lastError), and allocated `runtime` port slots
- [ ] `pi-messenger-swarm peers [--task <taskId>]` returns list of active workers and their current staked tasks from Mesh Registry
- [ ] `pi-messenger-swarm send <to> <message>` delivers targeted messages to `.pi/messenger/inbox/<recipient>.jsonl`
- [ ] `buildSwarmProtocol()` in `swarm/spawn.ts` updated to document these three tools directly in the system prompt for spawned workers
- [ ] Unit & integration tests in `tests/swarm/peer-toolbox.test.ts` pass 100%
