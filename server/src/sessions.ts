/**
 * Discovery and cleanup of sibling CallMe servers.
 *
 * ngrok's free plan allows 3 simultaneous tunnels, and every open Claude Code
 * session starts its own CallMe server with its own tunnel. Once the limit is
 * reached, further sessions boot with no public URL and cannot place calls.
 *
 * This module finds those sibling servers so the failure can name them, and can
 * stop them to free a slot. It deliberately targets *only* CallMe server
 * processes — never Claude Code itself, and never the session's own work.
 */

import { execFileSync } from 'node:child_process';

export interface CallMeProcess {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * A process is ours to manage only if its command line looks like a CallMe
 * server entrypoint. Both conditions must hold, so an unrelated `index.ts` or a
 * directory that merely mentions the word cannot match.
 */
function looksLikeCallMeServer(command: string): boolean {
  const inCallMePath = /call[-_]?me/i.test(command);
  const isServerEntry = /src[/\\]index\.ts|--cwd[^\n]*server|\bserver\b[^\n]*\bstart\b/.test(command);
  return inCallMePath && isServerEntry;
}

/** Every CallMe server process on this machine except this one and its wrapper. */
export function findOtherCallMeServers(): CallMeProcess[] {
  let raw: string;
  try {
    raw = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }

  const self = process.pid;
  const parent = process.ppid;

  return raw
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
    })
    .filter((p): p is CallMeProcess => p !== null)
    // Never target ourselves, our `bun run --cwd ...` wrapper, or our children.
    .filter((p) => p.pid !== self && p.pid !== parent && p.ppid !== self)
    .filter((p) => looksLikeCallMeServer(p.command));
}

export interface CloseResult {
  stopped: number[];
  failed: { pid: number; reason: string }[];
}

/**
 * Stop sibling CallMe servers, freeing their ngrok tunnels.
 *
 * Sends SIGTERM so each server runs its normal shutdown path (hanging up any
 * live call and closing its tunnel cleanly) rather than being killed outright.
 */
export function closeOtherCallMeServers(): CloseResult {
  const result: CloseResult = { stopped: [], failed: [] };

  for (const proc of findOtherCallMeServers()) {
    try {
      process.kill(proc.pid, 'SIGTERM');
      result.stopped.push(proc.pid);
    } catch (error) {
      result.failed.push({ pid: proc.pid, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
