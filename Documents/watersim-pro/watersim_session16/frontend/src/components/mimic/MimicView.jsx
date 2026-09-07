/**
 * MimicView — the plant as a schematic, generated from the flowsheet's own
 * layout and driven by measured values.
 *
 * Pipes are drawn first (outline, body, highlight, then the water when the
 * pipe carries flow, with moving dashes and bubbles whose speed follows the
 * nearest flow meter), flanges at every bend, then the equipment on top.
 * Pan by dragging, zoom with the wheel or the buttons. Clicking a machine
 * selects it for the side panel.
 *
 * Props
 *   nodes, edges     the canvas
 *   states           Map nodeId → { running, tripped, opened, closed, level, readings: { FT, LT, AT … } }
 *   selected         nodeId
 *   onSelect(nodeId)
 *   focus            Set of node ids to draw (one process area). The pipes that
 *                    leave the area are drawn to their far machine, dimmed, so the
 *                    flow visibly continues; flow is still worked out on the whole
 *                    plant, so a pump in the area upstream feeds this one.
 *   compact          a small window in a grid: no wheel zoom (the page scrolls), short footer
 */
import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Maximize2, Plus, Minus } from 'lucide-react';
import './mimic.css';
import MimicSymbol, { MimicDefs, PipeBody, PipeWater, PipeJoints } from './MimicSymbols';
import { ports, routePipe, propagateFlow, streamStyle, layoutBounds, familyOf, NODE_W, NODE_H } from './mimicLayout';

const READING_KIND = { LT: 'level', PT: 'pressure', FT: 'flow', AT: 'ph', TT: 'temperature' };
const READING_UNIT = { LT: '%', FT: 'm³/d', AT: 'pH', PT: 'bar', TT: '°C' };

/** The flow-meter reading that governs a pipe's animation speed: the source node's FT, else the target's. */
function flowSpeed(edge, states, byId) {
  for (const id of [edge.source, edge.target]) {
    const r = states.get(id)?.readings?.FT;
    if (r && r.value != null && r.rangeMin != null && r.rangeMax != null && r.rangeMax > r.rangeMin) {
      const f = Math.max(0, Math.min(1, (r.value - r.rangeMin) / (r.rangeMax - r.rangeMin)));
      return (2.6 - 2.0 * f).toFixed(2) + 's';
    }
    if (byId.get(id) && familyOf(byId.get(id).data?.opType) === 'drive') return '1.2s';
  }
  return '1.7s';
}

