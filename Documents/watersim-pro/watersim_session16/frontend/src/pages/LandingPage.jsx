/**
 * LandingPage — the public front door at "/": what SafeKrit is, its three
 * surfaces with real screens of the product, the reference plant, how an
 * alarm becomes work, who sees what, what it connects to, and the way in.
 *
 * "Log in" and "Register" open the forms in a popup (AuthDialog) rather than
 * leaving the page; /login and /register render this page with the popup
 * already open, so every old link and redirect still lands on the form.
 *
 * Images are screenshots of this very application (frontend/public/landing),
 * captured with every API response rewritten to a fictional organisation,
 * people and numbers, and without the plant's process layout: the page shows
 * the functionality, never a customer's plant or data.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Droplets, Monitor, Boxes, Wrench, Bell, LineChart, ClipboardList, Plug, MessageCircle, ShieldCheck, ArrowRight, Activity,
  Check, Gauge, ScrollText, Users, FileText, Cpu, Radio, Smartphone, Database, Download,
} from 'lucide-react';

/** The Android app: a Trusted Web Activity built from android/twa-manifest.json and published with the site. */
const APK = { href: '/downloads/safekrit.apk', version: '1.0.0', size: '1.2 MB' };
import { useAuth } from '../context/AuthContext';
import AuthDialog from '../components/auth/AuthDialog';

/** A product screenshot in a browser-like frame. */
function Shot({ src, alt, eager = false, className = '' }) {
  return (
    <figure className={`rounded-2xl bg-white border border-line shadow-float overflow-hidden ${className}`}>
      <div className="h-8 bg-ground border-b border-line flex items-center gap-1.5 px-3" aria-hidden="true">
        <span className="w-2.5 h-2.5 rounded-full bg-line" /><span className="w-2.5 h-2.5 rounded-full bg-line" /><span className="w-2.5 h-2.5 rounded-full bg-line" />
      </div>
      <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" className="block w-full h-auto" />
    </figure>
  );
}

const PROOF = [
  { value: '3', label: 'surfaces' },
  { value: '4', label: 'PLC protocols' },
  { value: '5', label: 'roles' },
  { value: '21', label: 'unit models' },
];

const SURFACES = [
  {
    icon: Monitor, key: 'ops', eyebrow: 'Surface A', title: 'Operations monitor & control',
    img: '/landing/trends.jpg', alt: 'The Trends page: historian series for selected instruments over the last hours, updating live, with export to CSV and Excel',
    blurb: 'The plant as it is wired. A photoreal SCADA mimic of every process area, alarms with acknowledgement, trends from the historian, control write-back for the roles allowed to act, and period reports.',
    points: [
      'A schematic of the whole plant and a mimic window per area, with levels, drives and valves moving on live data',
      'Alarm rules of five kinds: high, low, range, quality and drift; one open event per rule; a task policy per severity',
      'Every sample kept in the historian with minute and hour roll-ups; trends at any resolution; CSV and Excel exports',
      'Commands to the plant only for operators and above, with the PLC in live or shadow mode',
    ],
    to: '/live', cta: 'Live plant',
  },
  {
    icon: Boxes, key: 'twin', eyebrow: 'Surface B', title: 'Digital twin', reverse: true,
    img: '/landing/twin.jpg', alt: 'The Digital twin page: configuration, model-versus-measured residuals per instrument, and a what-if scenario from the live state',
    blurb: 'A model that runs beside the plant on the server, on a cadence you choose, and says where the two disagree.',
    points: [
      'Residuals per bound instrument, a z-score against recent history, and a drift alarm when the twin and the plant part ways',
      'What-if scenarios seeded from the live state, so a change is judged against what the plant is doing now',
      'Shadow mode and commissioning scripts written from the control narrative, played against a shadow plant before they touch the real one',
      'Import the monitored plant into a twin with one action; the twin keeps a link to its source flowsheet',
    ],
    to: '/twin', cta: 'Digital twin',
  },
  {
    icon: Wrench, key: 'maintenance', eyebrow: 'Surface C', title: 'Predictive maintenance',
    img: '/landing/tasks.jpg', alt: 'The Maintenance tasks board: open, assigned, in progress, awaiting approval and rejected columns',
    blurb: 'Alarms raise work, work goes through approval, and your CMMS gets the order and hands it back.',
    points: [
      'A task board with a state machine behind it: open, assigned, in progress, completed, approved or rejected, with one write path',
      'Run hours, starts and trips counted per drive from its status contacts, rolled up daily',
      'An asset and history API for the CMMS, with the plant’s ISA-5.1 tags as the shared language',
      'Signed webhooks (HMAC-SHA256, retried and dead-lettered) carry events out; work orders come back through the same boundary',
    ],
    to: '/tasks', cta: 'Task board',
  },
];

