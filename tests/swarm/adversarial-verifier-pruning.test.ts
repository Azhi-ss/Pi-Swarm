import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runVerification,
  detectProjectTestCommand,
  generatePatch,
} from '../../swarm/verifier/index.js';
import { taskDone, taskClaim, taskStake, taskReset } from '../../swarm/handlers/task-lifecycle.js';
import * as taskStore from '../../swarm/task-store/index.js';
import { executeTask } from '../../swarm/handlers/task-ops.js';
import { executeAction } from '../../router.js';
import { readFeedEvents, formatFeedLine } from '../../feed/index.js';
import type { MessengerState, Dirs, AgentMailMessage } from '../../lib.js';

const roots = new Set<string>();
const TEST_SESSION = 'adv-verif-session';
const TEST_CHANNEL = 'dev';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-adv-verif-'));
  roots.add(cwd);
  fs.mkdirSync(path.join(cwd, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.pi', 'messenger', 'channels'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.pi', 'messenger', 'tasks'), { recursive: true });
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

function mockState(agentName: string = 'Adversary-Bot'): MessengerState {
  return {
    registered: true,
    agentName,
    currentChannel: TEST_CHANNEL,
    sessionChannel: TEST_CHANNEL,
    joinedChannels: [TEST_CHANNEL],
    model: 'test-model',
    contextSessionId: TEST_SESSION,
  };
}

function mockDirs(cwd: string): Dirs {
  const base = path.join(cwd, '.pi', 'messenger');
  return {
    base,
    registry: path.join(base, 'registry'),
  };
}

