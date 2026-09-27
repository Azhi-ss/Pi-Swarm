import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  runVerification,
  detectProjectTestCommand,
  generatePatch,
} from '../../swarm/verifier/index.js';
import { taskDone } from '../../swarm/handlers/task-lifecycle.js';
import * as taskStore from '../../swarm/task-store/index.js';
import type { MessengerState } from '../../lib.js';

function createTempCwd(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-verif-test-'));
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'channels'), { recursive: true });
  return tmp;
}

function mockState(agentName: string = 'Tester'): MessengerState {
  return {
    registered: true,
    agentName,
    currentChannel: 'dev',
    sessionChannel: 'dev',
    joinedChannels: ['dev'],
    model: 'test-model',
  } as MessengerState;
}

describe('Module 4: Ground Truth Verifier Gate', () => {
  let cwd: string;
  const sessionId = 'test-session-verif';

  beforeEach(() => {
    cwd = createTempCwd();
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  describe('runVerification', () => {
    it('returns passed: true and exitCode: 0 on successful command execution', () => {
      const res = runVerification(
        cwd,
        'node -e "console.log(\'PASS_ALL_TESTS\'); process.exit(0)"',
        10_000
      );
      expect(res.passed).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('PASS_ALL_TESTS');
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns passed: false and non-zero exitCode with stderr on failure', () => {
      const res = runVerification(
        cwd,
        'node -e "console.error(\'AssertionError: expected 1 to be 2\'); process.exit(1)"',
        10_000
      );
      expect(res.passed).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('AssertionError: expected 1 to be 2');
    });

    it('terminates and returns exitCode: 124 when command times out', () => {
      // Command sleeps longer than timeout
      const res = runVerification(cwd, 'node -e "setTimeout(() => {}, 5000)"', 500);
      expect(res.passed).toBe(false);
      expect(res.exitCode).toBe(124);
      expect(res.error).toContain('timed out');
    });
  });

  describe('detectProjectTestCommand', () => {
    it('returns null when no package.json exists', () => {
      expect(detectProjectTestCommand(cwd)).toBeNull();
    });

    it('returns null when package.json test script is dummy placeholder', () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
        'utf-8'
      );
      expect(detectProjectTestCommand(cwd)).toBeNull();
    });

    it('detects npm test when valid test script is defined', () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
        'utf-8'
      );
      expect(detectProjectTestCommand(cwd)).toBe('npm test');
    });
  });

  describe('generatePatch', () => {
    it('returns null when cwd is not a git repository', () => {
      expect(generatePatch(cwd, 'task-1')).toBeNull();
    });

    it('generates .patch artifact in git repository with modifications', () => {
      // Initialize git repo in cwd
      execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@pi-swarm.local'], {
        cwd,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'Pi Tester'], { cwd, stdio: 'ignore' });

      // Create initial commit
      fs.writeFileSync(path.join(cwd, 'main.ts'), 'export const version = 1;\n', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd, stdio: 'ignore' });

      // Modify file
      fs.writeFileSync(path.join(cwd, 'main.ts'), 'export const version = 2;\n', 'utf-8');

      const patchPath = generatePatch(cwd, 'task-git-1');
      expect(patchPath).not.toBeNull();
      expect(patchPath).toBe(path.join('.pi', 'messenger', 'artifacts', 'task-git-1.patch'));

      const fullPatchPath = path.join(cwd, patchPath!);
      expect(fs.existsSync(fullPatchPath)).toBe(true);
      const patchContent = fs.readFileSync(fullPatchPath, 'utf-8');
      expect(patchContent).toContain('+export const version = 2;');
    });
  });

  describe('taskDone Verifier Gate Interception', () => {
    it('promotes task to verified on exit 0 and records verification evidence', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Implement feature X' }, 'dev');
      taskStore.claimTask(cwd, sessionId, task.id, 'Alice');

      const state = mockState('Alice');
      const res = taskDone(
        {
          id: task.id,
          summary: 'Feature X complete',
          verify: 'node -e "console.log(\'10/10 tests pass\'); process.exit(0)"',
        },
        state,
        cwd,
        'dev',
        sessionId
      );

      expect((res as any).details?.error).toBeUndefined();
      expect((res as any).details?.verified).toBe(true);
      expect((res as any).content[0]?.text).toContain('✅ Verified & Completed');

      const updated = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(updated.status).toBe('verified');
      expect(updated.verification?.exitCode).toBe(0);
      expect(updated.verification?.command).toContain('10/10 tests pass');

      // Check blackboard updated
      const bbPath = path.join(cwd, 'BLACKBOARD.md');
      expect(fs.existsSync(bbPath)).toBe(true);
      const bbContent = fs.readFileSync(bbPath, 'utf-8');
      expect(bbContent).toContain('## 🏆 Zone 3: Verified Artifacts');
      expect(bbContent).toContain(task.id);
    });

    it('strictly rejects taskDone on exit != 0, keeps task in_progress, and returns verification_failed error', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Buggy feature' }, 'dev');
      taskStore.claimTask(cwd, sessionId, task.id, 'Bob');

      const state = mockState('Bob');
      const res = taskDone(
        {
          id: task.id,
          summary: 'Should fail verification',
          verify:
            'node -e "console.error(\'TypeError: cannot read property of undefined\'); process.exit(1)"',
        },
        state,
        cwd,
        'dev',
        sessionId
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(1);
      expect((res as any).details?.output).toContain(
        'TypeError: cannot read property of undefined'
      );
      expect((res as any).content[0]?.text).toContain('❌ Verification failed');

      // Crucial: Task must NOT be marked done or verified!
      const notDone = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(notDone.status).toBe('in_progress');
      expect(notDone.verification_attempts).toBe(1);
      expect(notDone.last_verification_failure?.exitCode).toBe(1);
    });
  });
});
