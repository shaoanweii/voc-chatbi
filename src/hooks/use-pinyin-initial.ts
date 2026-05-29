"use client";

import { useEffect, useState } from 'react';

const localCache = new Map<string, string>();

const pendingRequests = new Map<string, Promise<string>>();

/** Fetch pinyin initials from DeepSeek V4 Flash API with multi-level caching */
async function fetchPinyinInitials(chars: string[]): Promise<Record<string, string>> {
  const uncached = chars.filter((c) => !localCache.has(c) && !pendingRequests.has(c));
  if (uncached.length > 0) {
    const promise = (async () => {
      try {
        const response = await fetch('/api/utils/pinyin-initial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chars: uncached }),
        });
        const json = await response.json();
        if (json.success && json.data) {
          const data = json.data as Record<string, string>;
          for (const [char, initial] of Object.entries(data)) {
            localCache.set(char, initial);
          }
        }
      } catch {
        // fallback: use uppercase of the character itself
      } finally {
        for (const c of uncached) {
          pendingRequests.delete(c);
          if (!localCache.has(c)) {
            localCache.set(c, c.toUpperCase());
          }
        }
      }
    })();

    for (const c of uncached) {
      pendingRequests.set(c, promise.then(() => localCache.get(c)!));
    }

    await promise;
  }

  const pendingChars = chars.filter((c) => pendingRequests.has(c));
  if (pendingChars.length > 0) {
    await Promise.all(pendingChars.map((c) => pendingRequests.get(c)!));
  }

  const result: Record<string, string> = {};
  for (const c of chars) {
    result[c] = localCache.get(c) || c.toUpperCase();
  }
  return result;
}

/** Hook to get pinyin initial for a name string, using DeepSeek V4 Flash with caching */
export function usePinyinInitial(name: string | null | undefined): string {
  const [initial, setInitial] = useState<string>(() => {
    if (!name) return '?';
    const firstChar = name.trim().charAt(0);
    if (!firstChar) return '?';
    return localCache.get(firstChar) || firstChar.toUpperCase();
  });

  useEffect(() => {
    if (!name) {
      setInitial('?');
      return;
    }

    const firstChar = name.trim().charAt(0);
    if (!firstChar) {
      setInitial('?');
      return;
    }

    if (localCache.has(firstChar)) {
      setInitial(localCache.get(firstChar)!);
      return;
    }

    let cancelled = false;

    fetchPinyinInitials([firstChar]).then((result) => {
      if (!cancelled) {
        setInitial(result[firstChar] || firstChar.toUpperCase());
      }
    });

    return () => {
      cancelled = true;
    };
  }, [name]);

  return initial;
}
