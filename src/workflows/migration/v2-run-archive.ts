/**
 * One-time, read-only-to-the-source archive for retired v2 workflow runs.
 *
 * The archive deliberately stores both the byte-exact legacy tree and the
 * current ops projection.  The legacy replay implementation can be deleted only
 * after `verifyV2RunArchive(..., { sourceRunsDir })` proves that both views
 * still match the live source.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { fsyncDirectorySyncPortable } from '../../utils/fs-durability.js';
import { withFileLock } from '../../utils/file-lock.js';
import { canonicalJsonStringify } from '../definition.js';
import { parseEvent, type WorkflowEvent } from '../events/schema.js';
import {
  isValidRunId,
  readRunSnapshot,
  type RunSnapshotDTO,
} from '../ops-projection.js';
import {
  V2_RUN_ARCHIVE_COMMIT_SCHEMA_VERSION,
  V2_RUN_ARCHIVE_KIND,
  V2_RUN_ARCHIVE_SCHEMA_VERSION,
  archiveDirectoryName,
  parseV2RunArchiveCommitMarker,
  parseV2RunArchiveManifest,
  sha256Ref,
  v2RunArchiveId,
  type V2RunArchiveCommitMarker,
  type V2RunArchiveContent,
  type V2RunArchiveFile,
  type V2RunArchiveManifest,
  type V2RunArchiveResidual,
  type V2RunArchiveRun,
  type V2RunArchiveWarning,
} from './v2-run-archive-schema.js';

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const BUFFER_BYTES = 64 * 1024;
const MANIFEST_FILE = 'manifest.json';
const COMMIT_FILE = 'COMMITTED';
const STAGING_PREFIX = '.staging-v2-run-archive-';
const STAGE_MARKER = 'stage.json';

export type V2RunArchiveCommitPhase =
  | 'after-first-capture'
  | 'after-copy'
  | 'after-second-capture'
  | 'after-manifest'
  | 'after-publish'
  | 'after-commit-marker';

export class V2RunArchiveError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'V2RunArchiveError';
  }
}

interface SourceCopy {
  sourcePath: string;
  archivePath: string;
  expected: V2RunArchiveFile;
}

interface SourceCapture {
  sourceRunsDir: string;
  content: V2RunArchiveContent;
  copies: SourceCopy[];
  projections: Map<string, Buffer>;
}

export interface V2RunArchivePlan {
  sourceRunsDir: string;
  content: V2RunArchiveContent;
  runCount: number;
  residualCount: number;
  totalPayloadBytes: number;
}

export interface CommitV2RunArchiveInput {
  runsDir: string;
  archiveBaseDir: string;
  now?: Date;
  /** Crash-injection seam. Production callers omit it. */
  onPhase?: (phase: V2RunArchiveCommitPhase) => void | Promise<void>;
}

export interface CommitV2RunArchiveResult {
  archiveDir: string;
  manifest: V2RunArchiveManifest;
  reused: boolean;
  verification: V2RunArchiveVerification;
}

export interface V2RunArchiveVerification {
  archiveDir: string;
  manifest: V2RunArchiveManifest;
  staticVerified: true;
  sourceVerified: boolean;
  fileCount: number;
  totalBytes: number;
}

export interface VerifyV2RunArchiveInput {
  archiveDir: string;
  /** When provided, also require byte/projection parity with the live source. */
  sourceRunsDir?: string;
  /** Publication recovery uses static verification before COMMITTED exists. */
  allowMissingCommitMarker?: boolean;
}

interface CapturedTree {
  directories: string[];
  files: Array<{ relativePath: string; sourcePath: string; bytes: number; sha256: string }>;
}

function fail(code: string, message: string): never {
  throw new V2RunArchiveError(code, message);
}

function assertSafeRelativePath(path: string, label: string): void {
  if (
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    fail('UNSAFE_ARCHIVE_PATH', `${label} is not a normalized relative path: ${path}`);
  }
}

function assertPathInside(parent: string, child: string, label: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel === '.') return;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail('PATH_ESCAPE', `${label} escapes ${parent}: ${child}`);
  }
}

