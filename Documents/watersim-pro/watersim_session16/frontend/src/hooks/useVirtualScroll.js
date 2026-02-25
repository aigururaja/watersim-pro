/**
 * WaterSim Pro — useVirtualScroll
 * Session 16: Performance — virtual scrolling for large data tables.
 *
 * Usage:
 *   const { containerProps, visibleItems, totalHeight, offsetY } =
 *     useVirtualScroll({ items, itemHeight, overscan, containerHeight });
 *
 * Returns only the rows that are currently visible (plus overscan buffer)
 * so the DOM stays small even with thousands of rows.
 */
import { useState, useCallback, useRef } from 'react';

/**
 * @param {object}   opts
 * @param {Array}    opts.items           – full flat array of data items
 * @param {number}   opts.itemHeight      – fixed row height in px (default 52)
 * @param {number}   opts.overscan        – rows to render beyond the viewport (default 5)
 * @param {number}   opts.containerHeight – visible scrollport height in px (default 600)
 */
export function useVirtualScroll({
  items = [],
  itemHeight = 52,
  overscan = 5,
  containerHeight = 600,
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef(null);

  const totalHeight = items.length * itemHeight;

  // First & last visible indices (clamped)
  const firstVisible = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const lastVisible  = Math.min(
    items.length - 1,
    Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan,
  );

  const visibleItems = items.slice(firstVisible, lastVisible + 1).map((item, i) => ({
    item,
    index: firstVisible + i,
    top: (firstVisible + i) * itemHeight,
  }));

  const offsetY = firstVisible * itemHeight;

  const handleScroll = useCallback((e) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const containerProps = {
    ref: scrollRef,
    onScroll: handleScroll,
    style: { height: containerHeight, overflowY: 'auto', position: 'relative' },
  };

  return { containerProps, visibleItems, totalHeight, offsetY, firstVisible, lastVisible };
}
