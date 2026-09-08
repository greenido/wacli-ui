import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { useInfiniteScroll } from './useInfiniteScroll.ts';

/** The observers built during a test, so a case can fire one by hand. */
let observers: Array<{
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
}> = [];

class FakeObserver {
  private entry: (typeof observers)[number];

  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, observed: [], disconnected: false };
    observers.push(this.entry);
  }
  observe(node: Element) {
    this.entry.observed.push(node);
  }
  disconnect() {
    this.entry.disconnected = true;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

function Harness(props: { hasMore: boolean; isLoading: boolean; onLoadMore: () => void }) {
  const ref = useInfiniteScroll(props);
  return <div data-testid="sentinel" ref={ref} />;
}

/** Fires the most recently created observer as though the sentinel scrolled in. */
function scrollSentinelIntoView() {
  const latest = observers[observers.length - 1];
  latest.callback(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    null as unknown as IntersectionObserver
  );
}

describe('useInfiniteScroll', () => {
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the next page when the sentinel comes into view', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore isLoading={false} onLoadMore={onLoadMore} />);

    scrollSentinelIntoView();

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not observe while a page is already loading', () => {
    // Otherwise a slow page and a scrolling operator stack one request per
    // frame, and the list pages past what they wanted to read.
    const onLoadMore = vi.fn();
    render(<Harness hasMore isLoading onLoadMore={onLoadMore} />);

    expect(observers).toHaveLength(0);
  });

  it('does not observe once there is nothing left to fetch', () => {
    render(<Harness hasMore={false} isLoading={false} onLoadMore={vi.fn()} />);

    expect(observers).toHaveLength(0);
  });

  it('renders without an IntersectionObserver rather than throwing', () => {
    // Older browsers and any test environment that has not stubbed it. Losing
    // auto-paging is a degraded list; throwing is no list at all.
    vi.stubGlobal('IntersectionObserver', undefined);

    expect(() =>
      render(<Harness hasMore isLoading={false} onLoadMore={vi.fn()} />)
    ).not.toThrow();
  });

  it('stops observing the old node when the sentinel is replaced', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore isLoading={false} onLoadMore={onLoadMore} />);

    // A list that grew: the sentinel unmounts and a new one takes its place.
    rerender(<Harness hasMore isLoading onLoadMore={onLoadMore} />);

    expect(observers[0].disconnected).toBe(true);
  });
});
