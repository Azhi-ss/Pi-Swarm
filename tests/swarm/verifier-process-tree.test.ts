import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runVerification } from '../../swarm/verifier/index.js';

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-verifier-tree-'));
  dirs.push(dir);
  return dir;
}

function recordedPid(dir: string) {
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  pids.push(pid);
  return pid;
}

const gone = async (pid: number) => {
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 2000 });
  // A reaped pid may be reused; only a still-running test process is killed.
  pids.splice(pids.indexOf(pid), 1);
};

const writePid = `require('fs').writeFileSync('pid', String(process.pid))`;

it.skipIf(process.platform === 'win32')(
  'kills the process the verify command started when it times out',
  async () => {
    const dir = sandbox();
    // `&& true` keeps the shell from exec-ing node, as a compound verify command would.
    const result = runVerification(dir, `node -e "${writePid}; while (true) {}" && true`, 1500);
    expect(result.exitCode).toBe(124);
    await gone(recordedPid(dir));
  }
);

it.skipIf(process.platform === 'win32')(
  'leaves no background process behind after a verify command exits',
  async () => {
    const dir = sandbox();
    const result = runVerification(
      dir,
      `node -e "${writePid}; setInterval(() => {}, 1000)" >/dev/null 2>&1 & while [ ! -s pid ]; do sleep 0.05; done`,
      10_000
    );
    expect(result.exitCode).toBe(0);
    await gone(recordedPid(dir));
  }
);
