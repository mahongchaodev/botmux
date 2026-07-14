/**
 * Unit tests for RiffBackend — write serialization (no duplicate task-execute
 * on rapid writes) and sandbox access-URL handling (directAccessUrl preference
 * + accessUrl origin rewrite onto the configured baseUrl).
 *
 * Run:  pnpm vitest run test/riff-backend.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RiffBackend } from '../src/adapters/backend/riff-backend.js';

const BASE = 'https://riff-infra-boe.bytedance.net';

type FetchCall = { url: string; init?: RequestInit };

/** Never-ending SSE body so streamTask stays pending without emitting events. */
function pendingSseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() { /* never pushes */ } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function taskResponse(id: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, data: { id, status: 'running', ...extra } });
}

describe('RiffBackend', () => {
  let calls: FetchCall[];
  let resolvers: Array<(r: Response) => void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    resolvers = [];
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes('/api2/task-stream')) return pendingSseResponse();
      if (u.includes('/api/task-detail')) {
        return Response.json({ success: true, data: { task: {} } });
      }
      // task-execute / task-follow-up: resolve manually so tests control timing
      return new Promise<Response>((resolve) => { resolvers.push(resolve); });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeBackend(config: Record<string, unknown> = {}): RiffBackend {
    return new RiffBackend({ baseUrl: BASE, jwt: 'test-jwt', ...config } as any, 'session-1');
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  describe('write serialization', () => {
    it('queues a second write until the first task-execute returns (no duplicate createTask)', async () => {
      const be = makeBackend();
      be.spawn('', [], {} as any);

      be.write('first message');
      be.write('second message');
      await flush();

      // Only ONE task-execute in flight — the second write must wait.
      const execCalls = () => calls.filter(c => c.url.includes('/api/task-execute'));
      const followCalls = () => calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(0);

      // First task lands → second write becomes a follow-up, not a new task.
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(1);
      const followBody = JSON.parse(String(followCalls()[0]!.init?.body));
      expect(followBody.parentTaskId).toBe('task-1');
      expect(String(followBody.prompt)).toContain('second message');
    });

    it('creates a new task after the previous one is done', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      // Simulate task completion via the done path
      (be as any).taskDone = true;

      be.write('second');
      await flush();
      resolvers.shift()!(taskResponse('task-2'));
      await flush();
      const execCalls = calls.filter(c => c.url.includes('/api/task-execute'));
      expect(execCalls.length).toBe(2);
    });
  });

  describe('onTaskDone turn boundary', () => {
    it('fires when the done SSE event arrives', () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed","exitCode":0}', 'task-1');
      expect(done).toHaveBeenCalledTimes(1);
      expect((be as any).taskDone).toBe(true);
    });

    it('fires when task creation fails, so queued follow-ups are not stuck', async () => {
      const be = makeBackend();
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async () => { throw new Error('network down'); });
      be.write('hello');
      await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  describe('access URL handling', () => {
    it('rewrites accessUrl origin onto the configured baseUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=abc&folder=%2Fx',
      }));
      await flush();
      expect(urls).toContain(`${BASE}/sandbox-access?sessionId=abc&folder=%2Fx`);
    });

    it('prefers directAccessUrl and never downgrades back to a frontend URL', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=abc',
        directAccessUrl: 'https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx',
      }));
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx');

      // A later frontend-only URL must not replace the direct terminal URL.
      (be as any).updateAccessUrl({ accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=late' });
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx');
    });

    it('upgrades to directAccessUrl from a task-detail fetch after an SSE accessUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      (be as any).currentTaskId = 'task-9';
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) {
          return Response.json({ success: true, data: { task: {
            accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=z',
            directAccessUrl: 'https://port-8080-z.cn-north.ai-sandbox-boe.byted.org/',
          } } });
        }
        return pendingSseResponse();
      });
      // Simulate the SSE init event carrying only the frontend accessUrl.
      (be as any).handleSseEvent('event:init\ndata:{"accessUrl":"https://riff.bytedance.net/sandbox-access?sessionId=z"}', 'task-9');
      expect(urls[urls.length - 1]).toBe(`${BASE}/sandbox-access?sessionId=z`);
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-z.cn-north.ai-sandbox-boe.byted.org/');
    });
  });
});