function assertPlainDirectory(path: string, label: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch (err) {
    fail('DIRECTORY_UNREADABLE', `${label} ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('UNSAFE_DIRECTORY', `${label} must be a real directory, not a symlink/special entry: ${path}`);
  }
  const fd = openSync(path, DIRECTORY_FLAGS);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      fail('DIRECTORY_RACED', `${label} changed while opening: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPlainDirectory(path, 'archive directory');
  chmodSync(path, 0o700);
}

/**
 * Create the dedicated archive base privately, but never chmod a caller-owned
 * existing directory such as /tmp or $HOME. An existing base must already
 * satisfy the private-mode contract or the operator must choose a child path.
 */
function ensurePrivateArchiveBase(path: string): void {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPlainDirectory(path, 'archive base directory');
  if (created !== undefined) chmodSync(path, 0o700);
  else assertPrivateMode(path, 0o700, 'archive base directory');
}

function assertPrivateMode(path: string, wanted: number, label: string): void {
  if (process.platform === 'win32') return;
  const mode = lstatSync(path).mode & 0o777;
  if (mode !== wanted) fail('ARCHIVE_MODE_MISMATCH', `${label} ${path} mode=${mode.toString(8)}, expected ${wanted.toString(8)}`);
}

function readSecureFile(path: string): Buffer {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('UNSAFE_SOURCE_ENTRY', `expected regular file: ${path}`);
  }
  if (before.nlink !== 1) fail('SOURCE_HARDLINK', `hard-linked source file is not archive-safe: ${path}`);
  const fd = openSync(path, READ_FLAGS);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
    ) fail('SOURCE_FILE_RACED', `source file changed while opening: ${path}`);
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(BUFFER_BYTES);
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      total += count;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 ||
      after.size !== opened.size || after.size !== total || after.mtimeMs !== opened.mtimeMs
    ) fail('SOURCE_FILE_CHANGED', `source file changed while reading: ${path}`);
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function hashSecureFile(path: string): { bytes: number; sha256: string } {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('UNSAFE_SOURCE_ENTRY', `expected regular file: ${path}`);
  }
  if (before.nlink !== 1) fail('SOURCE_HARDLINK', `hard-linked file is not archive-safe: ${path}`);
  const fd = openSync(path, READ_FLAGS);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
    ) fail('SOURCE_FILE_RACED', `file changed while opening: ${path}`);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(BUFFER_BYTES);
    let bytes = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 ||
      after.size !== opened.size || after.size !== bytes || after.mtimeMs !== opened.mtimeMs
    ) fail('SOURCE_FILE_CHANGED', `file changed while hashing: ${path}`);
    return { bytes, sha256: `sha256:${hash.digest('hex')}` };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

