import { useState, useRef, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Grid, MousePointer2, Move } from 'lucide-react';

// ─── Unit operation block types (Phase 1 shell — models added in Phase 2) ─
const UNIT_OP_PALETTE = [
  { category: 'Preliminary',  ops: [{ id: 'screen', label: 'Screening',    color: '#64748b' }, { id: 'grit', label: 'Grit Removal', color: '#64748b' }] },
  { category: 'Primary',      ops: [{ id: 'prim_clarifier', label: 'Primary Clarifier', color: '#0369a1' }] },
  { category: 'Secondary',    ops: [{ id: 'aeration', label: 'Aeration Basin', color: '#0891b2' }, { id: 'sec_clarifier', label: 'Sec. Clarifier', color: '#0891b2' }] },
  { category: 'Tertiary',     ops: [{ id: 'uv', label: 'UV Disinfection', color: '#7c3aed' }, { id: 'chlorination', label: 'Chlorination', color: '#7c3aed' }] },
  { category: 'Sludge',       ops: [{ id: 'thickener', label: 'Thickener', color: '#b45309' }, { id: 'digester', label: 'Digester', color: '#b45309' }] },
  { category: 'Water Purif.', ops: [{ id: 'coagulation', label: 'Coagulation', color: '#047857' }, { id: 'ro', label: 'RO Membrane', color: '#047857' }] },
];

let nodeIdCounter = 1;

