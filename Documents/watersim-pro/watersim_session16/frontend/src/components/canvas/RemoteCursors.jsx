/**
 * RemoteCursors — Renders faint colored cursor labels for collaborators.
 * Positioned absolutely over the canvas div; uses React Flow viewport coords.
 */

import React from 'react';

export default function RemoteCursors({ cursors }) {
  const entries = Object.values(cursors);
  if (entries.length === 0) return null;

  return (
    <div style={S.overlay} className="nopan nodrag" data-remote-cursors="true">
      {entries.map((c) => (
        <div
          key={c.userId || c.displayName}
          style={{
            ...S.cursor,
            left: c.x,
            top:  c.y,
          }}
        >
          {/* Cursor triangle */}
          <svg width="14" height="16" viewBox="0 0 14 16" style={{ display: 'block' }}>
            <path
              d="M1 1 L1 13 L5 9 L8 15 L10 14 L7 8 L13 8 Z"
              fill={c.color}
              stroke="#fff"
              strokeWidth="1"
            />
          </svg>
          {/* Name label */}
          <span style={{ ...S.label, background: c.color }}>
            {c.displayName.split(' ')[0]}
          </span>
        </div>
      ))}
    </div>
  );
}

const S = {
  overlay: {
    position:      'absolute',
    inset:         0,
    pointerEvents: 'none',
    zIndex:        50,
    overflow:      'hidden',
  },
  cursor: {
    position:   'absolute',
    display:    'flex',
    alignItems: 'flex-end',
    gap:        2,
    opacity:    0.85,
    transition: 'left 0.08s linear, top 0.08s linear',
  },
  label: {
    color:        '#fff',
    fontSize:     10,
    fontWeight:   600,
    padding:      '1px 5px',
    borderRadius: 3,
    whiteSpace:   'nowrap',
    lineHeight:   '14px',
  },
};