const FLOW = [
  { icon: Bell, title: 'A rule fires', text: 'A limit is breached or a PLC point goes quiet. One open alarm event per rule, with severity and the value that tripped it.' },
  { icon: MessageCircle, title: 'People are told', text: 'Email and WhatsApp reach the roles on the policy for that event and severity, with delivery receipts back from the provider.' },
  { icon: ClipboardList, title: 'Work is raised', text: 'Under the rule’s task policy a maintenance task appears on the board, assigned to a role or a person, with a due time.' },
  { icon: ShieldCheck, title: 'Work is approved', text: 'The assignee completes it, a manager approves or sends it back, and the audit trail keeps every step with who and when.' },
];

const ROLES = [
  { role: 'Viewer', text: 'The plant overview: what is running, what is alarming, the key readings. Looks, cannot act.' },
  { role: 'Operator', text: 'Alarms to acknowledge, drives to watch, the tasks on their desk, control write-back.' },
  { role: 'Engineer', text: 'The twin and its drift, PLC health, run hours and trips, projects and simulation runs.' },
  { role: 'Manager', text: 'Tasks waiting for approval, alarm load and time-to-acknowledge, the team, delivery of notifications.' },
  { role: 'Admin', text: 'Users and logins, API keys and webhooks, PLC connections, the audit trail and system health.' },
];

const CONNECT = [
  { icon: Plug, title: 'PLCs and SCADA', text: 'Modbus TCP, OPC UA, Siemens S7 and EtherNet/IP through a Python bridge, plus a built-in simulator for demonstrations and training.' },
  { icon: Gauge, title: 'ISA-5.1 tags', text: 'Every instrument, drive and signal carries an ISA-5.1 tag, validated on entry, so the mimic, the twin, the historian and the CMMS all speak the same names.' },
  { icon: MessageCircle, title: 'Email and WhatsApp', text: 'SMTP for email and the WhatsApp Business Cloud API for messages, with approved templates for alarms outside the reply window.' },
  { icon: Cpu, title: 'Your CMMS', text: 'API keys for reading assets and history, signed webhooks for events, and work orders posted back to the task board.' },
  { icon: FileText, title: 'Reports and exports', text: 'Period reports and simulation results as PDF and Excel, trends and alarm history as CSV.' },
  { icon: Database, title: 'One process, one file', text: 'The API, the WebSocket feed, the poller, the historian, the alarm sweep, the notification worker and the twin loop run in one service on a single database file.' },
];

