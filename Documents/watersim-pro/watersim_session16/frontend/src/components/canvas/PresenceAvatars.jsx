/**
 * PresenceAvatars — Shows colored initials bubbles for each connected collaborator.
 * Tooltip with name on hover.
 */

import React, { useState } from 'react';

export default function PresenceAvatars({ presence, self }) {
  const [tooltip, setTooltip] = useState(null); // userId

  // Filter self out of the list (we already know we're here)
  const others = presence.filter(p => p.userId !== self?.userId);
  const all    = self ? [{ ...self, isSelf: true }, ...others] : others;

  if (all.length === 0) return null;

  return (
    <div style={S.wrap}>
      {all.map((peer) => (
        <div
          key={peer.userId}
          style={{
            ...S.avatar,
            background: peer.color,
            border: peer.isSelf ? '2px solid #fff' : '2px solid rgba(255,255,255,0.6)',
            outline: peer.isSelf ? `2px solid ${peer.color}` : 'none',
          }}
          onMouseEnter={() => setTooltip(peer.userId)}
          onMouseLeave={() => setTooltip(null)}
        >
          {peer.initials}
          {tooltip === peer.userId && (
            <div style={S.tooltip}>
              {peer.displayName}{peer.isSelf ? ' (you)' : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const S = {
  wrap: {
    display:    'flex',
    alignItems: 'center',
    gap:        '-4px',
    marginRight: 6,
  },
  avatar: {
    position:     'relative',
    width:         30,
    height:        30,
    borderRadius:  '50%',
    display:       'flex',
    alignItems:    'center',
    justifyContent:'center',
    fontSize:      11,
    fontWeight:    700,
    color:         '#fff',
    cursor:        'default',
    userSelect:    'none',
    marginLeft:    -4,
    transition:    'transform 0.15s',
    flexShrink:     0,
  },
  tooltip: {
    position:     'absolute',
    bottom:       '110%',
    left:         '50%',
    transform:    'translateX(-50%)',
    background:   '#1E293B',
    color:        '#F8FAFC',
    fontSize:     11,
    whiteSpace:   'nowrap',
    padding:      '3px 8px',
    borderRadius: 4,
    pointerEvents:'none',
    zIndex:       1000,
  },
};
