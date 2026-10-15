import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * A fake pdf.js that behaves like the real one where it matters: a render task can be held
 * open, cancel() releases the canvas and rejects with RenderingCancelledException, and a
 * second render() on a canvas that is still in use rejects with the "same canvas" error.
 */
interface FakeTask {
  canvas: HTMLCanvasElement;
  width: number;
  cancelled: boolean;
  promise: Promise<void>;
  cancel: () => void;
  finish: () => void;
}

const fake = vi.hoisted(() => ({ tasks: [] as FakeTask[], inUse: new Set<HTMLCanvasElement>() }));

vi.mock('@/lib/pdfjs', () => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, viewBox: [0, 0, 600, 800], rotation: 0, scale }),
    render: ({ canvas, viewport }: { canvas: HTMLCanvasElement; viewport: { width: number } }) => {
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const task: FakeTask = {
        canvas,
        width: viewport.width,
        cancelled: false,
        promise,
        cancel: () => {
          task.cancelled = true;
          fake.inUse.delete(canvas);
          const err = new Error('Rendering cancelled, page 1');
          err.name = 'RenderingCancelledException';
          reject(err);
        },
        finish: () => {
          fake.inUse.delete(canvas);
          resolve();
        },
      };
      if (fake.inUse.has(canvas)) reject(new Error('Cannot use the same canvas during multiple render() operations.'));
      else fake.inUse.add(canvas);
      fake.tasks.push(task);
      return task;
    },
  };
  const pdf = { numPages: 1, getPage: () => Promise.resolve(page) };
  return {
    getDocumentWatchdogged: () => ({ task: { destroy: () => Promise.resolve() }, promise: Promise.resolve(pdf), done: () => undefined }),
  };
});

const { openPdf } = await import('../lib/pdfRender');
const { PageView } = await import('../public/signer/PdfReview');

beforeEach(() => {
  fake.tasks.length = 0;
  fake.inUse.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as CanvasRenderingContext2D);
});
afterEach(() => vi.restoreAllMocks());

describe('signer page view', () => {
  it('cancels the draw in flight when the width changes and ends with the page drawn', async () => {
    const pdf = openPdf({ data: new Uint8Array([1]) });
    const props = { pdf, index: 0, fields: [], signature: null, today: '', onSignatureField: () => undefined };
    const view = render(<PageView {...props} width={600} />);
    await waitFor(() => expect(fake.tasks).toHaveLength(1));

    view.rerender(<PageView {...props} width={400} />);
    await waitFor(() => expect(fake.tasks).toHaveLength(2));
    expect(fake.tasks[0].cancelled).toBe(true);
    expect(fake.tasks[1].width).toBe(400);

    fake.tasks[1].finish();
    await waitFor(() => expect(screen.getByRole('img', { name: 'Page 1' })).toHaveClass('block'));
    expect(screen.queryByText(/could not be shown/)).toBeNull();
  });
});

describe('openPdf renderPage', () => {
  it('never starts a second draw on a canvas until the first has settled', async () => {
    const pdf = openPdf({ data: new Uint8Array([1]) });
    const canvas = document.createElement('canvas');
    const first = pdf.renderPage(0, 600, canvas);
    await vi.waitFor(() => expect(fake.tasks).toHaveLength(1));
    const second = pdf.renderPage(0, 300, canvas);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.tasks).toHaveLength(1);

    fake.tasks[0].finish();
    await expect(first).resolves.toMatchObject({ canvasWidthPx: 600 });
    await vi.waitFor(() => expect(fake.tasks).toHaveLength(2));
    fake.tasks[1].finish();
    await expect(second).resolves.toMatchObject({ canvasWidthPx: 300 });
  });

  it('rejects an aborted draw as cancelled, not as a failure', async () => {
    const { isRenderCancelled } = await import('../lib/pdfRender');
    const pdf = openPdf({ data: new Uint8Array([1]) });
    const canvas = document.createElement('canvas');
    const controller = new AbortController();
    const drawing = pdf.renderPage(0, 600, canvas, controller.signal);
    await vi.waitFor(() => expect(fake.tasks).toHaveLength(1));
    controller.abort();
    const err = await drawing.catch((e: unknown) => e);
    expect(fake.tasks[0].cancelled).toBe(true);
    expect(isRenderCancelled(err)).toBe(true);
  });
});
