import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './ErrorBoundary.tsx';

/** Throws on demand, so a test can decide when the tree recovers. */
function Boom({ shouldThrow, label = 'the thread' }: { shouldThrow: boolean; label?: string }) {
  if (shouldThrow) throw new Error(`Cannot read properties of null (reading '${label}')`);
  return <p>console content</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error itself; the boundary adds its own line. Both
    // are noise here, and neither is what the test is checking.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText('console content')).toBeInTheDocument();
  });

  /**
   * Without a boundary React unmounts the whole tree, so one bad row — an
   * unexpected shape from a contact, a field the archive left null — took the
   * console down to a blank page with the reason only in a console log.
   */
  it('shows a panel instead of a blank page when a render throws', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/THE CONSOLE HIT AN ERROR/)).toBeInTheDocument();
  });

  it('names the actual error, so the operator can act on it', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow label="displayText" />
      </ErrorBoundary>
    );

    expect(screen.getByText(/reading 'displayText'/)).toBeInTheDocument();
  });

  it('says nothing was sent or lost', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>
    );

    expect(screen.getByText(/Nothing was sent and nothing was lost/)).toBeInTheDocument();
  });

  it('re-renders the children when the operator retries', async () => {
    const user = userEvent.setup();

    // Flipped by the test rather than counted per render: React may attempt a
    // failing render more than once (it re-runs the root synchronously to get a
    // reliable error), so anything that recovers on its own recovers too early
    // to observe. This models the real case — the next poll replaced the bad
    // row, and only then did the operator press RETRY.
    let broken = true;

    function MaybeBroken() {
      if (broken) throw new Error('one bad message');
      return <p>console content</p>;
    }

    render(
      <ErrorBoundary>
        <MaybeBroken />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    broken = false;
    await user.click(screen.getByRole('button', { name: /RETRY/i }));

    expect(screen.getByText('console content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('logs the failure where a local operator would look for it', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>
    );

    expect(console.error).toHaveBeenCalledWith(
      'Console render failed:',
      expect.any(Error),
      expect.anything()
    );
  });

  it('uses a caller’s own fallback when one is given', () => {
    render(
      <ErrorBoundary fallback={(error) => <p>pane unavailable: {error.message}</p>}>
        <Boom shouldThrow label="chatJid" />
      </ErrorBoundary>
    );

    expect(screen.getByText(/pane unavailable: .*chatJid/)).toBeInTheDocument();
    expect(screen.queryByText(/THE CONSOLE HIT AN ERROR/)).not.toBeInTheDocument();
  });
});
