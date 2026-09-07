/**
 * CanvasNode — the one node type the sheet registers. It draws the card the
 * way the sheet's style says: the Live plant's machine (MimicNode) or the
 * drafting symbol (UnitOpNode). Both are 168 × 116 with unnamed handles on
 * the centre line, so switching never moves a pipe.
 */
import { memo } from 'react';
import UnitOpNode from './UnitOpNode';
import MimicNode from './MimicNode';
import { useCanvasStyle } from './canvasStyle';

const CanvasNode = memo(function CanvasNode(props) {
  return useCanvasStyle() === 'mimic' ? <MimicNode {...props} /> : <UnitOpNode {...props} />;
});

export default CanvasNode;
