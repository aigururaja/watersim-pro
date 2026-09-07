/**
 * PipeEdge — the process line drawn as a PIPE, the way the Live plant draws
 * it: outline, body and highlight, a flange at every bend, and the water
 * inside when the stream carries flow.
 *
 * Routed orthogonally from the source port to the target port with the
 * mimic's own router (`routePipe`), so a sheet reads the same here and on the
 * Live plant. Values always, motion only live (§6.1): a still frame shows
 * which lines carry water and how much (the label); the dashes and bubbles
 * move only in live view, at a speed that follows Q against the sheet's
 * Qref; a dead line (Q < 0.5 m³/d) is an empty pipe — a closed valve visibly
 * empties the run below it. Colour is the service (water, recycle, sludge,
 * air, chemical, permeate), classified exactly as StreamEdge does.
 *
 * ReactFlow's BaseEdge is drawn LAST and transparent: it carries the hit
 * area, so click, select and delete keep working exactly as before.
 */
import React, { useCallback } from 'react';
import { useStore, BaseEdge, EdgeLabelRenderer } from 'reactflow';
import '../mimic/mimic.css';
import { PipeBody, PipeWater, PipeJoints } from '../mimic/MimicSymbols';
import { routePipe, streamStyle } from '../mimic/mimicLayout';
import { num, drive, useLiveEdge } from './liveStore';
import { serviceOf, DEAD_Q } from './StreamEdge';

const SERVICE_STREAM = { water: 'stream', recycle: 'recycle', sludge: 'was', air: 'air', chemical: 'chemical', permeate: 'permeate' };
const fmtQ = (q) => Number(q).toLocaleString('en-US', { maximumFractionDigits: 0 });

/** Where the flow tag sits: mid-run on a straight pipe, on the riser of a stepped or looped one. */
export function labelPoint(route) {
  const p = route.points;
  if (p.length <= 2) return { x: (p[0].x + p[p.length - 1].x) / 2, y: p[0].y };
  if (p.length === 4) return { x: p[1].x, y: (p[1].y + p[2].y) / 2 };
  return { x: (p[2].x + p[3].x) / 2, y: p[2].y };
}

const PipeEdge = React.memo(function PipeEdge({ id, source, sourceX, sourceY, targetX, targetY, data, selected }) {
  const selector = useCallback(
    (s) => ({ zoom: s.transform[2], srcOp: s.nodeInternals.get(source)?.data?.opType ?? null }),
    [source]
  );
  const { zoom, srcOp } = useStore(selector, (a, b) => a.zoom === b.zoom && a.srcOp === b.srcOp);
  const snap = useLiveEdge(id);

  const stream = snap.stream || data?.streamResult || null;
  const isRecycle = !!(data?.isRecycle || (data?.streamType && data.streamType !== 'stream'));
  const Q = num(stream?.Q);
  const wet = Q != null && Q >= DEAD_Q;
  const svc = wet ? serviceOf(data, stream, srcOp) : 'water';
  const style = streamStyle(SERVICE_STREAM[svc] || 'stream');
  const Qref = num(snap.refs?.Qref) ?? 1;
  const v = wet ? drive(Q, 0, Qref) : null;
  const speed = v == null ? '1.7s' : `${(2.6 - 2.0 * v).toFixed(2)}s`;
  const moving = wet && !!snap.live;

  const route = routePipe({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const at = labelPoint(route);
  const label = stream ? `${isRecycle ? 'RAS' : 'Q'}: ${fmtQ(stream.Q)} m³/d` : null;

  return (
    <g className="mimic-root ws-pipe" data-edge={id} data-wet={wet ? 'true' : 'false'} data-flowing={moving ? 'true' : 'false'} data-service={svc}
      style={{ '--mimic-flow-speed': speed }}>
      <title>{`${label || 'No flow'}${isRecycle ? ' · recycle' : ''}`}</title>
      <g pointerEvents="none">
        <PipeBody route={route} />
        {wet && <PipeWater d={route.d} style={style} moving={moving} />}
        <PipeJoints route={route} />
      </g>
      {selected && <path d={route.d} fill="none" stroke="var(--ws-brand-900, #1F4E79)" strokeWidth="17" strokeOpacity=".3" strokeLinejoin="round" pointerEvents="none" />}

      {/* Hit area and selection: ReactFlow's own edge path, drawn transparent on top. */}
      <BaseEdge id={id} path={route.d} interactionWidth={18} style={{ stroke: 'transparent', strokeWidth: 14, fill: 'none' }} />

      {label && zoom >= 0.55 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${at.x}px,${at.y}px)`,
              background: 'rgba(255,255,255,.92)',
              border: '1px solid #cfd6dc',
              borderLeft: `3px solid ${wet ? style.color : '#9aa3ab'}`,
              borderRadius: 3,
              padding: '0 5px',
              lineHeight: '15px',
              fontFamily: 'var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)',
              fontVariantNumeric: 'tabular-nums lining-nums',
              fontSize: 9.5,
              fontWeight: 600,
              color: '#243342',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
});

export default PipeEdge;
