/**
 * WaterSim Pro — usePaginatedReports
 * Session 16: Performance — cursor-based infinite scroll for the reports list.
 *
 * Replaces the old page/offset approach with a stable cursor so:
 *  – New runs inserted at the top don't shift pages mid-scroll.
 *  – Each batch fetch is O(log n) on the DB index.
 *
 * Usage:
 *   const { runs, loading, loadingMore, error, hasMore, loadMore, refresh, total } =
 *     usePaginatedReports({ projectId, mode, compliance, limit });
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import api from '../utils/api';

const DEFAULT_LIMIT = 40;

export function usePaginatedReports({
  projectId   = null,
  mode        = null,
  compliance  = null,
  limit       = DEFAULT_LIMIT,
} = {}) {
  const [runs,        setRuns]        = useState([]);
  const [total,       setTotal]       = useState(0);
  const [cursor,      setCursor]      = useState(null);   // ISO date string (completed_at of last row)
  const [hasMore,     setHasMore]     = useState(false);
  const [loading,     setLoading]     = useState(false);  // initial fetch
  const [loadingMore, setLoadingMore] = useState(false);  // subsequent pages
  const [error,       setError]       = useState(null);

  // Track current filter params so we know when to reset
  const filtersRef = useRef({ projectId, mode, compliance });

  const buildParams = useCallback((afterCursor = null) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (projectId)   p.set('projectId',  projectId);
    if (mode)        p.set('mode',       mode);
    if (compliance)  p.set('compliance', compliance);
    if (afterCursor) p.set('cursor',     afterCursor);   // cursor = completed_at of last fetched row
    return p.toString();
  }, [projectId, mode, compliance, limit]);

  // ── Initial / filter-change load ──────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/reports?${buildParams()}`);
      setRuns(data.runs);
      setTotal(data.total);
      setCursor(data.nextCursor ?? null);
      setHasMore(!!data.nextCursor);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // ── Load more (append) ────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    setError(null);
    try {
      const { data } = await api.get(`/reports?${buildParams(cursor)}`);
      setRuns(prev => {
        const existingIds = new Set(prev.map(r => r.id));
        const fresh = data.runs.filter(r => !existingIds.has(r.id));
        return [...prev, ...fresh];
      });
      setCursor(data.nextCursor ?? null);
      setHasMore(!!data.nextCursor);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, loading, cursor, buildParams]);

  // ── Re-fetch from top (e.g. after save/filter change) ────────────────────
  const refresh = useCallback(() => {
    setCursor(null);
    setRuns([]);
    setHasMore(false);
  }, []);

  // Re-run load when filters change or after refresh resets cursor
  useEffect(() => {
    const prev = filtersRef.current;
    const filtersChanged =
      prev.projectId  !== projectId  ||
      prev.mode       !== mode       ||
      prev.compliance !== compliance;

    if (filtersChanged) {
      filtersRef.current = { projectId, mode, compliance };
      setRuns([]);
      setCursor(null);
      setHasMore(false);
    }

    load();
  }, [projectId, mode, compliance, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Infinite scroll sentinel helper ──────────────────────────────────────
  // Returns a ref to attach to a sentinel div at the bottom of the list.
  const sentinelRef = useCallback((node) => {
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    // Cleanup handled by GC when node unmounts
  }, [loadMore]);

  return { runs, total, loading, loadingMore, error, hasMore, loadMore, refresh, sentinelRef };
}
