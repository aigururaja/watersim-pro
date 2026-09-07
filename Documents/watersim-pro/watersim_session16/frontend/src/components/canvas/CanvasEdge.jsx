/**
 * CanvasEdge — the one edge type the sheet registers: the Live plant's pipe
 * (PipeEdge) or the drafting process line (StreamEdge), by the sheet's style.
 */
import { memo } from 'react';
import StreamEdge from './StreamEdge';
import PipeEdge from './PipeEdge';
import { useCanvasStyle } from './canvasStyle';

const CanvasEdge = memo(function CanvasEdge(props) {
  return useCanvasStyle() === 'mimic' ? <PipeEdge {...props} /> : <StreamEdge {...props} />;
});

export default CanvasEdge;