export default function LandingPage({ dialog: initialDialog = null }) {
  const auth = useAuth();
  const isAuthenticated = !!auth?.isAuthenticated;
  const navigate = useNavigate();
  const location = useLocation();
  const [dialog, setDialog] = useState(initialDialog);

  useEffect(() => { setDialog(initialDialog); }, [initialDialog]);

  const open = (mode) => setDialog(mode);
  const close = () => {
    setDialog(null);
    // /login and /register open the popup on load; closing it must not reopen it on refresh.
    if (location.pathname !== '/') navigate('/', { replace: true });
  };

  const doors = (large = false) => (isAuthenticated ? (
    <Link to="/dashboard" className={`btn-primary ${large ? 'btn-lg' : ''}`}>Open dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" /></Link>
  ) : (
    <>
      <button type="button" onClick={() => open('login')} className={`btn-primary ${large ? 'btn-lg' : ''}`}>Log in</button>
      <button type="button" onClick={() => open('register')} className={`btn-secondary ${large ? 'btn-lg' : ''}`}>{large ? 'Register your organisation' : 'Register'}</button>
    </>
  ));

  return (
    <div className="min-h-[100dvh] bg-ground text-ink flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-ground/90 backdrop-blur border-b border-line/70">
        <div className="mx-auto max-w-[1200px] px-5 md:px-8 h-16 flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5 min-w-0" aria-label="SafeKrit home">
            <span className="w-9 h-9 rounded-xl bg-ink text-white flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <Droplets className="w-[18px] h-[18px]" />
            </span>
            <span className="font-extrabold text-lg tracking-tight">SafeKrit</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6 ml-8 text-sm font-medium text-ink-2" aria-label="Sections">
            <a href="#surfaces" className="hover:text-ink">Product</a>
            <a href="#flow" className="hover:text-ink">Alarm to action</a>
            <a href="#connect" className="hover:text-ink">Integrations</a>
          </nav>
          <nav className="ml-auto flex items-center gap-2" aria-label="Account">{doors()}</nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto max-w-[1200px] px-5 md:px-8 pt-12 pb-10 md:pt-20 md:pb-14">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-10 items-center">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold bg-white border border-line text-ink-2">
                <ShieldCheck className="w-3.5 h-3.5 text-accent" aria-hidden="true" /> Plant operations platform
              </span>
              <h1 className="mt-5 text-[40px] md:text-[56px] font-extrabold tracking-tight leading-[1.05]">SafeKrit</h1>
              <p className="mt-2 text-[22px] md:text-[26px] font-bold tracking-tight leading-tight">
                Run the plant you have. Model the plant you want.
              </p>
              <p className="mt-4 text-ink-3 text-[15px] md:text-[17px]">
                One product with three surfaces: a live operations monitor with alarms, trends and maintenance tasks;
                a digital twin that runs beside the plant and says where they disagree; and a predictive-maintenance
                boundary that hands work orders to your CMMS.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">{doors(true)}</div>
              <a href={APK.href} download className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-2 hover:text-ink">
                <Smartphone className="w-4 h-4" aria-hidden="true" /> Get the Android app
              </a>
              <dl className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-4" aria-label="At a glance">
                {PROOF.map((p) => (
                  <div key={p.label} className="rounded-2xl bg-white border border-line p-3">
                    <dt className="stat-label">{p.label}</dt>
                    <dd className="stat-value text-2xl mt-0.5">{p.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <Shot src="/landing/dashboard.jpg" alt="The SafeKrit administration dashboard: plant at a glance, approvals, team, integrations, notifications and PLC health" eager />
          </div>
        </section>

        {/* Surfaces */}
        <section id="surfaces" className="mx-auto max-w-[1200px] px-5 md:px-8 py-10 md:py-14" aria-label="What SafeKrit does">
          <div className="max-w-[720px] mb-8 md:mb-12">
            <div className="stat-label">Product</div>
            <h2 className="text-[28px] md:text-[36px] font-extrabold tracking-tight leading-tight mt-1">Three surfaces, one plant</h2>
            <p className="text-ink-3 mt-3">
              Monitoring projects are the plant as wired; twin projects are the models beside it. The same tags, the same
              people and roles, the same alarm and task history run through all three.
            </p>
          </div>
          <div className="space-y-10 md:space-y-16">
            {SURFACES.map((s) => (
              <article key={s.key} className={`grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center ${s.reverse ? 'lg:[&>*:first-child]:order-2' : ''}`} data-surface={s.key}>
                <div>
                  <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.12em] text-ink-3">
                    <span className="w-8 h-8 rounded-xl bg-ink text-white flex items-center justify-center" aria-hidden="true"><s.icon className="w-4 h-4" /></span>
                    {s.eyebrow}
                  </div>
                  <h2 className="text-[24px] md:text-[30px] font-extrabold tracking-tight leading-tight mt-3">{s.title}</h2>
                  <p className="text-ink-3 mt-3">{s.blurb}</p>
                  <ul className="mt-5 space-y-2.5" aria-label={`${s.title} highlights`}>
                    {s.points.map((p) => (
                      <li key={p} className="flex items-start gap-2.5 text-[14px]">
                        <span className="mt-0.5 w-5 h-5 rounded-full bg-accent-soft text-accent-ink flex items-center justify-center flex-shrink-0" aria-hidden="true"><Check className="w-3 h-3" /></span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                  {isAuthenticated && (
                    <Link to={s.to} className="mt-6 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink">{s.cta} <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" /></Link>
                  )}
                </div>
                <Shot src={s.img} alt={s.alt} />
              </article>
            ))}
          </div>
        </section>

        {/* Alarm to action */}
        <section id="flow" className="mx-auto max-w-[1200px] px-5 md:px-8 py-10 md:py-14" aria-label="From alarm to action">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center">
            <div>
              <div className="stat-label">From alarm to action</div>
              <h2 className="text-[28px] md:text-[36px] font-extrabold tracking-tight leading-tight mt-1">Every breach becomes work someone owns</h2>
              <ol className="mt-6 space-y-4">
                {FLOW.map((f, i) => (
                  <li key={f.title} className="flex items-start gap-4">
                    <span className="w-10 h-10 rounded-xl bg-ink text-white flex items-center justify-center flex-shrink-0" aria-hidden="true"><f.icon className="w-[18px] h-[18px]" /></span>
                    <div>
                      <div className="stat-label">Step {i + 1}</div>
                      <div className="font-semibold">{f.title}</div>
                      <p className="text-[13px] text-ink-3 mt-1">{f.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <Shot src="/landing/alarms.jpg" alt="The Alarms page: every limit breach across the flowsheets with severity, state, source, acknowledgement and the task raised for it" />
          </div>
        </section>

        {/* Roles + phone */}
        <section className="mx-auto max-w-[1200px] px-5 md:px-8 py-10 md:py-14" aria-label="Built for every role">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-8 lg:gap-12 items-start">
            <div>
              <div className="stat-label">Built for every role</div>
              <h2 className="text-[28px] md:text-[36px] font-extrabold tracking-tight leading-tight mt-1">A different home screen for each person</h2>
              <p className="text-ink-3 mt-3">
                Five roles, from viewer to administrator, and a named capability behind every action. The server decides
                what each role sees and the dashboard draws exactly that.
              </p>
              <ul className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Roles">
                {ROLES.map((r) => (
                  <li key={r.role} className="card p-4">
                    <div className="flex items-center gap-2 font-semibold"><Users className="w-4 h-4 text-ink-3" aria-hidden="true" /> {r.role}</div>
                    <p className="text-[13px] text-ink-3 mt-1.5">{r.text}</p>
                  </li>
                ))}
                <li className="card p-4 bg-ink text-white">
                  <div className="flex items-center gap-2 font-semibold"><ScrollText className="w-4 h-4 text-white/60" aria-hidden="true" /> Audit trail</div>
                  <p className="text-[13px] text-white/70 mt-1.5">Every sign-in, edit, acknowledgement and automated action, with who, when and from where.</p>
                </li>
              </ul>
            </div>
            <div className="flex flex-col items-center">
              <div className="w-[260px] rounded-[36px] bg-ink p-2.5 shadow-float">
                <img src="/landing/mobile-dashboard.jpg" alt="The operator console on a phone: plant at a glance, alarms and the tasks on the operator's desk, with a bottom navigation bar" loading="lazy" decoding="async" className="block w-full h-auto rounded-[28px]" />
              </div>
              <p className="mt-4 text-[13px] text-ink-3 text-center max-w-[300px] inline-flex items-start gap-2">
                <Smartphone className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                The same product on the plant floor: a bottom bar for the surface you are on, drawers for the rest.
              </p>
              <a href={APK.href} download className="btn-primary btn-lg mt-5" data-testid="apk-download">
                <Download className="w-4 h-4" aria-hidden="true" /> Download for Android
              </a>
              <p className="mt-2 text-[12px] text-ink-3 text-center max-w-[300px]">
                Version {APK.version} · {APK.size} · Android 5 or newer. Open the file to install; Android asks once to allow installs from your browser.
              </p>
            </div>
          </div>
        </section>

        {/* Integrations */}
        <section id="connect" className="mx-auto max-w-[1200px] px-5 md:px-8 py-10 md:py-14" aria-label="What it connects to">
          <div className="max-w-[720px] mb-8">
            <div className="stat-label">Integrations</div>
            <h2 className="text-[28px] md:text-[36px] font-extrabold tracking-tight leading-tight mt-1">Plugged into the plant and the people</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {CONNECT.map((c) => (
              <div key={c.title} className="card p-5">
                <span className="w-10 h-10 rounded-xl bg-ground text-ink flex items-center justify-center" aria-hidden="true"><c.icon className="w-5 h-5" /></span>
                <h3 className="font-semibold mt-3">{c.title}</h3>
                <p className="text-[13px] text-ink-3 mt-1">{c.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Administration shot + CTA */}
        <section className="mx-auto max-w-[1200px] px-5 md:px-8 py-10 md:py-14" aria-label="Administration">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center">
            <Shot src="/landing/admin.jpg" alt="The Admin page: team members with roles and WhatsApp numbers, organisation settings and the role permissions reference" />
            <div>
              <div className="stat-label">Administration</div>
              <h2 className="text-[24px] md:text-[30px] font-extrabold tracking-tight leading-tight mt-1">Set up in an afternoon</h2>
              <ul className="mt-5 space-y-2.5 text-[14px]">
                {[
                  'Invite the team, give each person a role and a WhatsApp number',
                  'Add a PLC connection, bind points to the plant’s tags, and watch the mimic come alive',
                  'Install the default notification policy for every role in one click',
                  'Hand your CMMS an API key and a webhook endpoint',
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <span className="mt-0.5 w-5 h-5 rounded-full bg-accent-soft text-accent-ink flex items-center justify-center flex-shrink-0" aria-hidden="true"><Check className="w-3 h-3" /></span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex items-center gap-2 text-[13px] text-ink-3">
                <Radio className="w-4 h-4 text-accent" aria-hidden="true" /> Live updates arrive over a WebSocket feed; nothing here needs a refresh.
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1200px] px-5 md:px-8 pb-14" aria-label="Get started">
          <div className="rounded-3xl bg-ink text-white p-8 md:p-12 flex flex-wrap items-center justify-between gap-6">
            <div className="max-w-[620px]">
              <h2 className="text-[26px] md:text-[32px] font-extrabold tracking-tight leading-tight">See your plant in SafeKrit</h2>
              <p className="text-white/70 mt-2">Register your organisation, invite the team, connect a PLC or start with the simulator.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {isAuthenticated ? (
                <Link to="/dashboard" className="btn-lg inline-flex items-center justify-center gap-2 rounded-2xl bg-white text-ink font-semibold px-5 hover:bg-ground">Open dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" /></Link>
              ) : (
                <>
                  <button type="button" onClick={() => open('register')} className="btn-lg inline-flex items-center justify-center gap-2 rounded-2xl bg-white text-ink font-semibold px-5 hover:bg-ground">Register your organisation</button>
                  <button type="button" onClick={() => open('login')} className="btn-lg inline-flex items-center justify-center gap-2 rounded-2xl bg-white/10 text-white font-semibold px-5 hover:bg-white/15 border border-white/20">Log in</button>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1200px] px-5 md:px-8 py-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3">
          <span className="font-semibold text-ink inline-flex items-center gap-2"><Droplets className="w-4 h-4" aria-hidden="true" /> SafeKrit</span>
          <span>Process simulation, live plant monitoring and maintenance.</span>
          <span className="inline-flex items-center gap-1"><LineChart className="w-3.5 h-3.5" aria-hidden="true" /> Operations · Twin · Maintenance</span>
          <span className="inline-flex items-center gap-1"><Activity className="w-3.5 h-3.5" aria-hidden="true" /> Modbus · OPC UA · S7 · EtherNet/IP</span>
          <span className="ml-auto">© {new Date().getFullYear()} SafeKrit</span>
        </div>
      </footer>

      {dialog && <AuthDialog mode={dialog} onClose={close} onModeChange={setDialog} />}
    </div>
  );
}
