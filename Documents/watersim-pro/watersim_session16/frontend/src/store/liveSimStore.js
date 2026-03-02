/**
 * Zustand store for live (real-time) simulation state.
 *
 * Speed multiplier (1x–1000x) controls how many solver steps are computed
 * per tick.  UI updates at max(compute_time, 5 s).  OPC polling is
 * independent.  Runs until the user clicks Stop.
 */

import { create } from 'zustand';

/** All available stream parameters for trend monitoring. */
export const STREAM_PARAMS = [
  { key: 'Q',    label: 'Flow (m³/d)',   unit: 'm³/d' },
  { key: 'TSS',  label: 'TSS (mg/L)',   unit: 'mg/L' },
  { key: 'BOD',  label: 'BOD (mg/L)',   unit: 'mg/L' },
  { key: 'COD',  label: 'COD (mg/L)',   unit: 'mg/L' },
  { key: 'TN',   label: 'TN (mg/L)',    unit: 'mg/L' },
  { key: 'NH4',  label: 'NH4-N (mg/L)', unit: 'mg/L' },
  { key: 'NO3',  label: 'NO3-N (mg/L)', unit: 'mg/L' },
  { key: 'NO2',  label: 'NO2-N (mg/L)', unit: 'mg/L' },
  { key: 'TP',   label: 'TP (mg/L)',    unit: 'mg/L' },
  { key: 'DO',   label: 'DO (mg/L)',    unit: 'mg/L' },
  { key: 'pH',   label: 'pH',           unit: '-' },
  { key: 'temp', label: 'Temp (°C)',     unit: '°C' },
];

/** 20 visually-distinct colours that cycle for trend lines. */
export const TREND_COLORS = [
  '#2563EB', '#DC2626', '#059669', '#D97706', '#7C3AED',
  '#E11D48', '#0891B2', '#B45309', '#6366F1', '#14B8A6',
  '#F97316', '#6D28D9', '#0D9488', '#DB2777', '#CA8A04',
  '#4F46E5', '#0284C7', '#BE185D', '#65A30D', '#9333EA',
];

const useLiveSimStore = create((set, get) => ({
  // ── Simulation state ──────────────────────────────────────────────────────
  status:      'idle',    // 'idle' | 'running' | 'paused' | 'cancelled'
  runId:       null,
  steps:       [],        // Accumulated step results
  currentStep: 0,
  startedBy:   null,
  error:       null,
  speed:       1,         // Speed multiplier (1, 5, 10, 100, 1000)
  xAxisMode:   'elapsed', // 'elapsed' | 'step' | 'hour'

  // ── Trend config: which params the user is watching ───────────────────────
  // Each entry: { key, nodeId, outputKey, label, color }
  //   nodeId = '__summary__' for global influent/effluent
  //   outputKey = 'influent'|'effluent' for summary, or 'effluent'|'filtrate'|'permeate'|'thickened'|'digestate' for nodes
  watchedParams: [],

  // ── WebSocket event handlers ──────────────────────────────────────────────
  onStarted: ({ runId, startedBy, speed }) =>
    set(s => ({
      status: 'running', runId, startedBy, steps: [], currentStep: 0, error: null,
      speed: speed || s.speed,
    })),

  /** Handle a batch of steps from the backend (sim:live:steps). */
  onSteps: ({ steps }) =>
    set(s => {
      const lastStep = steps[steps.length - 1];
      return {
        steps:       [...s.steps, ...steps],
        currentStep: lastStep ? lastStep.tick + 1 : s.currentStep,
      };
    }),

  onPaused:    () => set({ status: 'paused' }),
  onResumed:   () => set({ status: 'running' }),
  onCancelled: () => set({ status: 'cancelled' }),
  onError: ({ error }) => set({ status: 'idle', error }),
  onSpeedChanged: ({ speed }) => set({ speed }),
  setSpeed: (speed) => set({ speed }),
  setXAxisMode: (mode) => set({ xAxisMode: mode }),

  // ── Trend variable management ─────────────────────────────────────────────
  addWatchedParam: (key, nodeId, outputKey, nodeLabel) => {
    const label = `${nodeLabel} — ${key}`;
    set(s => {
      if (s.watchedParams.find(w => w.key === key && w.nodeId === nodeId && w.outputKey === outputKey)) return s;
      const color = TREND_COLORS[s.watchedParams.length % TREND_COLORS.length];
      return { watchedParams: [...s.watchedParams, { key, nodeId, outputKey, label, color }] };
    });
  },

  removeWatchedParam: (key, nodeId, outputKey) =>
    set(s => ({
      watchedParams: s.watchedParams.filter(
        w => !(w.key === key && w.nodeId === nodeId && w.outputKey === outputKey)
      ),
    })),

  // ── Reset ─────────────────────────────────────────────────────────────────
  reset: () => set(s => ({
    status: 'idle', runId: null, steps: [], currentStep: 0,
    error: null, startedBy: null, speed: s.speed,
  })),
}));

export default useLiveSimStore;
