/**
 * UnitOpIcon — shared equipment glyphs for the palette, canvas nodes, and
 * the live diagram. One source of truth so the flowsheet editor reads as one
 * visual system.
 *
 *   <UnitOpIcon opType="sand_filter" size={22} />       // icon from opType
 *   <UnitOpIcon cat="pump" animated size={26} />        // explicit + animated
 */
import { memo } from 'react';

const C = {
  panel: '#ffffff', panel2: '#F3F4F6', line: '#E5E7EB', ink2: '#4B5563',
  steel: '#94A3B8', water: '#2F86BD', accent: '#0891B2', accent2: '#22B8CF',
  solid2: '#A87142', mediaA: '#D8C48A', mediaB: '#7C8794',
};

/** Icon categories the palette lets users choose from, with a base solver model. */
export const ICON_OPTIONS = [
  { cat: 'inlet',     label: 'Inlet',              base: 'inlet' },
  { cat: 'outlet',    label: 'Outlet',             base: 'outlet' },
  { cat: 'pump',      label: 'Pump',               base: 'pump' },
  { cat: 'blower',    label: 'Blower',             base: 'blower' },
  { cat: 'clarifier', label: 'Clarifier / Agitator', base: 'primary_clarifier' },
  { cat: 'vessel',    label: 'Filter / Vessel',    base: 'sand_filter' },
  { cat: 'basin',     label: 'Aeration Basin',     base: 'activated_sludge' },
  { cat: 'tank',      label: 'Storage Tank',       base: 'tank' },
  { cat: 'dosing',    label: 'Dosing',             base: 'chemical_dosing' },
  { cat: 'uv',        label: 'UV / Disinfection',  base: 'uv_disinfection' },
  { cat: 'valve',     label: 'Valve',              base: 'control_valve' },
  { cat: 'screen',    label: 'Screen',             base: 'screening' },
  { cat: 'unit',      label: 'Generic Unit',       base: 'tank' },
];

/** Map any opType to one of the glyph categories. */
export function iconCategory(op) {
  op = op || '';
  if (op.includes('inlet')) return 'inlet';
  if (op.includes('outlet')) return 'outlet';
  if (op.includes('opc')) return 'opc';
  if (op.includes('pump')) return 'pump';
  if (op.includes('blower')) return 'blower';
  if (op.includes('thicken') || op.includes('clarifier')) return 'clarifier';
  if (op.includes('aeration') || op.includes('activated') || op.includes('reactor') || op.includes('bioreactor') || op.includes('digest')) return 'basin';
  if (op.includes('filter') || op.includes('sand') || op.includes('gac') || op.includes('membrane') || op === 'ro' || op.includes('ro_') || op.includes('uf')) return 'vessel';
  if (op.includes('dos') || op.includes('coagul') || op.includes('polymer') || op === 'ph_adjustment' || op.includes('chlor')) return 'dosing';
  if (op.includes('uv')) return 'uv';
  if (op.includes('valve')) return 'valve';
  if (op.includes('screen') || op.includes('grit')) return 'screen';
  if (op.includes('tank')) return 'tank';
  return 'unit';
}

