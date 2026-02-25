/**
 * SimBanner — Pulsing banner shown when a collaborator is running a simulation.
 */

import React from 'react';

export default function SimBanner({ simBanner }) {
  if (!simBanner) return null;

  return (
    <div style={S.banner}>
      <span style={S.pulse} />
      <span style={S.text}>
        <strong>{simBanner.displayName}</strong> is simulating…
      </span>
      <style>{`
        @keyframes ws-pulse {
          0%,100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(1.4); }
        }
      `}</style>
    </div>
  );
}

const S = {
  banner: {
    display:         'flex',
    alignItems:      'center',
    gap:             8,
    background:      '#FEFCE8',
    border:          '1px solid #FDE047',
    borderRadius:    6,
    padding:         '5px 12px',
    fontSize:        12,
    color:           '#713F12',
    position:        'relative',
    boxShadow:       '0 1px 4px rgba(0,0,0,0.08)',
  },
  pulse: {
    display:         'inline-block',
    width:           8,
    height:          8,
    borderRadius:    '50%',
    background:      '#EAB308',
    animation:       'ws-pulse 1.2s ease-in-out infinite',
    flexShrink:      0,
  },
  text: {
    lineHeight: 1.4,
  },
};
