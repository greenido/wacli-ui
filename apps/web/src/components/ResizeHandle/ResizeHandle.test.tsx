import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResizeHandle } from './ResizeHandle.tsx';

describe('ResizeHandle', () => {
  beforeEach(() => {
    // jsdom has no pointer capture.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  function drag(from: number, to: number) {
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { clientX: from, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: to, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: to, pointerId: 1 });
  }

  it('widens a left pane as it is dragged right, within its limits', () => {
    const onResize = vi.fn();
    render(<ResizeHandle side="left" currentWidth={300} minWidth={200} maxWidth={600} onResize={onResize} />);

    drag(300, 350);
    expect(onResize).toHaveBeenLastCalledWith(350);

    drag(300, 2000);
    expect(onResize).toHaveBeenLastCalledWith(600);
  });

  it('widens a right pane as it is dragged left, and stops at its minimum', () => {
    const onResize = vi.fn();
    render(<ResizeHandle side="right" currentWidth={256} minWidth={180} maxWidth={500} onResize={onResize} />);

    drag(1000, 950);
    expect(onResize).toHaveBeenLastCalledWith(306);

    drag(1000, 1500);
    expect(onResize).toHaveBeenLastCalledWith(180);
  });

  it('resets on double click', () => {
    const onReset = vi.fn();
    render(
      <ResizeHandle side="left" currentWidth={300} minWidth={200} maxWidth={600} onResize={vi.fn()} onReset={onReset} />
    );

    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
