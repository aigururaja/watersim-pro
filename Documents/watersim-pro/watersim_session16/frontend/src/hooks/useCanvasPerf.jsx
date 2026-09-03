/**
 * WaterSim Pro — useCanvasPerf
 * Session 16: Performance — lightweight FPS counter and render-budget guard
 * for the flowsheet canvas. Activates only in development mode.
 *
 * Usage:
 *   const { fps, nodeCount, edgeCount, PerfOverlay } = useCanvasPerf(nodes, edges);
 *
 * Drop <PerfOverlay /> anywhere inside the canvas container to display the
 * live HUD. It renders nothing in production builds.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

const IS_DEV = import.meta.env.DEV;

export function useCanvasPerf(nodes = [], edges = []) {
  const [fps, setFps] = useState(0);
  const frameRef  = useRef(0);
  const lastRef   = useRef(performance.now());
  const rafHandle = useRef(null);

  // FPS loop (dev only)
  useEffect(() => {
    if (!IS_DEV) return;

    const tick = (now) => {
      frameRef.current++;
      const elapsed = now - lastRef.current;
      if (elapsed >= 1000) {
        setFps(Math.round((frameRef.current * 1000) / elapsed));
        frameRef.current = 0;
        lastRef.current  = now;
      }
      rafHandle.current = requestAnimationFrame(tick);
    };

    rafHandle.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafHandle.current);
  }, []);

  const nodeCount = nodes.length;
  const edgeCount = edges.length;

  // Warn in console when element count gets large
  useEffect(() => {
    if (!IS_DEV) return;
    if (nodeCount > 50)  console.warn(`[WaterSim Canvas] Large flowsheet: ${nodeCount} nodes. Consider splitting into sub-flowsheets.`);
    if (edgeCount > 100) console.warn(`[WaterSim Canvas] High edge count: ${edgeCount}. Performance may degrade.`);
  }, [nodeCount, edgeCount]);

  const PerfOverlay = useCallback(() => {
    if (!IS_DEV) return null;

    const fpsColor = fps >= 55 ? '#10b981' : fps >= 30 ? '#f59e0b' : '#ef4444';
    return (
      <div style={{
        position: 'absolute',
        bottom: 8,
        left: 56,
        background: 'rgba(15,23,42,0.82)',
        color: '#e2e8f0',
        fontFamily: 'monospace',
        fontSize: 11,
        padding: '4px 8px',
        borderRadius: 6,
        lineHeight: 1.6,
        zIndex: 999,
        pointerEvents: 'none',
        backdropFilter: 'blur(4px)',
        userSelect: 'none',
      }}>
        <span style={{ color: fpsColor, fontWeight: 700 }}>{fps} fps</span>
        {'  '}
        <span style={{ color: '#94a3b8' }}>
          {nodeCount}N · {edgeCount}E
        </span>
      </div>
    );
  }, [fps, nodeCount, edgeCount]);

  return { fps, nodeCount, edgeCount, PerfOverlay };
}