export default function MimicView({ nodes = [], edges = [], states = new Map(), selected = null, onSelect, height = 620, focus = null, compact = false }) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // The whole plant decides what flows; `focus` only decides what is drawn.
  const { flowing, active } = useMemo(() => propagateFlow(nodes, edges, states), [nodes, edges, states]);
  const scope = useMemo(() => {
    if (!focus) return { drawNodes: nodes, drawEdges: edges, neighbours: new Set(), fitNodes: nodes };
    const neighbours = new Set();
    const drawEdges = edges.filter((e) => {
      const inS = focus.has(e.source), inT = focus.has(e.target);
      if (!inS && !inT) return false;
      if (!inS && byId.has(e.source)) neighbours.add(e.source);
      if (!inT && byId.has(e.target)) neighbours.add(e.target);
      return true;
    });
    return {
      drawNodes: nodes.filter((n) => focus.has(n.id) || neighbours.has(n.id)),
      drawEdges, neighbours,
      fitNodes: nodes.filter((n) => focus.has(n.id)),
    };
  }, [nodes, edges, focus, byId]);
  const bounds = useMemo(() => layoutBounds(scope.fitNodes, focus ? 40 : 80), [scope.fitNodes, focus]);
  const flowingDrawn = useMemo(() => scope.drawEdges.filter((e) => flowing.has(e.id)).length, [scope.drawEdges, flowing]);

  const pipes = useMemo(() => scope.drawEdges.map((e) => {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) return null;
    const route = routePipe(ports(a).out, ports(b).in);
    return { edge: e, route, style: streamStyle(e.data?.streamType), flowing: flowing.has(e.id), speed: flowSpeed(e, states, byId) };
  }).filter(Boolean), [scope.drawEdges, byId, flowing, states]);

  // ── Viewport: fit to the plant, then pan and zoom ──
  const [vb, setVb] = useState(bounds);
  useEffect(() => { setVb(bounds); }, [bounds]);
  const svgRef = useRef(null);
  const drag = useRef(null);

  const zoomAt = useCallback((factor, cx, cy) => {
    setVb((v) => {
      const w = v.w * factor, h = v.h * factor;
      const fx = cx == null ? 0.5 : (cx - v.x) / v.w;
      const fy = cy == null ? 0.5 : (cy - v.y) / v.h;
      return { x: v.x + (v.w - w) * fx, y: v.y + (v.h - h) * fy, w, h };
    });
  }, []);
  const toWorld = (evt) => {
    const el = svgRef.current; if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: vb.x + ((evt.clientX - r.left) / r.width) * vb.w, y: vb.y + ((evt.clientY - r.top) / r.height) * vb.h };
  };
  const onWheel = (e) => { e.preventDefault(); const p = toWorld(e); zoomAt(e.deltaY > 0 ? 1.12 : 0.89, p?.x, p?.y); };
  const onDown = (e) => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, vb }; };
  const onMove = (e) => {
    if (!drag.current) return;
    const el = svgRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - drag.current.x) / r.width) * drag.current.vb.w;
    const dy = ((e.clientY - drag.current.y) / r.height) * drag.current.vb.h;
    setVb({ ...drag.current.vb, x: drag.current.vb.x - dx, y: drag.current.vb.y - dy });
  };
  const onUp = () => { drag.current = null; };

  return (
    <div className="mimic-root relative rounded-xl border border-gray-200 bg-[#eef1f4] overflow-hidden" style={{ height }} data-testid="mimic">
      <svg ref={svgRef} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} width="100%" height="100%" role="img" aria-label="Plant schematic"
        onWheel={compact ? undefined : onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} style={{ cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}>
        <MimicDefs />
        <rect x={bounds.x - 4000} y={bounds.y - 4000} width={bounds.w + 8000} height={bounds.h + 8000} fill="#eef1f4" />

        {/* Pipes */}
        <g className="mimic-pipes">
          {pipes.map(({ edge, route, style, flowing: on, speed }) => (
            <g key={edge.id} data-edge={edge.id} data-flowing={on ? 'true' : 'false'} style={{ '--mimic-flow-speed': speed }}>
              <title>{`${edge.data?.label ? `${edge.data.label} · ` : ''}${style.kind}${on ? ', flowing' : ', static'}`}</title>
              <PipeBody route={route} />
              {on && <PipeWater d={route.d} style={style} moving />}
              <PipeJoints route={route} />
            </g>
          ))}
        </g>

        {/* Equipment */}
        <g className="mimic-nodes">
          {scope.drawNodes.map((n) => {
            const fam = familyOf(n.data?.opType);
            const dim = scope.neighbours.has(n.id);
            const s = states.get(n.id) || {};
            const tag = (n.data?.tags || [])[0] || null;
            const readings = s.readings || {};
            const primary = readings.FT || readings.LT || readings.AT || readings.PT || readings.TT || null;
            const readingFn = primary ? Object.keys(readings).find((k) => readings[k] === primary) : null;
            const isSel = selected === n.id;
            return (
              <g key={n.id} className={`mimic-node${isSel ? ' mimic-node--selected' : ''}`} transform={`translate(${n.position?.x ?? 0} ${n.position?.y ?? 0})`}
                data-node={n.id} data-family={fam} data-neighbour={dim ? 'true' : undefined} opacity={dim ? 0.38 : 1}
                tabIndex={0} role="button" aria-label={n.data?.label || n.id}
                onClick={(e) => { e.stopPropagation(); onSelect?.(n.id); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(n.id); } }}>
                <title>{`${n.data?.label || n.id}${tag ? ` · ${tag}` : ''}`}</title>
                <rect className="mimic-hit" x="-4" y="-4" width={NODE_W + 8} height={NODE_H + 8} rx="10" fill="transparent" stroke="transparent" strokeWidth="2" />
                <MimicSymbol
                  family={fam} opType={n.data?.opType} s={s}
                  label={fam === 'source' || fam === 'sink' ? (n.data?.label || n.id) : (tag || n.data?.label || n.id)}
                  sub={fam === 'tank' || fam === 'basin' ? (n.data?.label || '').split(' — ')[0] : undefined}
                  active={active.has(n.id)}
                  reading={primary} unit={readingFn ? READING_UNIT[readingFn] : undefined} kind={readingFn ? READING_KIND[readingFn] : undefined}
                  chemical={fam === 'dosing' ? (n.data?.label || '').split(' ')[0] : undefined}
                />
              </g>
            );
          })}
        </g>
      </svg>

      <div className={`absolute ${compact ? 'right-2 top-2 gap-0.5' : 'right-3 top-3 gap-1'} flex flex-col`} role="group" aria-label="Zoom">
        <button onClick={() => zoomAt(0.8)} className={`${compact ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-white/90 border border-gray-200 text-gray-700 hover:bg-white flex items-center justify-center`} aria-label="Zoom in"><Plus className={compact ? 'w-3 h-3' : 'w-4 h-4'} /></button>
        <button onClick={() => zoomAt(1.25)} className={`${compact ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-white/90 border border-gray-200 text-gray-700 hover:bg-white flex items-center justify-center`} aria-label="Zoom out"><Minus className={compact ? 'w-3 h-3' : 'w-4 h-4'} /></button>
        <button onClick={() => setVb(bounds)} className={`${compact ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-white/90 border border-gray-200 text-gray-700 hover:bg-white flex items-center justify-center`} aria-label={focus ? 'Fit area' : 'Fit plant'}><Maximize2 className={compact ? 'w-3 h-3' : 'w-4 h-4'} /></button>
      </div>
      <div className="absolute left-3 bottom-2 text-[10px] text-gray-500 bg-white/80 rounded px-2 py-0.5 pointer-events-none">
        {flowingDrawn} of {scope.drawEdges.length} lines flowing{compact ? '' : ' · drag to pan, wheel to zoom · every state shown is measured'}
      </div>
    </div>
  );
}