// Inject the animation keyframes once.
const STYLE_ID = 'uoi-anim-style';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    .uoi-spin{transform-box:view-box;transform-origin:22px 22px}
    .uoi-anim .uoi-spin{animation:uoiSpin 1.1s linear infinite}
    .uoi-anim .uoi-spin.fast{animation-duration:.6s}
    .uoi-bubble{opacity:0}
    .uoi-anim .uoi-bubble{animation:uoiRise 1.5s ease-in infinite}
    .uoi-drop{opacity:0}
    .uoi-anim .uoi-drop{animation:uoiDrip 1.3s ease-in infinite}
    @keyframes uoiSpin{to{transform:rotate(360deg)}}
    @keyframes uoiRise{0%{opacity:0;transform:translateY(0)}25%{opacity:.9}100%{opacity:0;transform:translateY(-14px)}}
    @keyframes uoiDrip{0%{opacity:0;transform:translateY(-3px)}30%{opacity:1}100%{opacity:0;transform:translateY(9px)}}
    @media (prefers-reduced-motion:reduce){.uoi-anim .uoi-spin,.uoi-anim .uoi-bubble,.uoi-anim .uoi-drop{animation:none}}
  `;
  document.head.appendChild(el);
}

function Glyph({ cat }) {
  switch (cat) {
    case 'pump':
      return (<g>
        <circle cx="22" cy="22" r="15" fill={C.panel} stroke={C.steel} strokeWidth="2" />
        <g className="uoi-spin fast">
          <path d="M22 22 L34 17 L34 27 Z" fill={C.accent} />
          <path d="M22 22 L10 27 L10 17 Z" fill={C.accent} />
          <path d="M22 22 L17 8 L27 8 Z" fill={C.accent} opacity="0.85" />
        </g>
        <circle cx="22" cy="22" r="3" fill={C.panel} stroke={C.steel} strokeWidth="1" />
      </g>);
    case 'blower':
      return (<g>
        <circle cx="22" cy="22" r="15" fill={C.panel} stroke={C.steel} strokeWidth="2" />
        <g className="uoi-spin fast">
          <path d="M22 22 L34 22 L28 29 Z" fill={C.accent} />
          <path d="M22 22 L16 32 L10 25 Z" fill={C.accent} />
          <path d="M22 22 L16 12 L24 8 Z" fill={C.accent} />
        </g>
        <circle cx="22" cy="22" r="3" fill={C.accent} />
      </g>);
    case 'clarifier':
      return (<g>
        <circle cx="22" cy="22" r="16" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        <circle cx="22" cy="22" r="10" fill="none" stroke={C.line} strokeWidth="1" />
        <g className="uoi-spin">
          <rect x="8" y="20.4" width="28" height="3.2" rx="1.5" fill={C.solid2} />
          <path d="M8 22 l3 -3 l0 6 Z" fill={C.solid2} />
          <path d="M36 22 l-3 -3 l0 6 Z" fill={C.solid2} />
        </g>
        <rect x="11" y="2" width="22" height="6" rx="2" fill={C.ink2} />
        <circle cx="22" cy="22" r="3" fill={C.steel} />
      </g>);
    case 'vessel':
      return (<g>
        <ellipse cx="22" cy="9" rx="14" ry="4" fill={C.panel} stroke={C.steel} strokeWidth="2" />
        <rect x="8" y="9" width="28" height="27" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        <rect x="9" y="11" width="26" height="11" fill={C.mediaA} opacity="0.9" />
        <rect x="9" y="22" width="26" height="12" fill={C.mediaB} opacity="0.85" />
        <line x1="9" y1="22" x2="35" y2="22" stroke={C.ink2} strokeWidth="1" strokeDasharray="3 3" />
        <ellipse cx="22" cy="36" rx="14" ry="4" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
      </g>);
    case 'basin':
      return (<g>
        <rect x="4" y="10" width="36" height="26" rx="3" fill={C.water} fillOpacity="0.4" stroke={C.steel} strokeWidth="2" />
        <line x1="8" y1="33" x2="36" y2="33" stroke={C.steel} strokeWidth="1.5" strokeDasharray="2 3" />
        <circle className="uoi-bubble" cx="12" cy="30" r="2" fill={C.accent2} style={{ animationDelay: '0s' }} />
        <circle className="uoi-bubble" cx="20" cy="30" r="2" fill={C.accent2} style={{ animationDelay: '.3s' }} />
        <circle className="uoi-bubble" cx="28" cy="30" r="2" fill={C.accent2} style={{ animationDelay: '.6s' }} />
        <circle className="uoi-bubble" cx="34" cy="30" r="2" fill={C.accent2} style={{ animationDelay: '.9s' }} />
      </g>);
    case 'tank':
      return (<g>
        <rect x="8" y="6" width="28" height="30" rx="4" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        <rect x="10" y="20" width="24" height="14" rx="2" fill={C.water} fillOpacity="0.5" />
      </g>);
    case 'dosing':
      return (<g>
        <rect x="13" y="12" width="18" height="22" rx="2" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        <path d="M22 5 l4 6 a4 4 0 1 1 -8 0 Z" fill={C.accent} />
        <circle className="uoi-drop" cx="22" cy="36" r="2.2" fill={C.accent2} />
      </g>);
    case 'uv':
      return (<g>
        <rect x="5" y="15" width="34" height="14" rx="3" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        <rect x="9" y="19" width="26" height="6" rx="3" fill={C.accent2} />
      </g>);
    case 'valve':
      return (<g>
        <path d="M8 12 L22 22 L8 32 Z" fill={C.panel2} stroke={C.steel} strokeWidth="2" strokeLinejoin="round" />
        <path d="M36 12 L22 22 L36 32 Z" fill={C.panel2} stroke={C.steel} strokeWidth="2" strokeLinejoin="round" />
      </g>);
    case 'screen':
      return (<g>
        <rect x="8" y="8" width="28" height="28" rx="3" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        {[13, 19.5, 26, 32.5].map(x => <line key={x} x1={x} y1="11" x2={x} y2="33" stroke={C.steel} strokeWidth="1.5" />)}
      </g>);
    case 'inlet':
      return (<g>
        <path d="M6 10 H38 V20 L26 32 H18 L6 20 Z" fill={C.panel2} stroke={C.steel} strokeWidth="2" strokeLinejoin="round" />
        <circle className="uoi-drop" cx="22" cy="37" r="3" fill={C.accent2} />
      </g>);
    case 'outlet':
      return (<g>
        <rect x="6" y="9" width="32" height="22" rx="3" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        <path d="M22 31 l7 -8 h-14 Z" fill={C.accent} />
      </g>);
    case 'opc':
      return (<g>
        <rect x="9" y="14" width="26" height="18" rx="3" fill={C.panel2} stroke={C.steel} strokeWidth="2" />
        <path d="M16 14 v-4 M28 14 v-4" stroke={C.steel} strokeWidth="2" strokeLinecap="round" />
        <circle cx="16" cy="9" r="2" fill={C.accent} />
        <circle cx="28" cy="9" r="2" fill={C.accent} />
        <path d="M15 23 h14 M15 27 h9" stroke={C.accent} strokeWidth="2" strokeLinecap="round" />
      </g>);
    default:
      return <rect x="8" y="9" width="28" height="26" rx="6" fill={C.panel2} stroke={C.steel} strokeWidth="2" />;
  }
}

const UnitOpIcon = memo(function UnitOpIcon({ opType, cat, size = 22, animated = false }) {
  const category = cat || iconCategory(opType);
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true"
      className={animated ? 'uoi-anim' : undefined}
      style={{ flexShrink: 0, display: 'block' }}>
      <Glyph cat={category} />
    </svg>
  );
});

export default UnitOpIcon;
