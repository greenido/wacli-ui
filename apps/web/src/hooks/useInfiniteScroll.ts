import { useCallback, useEffect, useRef } from 'react';

interface Options {
  /** Whether there is another page to ask for. */
  hasMore: boolean;
  /** True while one is already in flight, so scrolling cannot stack requests. */
  isLoading: boolean;
  onLoadMore: () => void;
  /** How far ahead of the sentinel to fire, so the next page is already there. */
  rootMargin?: string;
}

/**
 * Loads the next page when a sentinel element scrolls into view.
 *
 * Returns a ref callback to put on the last element of the list. It is a
 * callback rather than an object ref because the sentinel is unmounted and
 * remounted as the list grows, and an object ref would leave the observer
 * watching a node that is no longer on the page.
 */
export function useInfiniteScroll({
  hasMore,
  isLoading,
  onLoadMore,
  rootMargin = '120px',
}: Options): (node: HTMLElement | null) => void {
  const observer = useRef<IntersectionObserver | null>(null);
  // Held in a ref so changing the handler does not tear down and rebuild the
  // observer on every render, which would re-fire the moment it reconnected.
  const loadMore = useRef(onLoadMore);
  // Synced in an effect rather than during render: a ref written mid-render is
  // a tear in concurrent mode, and this only has to be current by the time an
  // intersection can fire, which is after paint either way.
  useEffect(() => {
    loadMore.current = onLoadMore;
  });

  useEffect(() => () => observer.current?.disconnect(), []);

  return useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!node || !hasMore || isLoading) return;

      // jsdom and older browsers have no IntersectionObserver. Without this the
      // component throws on mount rather than simply not auto-paging.
      if (typeof IntersectionObserver === 'undefined') return;

      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) loadMore.current();
        },
        { rootMargin }
      );
      observer.current.observe(node);
    },
    [hasMore, isLoading, rootMargin]
  );
}
