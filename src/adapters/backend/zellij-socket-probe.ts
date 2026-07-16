/**
 * Zellij socket probe — attribute a (possibly renamed) zellij session socket
 * FILE to the server PID that owns it. Runs as a standalone child script
 * (`node zellij-socket-probe.js <socketPath> <candidatePid>...`) so the
 * parent's sync findServerPid can spawnSync it.
 *
 * Why this exists: `zellij action rename-session` (what the session-manager
 * plugin drives) renames the session's socket FILE, but both the server's
 * argv AND the kernel's bound-address string (/proc/net/unix Path column)
 * keep the spawn-time path forever (verified live on 0.44.1). Session names
 * are also REUSABLE after a rename frees them, so two servers can share the
 * same spawn-time path — any lookup keyed on names/paths (argv tail, bound
 * path) can bind the WRONG server (Codex review findings #1/#2 on PR #468).
 * The only sound mapping is per-connection causality, established here.
 *
 * Attribution protocol (all snapshots are of candidate servers' /proc/<pid>/fd
 * socket inodes, filtered to inodes whose /proc/net/unix row is bound under
 * the socket dir — i.e. accepted zellij-session sockets, not random fds):
 *   1. snapshot BEFORE, then connect() to the socket file and HOLD;
 *   2. after 300ms, snapshot DURING — the owner has accept()ed our connection
 *      by now, so it gained an inode; then close our end;
 *   3. after 150ms, snapshot FINAL — the owner's accepted socket disappears.
 * A pid owns the file iff it gained an inode during the hold AND that inode
 * vanished after our close (appear-during-hold ∧ vanish-after-close). A
 * sibling server that received an unrelated connection in the window keeps it
 * open past our close (long-lived client → excluded); an unrelated SHORT
 * client (e.g. a concurrent `zellij action`) also appears-then-vanishes, but
 * then TWO pids qualify → exit 3, fail-closed. The parent retries once; a
 * repeat coincidence is practically impossible.
 *
 * Output: the owner PID on stdout, exit 0. Non-zero on any failure (connect
 * refused / no owner attributable / ambiguous) — callers treat all of these
 * as "not found" (宁缺勿错). Linux-only (/proc).
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Kernel socket inodes bound under `dir` per /proc/net/unix content. Pure. */
export function unixInodesUnderDir(procNetUnix: string, dir: string): Set<string> {
  const inodes = new Set<string>();
  for (const line of procNetUnix.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 8 && cols[7]!.startsWith(`${dir}/`)) inodes.add(cols[6]!);
  }
  return inodes;
}

/** Socket inodes among fd link targets (`socket:[123]` → "123"). Pure. */
export function socketInodesFromFdLinks(links: string[]): Set<string> {
  const inodes = new Set<string>();
  for (const l of links) {
    const m = l.match(/^socket:\[(\d+)\]$/);
    if (m) inodes.add(m[1]!);
  }
  return inodes;
}

/**
 * The pids whose fd table gained a dir-bound socket inode between `before`
 * and `during` that is gone again in `final` — i.e. the accept()/close()
 * lifecycle of OUR probe connection. Pure (testable): the causal core.
 */
export function attributeOwners(
  pids: number[],
  before: Map<number, Set<string>>,
  during: Map<number, Set<string>>,
  final: Map<number, Set<string>>,
  dirBoundInodes: Set<string>,
): number[] {
  return pids.filter(pid => {
    const b = before.get(pid) ?? new Set();
    const d = during.get(pid) ?? new Set();
    const f = final.get(pid) ?? new Set();
    return [...d].some(ino => !b.has(ino) && dirBoundInodes.has(ino) && !f.has(ino));
  });
}

function snapFds(pid: number): Set<string> {
  const links: string[] = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try { links.push(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* fd raced away */ }
    }
  } catch { /* process gone or fd table not readable */ }
  return socketInodesFromFdLinks(links);
}

function main(socketPath: string, pids: number[]): void {
  const dir = dirname(socketPath);
  const snapAll = () => new Map(pids.map(p => [p, snapFds(p)]));
  const before = snapAll();
  const client = connect(socketPath, () => {
    setTimeout(() => {
      const during = snapAll();
      const bound = unixInodesUnderDir(readFileSync('/proc/net/unix', 'utf-8'), dir);
      client.destroy();
      setTimeout(() => {
        const owners = attributeOwners(pids, before, during, snapAll(), bound);
        if (owners.length === 1) {
          process.stdout.write(String(owners[0]));
          process.exit(0);
        }
        process.exit(3); // 0 = accept not observed; >1 = concurrent-client race
      }, 150);
    }, 300);
  });
  client.on('error', () => process.exit(1));
  setTimeout(() => { client.destroy(); process.exit(2); }, 5000).unref();
}

// Only run when executed directly (the pure helpers are also imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sock = process.argv[2];
  const pids = process.argv.slice(3).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!sock || pids.length === 0) process.exit(64);
  main(sock, pids);
}
