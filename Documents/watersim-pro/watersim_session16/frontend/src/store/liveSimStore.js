/**
 * Zustand store for live (real-time) simulation state.
 *
 * Tracks streaming step results, playback status, speed,
 * and the user's watched trend variables.
 */

import { create } from 'zustand';

/** All available stream parameters for trend monitoring. */
export const STREAM_PARAMS = [
  { key: 'Q',    label: 'Flow (m\u00b3/d)',   unit: 'm\u00b3/d', color: '#2563EB' },
  { key: 'TSS',  label: 'TSS (mg/L)',   unit: 'mg/L', color: '#D97706' },
  { key: 'BOD',  label: 'BOD (mg/L)',   unit: 'mg/L', color: '#DC2626' },
  { key: 'COD',  label: 'COD (mg/L)',   unit: 'mg/L', color: '#7C3AED' },
  { key: 'TN',   label: 'TN (mg/L)',    unit: 'mg/L', color: '#059669' },
  { key: 'NH4',  label: 'NH4-N (mg/L)', unit: 'mg/L', color: '#E11D48' },
  { key: 'NO3',  label: 'NO3-N (mg/L)', unit: 'mg/L', color: '#0891B2' },
  { key: 'NO2',  label: 'NO2-N (mg/L)', unit: 'mg/L', color: '#6D28D9' },
  { key: 'TP',   label: 'TP (mg/L)',    unit: 'mg/L', color: '#B45309' },
  { key: 'DO',   label: 'DO (mg/L)',    unit: 'mg/L', color: '#14B8A6' },
  { key: 'pH',   label: 'pH',           unit: '-',    color: '#6366F1' },
  { key: 'temp', label: 'Temp (\u00b0C)',     unit: '\u00b0C',   color: '#F97316' },
];

const useLiveSimStore = create((set, get) => ({
  // ── Simulation state ──────────────────────────────────────────────────────
  status:      'idle',    // 'idle' | 'running' | 'paused' | 'completed' | 'cancelled'
  runId:       null,
  steps:       [],        // Accumulated step results
  totalSteps:  0,
  currentStep: 0,
  speed:       100,       // Real-time multiplier
  startedBy:   null,
  error:       null,

  // ── Trend config: which params the user is watching ───────────────────────
  watchedParams: [
    { key: 'Q',   source: 'influent', label: 'Inf Q' },
    { key: 'Q',   source: 'effluent', label: 'Eff Q' },
    { key: 'BOD', source: 'effluent', label: 'Eff BOD' },
  ],

  // ── WebSocket event handlers ──────────────────────────────────────────────
  onStarted: ({ runId, totalSteps, speed, startedBy }) =>
    set({ status: 'running', runId, totalSteps, speed, startedBy, steps: [], currentStep: 0, error: null }),

  onStep: ({ step, stepIndex, totalSteps }) =>
    set(s => ({
      steps:       [...s.steps, step],
      currentStep: stepIndex + 1,
      totalSteps,
    })),

  onComplete: () => set({ status: 'completed' }),
  onPaused:   () => set({ status: 'paused' }),
  onResumed:  () => set({ status: 'running' }),
  onCancelled: () => set({ status: 'cancelled' }),
  onSpeedChanged: ({ speed }) => set({ speed }),
  onError: ({ error }) => set({ status: 'idle', error }),

  // ── Trend variable management ─────────────────────────────────────────────
  addWatchedParam: (key, source) => {
    const label = `${source === 'influent' ? 'Inf' : 'Eff'} ${key}`;
    set(s => {
      if (s.watchedParams.find(w => w.key === key && w.source === source)) return s;
      return { watchedParams: [...s.watchedParams, { key, source, label }] };
    });
  },

  removeWatchedParam: (key, source) =>
    set(s => ({
      watchedParams: s.watchedParams.filter(w => !(w.key === key && w.source === source)),
    })),

  // ── Reset ─────────────────────────────────────────────────────────────────
  reset: () => set({
    status: 'idle', runId: null, steps: [], totalSteps: 0,
    currentStep: 0, speed: 100, error: null, startedBy: null,
  }),
}));

export default useLiveSimStore;
