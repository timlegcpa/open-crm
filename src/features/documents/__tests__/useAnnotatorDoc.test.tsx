// A close or a switch while pdf.js is still parsing must destroy the loading task: a
// wedged decoder never resolves its promise, and only destroying the task terminates the
// worker. The hook holds the task in a ref only once the load resolves, so the cleanup
// must also reach the task that is still in flight.
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tasks: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];

vi.mock('@/lib/pdfjs', () => ({
  PDFJS_DOC_OPTIONS: {},
  PDFJS_PARSE_TIMEOUT_MS: 60_000,
  pdfjs: {
    getDocument: () => {
      const task = {
        // Never settles: the parse of a pathological file.
        promise: new Promise(() => undefined),
        destroy: vi.fn(async () => undefined),
      };
      tasks.push(task);
      return task;
    },
  },
}));

vi.mock('../api', () => ({
  // %PDF-1.7
  documentBytes: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
}));

import { useAnnotatorDoc } from '../annotator/useAnnotatorDoc';

beforeEach(() => {
  tasks.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useAnnotatorDoc: a pending parse', () => {
  it('is destroyed when the annotator closes', async () => {
    const { unmount } = renderHook(() => useAnnotatorDoc('doc-1'));
    await waitFor(() => expect(tasks).toHaveLength(1));
    expect(tasks[0].destroy).not.toHaveBeenCalled();
    unmount();
    expect(tasks[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('is destroyed when the annotator switches to another document', async () => {
    const { rerender, unmount } = renderHook(({ id }) => useAnnotatorDoc(id), { initialProps: { id: 'doc-1' } });
    await waitFor(() => expect(tasks).toHaveLength(1));
    rerender({ id: 'doc-2' });
    expect(tasks[0].destroy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(tasks).toHaveLength(2));
    unmount();
    expect(tasks[1].destroy).toHaveBeenCalledTimes(1);
  });
});
