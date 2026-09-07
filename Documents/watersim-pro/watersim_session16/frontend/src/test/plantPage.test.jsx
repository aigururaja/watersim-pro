/**
 * PlantPage — the ITC plant definition and proposal review.
 *
 * The page's job is to show a person where a commercial proposal disagrees with
 * itself, so what is pinned here is exactly that: that a divergence is VISIBLE
 * (both numbers shown, not silently reconciled), that the high-severity count
 * reaches the user before they have to go looking, and that the tabs each render
 * their own payload without one tab's absent data breaking another.
 *
 * The fixtures are trimmed shapes of the real /plant responses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import PlantPage from '../pages/PlantPage';
import api from '../services/api';
import { downloadFile } from '../utils/download';

vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), request: vi.fn() };
  return { default: mock, api: mock };
});

vi.mock('../utils/download', () => ({
  downloadFile: vi.fn().mockResolvedValue('itc-stp-io-schedule.csv'),
  default: vi.fn(),
}));

vi.mock('../components/layout/AppLayout', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

// The "Open on the canvas" action navigates on success.
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig()),
  useNavigate: () => navigate,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLANT = {
  identity: {
    name: 'ITC — Sewage Treatment Plant',
    client: 'ITC', contractor: 'Safekrite', subContractor: 'Infercon Automation',
    designFlowKld: 675, processCount: 11,
    sourceDocument: 'Project Proposal v2 — Sewage Treatment Plant',
  },
  reuseCriteria: {
    name: 'Treated water for in-building reuse — TEMPLATE, to be confirmed',
    basis: 'The proposal states no limits of its own.',
    limits: { BOD: 10, TSS: 10, NH4: 5, TN: null, TP: null, pH_min: 6.5, pH_max: 8.5 },
  },
  processes: [
    {
      no: 4, id: 'sludge', name: 'Sludge Process', system: 'SHT dewatering train',
      area: 'SHT', deviceCount: 5,
      totals: {
        derived: { DI: 8, DO: 4, AI: 1, AO: 0 },
        printed: { DI: 8, DO: 4, AI: 1, AO: 0 },
        summary: { DI: 10, DO: 4, AI: 1, AO: 0 },
      },
    },
    {
      no: 2, id: 'reactor_feed', name: 'Reactor Feed Pump Process', system: 'RFP',
      area: 'RFP', deviceCount: 7,
      totals: {
        derived: { DI: 12, DO: 6, AI: 1, AO: 0 },
        printed: { DI: 8, DO: 6, AI: 1, AO: 0 },
        summary: { DI: 8, DO: 6, AI: 1, AO: 0 },
      },
    },
  ],
  io: {
    totals: { derived: { DI: 214, DO: 108, AI: 17, AO: 0 } },
    deviceCounts: { byFamily: { valves: 73 } },
    capacityHeadroom: [],
  },
  reviewSummary: { total: 27, bySeverity: { high: 11, medium: 16, low: 0 } },
};

const IO = {
  total: 2,
  rows: [
    {
      tag: 'ELP-XV-101/1.ZSO', type: 'DI', signal: 'Open limit switch',
      device: 'PP & SP inlet valves', area: 'ELP', processId: 'feed_water',
      node: 'Node 1 — MCC panel',
    },
    {
      tag: 'R-LT-301/1.LT', type: 'AI', signal: 'Level',
      device: 'R1 + R2 level transmitters', area: 'R', processId: 'reactor',
      node: 'Node 2 — Reactor',
    },
  ],
  capacityHeadroom: [
    { type: 'DI', capacity: 240, derived: 214, printed: 210, summary: 212, spareAgainstDerived: 26, utilisationPct: 89.2 },
    { type: 'DO', capacity: 160, derived: 108, printed: 116, summary: 116, spareAgainstDerived: 52, utilisationPct: 67.5 },
  ],
  nodeLoading: [
    { node: 'Node 1 — MCC panel', DI: 34, DO: 16, AI: 3, areas: ['ELP', 'RFP'] },
  ],
};

const NARRATIVE = {
  cycleAnalysis: {
    designFlow_m3_d: 675,
    sbr: {
      cycleHours: 5.25, cyclesPerDay: 4.57, reactors: 2, feedPump_m3_h: 43,
      fillHours: 1.5, volumePerFill_m3: 64.5, throughput_m3_d: 589.7,
      shortfall_m3_d: 85.3, meetsDesignFlow: false,
      requiredFillHours: 1.72, requiredFeedPump_m3_h: 49.2,
      phases: [
        { key: 'fill', label: 'Fill', hours: 1.5, sharePct: 28.6, source: 'Slide 22' },
        { key: 'aerate', label: 'Aeration', hours: 2, sharePct: 38.1, source: 'Slide 22' },
        { key: 'settle', label: 'Settle', hours: 1, sharePct: 19, source: 'Slide 22' },
        { key: 'decant', label: 'Decant', hours: 0.75, sharePct: 14.3, source: 'Slide 22' },
      ],
    },
    uf: { cycleMinutes: 21, cyclesPerDay: 68.6, produced_m3_d: 228.6, backwash_m3_d: 17.1, netToFwt_m3_d: 211.4, recoveryPct: 92.5, backwashReturnsTo: 'EQT' },
  },
  sections: [
    {
      id: 'reactor', numeral: 'II', title: 'Reactor process', slide: 22, totalHours: 5.25,
      steps: [
        {
          no: 1, text: 'Depend upon the level of INT-WT Reactor will ON.',
          action: 'check', devices: ['INT-LT-501'], durationH: 0,
          review: 'The reactor is fed from EQT, not INT-WT.',
        },
      ],
    },
  ],
};

const COSTING = {
  scenarios: [
    {
      optionId: 'option1', optionLabel: 'Option 1 — Siemens SCADA & Controller',
      valveOptionId: 'new_electrical', valveOptionLabel: 'New valve with electrical actuator',
      computedTotal: 5600880, quotedTotal: 5600880, variance: 0, quotedInProposal: true,
    },
    {
      optionId: 'option1', optionLabel: 'Option 1 — Siemens SCADA & Controller',
      valveOptionId: 'monitoring_only', valveOptionLabel: 'Monitoring only — no valve actuation',
      computedTotal: 2525000, quotedTotal: 2555000, variance: -30000, quotedInProposal: true,
    },
    {
      optionId: 'option2', optionLabel: 'Option 2 — IOT nodes & ICMES software',
      valveOptionId: 'new_pneumatic', valveOptionLabel: 'New valve with pneumatic actuator',
      computedTotal: 4910880, quotedTotal: null, variance: null, quotedInProposal: false,
    },
  ],
  pricedQuantities: { valves: 58, pumps: 26 },
  derivedQuantities: { valves: 73, pumps: 33 },
  addOns: [{ id: 'display', label: 'Display station', detail: '43-inch display', formatted: '₹1,50,000' }],
};

const REVIEW = {
  summary: { total: 2, bySeverity: { high: 1, medium: 1, low: 0 } },
  findings: [
    {
      id: 'qty.valves', severity: 'high', area: 'Commercial',
      title: 'Valves — 73 on the equipment list, 58 priced',
      derived: 73, stated: 58, source: 'Slides 4–15 against slide 16',
      impact: '15 devices appear in the process tables but are not in the monitoring or control price.',
    },
    {
      id: 'narrative.reactor.1', severity: 'medium', area: 'R',
      title: 'II.1 — Reactor process',
      derived: 'The reactor is fed from EQT, not INT-WT.',
      stated: 'Depend upon the level of INT-WT Reactor will ON.',
      source: 'Slide 22',
      impact: 'The sequence cannot be commissioned as written until this is resolved.',
    },
  ],
};

const DIAGRAM = {
  model: {
    generatedFrom: 'backend/src/plants/itcStp/flowsheet.js',
    blocks: [
      { id: 'eqt', tag: 'EQT', name: 'Equalisation tank' },
      { id: 'r1', tag: 'R1', name: 'Reactor 1' },
      { id: 'blowers', tag: 'B-301', name: 'Air blowers ×3' },
    ],
    streams: [{ no: 1 }, { no: 2 }, { no: 3 }],
    assumptions: [
      { tag: 'EQT', text: 'Working volume is not stated. 225 m³ is 8 h at the 675 KLD design flow.' },
    ],
    balanced: true,
  },
  streamTable: [
    { no: 1, from: 'EQT', to: 'RFP', service: 'Raw sewage', size: '100 mm', Q_m3_d: 714.1, TSS: 279.3, BOD: 280.7, TN: 41.3, TP: 9.33, pH: 7.36, inlineEquipment: 'RFP inlet valves (2)' },
    { no: 2, from: 'R1', to: 'INT-WT', service: 'Treated water', size: '80 mm', Q_m3_d: 288.2, TSS: 20, BOD: 1, TN: 33, TP: 8.2, pH: 7.3, inlineEquipment: '—' },
    { no: 3, from: 'B-301', to: 'R1', service: 'Process air', size: '125 mm', Q_m3_d: null, TSS: null, BOD: null, TN: null, TP: null, pH: null, inlineEquipment: '—' },
  ],
  mermaid: 'flowchart LR\n  eqt["EQT"]',
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>';

const ROUTES = {
  '/plant': PLANT,
  '/plant/io-schedule': IO,
  '/plant/narrative': NARRATIVE,
  '/plant/costing': COSTING,
  '/plant/review': REVIEW,
  '/plant/flow-diagram?detail=pfd': DIAGRAM,
  '/plant/flow-diagram.svg?detail=pfd': SVG,
  '/plant/flow-diagram?detail=full': DIAGRAM,
  '/plant/flow-diagram.svg?detail=full': SVG,
};

function renderPage() {
  return render(<MemoryRouter><PlantPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    const data = ROUTES[url];
    return data ? Promise.resolve({ data }) : Promise.reject(new Error(`no fixture for ${url}`));
  });
});

// ── Overview ─────────────────────────────────────────────────────────────────

describe('PlantPage overview', () => {
  it('names the plant and the three parties', async () => {
    renderPage();
    expect(await screen.findByText('ITC — Sewage Treatment Plant')).toBeInTheDocument();
    expect(screen.getByText(/ITC · Safekrite · Infercon Automation/)).toBeInTheDocument();
  });

  it('leads with the design flow and the wired signal count', async () => {
    renderPage();
    expect(await screen.findByText('675 KLD')).toBeInTheDocument();
    // 214 DI + 108 DO + 17 AI
    expect(screen.getByText('339')).toBeInTheDocument();
  });

  it('says plainly that the reuse criteria are a template, not a permit', async () => {
    renderPage();
    expect(await screen.findByText(/TEMPLATE, to be confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/The proposal states no effluent quality requirement/)).toBeInTheDocument();
  });

  it('SHOWS both numbers where a process disagrees, rather than picking one', async () => {
    renderPage();
    await screen.findByText('Reactor Feed Pump Process');
    // Derived 12 DI against 8 printed — the divergence must be on screen.
    expect(screen.getByText('vs 8', { exact: false })).toBeInTheDocument();
  });

  it('surfaces the high-severity count before the user goes looking', async () => {
    renderPage();
    const banner = await screen.findByRole('button', { name: /11 high-severity findings/ });
    expect(banner).toBeInTheDocument();
  });

  it('takes the user to the review when they click that banner', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /11 high-severity findings/ }));
    expect(await screen.findByText('Valves — 73 on the equipment list, 58 priced')).toBeInTheDocument();
  });
});

// ── Opening the plant on a canvas ────────────────────────────────────────────

describe('PlantPage open on the canvas', () => {
  it('creates the flowsheet and goes straight to it', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({
      data: { canvasUrl: '/projects/p1/flowsheets/f1', nodes: 55, edges: 60 },
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Open on the canvas/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/plant/instantiate'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/projects/p1/flowsheets/f1'));
  });

  it('explains a 403 in role terms rather than showing a raw error', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue({ response: { status: 403, data: { error: 'Forbidden' } } });
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Open on the canvas/ }));
    expect(await screen.findByText(/needs the engineer role/)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ── Flow diagram ─────────────────────────────────────────────────────────────

describe('PlantPage flow diagram', () => {
  const openFlow = async (user) => {
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Flow diagram/ }));
  };

  it('renders the sheet as an image, so the SVG can never execute', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    const img = await screen.findByRole('img', { name: /Process flow diagram/ });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    // No injected markup — the sheet arrives through an object URL, not innerHTML.
    expect(document.querySelector('svg[viewBox="0 0 100 50"]')).toBeNull();
  });

  it('says where the drawing came from', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    expect(await screen.findByText(/generated from backend\/src\/plants\/itcStp\/flowsheet\.js/)).toBeInTheDocument();
  });

  it('explains that valves and instruments are on the line, not the sheet', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    expect(await screen.findByText(/belong on the P&ID/)).toBeInTheDocument();
  });

  it('lists the blocks whose parameters are assumed, not stated', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    expect(await screen.findByText(/1 blocks carry an assumed parameter/)).toBeInTheDocument();
  });

  it('shows the stream table keyed to the numbers on the sheet', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    const row = (await screen.findByText('714.1')).closest('tr');
    expect(within(row).getByText('EQT')).toBeInTheDocument();
    expect(within(row).getByText('RFP')).toBeInTheDocument();
    expect(within(row).getByText('100 mm')).toBeInTheDocument();
    expect(within(row).getByText('RFP inlet valves (2)')).toBeInTheDocument();
  });

  it('leaves the air stream blank rather than inventing a flow for it', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    // "Process air" is also a filter option, so the row is found by its size.
    const row = (await screen.findByText('125 mm')).closest('tr');
    expect(within(row).getByText('Process air')).toBeInTheDocument();
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(6);
  });

  it('filters the stream table by service', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    expect(await screen.findByText('714.1')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter by service'), 'Process air');
    expect(screen.queryByText('714.1')).not.toBeInTheDocument();
    expect(screen.getByText('125 mm')).toBeInTheDocument();   // the air row survived
    expect(screen.queryByText('100 mm')).not.toBeInTheDocument(); // the raw row did not
  });

  it('refetches at full detail when the toggle is switched', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    await screen.findByRole('img', { name: /Process flow diagram/ });
    await user.click(screen.getByRole('button', { name: 'Full' }));
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/plant/flow-diagram?detail=full');
    });
  });

  it('downloads the sheet through the authenticated helper', async () => {
    const user = userEvent.setup();
    await openFlow(user);
    await user.click(await screen.findByRole('button', { name: /Download SVG/ }));
    await waitFor(() => {
      expect(downloadFile).toHaveBeenCalledWith(
        '/plant/flow-diagram.svg?detail=pfd&download=1',
        'itc-stp-process-flow-diagram.svg'
      );
    });
  });
});

// ── I/O schedule ─────────────────────────────────────────────────────────────

describe('PlantPage I/O schedule', () => {
  it('shows the four counts side by side with the spare capacity', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /I\/O schedule/ }));

    // "DI" appears in the filter dropdown and the node-loading card too, so the
    // row is found by the one cell unique to it — its spare-capacity figure.
    const row = (await screen.findByText('+26')).closest('tr');
    expect(within(row).getByText('DI')).toBeInTheDocument();
    expect(within(row).getByText('214')).toBeInTheDocument();  // devices need
    expect(within(row).getByText('210')).toBeInTheDocument();  // slides 4–14
    expect(within(row).getByText('212')).toBeInTheDocument();  // slide 15
    expect(within(row).getByText('240')).toBeInTheDocument();  // panel capacity
  });

  it('filters the tag list by signal type', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /I\/O schedule/ }));
    expect(await screen.findByText('ELP-XV-101/1.ZSO')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by signal type'), 'AI');
    expect(screen.queryByText('ELP-XV-101/1.ZSO')).not.toBeInTheDocument();
    expect(screen.getByText('R-LT-301/1.LT')).toBeInTheDocument();
  });

  it('exports the schedule through the authenticated download helper', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /I\/O schedule/ }));
    await user.click(await screen.findByRole('button', { name: /Export CSV/ }));
    await waitFor(() => {
      expect(downloadFile).toHaveBeenCalledWith('/plant/io-schedule.csv', 'itc-stp-io-schedule.csv');
    });
  });
});

// ── Sequences ────────────────────────────────────────────────────────────────

describe('PlantPage sequences', () => {
  it('reports the SBR shortfall against the design flow, and the two ways out', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Sequences/ }));

    expect(await screen.findByText('589.7 m³/d')).toBeInTheDocument();
    expect(screen.getByText(/Short by 85.3 m³\/d/)).toBeInTheDocument();
    expect(screen.getByText(/1.72 h/)).toBeInTheDocument();
    expect(screen.getByText(/49.2 m³\/hr/)).toBeInTheDocument();
  });

  it('keeps the proposal wording and shows the review note beside it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Sequences/ }));
    await user.click(await screen.findByText('Reactor process'));

    expect(screen.getByText('Depend upon the level of INT-WT Reactor will ON.')).toBeInTheDocument();
    expect(screen.getByText('The reactor is fed from EQT, not INT-WT.')).toBeInTheDocument();
  });
});

// ── Commercial ───────────────────────────────────────────────────────────────

describe('PlantPage commercial', () => {
  it('marks a total that reconciles and one that does not', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Commercial/ }));

    expect(await screen.findByText('reconciles')).toBeInTheDocument();
    expect(screen.getByText('₹25,25,000')).toBeInTheDocument();
    expect(screen.getByText('₹25,55,000')).toBeInTheDocument();
    expect(screen.getByText('-₹30,000')).toBeInTheDocument();
  });

  it('surfaces the option that was priced but never offered', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Commercial/ }));
    expect(await screen.findByText('Priced but never offered')).toBeInTheDocument();
    expect(screen.getByText('₹49,10,880')).toBeInTheDocument();
  });

  it('contrasts the device quantities listed against those priced', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Commercial/ }));
    expect(await screen.findByText('+15 unpriced')).toBeInTheDocument();
    expect(screen.getByText('+7 unpriced')).toBeInTheDocument();
  });
});

// ── Review ───────────────────────────────────────────────────────────────────

describe('PlantPage review', () => {
  it('shows what the app derived and what the proposal states, side by side', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Review/ }));

    const finding = (await screen.findByText('Valves — 73 on the equipment list, 58 priced')).closest('article');
    expect(within(finding).getByText('This app derives')).toBeInTheDocument();
    expect(within(finding).getByText('73')).toBeInTheDocument();
    expect(within(finding).getByText('The proposal states')).toBeInTheDocument();
    expect(within(finding).getByText('58')).toBeInTheDocument();
    expect(within(finding).getByText('Slides 4–15 against slide 16')).toBeInTheDocument();
  });

  it('filters findings by severity', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: /^High \(1\)$/ }));

    expect(screen.getByText('Valves — 73 on the equipment list, 58 priced')).toBeInTheDocument();
    expect(screen.queryByText('II.1 — Reactor process')).not.toBeInTheDocument();
  });
});

// ── Failure ──────────────────────────────────────────────────────────────────

describe('PlantPage failure', () => {
  it('offers a retry when the definition cannot be loaded', async () => {
    api.get.mockRejectedValue({ response: { data: { error: 'Service unavailable' } } });
    renderPage();
    expect(await screen.findByText('Could not load the plant definition')).toBeInTheDocument();
    expect(screen.getByText('Service unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});