function UnitOpNode({ node, selected, onSelect, onDragStart }) {
  return (
    <div
      onMouseDown={(e) => { e.stopPropagation(); onSelect(node.id); onDragStart(e, node.id); }}
      style={{ left: node.x, top: node.y, borderColor: selected ? '#2E75B6' : node.color }}
      className={`absolute cursor-grab active:cursor-grabbing select-none
        bg-white rounded-lg border-2 shadow-sm hover:shadow-md transition-shadow
        min-w-[110px] text-center ${selected ? 'ring-2 ring-brand-400 ring-offset-1' : ''}`}
    >
      <div style={{ backgroundColor: node.color }} className="rounded-t-md px-3 py-1.5">
        <span className="text-white text-xs font-semibold">{node.category}</span>
      </div>
      <div className="px-3 py-2">
        <p className="text-xs font-medium text-gray-800 leading-tight">{node.label}</p>
        <p className="text-xs text-gray-400 mt-0.5">{node.id}</p>
      </div>
      {/* Connection ports */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-2 w-3 h-3 rounded-full bg-blue-400 border-2 border-white shadow" title="Inlet" />
      <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-2 w-3 h-3 rounded-full bg-green-400 border-2 border-white shadow" title="Outlet" />
    </div>
  );
}

export default function FlowsheetCanvas({ flowsheetId, readOnly = false }) {
  const [nodes, setNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState('select'); // 'select' | 'pan'
  const [showGrid, setShowGrid] = useState(true);
  const [dragging, setDragging] = useState(null); // { nodeId, startX, startY, origX, origY }
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState(null);
  const canvasRef = useRef(null);

  // ── Drop from palette ──────────────────────────────────────────────────
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/watersim-op');
    if (!data) return;
    const op = JSON.parse(data);
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - pan.x) / zoom - 60;
    const y = (e.clientY - rect.top  - pan.y) / zoom - 40;
    setNodes(ns => [...ns, { id: `${op.id}_${nodeIdCounter++}`, label: op.label, category: op.category, color: op.color, x, y }]);
  }, [pan, zoom]);

  const handleDragOver = (e) => e.preventDefault();

  // ── Node dragging ──────────────────────────────────────────────────────
  const handleNodeDragStart = useCallback((e, nodeId) => {
    if (readOnly || tool !== 'select') return;
    const node = nodes.find(n => n.id === nodeId);
    setDragging({ nodeId, startMouseX: e.clientX, startMouseY: e.clientY, origX: node.x, origY: node.y });
  }, [nodes, readOnly, tool]);

  const handleMouseMove = useCallback((e) => {
    if (dragging) {
      const dx = (e.clientX - dragging.startMouseX) / zoom;
      const dy = (e.clientY - dragging.startMouseY) / zoom;
      setNodes(ns => ns.map(n => n.id === dragging.nodeId ? { ...n, x: dragging.origX + dx, y: dragging.origY + dy } : n));
    }
    if (isPanning && panStart) {
      setPan(p => ({ x: p.x + e.clientX - panStart.x, y: p.y + e.clientY - panStart.y }));
      setPanStart({ x: e.clientX, y: e.clientY });
    }
  }, [dragging, isPanning, panStart, zoom]);

  const handleMouseUp = useCallback(() => { setDragging(null); setIsPanning(false); setPanStart(null); }, []);

  const handleCanvasMouseDown = useCallback((e) => {
    if (tool === 'pan' || e.button === 1) { setIsPanning(true); setPanStart({ x: e.clientX, y: e.clientY }); }
    else setSelectedId(null);
  }, [tool]);

  // ── Zoom ──────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.25, Math.min(2.5, z + (e.deltaY < 0 ? 0.1 : -0.1))));
  }, []);

  const fitView = () => { setZoom(1); setPan({ x: 40, y: 40 }); };

  const deleteSelected = useCallback(() => {
    if (selectedId) { setNodes(ns => ns.filter(n => n.id !== selectedId)); setSelectedId(null); }
  }, [selectedId]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  }, [deleteSelected]);

  return (
    <div className="flex h-full bg-gray-100 overflow-hidden" tabIndex={0} onKeyDown={handleKeyDown}>
      {/* Palette */}
      {!readOnly && (
        <aside className="w-52 bg-white border-r border-gray-200 overflow-y-auto flex-shrink-0">
          <div className="px-3 py-3 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Unit Operations</p>
          </div>
          {UNIT_OP_PALETTE.map(({ category, ops }) => (
            <div key={category} className="px-2 py-2 border-b border-gray-100">
              <p className="text-xs font-medium text-gray-400 px-1 mb-1.5">{category}</p>
              {ops.map(op => (
                <div key={op.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/watersim-op', JSON.stringify({ ...op, category }))}
                  style={{ borderLeftColor: op.color }}
                  className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded border border-gray-200 border-l-4 bg-gray-50 hover:bg-white cursor-grab active:cursor-grabbing text-xs text-gray-700 font-medium select-none transition-colors"
                >
                  {op.label}
                </div>
              ))}
            </div>
          ))}
        </aside>
      )}

      {/* Canvas area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button onClick={() => setTool('select')}
              className={`p-1.5 rounded ${tool === 'select' ? 'bg-white shadow text-brand-600' : 'text-gray-500 hover:text-gray-700'}`}
              title="Select (V)">
              <MousePointer2 className="w-4 h-4" />
            </button>
            <button onClick={() => setTool('pan')}
              className={`p-1.5 rounded ${tool === 'pan' ? 'bg-white shadow text-brand-600' : 'text-gray-500 hover:text-gray-700'}`}
              title="Pan (H)">
              <Move className="w-4 h-4" />
            </button>
          </div>
          <div className="w-px h-5 bg-gray-200 mx-1" />
          <button onClick={() => setZoom(z => Math.min(2.5, z + 0.1))} className="p-1.5 rounded hover:bg-gray-100 text-gray-500" title="Zoom in"><ZoomIn className="w-4 h-4" /></button>
          <span className="text-xs text-gray-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.max(0.25, z - 0.1))} className="p-1.5 rounded hover:bg-gray-100 text-gray-500" title="Zoom out"><ZoomOut className="w-4 h-4" /></button>
          <button onClick={fitView} className="p-1.5 rounded hover:bg-gray-100 text-gray-500" title="Fit view"><Maximize2 className="w-4 h-4" /></button>
          <div className="w-px h-5 bg-gray-200 mx-1" />
          <button onClick={() => setShowGrid(g => !g)}
            className={`p-1.5 rounded hover:bg-gray-100 ${showGrid ? 'text-brand-600' : 'text-gray-400'}`}
            title="Toggle grid">
            <Grid className="w-4 h-4" />
          </button>
          <div className="ml-auto flex items-center gap-3">
            {nodes.length > 0 && (
              <span className="text-xs text-gray-400">{nodes.length} unit op{nodes.length !== 1 ? 's' : ''}</span>
            )}
            {selectedId && !readOnly && (
              <button onClick={deleteSelected} className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50">
                Delete selected
              </button>
            )}
            {!readOnly && (
              <span className="text-xs text-gray-400">Drag unit ops from palette · Drop to canvas</span>
            )}
          </div>
        </div>

        {/* Canvas */}
        <div
          ref={canvasRef}
          className={`flex-1 overflow-hidden relative ${tool === 'pan' ? 'cursor-grab' : 'cursor-default'} ${isPanning ? '!cursor-grabbing' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{ userSelect: 'none' }}
        >
          {/* Grid background */}
          {showGrid && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <pattern id="grid-minor" width={20 * zoom} height={20 * zoom} patternUnits="userSpaceOnUse"
                  x={pan.x % (20 * zoom)} y={pan.y % (20 * zoom)}>
                  <circle cx={20 * zoom} cy={20 * zoom} r="0.5" fill="#d1d5db" />
                </pattern>
                <pattern id="grid-major" width={100 * zoom} height={100 * zoom} patternUnits="userSpaceOnUse"
                  x={pan.x % (100 * zoom)} y={pan.y % (100 * zoom)}>
                  <circle cx={100 * zoom} cy={100 * zoom} r="1" fill="#9ca3af" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#grid-minor)" />
              <rect width="100%" height="100%" fill="url(#grid-major)" />
            </svg>
          )}

          {/* Node layer */}
          <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0', position: 'absolute', width: '100%', height: '100%' }}>
            {nodes.map(node => (
              <UnitOpNode key={node.id} node={node}
                selected={selectedId === node.id}
                onSelect={setSelectedId}
                onDragStart={handleNodeDragStart}
              />
            ))}
          </div>

          {/* Empty state */}
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-gray-200 flex items-center justify-center mx-auto mb-4">
                  <Grid className="w-8 h-8 text-gray-400" />
                </div>
                <p className="text-gray-500 font-medium">Flowsheet canvas</p>
                <p className="text-gray-400 text-sm mt-1">
                  {readOnly ? 'No unit operations on this flowsheet' : 'Drag unit operations from the left panel to begin'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
