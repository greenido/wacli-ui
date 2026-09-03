import { useEffect, useState } from 'react';

/**
 * Holds a value back until it has stopped changing for `delayMs`.
 *
 * Search boxes here feed React Query keys directly, and every distinct key is
 * another wacli subprocess against the SQLite store: an undebounced sidebar
 * spawns `chats list` *and* the 400-message preview scan on every keystroke.
 * Debouncing the key, rather than the request, also stops the result list from
 * thrashing between partial-word matches while the operator is still typing.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (Object.is(value, debounced)) return;

    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);

  return debounced;
}
