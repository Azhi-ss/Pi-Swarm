# Peer Harness Actions Are Deferred Tools

A spawned Peer learns twelve harness actions as deferred tools, named in its nine-line protocol. The Delegator keeps the command line and the swarm skill. We rejected always-on tool schemas and a shell-only protocol: schemas on every coding turn spend attention, and a protocol that shows shell commands makes the Peer use `bash` instead of looking the tools up.

## Considered Options

- **Shell only**: The Peer already has `bash`, so attention stays smaller, but arguments are easy to mistype and results come back as text.
- **Direct tools**: Convenient, and all twelve schemas sit in the tool list from the first turn.
- **Three tools**: `claim`, `progress`, and `done` only. The protocol would still teach the other actions as shell, so the Peer has two ways to do one job.

## Consequences

- The tools register only on a spawned Peer, with exposure `deferred`. `tool_search` is on. A tool stays declared after the Peer finds it. `spawn`, `abort`, and `run start` stay on the command line.
- The Peer starts with this extension alone. It does not load the swarm skill, built-in MCP, or other configured packages. It receives the current repo's skills, plus any skill named on `spawn`. It joins the mesh when it starts. `task progress` extends the Lease.
- The nine-line protocol names the tools. Duplicated command tutorials leave the mission brief and the registration message. The skill file stays on disk for the Delegator and the human.
- A search and the call that follows both count toward the run's step budget. This decision does not change `CONTEXT.md` or Context Admission.