describe('Module 4 Adversarial Stress: Ground Truth Verifier & Fast Pruning', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCwd();
  });

  // =========================================================================
  // 1. Fake Done Attempts & Ground Truth Interception
  // =========================================================================
  describe('Suite 1: Fake Done Interception & Verification Gate', () => {
    it('strictly intercepts exit 1 test command: task NEVER marked done or verified', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Exit 1 bypass test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Red');
      const state = mockState('Agent-Red');

      const res = taskDone(
        {
          id: task.id,
          summary: 'Claiming success despite failure',
          verify: 'node -e "process.exit(1)"',
        },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      // Rejection checks
      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(1);
      expect((res as any).content[0]?.text).toContain('❌ Verification failed');

      // Task store check: Must remain in_progress
      const current = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(current.status).toBe('in_progress');
      expect(current.status).not.toBe('done');
      expect(current.status).not.toBe('verified');
      expect(current.verification).toBeUndefined();
      expect(current.verification_attempts).toBe(1);
      expect(current.last_verification_failure?.exitCode).toBe(1);
    });

    it('strictly intercepts syntax errors in verification command: captures error and rejects', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Syntax error verify' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Red');
      const state = mockState('Agent-Red');

      // Command with deliberate JavaScript syntax error
      const syntaxErrorCmd = 'node -e "function broken( {"';

      const res = taskDone(
        {
          id: task.id,
          summary: 'Syntax error verification test',
          verify: syntaxErrorCmd,
        },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).not.toBe(0);
      expect((res as any).details?.output).toMatch(/SyntaxError|Unexpected/i);

      const current = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(current.status).toBe('in_progress');
      expect(current.verification).toBeUndefined();
    });

    it('strictly intercepts exit 127 (non-existent command / binary not found)', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Missing binary verify' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Red');
      const state = mockState('Agent-Red');

      const nonExistentCmd = 'non_existent_binary_xyz_123456789 --flag';

      const res = taskDone(
        {
          id: task.id,
          summary: 'Missing command test',
          verify: nonExistentCmd,
        },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(127);
      expect((res as any).details?.output).toMatch(/not found/i);

      const current = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(current.status).toBe('in_progress');
      expect(current.status).not.toBe('verified');
    });

    it('intercepts arbitrary non-zero exit codes (exit 42, exit 255)', () => {
      for (const code of [42, 255]) {
        const task = taskStore.createTask(
          cwd,
          TEST_SESSION,
          { title: `Exit code ${code} test` },
          TEST_CHANNEL
        );
        taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Red');
        const state = mockState('Agent-Red');

        const res = taskDone(
          {
            id: task.id,
            summary: `Exit ${code}`,
            verify: `sh -c "exit ${code}"`,
          },
          state,
          cwd,
          TEST_CHANNEL,
          TEST_SESSION
        );

        expect((res as any).details?.error).toBe('verification_failed');
        expect((res as any).details?.exitCode).toBe(code);
        expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
      }
    });

    it('strictly intercepts uncaught runtime exceptions thrown by test scripts', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Runtime exception test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Red');
      const state = mockState('Agent-Red');

      const throwCmd = 'node -e "throw new Error(\'CRITICAL_VERIFICATION_CRASH\')"';

      const res = taskDone(
        { id: task.id, summary: 'Crash test', verify: throwCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.output).toContain('CRITICAL_VERIFICATION_CRASH');
      expect((res as any).details?.exitCode).toBe(1);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
    });

    it('blocks unauthorized completion: non-claimant agent cannot done a task', () => {
      const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Alice task' }, TEST_CHANNEL);
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Alice');

      const eveState = mockState('Eve');
      const res = taskDone(
        {
          id: task.id,
          summary: 'Eve steals Alice completion',
          verify: 'node -e "process.exit(0)"',
        },
        eveState,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('not_owner');
      expect((res as any).content[0]?.text).toContain('claimed by Alice');
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
    });

    it('rejects done attempts on unready/todo/verified tasks', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Unclaimed task' },
        TEST_CHANNEL
      );
      const state = mockState('Alice');

      const res = taskDone(
        { id: task.id, summary: 'Try done on unclaimed', verify: 'node -e "process.exit(0)"' },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('invalid_status');
    });

    it('respects verify command precedence: params.verify > task.verify_command > package.json', () => {
      // 1. package.json has a failing test script
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
        'utf-8'
      );

      // 2. task has a failing verify_command
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Precedence test', verifyCommand: 'node -e "process.exit(2)"' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-P');
      const state = mockState('Agent-P');

      // 3. params.verify overrides both with a passing command (exit 0)
      const res = taskDone(
        {
          id: task.id,
          summary: 'Override with passing verify',
          verify: 'node -e "process.exit(0)"',
        },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBeUndefined();
      expect((res as any).details?.verified).toBe(true);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('verified');
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.verification?.command).toContain(
        'exit(0)'
      );
    });

    it('falls back to task.verify_command when params.verify is omitted and intercepts failure', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Fallback task verifyCommand', verifyCommand: 'node -e "process.exit(4)"' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-P');
      const state = mockState('Agent-P');

      // Call taskDone without params.verify
      const res = taskDone(
        { id: task.id, summary: 'No verify override' },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(4);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
    });

    it('falls back to detectProjectTestCommand when both overrides omitted and intercepts failure', () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(5)"' } }),
        'utf-8'
      );

      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Fallback package.json' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-P');
      const state = mockState('Agent-P');

      const res = taskDone(
        { id: task.id, summary: 'Detect package test' },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(5);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
    });
  });

  // =========================================================================
  // 2. Command Injection & Dangerous Shell Commands
  // =========================================================================
  describe('Suite 2: Command Injection & Dangerous Shell Commands', () => {
    it('handles nested quotes, double quotes, and spaces safely', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Quoted command test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Sec');
      const state = mockState('Agent-Sec');

      // Command with nested quotes and escaped characters
      const cmd = `node -e "console.log('nested \\"double\\" and \\'single\\' quotes'); process.exit(0)"`;

      const res = taskDone(
        { id: task.id, summary: 'Passed with tricky quotes', verify: cmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBeUndefined();
      expect((res as any).details?.verified).toBe(true);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('verified');
    });

    it('correctly captures exit code in chained commands and subshells', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Chained command failure' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Sec');
      const state = mockState('Agent-Sec');

      // Semicolon chaining where second command fails
      const cmd = 'echo "first passed"; exit 1';

      const res = taskDone(
        { id: task.id, summary: 'Chained fail', verify: cmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(1);
      expect((res as any).details?.output).toContain('first passed');
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
    });

    it('handles subshell execution without hanging or shell escape', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Subshell test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Sec');
      const state = mockState('Agent-Sec');

      const cmd = 'bash -c "exit $(echo 3)"';

      const res = taskDone(
        { id: task.id, summary: 'Subshell exit', verify: cmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(3);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
    });

    it('handles multi-line commands, pipes, and environment variables', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Pipeline test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Sec');
      const state = mockState('Agent-Sec');

      // Pipeline where grep fails to find a match (grep exit 1 on no match)
      const pipelineCmd = 'printf "alpha\\nbeta\\ngamma\\n" | grep "delta"';

      const res = taskDone(
        { id: task.id, summary: 'Pipeline mismatch', verify: pipelineCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(1);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');
    });

    it('executes cleanly through router and executeAction dispatch without argument drift', async () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Router dispatch test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Router');
      const state = mockState('Agent-Router');
      const dirs = mockDirs(cwd);
      const ctx = { cwd } as any;

      const res = await executeAction(
        'done',
        {
          taskId: task.id,
          summary: 'Router verified completion',
          verify: 'node -e "console.log(\'Router verify ok\'); process.exit(0)"',
          channel: TEST_CHANNEL,
        },
        state,
        dirs,
        ctx,
        () => {},
        () => {}
      );

      expect((res as any).details?.error).toBeUndefined();
      expect((res as any).details?.verified).toBe(true);
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('verified');
    });
  });

  // =========================================================================
  // 3. Timeout Handling & Process Safety
  // =========================================================================
  describe('Suite 3: Timeout Handling & Process Safety', () => {
    it('kills infinite CPU loops within timeout and returns exitCode 124 without hanging', () => {
      const start = Date.now();
      const res = runVerification(cwd, 'node -e "while(true){}"', 400);
      const elapsed = Date.now() - start;

      expect(res.passed).toBe(false);
      expect(res.exitCode).toBe(124);
      expect(res.error).toContain('timed out after 400ms');
      expect(elapsed).toBeLessThan(2500); // Definitely didn't hang indefinitely
    });

    it('kills sleep/hanging processes within timeout and returns exitCode 124', () => {
      const start = Date.now();
      const res = runVerification(cwd, 'node -e "setTimeout(() => {}, 20000)"', 350);
      const elapsed = Date.now() - start;

      expect(res.passed).toBe(false);
      expect(res.exitCode).toBe(124);
      expect(res.error).toContain('timed out');
      expect(elapsed).toBeLessThan(2500);
    });

    it('handles verification timeout in taskDone with steer message and keeps task in_progress', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Hanging verification task' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Slow');
      const state = mockState('Agent-Slow');

      const deliverMock = vi.fn();

      // We spy or call runVerification directly to simulate a timeout under taskDone
      // Alternatively, let's verify that when verifyCommand times out, taskDone handles exitCode 124:
      const timeoutCmd = 'node -e "setTimeout(() => {}, 20000)"';

      // We test taskDone with a timeout-wrapped command or fast timeout
      // Let's test by verifying taskDone behavior when verifier returns exitCode 124:
      const res = taskDone(
        {
          id: task.id,
          summary: 'Should time out',
          verify: `bash -c "timeout 0.3s node -e 'while(true){}'"`,
        },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION,
        deliverMock
      );

      expect((res as any).details?.error).toBe('verification_failed');
      expect((res as any).details?.exitCode).toBe(124); // GNU timeout returns 124 on timeout
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');

      // Verify steer message received
      expect(deliverMock).toHaveBeenCalledTimes(1);
      const steer = deliverMock.mock.calls[0][0] as AgentMailMessage;
      expect(steer.text).toContain('🚨 [Verification Failed]');
      expect(steer.text).toContain('Exit Code: 124');
    });

    it('completes fast tasks without false timeouts', () => {
      const start = Date.now();
      const res = runVerification(cwd, 'node -e "console.log(\'fast\'); process.exit(0)"', 5000);
      expect(res.passed).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('fast');
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  // =========================================================================
  // 4. Fast Pruning Boundary & Lifecycle Transitions
  // =========================================================================
  describe('Suite 4: Fast Pruning Boundary & Dead End Transitions', () => {
    it('verifies exact boundary: attempt 1 (fails) -> attempt 2 (fails) -> attempt 3 (prunes to dead_end)', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Three strikes algorithm' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-3Strikes');
      const state = mockState('Agent-3Strikes');

      const failingCmd = 'node -e "console.error(\'Flawed invariant\'); process.exit(1)"';
      const deliverMock = vi.fn();

      // --- Attempt 1 ---
      const res1 = taskDone(
        { id: task.id, summary: 'First try', verify: failingCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION,
        deliverMock
      );
      expect((res1 as any).details?.error).toBe('verification_failed');
      expect((res1 as any).details?.attempt).toBe(1);
      expect((res1 as any).details?.pruned).toBeUndefined();

      const taskA1 = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(taskA1.status).toBe('in_progress');
      expect(taskA1.claimed_by).toBe('Agent-3Strikes');
      expect(taskA1.verification_attempts).toBe(1);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deliverMock.mock.calls[0][0].text).toContain('Attempt 1/3');

      // --- Attempt 2 ---
      const res2 = taskDone(
        { id: task.id, summary: 'Second try', verify: failingCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION,
        deliverMock
      );
      expect((res2 as any).details?.error).toBe('verification_failed');
      expect((res2 as any).details?.attempt).toBe(2);
      expect((res2 as any).details?.pruned).toBeUndefined();

      const taskA2 = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(taskA2.status).toBe('in_progress');
      expect(taskA2.claimed_by).toBe('Agent-3Strikes');
      expect(taskA2.verification_attempts).toBe(2);
      expect(deliverMock).toHaveBeenCalledTimes(2);
      expect(deliverMock.mock.calls[1][0].text).toContain('Attempt 2/3');

      // --- Attempt 3 (BOUNDARY: Fast Pruning!) ---
      const res3 = taskDone(
        { id: task.id, summary: 'Third try', verify: failingCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION,
        deliverMock
      );
      expect((res3 as any).details?.error).toBe('verification_failed');
      expect((res3 as any).details?.attempt).toBe(3);
      expect((res3 as any).details?.pruned).toBe(true);
      expect((res3 as any).content[0]?.text).toContain('🪦 Task');
      expect((res3 as any).content[0]?.text).toContain(
        'pruned to Dead End after 3 verification failures'
      );

      const taskA3 = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(taskA3.status).toBe('dead_end');
      expect(taskA3.verification_attempts).toBe(3);
      expect(taskA3.claimed_by).toBeUndefined(); // Claim revoked!
      expect(taskA3.claimed_at).toBeUndefined();
      expect(taskA3.lease_expires_at).toBeUndefined();
      expect(taskA3.dead_end_reason).toContain('Verification failed 3 times');
      expect(taskA3.dead_ends?.length).toBe(1);
      expect(taskA3.dead_ends![0].agent).toBe('Agent-3Strikes');
      expect(taskA3.dead_ends![0].reason).toContain('Verification failed 3 times');
      expect(taskA3.dead_ends![0].errorLog).toContain('Flawed invariant');

      // Feed check: task.dead_end event emitted
      const events = readFeedEvents(cwd, 10, TEST_CHANNEL);
      const deadEndEvent = events.find((e) => e.type === 'task.dead_end');
      expect(deadEndEvent).toBeDefined();
      expect(deadEndEvent?.target).toBe(task.id);
      expect(formatFeedLine(deadEndEvent!)).toContain('🪦 dead_end');

      // Blackboard check: Graveyard Zone has the tombstone
      const bbContent = fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf-8');
      expect(bbContent).toContain('## 🪦 Zone 4: Graveyard & Dead Ends');
      expect(bbContent).toContain(task.id);
      expect(bbContent).toContain('Three strikes algorithm');
      expect(bbContent).toContain('Flawed invariant');
    });

    it('strictly prevents 4th attempt from completing a pruned dead_end task', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: '4th attempt defense' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-4');
      const state = mockState('Agent-4');

      const failCmd = 'node -e "process.exit(1)"';
      taskDone(
        { id: task.id, summary: '1', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: task.id, summary: '2', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: task.id, summary: '3', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      // Verify task is now dead_end
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('dead_end');

      // Attempt 4: Sneak done attempt with a PASSING verify command on dead_end task
      const sneakRes = taskDone(
        { id: task.id, summary: 'Sneak done on dead_end', verify: 'node -e "process.exit(0)"' },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      // Must be rejected with invalid_status!
      expect((sneakRes as any).details?.error).toBe('invalid_status');
      expect((sneakRes as any).content[0]?.text).toContain('is dead_end, not in_progress');

      // Task status remains dead_end
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('dead_end');
    });

    it('rejects claimTask and stakeTask on dead_end tasks', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Cannot revive via claim' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Init');
      const state = mockState('Agent-Init');

      const failCmd = 'node -e "process.exit(1)"';
      taskDone(
        { id: task.id, summary: '1', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: task.id, summary: '2', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: task.id, summary: '3', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('dead_end');

      // Agent-2 tries to claim or stake dead_end task
      const otherState = mockState('Agent-Other');
      const claimRes = taskClaim({ id: task.id }, otherState, cwd, TEST_CHANNEL, TEST_SESSION);
      expect((claimRes as any).details?.error).toBe('not_ready');

      const stakeRes = taskStake({ id: task.id }, otherState, cwd, TEST_CHANNEL, TEST_SESSION);
      expect((stakeRes as any).details?.error).toBe('not_ready');

      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('dead_end');
    });

    it('allows successful recovery before boundary: failure on 1 & 2, then success on 3 -> verified', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Healed before pruning' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Healer');
      const state = mockState('Agent-Healer');

      const failCmd = 'node -e "process.exit(1)"';
      const passCmd = 'node -e "process.exit(0)"';

      // Attempt 1: Fail
      taskDone(
        { id: task.id, summary: '1', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');

      // Attempt 2: Fail
      taskDone(
        { id: task.id, summary: '2', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('in_progress');

      // Attempt 3: SUCCESS (bug fixed)
      const res3 = taskDone(
        { id: task.id, summary: 'Fixed and passing', verify: passCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res3 as any).details?.error).toBeUndefined();
      expect((res3 as any).details?.verified).toBe(true);

      const verifiedTask = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(verifiedTask.status).toBe('verified');
      expect(verifiedTask.verification?.exitCode).toBe(0);
      expect(verifiedTask.dead_end_reason).toBeUndefined();
    });

    it('permits explicit taskReset to revive a dead_end task back to todo', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Dead end to revive' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Init');
      const state = mockState('Agent-Init');

      const failCmd = 'node -e "process.exit(1)"';
      taskDone(
        { id: task.id, summary: '1', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: task.id, summary: '2', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: task.id, summary: '3', verify: failCmd },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.status).toBe('dead_end');

      // Reset the dead_end task
      const resetRes = taskReset({ id: task.id }, state, cwd, TEST_CHANNEL, TEST_SESSION);
      expect((resetRes as any).details?.reset).toContain(task.id);

      const revived = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(revived.status).toBe('todo');
      expect(revived.claimed_by).toBeUndefined();

      // Now it can be claimed again!
      const newClaim = taskClaim({ id: task.id }, state, cwd, TEST_CHANNEL, TEST_SESSION);
      expect((newClaim as any).details?.task?.status).toBe('in_progress');
    });

    it('accumulates failure attempts across agent handoffs/unclaims without strike counter reset', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Multi-agent failure accumulation' },
        TEST_CHANNEL
      );
      const failCmd = 'node -e "process.exit(1)"';

      // Agent 1 claims, fails once, unclaims
      const state1 = mockState('Agent-One');
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-One');
      taskDone(
        { id: task.id, summary: 'A1 try 1', verify: failCmd },
        state1,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.verification_attempts).toBe(1);
      taskStore.unclaimTask(cwd, TEST_SESSION, task.id, 'Agent-One');

      // Agent 2 claims, fails once, unclaims
      const state2 = mockState('Agent-Two');
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Two');
      taskDone(
        { id: task.id, summary: 'A2 try 2', verify: failCmd },
        state2,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(taskStore.getTask(cwd, TEST_SESSION, task.id)!.verification_attempts).toBe(2);
      taskStore.unclaimTask(cwd, TEST_SESSION, task.id, 'Agent-Two');

      // Agent 3 claims, fails 3rd time -> triggers Fast Pruning to dead_end!
      const state3 = mockState('Agent-Three');
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Three');
      const res3 = taskDone(
        { id: task.id, summary: 'A3 try 3', verify: failCmd },
        state3,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res3 as any).details?.pruned).toBe(true);
      const finalTask = taskStore.getTask(cwd, TEST_SESSION, task.id)!;
      expect(finalTask.status).toBe('dead_end');
      expect(finalTask.verification_attempts).toBe(3);
    });

    it('strictly isolates failures across different tasks and updates SwarmSummary metrics', () => {
      // Task A: Fails 3 times -> dead_end
      const taskA = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Task A (flawed)' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, taskA.id, 'Agent-A');
      const stateA = mockState('Agent-A');
      const failCmd = 'node -e "process.exit(1)"';
      taskDone(
        { id: taskA.id, summary: '1', verify: failCmd },
        stateA,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: taskA.id, summary: '2', verify: failCmd },
        stateA,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      taskDone(
        { id: taskA.id, summary: '3', verify: failCmd },
        stateA,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(taskStore.getTask(cwd, TEST_SESSION, taskA.id)!.status).toBe('dead_end');

      // Task B: Fails once -> in_progress, attempts=1
      const taskB = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Task B (in progress)' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, taskB.id, 'Agent-B');
      const stateB = mockState('Agent-B');
      taskDone(
        { id: taskB.id, summary: '1', verify: failCmd },
        stateB,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      const taskBState = taskStore.getTask(cwd, TEST_SESSION, taskB.id)!;
      expect(taskBState.status).toBe('in_progress');
      expect(taskBState.verification_attempts).toBe(1);

      // Task C: Verified -> verified
      const taskC = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Task C (golden fact)' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, taskC.id, 'Agent-C');
      const stateC = mockState('Agent-C');
      taskDone(
        { id: taskC.id, summary: 'Success', verify: 'node -e "process.exit(0)"' },
        stateC,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(taskStore.getTask(cwd, TEST_SESSION, taskC.id)!.status).toBe('verified');

      // Check summary
      const summary = taskStore.getSummary(cwd, TEST_SESSION);
      expect(summary.dead_end).toBe(1);
      expect(summary.in_progress).toBe(1);
      expect(summary.verified).toBe(1);
      expect(summary.total).toBe(3);

      // Check graveyard selector
      const graveyard = taskStore.getGraveyardTasks(cwd, TEST_SESSION);
      expect(graveyard.length).toBe(1);
      expect(graveyard[0].id).toBe(taskA.id);
    });
  });

  // =========================================================================
  // 5. Stderr/Stdout Capture & Truncation Under Load
  // =========================================================================
  describe('Suite 5: Stderr/Stdout Capture & Truncation Under Load', () => {
    it('captures massive stderr output (120KB) in runVerification without buffer overflow', () => {
      // 120KB output script
      const script = 'node -e "console.error(\'E\'.repeat(120_000)); process.exit(1)"';
      const res = runVerification(cwd, script, 10_000);

      expect(res.passed).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.length).toBeGreaterThanOrEqual(120_000);
      expect(res.error).toBeUndefined(); // child_process did not throw maxBuffer error
    });

    it('strictly truncates giant output to 2000 chars in taskDone and prevents JSONL explosion', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Giant output test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-Flood');
      const state = mockState('Agent-Flood');
      const deliverMock = vi.fn();

      const giantStderrScript = 'node -e "console.error(\'X\'.repeat(100_000)); process.exit(1)"';

      const res = taskDone(
        { id: task.id, summary: 'Giant stderr test', verify: giantStderrScript },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION,
        deliverMock
      );

      expect((res as any).details?.error).toBe('verification_failed');

      // 1. Check returned output in result details: must be truncated to around 2000 chars + message
      const output = (res as any).details?.output as string;
      expect(output.length).toBeLessThan(2050);
      expect(output).toContain('... [truncated]');

      // 2. Check JSONL file size: must NOT contain 100KB of raw text!
      const jsonlPath = path.join(cwd, '.pi', 'messenger', 'tasks', `${TEST_SESSION}.jsonl`);
      expect(fs.existsSync(jsonlPath)).toBe(true);
      const stat = fs.statSync(jsonlPath);
      // Entire JSONL with task creation, claim, and failure should be well under 10KB
      expect(stat.size).toBeLessThan(8000);

      // 3. Check steer message delivery: text must be bounded
      expect(deliverMock).toHaveBeenCalledTimes(1);
      const steerMsg = deliverMock.mock.calls[0][0] as AgentMailMessage;
      expect(steerMsg.text.length).toBeLessThan(2500);
      expect(steerMsg.text).toContain('... [truncated]');
    });

    it('keeps BLACKBOARD.md compact (<1000 tokens) even when multiple tasks experience giant failures', () => {
      // Create 3 tasks and fail them all with massive stdout/stderr
      for (let i = 1; i <= 3; i++) {
        const task = taskStore.createTask(
          cwd,
          TEST_SESSION,
          { title: `Task Flood ${i}` },
          TEST_CHANNEL
        );
        taskStore.claimTask(cwd, TEST_SESSION, task.id, `Agent-${i}`);
        const state = mockState(`Agent-${i}`);
        const giantScript = `node -e "console.error('ERROR_LINE_${i}_'.repeat(5000)); process.exit(1)"`;

        // 3 failures each to prune all 3 to dead_end
        taskDone(
          { id: task.id, summary: '1', verify: giantScript },
          state,
          cwd,
          TEST_CHANNEL,
          TEST_SESSION
        );
        taskDone(
          { id: task.id, summary: '2', verify: giantScript },
          state,
          cwd,
          TEST_CHANNEL,
          TEST_SESSION
        );
        taskDone(
          { id: task.id, summary: '3', verify: giantScript },
          state,
          cwd,
          TEST_CHANNEL,
          TEST_SESSION
        );
      }

      // Check blackboard file
      const bbPath = path.join(cwd, 'BLACKBOARD.md');
      expect(fs.existsSync(bbPath)).toBe(true);
      const bbContent = fs.readFileSync(bbPath, 'utf-8');

      // Check that all 3 tasks are listed in Graveyard
      expect(bbContent).toContain('Task Flood 1');
      expect(bbContent).toContain('Task Flood 2');
      expect(bbContent).toContain('Task Flood 3');

      // The entire BLACKBOARD.md file size should be strictly bounded (well under 10KB / ~1000 tokens)
      expect(bbContent.length).toBeLessThan(6000);

      // Check that the error snippet per task in graveyard is cleanly excerpted
      const lines = bbContent.split('\n');
      for (const line of lines) {
        if (line.includes('Error Snippet:')) {
          expect(line.length).toBeLessThan(300);
        }
      }
    });

    it('safely handles combined giant stdout AND giant stderr without overflow', () => {
      const task = taskStore.createTask(
        cwd,
        TEST_SESSION,
        { title: 'Mixed flood test' },
        TEST_CHANNEL
      );
      taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Agent-FloodMix');
      const state = mockState('Agent-FloodMix');

      // Generates 80KB stdout and 80KB stderr
      const script =
        "node -e \"console.log('O'.repeat(80_000)); console.error('E'.repeat(80_000)); process.exit(1)\"";

      const res = taskDone(
        { id: task.id, summary: 'Mixed flood', verify: script },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );

      expect((res as any).details?.error).toBe('verification_failed');
      const output = (res as any).details?.output as string;
      expect(output.length).toBeLessThan(2050);
      expect(output).toContain('... [truncated]');
      expect(output).toContain('E'); // Stderr appears first in combined output
    });
  });
});
