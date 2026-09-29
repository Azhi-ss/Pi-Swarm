/**
 * Harness server lifecycle and CLI shell alias management.
 */

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { resolveProjectContext } from '../project.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';

/** Resolve the path to the compiled CLI entry point if it exists. */
function getDistCliPath(): string | null {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  // When loaded from dist/ (npm package), __dirname is dist/extension/
  // and the compiled CLI is at dist/harness/cli.js.
  const distPath = join(__dirname, '..', 'harness', 'cli.js');
  try {
    if (fs.existsSync(distPath)) return distPath;
  } catch {}
  return null;
}

/** Resolve the path to the source CLI entry point. */
function getSourceCliPath(): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  return join(__dirname, '..', 'harness', 'cli.ts');
}

export interface CliResolution {
  /** Command to execute ("node" or "npx"). */
  command: string;
  /** Arguments before the CLI path (e.g. ["tsx"]). */
  prefixArgs: string[];
  /** Absolute path to the CLI entry point. */
  cliPath: string;
  /** Working directory for the CLI process. */
  cwd: string;
}

/**
 * Resolve the CLI entry point, preferring the compiled dist/ version
 * when available (faster startup, no transpile overhead).
 * Falls back to npx tsx with the source .ts file.
 */
export function resolveCli(): CliResolution {
  const distCli = getDistCliPath();
  if (distCli) {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    // cwd is the package root (parent of dist/)
    return { command: 'node', prefixArgs: [], cliPath: distCli, cwd: process.cwd() };
  }
  const sourceCli = getSourceCliPath();
  const projectRoot = getProjectRoot();
  return { command: 'npx', prefixArgs: ['tsx'], cliPath: sourceCli, cwd: process.cwd() };
}

/** Resolve the project root for cwd. */
function getProjectRoot(): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  return join(__dirname, '..');
}

/**
 * Write a small shell wrapper script at ~/.pi/agent/bin/pi-messenger-swarm
 * that invokes the CLI via node. Pi adds ~/.pi/agent/bin/ to PATH for
 * every bash invocation (`getShellEnv()` prepends it), so the CLI becomes
 * available as a normal command regardless of install method.
 *
 * Uses a wrapper script instead of a symlink because the CLI's location
 * depends on whether the extension runs from source (tsx) or compiled (dist/).
 */
export function installShellAlias(): void {
  try {
    const agentBinDir = join(getAgentDir(), 'bin');
    if (!fs.existsSync(agentBinDir)) {
      fs.mkdirSync(agentBinDir, { recursive: true });
    }

    const { command, prefixArgs, cliPath } = resolveCli();
    const linkPath = join(agentBinDir, 'pi-messenger-swarm');

    const argsStr = prefixArgs.length > 0 ? ` ${prefixArgs.join(' ')}` : '';
    // The CLI resolves the target project from the caller's working directory.
    const wrapperContent = `#!/bin/sh
exec ${command}${argsStr} "${cliPath}" "$@"
`;

    // Only write if content differs (avoids unnecessary writes on every session_start)
    let currentContent: string | null = null;
    try {
      currentContent = fs.readFileSync(linkPath, 'utf-8');
    } catch {
      // doesn't exist
    }
    if (currentContent !== wrapperContent) {
      fs.writeFileSync(linkPath, wrapperContent, { mode: 0o755 });
    }
  } catch {
    // Best effort — CLI path is still available via resolveCli()
  }
}

export interface HarnessServerController {
  start(): void;
  stop(): void;
}

export function createHarnessServer(messengerDir: string): HarnessServerController {
  let harnessProcess: ChildProcess | null = null;

  function start(): void {
    if (harnessProcess) return;

    const {
      PI_MESSENGER_CHANNEL,
      PI_MESSENGER_CWD: _inheritedProject,
      ...restEnv
    } = process.env as Record<string, string | undefined>;

    // PI_MESSENGER_CHANNEL is a per-request hint (sent via x-messenger-channel
    // header) that tells a child process which channel to join. The harness is
    // a long-lived shared daemon — baking this env var into its process
    // environment makes every subsequent request resolve to that channel,
    // regardless of which agent actually issued the request.
    let pinnedProject: string | undefined;
    try {
      pinnedProject = resolveProjectContext({
        cwd: process.cwd(),
        peer: process.env.PI_SWARM_PROJECT_ROOT,
      });
    } catch {
      pinnedProject = undefined;
    }
    const env: Record<string, string> = {
      ...(restEnv as Record<string, string>),
      ...(process.env.PI_MESSENGER_DIR ? { PI_MESSENGER_DIR: process.env.PI_MESSENGER_DIR } : {}),
      ...(pinnedProject ? { PI_MESSENGER_CWD: pinnedProject } : {}),
    };

    if (process.env.PI_MESSENGER_GLOBAL) {
      env.PI_MESSENGER_GLOBAL = process.env.PI_MESSENGER_GLOBAL;
    }
    delete env.PI_MESSENGER_CHANNEL;

    const { command, prefixArgs, cliPath, cwd } = resolveCli();

    try {
      harnessProcess = spawnChild(command, [...prefixArgs, cliPath, '--start'], {
        cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        env,
      });
      harnessProcess.unref();
    } catch {
      // Harness server is optional — the extension still works for lifecycle hooks
    }
  }

  function stop(): void {
    if (!harnessProcess) return;
    try {
      harnessProcess.kill('SIGTERM');
    } catch {
      // Best effort
    }
    harnessProcess = null;
  }

  return { start, stop };
}
