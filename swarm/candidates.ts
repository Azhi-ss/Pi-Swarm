import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SpawnedAgent } from './types.js';
import { PATCH_EXCLUDES } from './verifier/index.js';

export interface HandoffCandidate {
  id: string;
  project: string;
  runId: string;
  taskId: string;
  peer: string;
  baseCommit: string;
  createdAt: string;
  status: 'unverified';
  patch: string;
}
function directory(cwd: string, runId: string) {
  if (!/^[\w.-]+$/.test(runId)) throw new Error('Invalid run ID');
  return path.join(cwd, '.pi/messenger/candidates', runId);
}
export function listCandidates(cwd: string, runId: string): HandoffCandidate[] {
  const dir = directory(cwd, runId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function preserveCandidate(agent: SpawnedAgent): void {
  const sandbox = agent.worktreePath;
  if (
    !agent.taskId ||
    !agent.sessionId ||
    !sandbox ||
    sandbox === agent.cwd ||
    !fs.existsSync(sandbox)
  )
    return;
  const dir = directory(agent.cwd, agent.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // Stable per peer: crash recovery and close events cannot create duplicates.
  if (fs.existsSync(path.join(dir, `${agent.id}.json`))) return;
  const index = path.join(dir, `${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: sandbox, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  try {
    const baseCommit = agent.baseCommit || git('rev-parse', 'HEAD').trim();
    git('read-tree', 'HEAD');
    git('add', '-A', '--', '.', ...PATCH_EXCLUDES);
    const patch = git('diff', '--cached', '--binary', baseCommit);
    if (!patch.trim()) return;
    fs.writeFileSync(path.join(dir, `${agent.id}.patch`), patch);
    const candidate: HandoffCandidate = {
      id: agent.id,
      project: agent.cwd,
      runId: agent.sessionId,
      taskId: agent.taskId,
      peer: agent.name,
      baseCommit,
      createdAt: new Date().toISOString(),
      status: 'unverified',
      patch: path.join(dir, `${agent.id}.patch`),
    };
    fs.writeFileSync(path.join(dir, `${agent.id}.json`), JSON.stringify(candidate, null, 2));
  } finally {
    fs.rmSync(index, { force: true });
  }
}
export function restoreCandidate(
  candidate: HandoffCandidate,
  sandbox: string,
  paths?: string[]
): void {
  if (
    sandbox === candidate.project ||
    !sandbox.startsWith(path.join(candidate.project, '.swarm/workspaces') + path.sep)
  )
    throw new Error('Candidate restoration requires your own detached Sandbox.');
  const args = ['apply', '--3way', ...(paths || []).map((p) => `--include=${p}`), candidate.patch];
  const applied = spawnSync('git', args, { cwd: sandbox, encoding: 'utf8' });
  if (applied.status !== 0)
    throw new Error(
      `Candidate remains unverified; resolve conflicts in your Sandbox and reverify: ${applied.stderr}`
    );
}
