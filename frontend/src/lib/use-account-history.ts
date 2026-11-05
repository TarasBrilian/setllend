"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { getAccountHistory, type HistoryEntry } from "@/lib/api";
import { byTimeDesc } from "@/lib/api/history";

/**
 * The account's merged history, one page of each list at a time (SOT/frontend.md#data, D65). Rows
 * older than the last page's `hold_before` wait for the next page, so no newer row of another list
 * can appear below them later.
 */
export function useAccountHistory(account: string | undefined, enabled = true) {
  const query = useInfiniteQuery({
    queryKey: ["history", account],
    queryFn: ({ pageParam }) => getAccountHistory(account!, pageParam),
    initialPageParam: null as Parameters<typeof getAccountHistory>[1],
    getNextPageParam: (last) => last.next,
    enabled: enabled && account !== undefined,
  });
  let entries: HistoryEntry[] | undefined;
  if (query.data) {
    const all = query.data.pages.flatMap((p) => p.entries).sort(byTimeDesc);
    const hold = query.data.pages.at(-1)!.hold_before;
    entries = hold === null ? all : all.filter((e) => BigInt(e.timestamp) >= BigInt(hold));
  }
  return {
    entries,
    /** The first page failed after its retries; `retry` asks again. */
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
    hasMore: query.hasNextPage,
    loadMore: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
  };
}
