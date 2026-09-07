/**
 * canvasStyle — how the sheet is drawn.
 *
 *   'mimic'    the machines and pipes of the Live plant (components/mimic):
 *              shaded castings, a spinning impeller, water in the pipes. The
 *              sheet being built and the plant being watched are one picture.
 *   'drawing'  the drafting symbols (components/canvas/symbols): the P&ID
 *              look, value-driven, for print and for people who read symbols.
 *
 * A context, not a prop: the node and edge renderers are module-scope
 * constants in ReactFlow's `nodeTypes` / `edgeTypes` and cannot take props.
 * The default WITHOUT a provider is 'drawing', so a card rendered on its own
 * (tests, print) is exactly what it was.
 */
import { createContext, useContext } from 'react';

export const CANVAS_STYLE_KEY = 'ws.canvasStyle';

export const CanvasStyleContext = createContext('drawing');
export const useCanvasStyle = () => useContext(CanvasStyleContext);

/** The remembered style; realistic unless the person chose the drawing. */
export function readCanvasStyle() {
  try { return localStorage.getItem(CANVAS_STYLE_KEY) === 'drawing' ? 'drawing' : 'mimic'; } catch { return 'mimic'; }
}

export function writeCanvasStyle(style) {
  try { localStorage.setItem(CANVAS_STYLE_KEY, style); } catch { /* private mode */ }
}