function writeNewPrivateFile(path: string, data: Buffer): void {
  assertPathInside(dirname(path), path, 'archive file');
  const fd = openSync(path, CREATE_FLAGS, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeAll(fd, data);
    fsyncSync(fd);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== data.length) {
      fail('ARCHIVE_WRITE_INVALID', `new archive file is not a private regular inode: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

function copyRegularFileSecure(copy: SourceCopy, payloadRoot: string): void {
  assertSafeRelativePath(copy.archivePath, 'copy destination');
  const destination = join(payloadRoot, ...copy.archivePath.split('/'));
  assertPathInside(payloadRoot, destination, 'copy destination');

  const before = lstatSync(copy.sourcePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('UNSAFE_SOURCE_ENTRY', `expected regular source file: ${copy.sourcePath}`);
  }
  if (before.nlink !== 1) fail('SOURCE_HARDLINK', `hard-linked source file is not archive-safe: ${copy.sourcePath}`);

  const sourceFd = openSync(copy.sourcePath, READ_FLAGS);
  const destinationFd = openSync(destination, CREATE_FLAGS, 0o600);
  try {
    fchmodSync(destinationFd, 0o600);
    const opened = fstatSync(sourceFd);
    if (
      !opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
    ) fail('SOURCE_FILE_RACED', `source file changed while opening: ${copy.sourcePath}`);

    const hash = createHash('sha256');
    const buffer = Buffer.alloc(BUFFER_BYTES);
    let bytes = 0;
    while (true) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      writeAll(destinationFd, buffer.subarray(0, count));
      bytes += count;
    }
    fsyncSync(destinationFd);
    const afterSource = fstatSync(sourceFd);
    const destinationStat = fstatSync(destinationFd);
    const sha256 = `sha256:${hash.digest('hex')}`;
    if (
      afterSource.dev !== opened.dev || afterSource.ino !== opened.ino || afterSource.nlink !== 1 ||
      afterSource.size !== opened.size || afterSource.size !== bytes || afterSource.mtimeMs !== opened.mtimeMs
    ) fail('SOURCE_FILE_CHANGED', `source file changed while copying: ${copy.sourcePath}`);
    if (!destinationStat.isFile() || destinationStat.nlink !== 1 || destinationStat.size !== bytes) {
      fail('ARCHIVE_COPY_INVALID', `destination file identity is unsafe: ${destination}`);
    }
    if (bytes !== copy.expected.bytes || sha256 !== copy.expected.sha256) {
      fail('SOURCE_CHANGED_DURING_ARCHIVE', `source bytes changed after first capture: ${copy.sourcePath}`);
    }
  } finally {
    closeSync(sourceFd);
    closeSync(destinationFd);
  }
}

function captureDirectoryTree(root: string): CapturedTree {
  assertPlainDirectory(root, 'source tree');
  const directories: string[] = [];
  const files: CapturedTree['files'] = [];

  const visit = (directory: string, relativeDirectory: string): void => {
    assertPlainDirectory(directory, 'source tree directory');
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\')) {
        fail('UNSAFE_SOURCE_NAME', `unsafe source entry name in ${directory}: ${entry.name}`);
      }
      const absolute = join(directory, entry.name);
      const relativePath = relativeDirectory ? posix.join(relativeDirectory, entry.name) : entry.name;
      assertSafeRelativePath(relativePath, 'source tree entry');
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('SOURCE_SYMLINK', `symlinks are forbidden in the archive source: ${absolute}`);
      if (stat.isDirectory()) {
        directories.push(relativePath);
        visit(absolute, relativePath);
        continue;
      }
      if (!stat.isFile()) fail('SOURCE_SPECIAL_ENTRY', `special filesystem entry is forbidden: ${absolute}`);
      if (stat.nlink !== 1) fail('SOURCE_HARDLINK', `hard-linked source file is forbidden: ${absolute}`);
      const hashed = hashSecureFile(absolute);
      files.push({ relativePath, sourcePath: absolute, ...hashed });
    }
  };
  visit(root, '');
  directories.sort();
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { directories, files };
}

function captureTopFile(path: string, name: string): CapturedTree {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail('SOURCE_SPECIAL_ENTRY', `unsafe top-level entry: ${path}`);
  if (stat.nlink !== 1) fail('SOURCE_HARDLINK', `hard-linked top-level file is forbidden: ${path}`);
  const hashed = hashSecureFile(path);
  return { directories: [], files: [{ relativePath: name, sourcePath: path, ...hashed }] };
}

function treeDigest(tree: CapturedTree): string {
  return sha256Ref(canonicalJsonStringify({
    directories: tree.directories,
    files: tree.files.map(({ relativePath: path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  }));
}

function strictReadJournal(runDir: string, runId: string): WorkflowEvent[] {
  const path = join(runDir, 'events.ndjson');
  const raw = readSecureFile(path).toString('utf-8');
  if (!raw.endsWith('\n')) {
    fail('TORN_EVENT_LOG', `${path} has no final newline (possible partial append)`);
  }
  const events: WorkflowEvent[] = [];
  let lineNumber = 0;
  const lines = raw.split('\n');
  lines.pop(); // exactly one final empty segment is required above
  for (const line of lines) {
    lineNumber++;
    if (!line) fail('CORRUPT_EVENT_LOG', `${path}:${lineNumber}: blank journal line`);
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (err) {
      fail('CORRUPT_EVENT_LOG', `${path}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let event: WorkflowEvent;
    try { event = parseEvent(value); }
    catch (err) {
      fail('CORRUPT_EVENT_LOG', `${path}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const expectedEventId = `${runId}-${events.length + 1}`;
    if (event.runId !== runId || event.eventId !== expectedEventId) {
      fail(
        'RUN_IDENTITY_MISMATCH',
        `${path}:${lineNumber} expected runId/eventId ${runId}/${expectedEventId}, got ${event.runId}/${event.eventId}`,
      );
    }
    events.push(event);
  }
  if (events.length === 0) fail('EMPTY_EVENT_LOG', `${path} has no workflow events`);
  return events;
}

function presenceInTree(tree: CapturedTree): V2RunArchiveRun['presence'] {
  const files = new Set(tree.files.map((file) => file.relativePath));
  const directories = new Set(tree.directories);
  return {
    workflowJson: files.has('workflow.json'),
    chatBindingJson: files.has('chat-binding.json'),
    attemptsDir: directories.has('attempts'),
    blobsDir: directories.has('blobs'),
  };
}

function projectionWarnings(snapshot: RunSnapshotDTO, presence: V2RunArchiveRun['presence']): V2RunArchiveWarning[] {
  const warnings: V2RunArchiveWarning[] = [];
  const danglingCount =
    snapshot.dangling.activities.length +
    snapshot.dangling.effectAttempted.length +
    snapshot.dangling.waits.length +
    snapshot.dangling.cancels.length;
  const liveTerminals = Object.values(snapshot.attemptIO).filter((item) => item.terminal?.status === 'live').length;
  if (danglingCount > 0) {
    warnings.push({
      code: 'TERMINAL_RUN_HAS_DANGLING_STATE',
      message: `Terminal run retains ${danglingCount} dangling replay item(s); raw bytes and projection are preserved.`,
    });
  }
  if (liveTerminals > 0) {
    warnings.push({
      code: 'TERMINAL_RUN_HAS_LIVE_SIDECAR',
      message: `Terminal run retains ${liveTerminals} terminal sidecar(s) marked live; treated as historical metadata.`,
    });
  }
  if (!presence.workflowJson) {
    warnings.push({
      code: 'WORKFLOW_SNAPSHOT_MISSING',
      message: 'Historical run has no workflow.json snapshot; the archive preserves all bytes that remain.',
    });
  }
  return warnings;
}

function addTreeToPayload(input: {
  tree: CapturedTree;
  archiveRoot: string;
  directories: Set<string>;
  files: V2RunArchiveFile[];
  copies: SourceCopy[];
}): void {
  assertSafeRelativePath(input.archiveRoot, 'archive raw root');
  addDirectoryWithParents(input.directories, input.archiveRoot);
  for (const sourceDirectory of input.tree.directories) {
    addDirectoryWithParents(input.directories, posix.join(input.archiveRoot, sourceDirectory));
  }
  for (const sourceFile of input.tree.files) {
    const archivePath = posix.join(input.archiveRoot, sourceFile.relativePath);
    const expected = { path: archivePath, bytes: sourceFile.bytes, sha256: sourceFile.sha256 };
    input.files.push(expected);
    input.copies.push({ sourcePath: sourceFile.sourcePath, archivePath, expected });
  }
}

function addDirectoryWithParents(directories: Set<string>, path: string): void {
  assertSafeRelativePath(path, 'archive directory');
  const segments = path.split('/');
  for (let index = 1; index <= segments.length; index++) {
    directories.add(segments.slice(0, index).join('/'));
  }
}

async function captureSource(runsDirInput: string): Promise<SourceCapture> {
  const absoluteRunsDir = resolve(runsDirInput);
  assertPlainDirectory(absoluteRunsDir, 'workflow runs root');
  const sourceRunsDir = realpathSync(absoluteRunsDir);

  const runs: V2RunArchiveRun[] = [];
  const residuals: V2RunArchiveResidual[] = [];
  const directories = new Set<string>();
  const files: V2RunArchiveFile[] = [];
  const copies: SourceCopy[] = [];
  const projections = new Map<string, Buffer>();

  const entries = readdirSync(sourceRunsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.includes('/') || entry.name.includes('\\') || entry.name === '.' || entry.name === '..') {
      fail('UNSAFE_SOURCE_NAME', `unsafe top-level entry name: ${entry.name}`);
    }
    const sourcePath = join(sourceRunsDir, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) fail('SOURCE_SYMLINK', `top-level symlink is forbidden: ${sourcePath}`);
    if (!stat.isDirectory() && !stat.isFile()) fail('SOURCE_SPECIAL_ENTRY', `top-level special entry is forbidden: ${sourcePath}`);

    if (stat.isFile()) {
      const tree = captureTopFile(sourcePath, entry.name);
      const rawRoot = posix.join('residual', entry.name, 'raw');
      addTreeToPayload({ tree, archiveRoot: rawRoot, directories, files, copies });
      residuals.push({
        name: entry.name,
        sourceType: 'file',
        reason: 'top-level-file',
        rawRoot,
        fileCount: tree.files.length,
        totalBytes: tree.files.reduce((sum, file) => sum + file.bytes, 0),
        treeSha256: treeDigest(tree),
      });
      continue;
    }

    const tree = captureDirectoryTree(sourcePath);
    const hasEvents = tree.files.some((file) => file.relativePath === 'events.ndjson');
    if (!hasEvents) {
      const rawRoot = posix.join('residual', entry.name, 'raw');
      addTreeToPayload({ tree, archiveRoot: rawRoot, directories, files, copies });
      residuals.push({
        name: entry.name,
        sourceType: 'directory',
        reason: 'directory-without-events',
        rawRoot,
        fileCount: tree.files.length,
        totalBytes: tree.files.reduce((sum, file) => sum + file.bytes, 0),
        treeSha256: treeDigest(tree),
      });
      continue;
    }

    if (!isValidRunId(entry.name)) fail('INVALID_RUN_ID', `event-bearing directory has unsafe runId '${entry.name}'`);
    const events = strictReadJournal(sourcePath, entry.name);
    const snapshot = await readRunSnapshot(sourceRunsDir, entry.name);
    if (!snapshot) fail('UNPROJECTABLE_RUN', `current ops projection cannot read run ${entry.name}`);
    if (snapshot.runId !== entry.name || snapshot.run.runId !== entry.name) {
      fail('RUN_IDENTITY_MISMATCH', `projection identity for ${entry.name} does not match its directory`);
    }
    if (snapshot.lastSeq !== events.length) {
      fail('EVENT_SEQUENCE_MISMATCH', `projection lastSeq=${snapshot.lastSeq}, strict journal count=${events.length} for ${entry.name}`);
    }
    if (!['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) {
      fail('NONTERMINAL_RUN', `run ${entry.name} is ${snapshot.run.status}; drain it before archiving`);
    }

    const projection = Buffer.from(`${canonicalJsonStringify(snapshot)}\n`, 'utf-8');
    const projectionPath = posix.join('runs', entry.name, 'projection.json');
    const projectionFile = { path: projectionPath, bytes: projection.length, sha256: sha256Ref(projection) };
    const rawRoot = posix.join('runs', entry.name, 'raw');
    addTreeToPayload({ tree, archiveRoot: rawRoot, directories, files, copies });
    addDirectoryWithParents(directories, posix.dirname(projectionPath));
    files.push(projectionFile);
    projections.set(projectionPath, projection);
    const presence = presenceInTree(tree);
    const liveTerminalSidecars = Object.values(snapshot.attemptIO)
      .filter((item) => item.terminal?.status === 'live').length;
    runs.push({
      runId: entry.name,
      rawRoot,
      projectionPath,
      projectionSha256: projectionFile.sha256,
      presence,
      missingOptional: [
        ...(!presence.chatBindingJson ? ['chat-binding.json' as const] : []),
        ...(!presence.attemptsDir ? ['attempts' as const] : []),
      ],
      warnings: projectionWarnings(snapshot, presence),
      verdict: {
        status: snapshot.run.status as 'succeeded' | 'failed' | 'cancelled',
        workflowId: snapshot.run.workflowId ?? 'unknown',
        ...(snapshot.run.revisionId ? { revisionId: snapshot.run.revisionId } : {}),
        lastSeq: snapshot.lastSeq,
        updatedAt: snapshot.updatedAt,
        dangling: {
          activities: snapshot.dangling.activities.length,
          effectAttempted: snapshot.dangling.effectAttempted.length,
          waits: snapshot.dangling.waits.length,
          cancels: snapshot.dangling.cancels.length,
        },
        liveTerminalSidecars,
      },
    });
  }

  if (runs.length === 0) fail('NO_WORKFLOW_RUNS', `${sourceRunsDir} has no terminal v2 workflow runs to archive`);
  runs.sort((a, b) => a.runId.localeCompare(b.runId));
  residuals.sort((a, b) => a.name.localeCompare(b.name));
  const payloadDirectories = [...directories].sort();
  const payloadFiles = files.sort((a, b) => a.path.localeCompare(b.path));
  assertUnique(payloadDirectories, 'payload directory');
  assertUnique(payloadFiles.map((file) => file.path), 'payload file');
  return {
    sourceRunsDir,
    content: { runs, residuals, payloadDirectories, payloadFiles },
    copies: copies.sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
    projections,
  };
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail('DUPLICATE_ARCHIVE_ENTRY', `duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function comparableContent(left: V2RunArchiveContent, right: V2RunArchiveContent): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

export async function planV2RunArchive(input: { runsDir: string }): Promise<V2RunArchivePlan> {
  const capture = await captureSource(input.runsDir);
  return {
    sourceRunsDir: capture.sourceRunsDir,
    content: capture.content,
    runCount: capture.content.runs.length,
    residualCount: capture.content.residuals.length,
    totalPayloadBytes: capture.content.payloadFiles.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function materializePayload(payloadRoot: string, capture: SourceCapture): void {
  ensurePrivateDirectory(payloadRoot);
  for (const directory of capture.content.payloadDirectories) {
    assertSafeRelativePath(directory, 'payload directory');
    const absolute = join(payloadRoot, ...directory.split('/'));
    assertPathInside(payloadRoot, absolute, 'payload directory');
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    chmodSync(absolute, 0o700);
  }
  for (const copy of capture.copies) copyRegularFileSecure(copy, payloadRoot);
  for (const [path, projection] of capture.projections) {
    const absolute = join(payloadRoot, ...path.split('/'));
    writeNewPrivateFile(absolute, projection);
  }
  for (const directory of [...capture.content.payloadDirectories].sort((a, b) => b.split('/').length - a.split('/').length)) {
    fsyncDirectorySyncPortable(join(payloadRoot, ...directory.split('/')));
  }
  fsyncDirectorySyncPortable(payloadRoot);
}

function canonicalFile(value: unknown): Buffer {
  return Buffer.from(`${canonicalJsonStringify(value)}\n`, 'utf-8');
}

function publishCommitMarker(
  archiveDir: string,
  stageDir: string,
  marker: V2RunArchiveCommitMarker,
): void {
  const path = join(archiveDir, COMMIT_FILE);
  const bytes = canonicalFile(marker);
  // Keep the link source outside the immutable archive tree. A process crash
  // after writing this inode but before link/unlink must not leave an extra
  // file that makes the content-address target unverifiable forever. The
  // owned staging transaction is safely reclaimed on the next invocation.
  const tmp = join(stageDir, `COMMITTED.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeNewPrivateFile(tmp, bytes);
    try {
      linkSync(tmp, path);
      unlinkSync(tmp);
      fsyncDirectorySyncPortable(archiveDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readSecureFile(path);
      if (!existing.equals(bytes)) fail('COMMIT_MARKER_CONFLICT', `existing ${path} differs from expected marker`);
      unlinkSync(tmp);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function stageMarkerBytes(sourceRunsDir: string): Buffer {
  return canonicalFile({
    schemaVersion: 1,
    kind: V2_RUN_ARCHIVE_KIND,
    sourceRunsDir,
  });
}

function cleanOwnedStaging(archiveBaseDir: string): void {
  for (const entry of readdirSync(archiveBaseDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(STAGING_PREFIX)) continue;
    const path = join(archiveBaseDir, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('UNSAFE_STAGING_ENTRY', `refusing to clean non-directory staging path ${path}`);
    }
    const markerPath = join(path, STAGE_MARKER);
    let parsed: unknown;
    try { parsed = JSON.parse(readSecureFile(markerPath).toString('utf-8')); }
    catch (err) {
      fail('UNKNOWN_STAGING_ENTRY', `staging directory lacks a valid ownership marker: ${path} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (
      !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).schemaVersion !== 1 ||
      (parsed as Record<string, unknown>).kind !== V2_RUN_ARCHIVE_KIND
    ) fail('UNKNOWN_STAGING_ENTRY', `staging ownership marker is not recognized: ${path}`);
    rmSync(path, { recursive: true, force: false });
    fsyncDirectorySyncPortable(archiveBaseDir);
  }
}

function ensureDisjoint(source: string, archiveBase: string): void {
  const sourceToArchive = relative(source, archiveBase);
  const archiveToSource = relative(archiveBase, source);
  const inside = (rel: string) => rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside(sourceToArchive) || inside(archiveToSource)) {
    fail('ARCHIVE_SOURCE_OVERLAP', `source and archive directories must be disjoint: ${source} <> ${archiveBase}`);
  }
}

/** Resolve a path that may not exist yet without creating any ancestor. */
function realpathProspective(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        // realpath below is allowed to resolve existing ancestors, but the
        // archive base itself must never be a symlink.
        if (missing.length === 0) fail('ARCHIVE_BASE_SYMLINK', `archive base must not be a symlink: ${cursor}`);
        const realAncestor = realpathSync(cursor);
        if (!lstatSync(realAncestor).isDirectory()) {
          fail('ARCHIVE_PARENT_INVALID', `archive symlink ancestor is not a directory: ${cursor}`);
        }
        return join(realAncestor, ...missing);
      }
      if (!stat.isDirectory()) fail('ARCHIVE_PARENT_INVALID', `archive parent is not a directory: ${cursor}`);
      return join(realpathSync(cursor), ...missing);
    } catch (err) {
      if (err instanceof V2RunArchiveError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(cursor);
      if (parent === cursor) throw err;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function commitV2RunArchive(input: CommitV2RunArchiveInput): Promise<CommitV2RunArchiveResult> {
  const archiveBaseDir = resolve(input.archiveBaseDir);
  // Preflight overlap before *any* archive mkdir/chmod/lock write.  Resolve
  // the nearest existing archive ancestor so a symlinked parent cannot hide
  // that the requested output actually lives inside the source tree.
  const sourceInput = resolve(input.runsDir);
  assertPlainDirectory(sourceInput, 'workflow runs root');
  const sourceReal = realpathSync(sourceInput);
  ensureDisjoint(sourceInput, archiveBaseDir);
  ensureDisjoint(sourceReal, realpathProspective(archiveBaseDir));
  ensurePrivateArchiveBase(archiveBaseDir);
  return withFileLock(join(archiveBaseDir, '.v2-run-archive-publication'), async () => {
    cleanOwnedStaging(archiveBaseDir);
    const first = await captureSource(input.runsDir);
    ensureDisjoint(first.sourceRunsDir, archiveBaseDir);
    await input.onPhase?.('after-first-capture');

    const stageDir = join(archiveBaseDir, `${STAGING_PREFIX}${process.pid}-${randomBytes(8).toString('hex')}`);
    mkdirSync(stageDir, { mode: 0o700 });
    chmodSync(stageDir, 0o700);
    writeNewPrivateFile(join(stageDir, STAGE_MARKER), stageMarkerBytes(first.sourceRunsDir));
    const payloadRoot = join(stageDir, 'payload');
    materializePayload(payloadRoot, first);
    await input.onPhase?.('after-copy');

    const second = await captureSource(first.sourceRunsDir);
    if (!comparableContent(first.content, second.content)) {
      fail('SOURCE_CHANGED_DURING_ARCHIVE', 'source tree or live projection changed between the two captures');
    }
    await input.onPhase?.('after-second-capture');

    const archiveId = v2RunArchiveId(first.content);
    const manifest: V2RunArchiveManifest = {
      schemaVersion: V2_RUN_ARCHIVE_SCHEMA_VERSION,
      kind: V2_RUN_ARCHIVE_KIND,
      archiveId,
      createdAt: (input.now ?? new Date()).toISOString(),
      sourceRunsDir: first.sourceRunsDir,
      containsSensitiveData: true,
      content: first.content,
    };
    // Validate the exact persisted shape before publication; a path-length or
    // enum drift must strand only staging bytes, never an unopenable archive.
    parseV2RunArchiveManifest(manifest);
    const manifestBytes = canonicalFile(manifest);
    writeNewPrivateFile(join(payloadRoot, MANIFEST_FILE), manifestBytes);
    fsyncDirectorySyncPortable(payloadRoot);
    await input.onPhase?.('after-manifest');

    const archiveDir = join(archiveBaseDir, archiveDirectoryName(archiveId));
    let reused = false;
    try {
      const existing = lstatSync(archiveDir);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        fail('ARCHIVE_TARGET_UNSAFE', `content-address target is not a real directory: ${archiveDir}`);
      }
      const existingVerification = await verifyV2RunArchive({
        archiveDir,
        allowMissingCommitMarker: true,
      });
      if (!comparableContent(existingVerification.manifest.content, manifest.content)) {
        fail('ARCHIVE_TARGET_CONFLICT', `existing content-address target does not match ${archiveId}`);
      }
      reused = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      renameSync(payloadRoot, archiveDir);
      fsyncDirectorySyncPortable(archiveBaseDir);
    }
    await input.onPhase?.('after-publish');

    const publishedManifestBytes = readSecureFile(join(archiveDir, MANIFEST_FILE));
    const marker: V2RunArchiveCommitMarker = {
      schemaVersion: V2_RUN_ARCHIVE_COMMIT_SCHEMA_VERSION,
      archiveId,
      manifestSha256: sha256Ref(publishedManifestBytes),
    };
    publishCommitMarker(archiveDir, stageDir, marker);
    await input.onPhase?.('after-commit-marker');

    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* committed archive is already durable */ }
    fsyncDirectorySyncPortable(archiveBaseDir);
    const verification = await verifyV2RunArchive({
      archiveDir,
      sourceRunsDir: first.sourceRunsDir,
    });
    return { archiveDir, manifest: verification.manifest, reused, verification };
  });
}

function walkArchiveTree(root: string): { directories: string[]; files: string[] } {
  assertPlainDirectory(root, 'archive root');
  const directories: string[] = [];
  const files: string[] = [];
  const visit = (dir: string, relDir: string): void => {
    assertPlainDirectory(dir, 'archive directory');
    assertPrivateMode(dir, 0o700, 'archive directory');
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.includes('/') || entry.name.includes('\\') || entry.name === '.' || entry.name === '..') {
        fail('UNSAFE_ARCHIVE_ENTRY', `unsafe archive entry name in ${dir}: ${entry.name}`);
      }
      const absolute = join(dir, entry.name);
      const rel = relDir ? posix.join(relDir, entry.name) : entry.name;
      assertSafeRelativePath(rel, 'archive entry');
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('ARCHIVE_SYMLINK', `archive contains symlink: ${absolute}`);
      if (stat.isDirectory()) {
        directories.push(rel);
        visit(absolute, rel);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) fail('ARCHIVE_HARDLINK', `archive contains hard-linked file: ${absolute}`);
        assertPrivateMode(absolute, 0o600, 'archive file');
        files.push(rel);
      } else {
        fail('ARCHIVE_SPECIAL_ENTRY', `archive contains special filesystem entry: ${absolute}`);
      }
    }
  };
  visit(root, '');
  return { directories: directories.sort(), files: files.sort() };
}

function assertProjectionMatchesVerdict(archiveDir: string, run: V2RunArchiveRun): void {
  const path = join(archiveDir, ...run.projectionPath.split('/'));
  let projection: RunSnapshotDTO;
  try { projection = JSON.parse(readSecureFile(path).toString('utf-8')) as RunSnapshotDTO; }
  catch (err) {
    fail('ARCHIVE_PROJECTION_INVALID', `${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (
    projection.runId !== run.runId || projection.run.runId !== run.runId ||
    projection.run.status !== run.verdict.status ||
    (projection.run.workflowId ?? 'unknown') !== run.verdict.workflowId ||
    projection.lastSeq !== run.verdict.lastSeq || projection.updatedAt !== run.verdict.updatedAt
  ) fail('ARCHIVE_VERDICT_MISMATCH', `projection and manifest verdict disagree for ${run.runId}`);
}

export async function verifyV2RunArchive(input: VerifyV2RunArchiveInput): Promise<V2RunArchiveVerification> {
  const archiveDir = resolve(input.archiveDir);
  assertPlainDirectory(archiveDir, 'archive root');
  const manifestPath = join(archiveDir, MANIFEST_FILE);
  const manifestBytes = readSecureFile(manifestPath);
  let manifest: V2RunArchiveManifest;
  try { manifest = parseV2RunArchiveManifest(JSON.parse(manifestBytes.toString('utf-8'))); }
  catch (err) {
    fail('ARCHIVE_MANIFEST_INVALID', `${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (v2RunArchiveId(manifest.content) !== manifest.archiveId) {
    fail('ARCHIVE_ID_MISMATCH', `manifest content does not derive ${manifest.archiveId}`);
  }
  if (basename(archiveDir) !== archiveDirectoryName(manifest.archiveId)) {
    fail('ARCHIVE_DIRECTORY_MISMATCH', `archive directory name does not match ${manifest.archiveId}`);
  }
  assertUnique(manifest.content.payloadDirectories, 'manifest payload directory');
  assertUnique(manifest.content.payloadFiles.map((file) => file.path), 'manifest payload file');
  assertUnique(manifest.content.runs.map((run) => run.runId), 'manifest runId');
  assertUnique(manifest.content.residuals.map((residual) => residual.name), 'manifest residual name');

  const tree = walkArchiveTree(archiveDir);
  const expectedDirectories = [...manifest.content.payloadDirectories].sort();
  if (canonicalJsonStringify(tree.directories) !== canonicalJsonStringify(expectedDirectories)) {
    fail('ARCHIVE_DIRECTORY_TOPOLOGY_MISMATCH', 'archive directory topology differs from manifest');
  }
  const expectedFiles = [...manifest.content.payloadFiles.map((file) => file.path), MANIFEST_FILE];
  const hasCommitMarker = tree.files.includes(COMMIT_FILE);
  if (hasCommitMarker) expectedFiles.push(COMMIT_FILE);
  if (!hasCommitMarker && !input.allowMissingCommitMarker) {
    fail('ARCHIVE_NOT_COMMITTED', `${archiveDir} has no ${COMMIT_FILE} marker`);
  }
  expectedFiles.sort();
  if (canonicalJsonStringify(tree.files) !== canonicalJsonStringify(expectedFiles)) {
    fail('ARCHIVE_FILE_TOPOLOGY_MISMATCH', 'archive file topology differs from manifest');
  }
  let totalBytes = 0;
  for (const expected of manifest.content.payloadFiles) {
    const absolute = join(archiveDir, ...expected.path.split('/'));
    assertPathInside(archiveDir, absolute, 'manifest payload file');
    const actual = hashSecureFile(absolute);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      fail('ARCHIVE_FILE_HASH_MISMATCH', `${expected.path} differs from its manifest digest`);
    }
    totalBytes += actual.bytes;
  }
  for (const run of manifest.content.runs) {
    const projected = manifest.content.payloadFiles.find((file) => file.path === run.projectionPath);
    if (!projected || projected.sha256 !== run.projectionSha256) {
      fail('ARCHIVE_PROJECTION_HASH_MISMATCH', `projection file record is inconsistent for ${run.runId}`);
    }
    assertProjectionMatchesVerdict(archiveDir, run);
  }
  if (hasCommitMarker) {
    let marker: V2RunArchiveCommitMarker;
    try { marker = parseV2RunArchiveCommitMarker(JSON.parse(readSecureFile(join(archiveDir, COMMIT_FILE)).toString('utf-8'))); }
    catch (err) {
      fail('COMMIT_MARKER_INVALID', `${archiveDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (marker.archiveId !== manifest.archiveId || marker.manifestSha256 !== sha256Ref(manifestBytes)) {
      fail('COMMIT_MARKER_MISMATCH', `${COMMIT_FILE} does not authenticate manifest.json`);
    }
  }

  let sourceVerified = false;
  if (input.sourceRunsDir) {
    const live = await captureSource(input.sourceRunsDir);
    if (live.sourceRunsDir !== manifest.sourceRunsDir) {
      fail('ARCHIVE_SOURCE_MISMATCH', `manifest source ${manifest.sourceRunsDir} != live source ${live.sourceRunsDir}`);
    }
    if (!comparableContent(live.content, manifest.content)) {
      fail('ARCHIVE_SOURCE_CHANGED', 'live source bytes or current ops projections differ from the archive');
    }
    sourceVerified = true;
  }
  return {
    archiveDir,
    manifest,
    staticVerified: true,
    sourceVerified,
    fileCount: manifest.content.payloadFiles.length,
    totalBytes,
  };
}
