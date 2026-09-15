/**
 * LandingPage — the public front door at "/": what SafeKrit is, its three
 * surfaces, how it connects to a plant, and the way in. "Log in" and
 * "Register" open the forms in a popup (AuthDialog) rather than leaving the
 * page; /login and /register render this page with the popup already open,
 * so every old link and redirect still lands on the form.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Droplets, Monitor, Boxes, Wrench, Bell, LineChart, ClipboardList, Plug, MessageCircle, ShieldCheck, ArrowRight, Activity,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import AuthDialog from '../components/auth/AuthDialog';

const SURFACES = [
  {
    icon: Monitor, tile: 'tile-gradient-1', title: 'Operations monitor & control',
    blurb: 'The plant as wired: a live mimic of every area, alarms with acknowledgement, trends from the historian, control write-back and period reports.',
    points: ['Live plant screen', 'Alarms and trends', 'Maintenance tasks', 'Period reports'],
  },
  {
    icon: Boxes, tile: 'tile-gradient-2', title: 'Digital twin',
    blurb: 'A model that runs beside the plant on the server and says where they disagree: residuals, drift alarms, what-if scenarios and shadow commissioning.',
    points: ['Residuals and drift', 'What-if from live state', 'Shadow mode', 'Commissioning scripts'],
  },
  {
    icon: Wrench, tile: 'tile-gradient-3', title: 'Predictive maintenance',
    blurb: 'Run hours, starts and trips per drive, an asset and history API, and signed webhooks that hand work orders to your CMMS and take them back.',
    points: ['Asset register', 'Run-hour counters', 'Signed webhooks', 'CMMS round trip'],
  },
];

const STEPS = [
  { icon: Plug, title: 'Connect', text: 'Modbus TCP, OPC UA, Siemens S7 and EtherNet/IP, or the built-in simulator. Every point carries an ISA-5.1 tag.' },
  { icon: Activity, title: 'Watch', text: 'A photoreal SCADA mimic of each process area, with levels, drives and valves moving on live data.' },
  { icon: MessageCircle, title: 'Get told', text: 'Alarms and tasks reach the right role by email and WhatsApp, with delivery receipts and a policy per role.' },
  { icon: ClipboardList, title: 'Act', text: 'Alarms raise tasks, tasks go through approval, and the audit trail keeps every action.' },
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
          <nav className="ml-auto flex items-center gap-2" aria-label="Account">
            {isAuthenticated ? (
              <Link to="/dashboard" className="btn-primary">Open dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" /></Link>
            ) : (
              <>
                <button type="button" onClick={() => open('login')} className="btn-secondary">Log in</button>
                <button type="button" onClick={() => open('register')} className="btn-primary">Register</button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto max-w-[1200px] px-5 md:px-8 pt-14 pb-10 md:pt-24 md:pb-16">
          <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold bg-white border border-line text-ink-2">
            <ShieldCheck className="w-3.5 h-3.5 text-accent" aria-hidden="true" /> Plant operations platform
          </span>
          <h1 className="mt-5 text-[40px] md:text-[56px] font-extrabold tracking-tight leading-[1.05]">SafeKrit</h1>
          <p className="mt-2 text-[22px] md:text-[28px] font-bold tracking-tight text-ink leading-tight max-w-[720px]">
            Run the plant you have. Model the plant you want.
          </p>
          <p className="mt-4 text-ink-3 text-[15px] md:text-[17px] max-w-[680px]">
            One product with three surfaces: a live operations monitor with alarms, trends and maintenance tasks;
            a digital twin that runs beside the plant and says where they disagree; and a predictive-maintenance
            boundary that hands work orders to your CMMS.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {isAuthenticated ? (
              <Link to="/dashboard" className="btn-primary btn-lg">Open dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" /></Link>
            ) : (
              <>
                <button type="button" onClick={() => open('login')} className="btn-primary btn-lg">Log in</button>
                <button type="button" onClick={() => open('register')} className="btn-secondary btn-lg">Register your organisation</button>
              </>
            )}
          </div>
          <p className="mt-6 text-[13px] text-ink-3">
            Built around a real 675 KLD sequencing-batch sewage treatment plant: 11 process areas, 339 wired signals.
          </p>
        </section>

        {/* Surfaces */}
        <section className="mx-auto max-w-[1200px] px-5 md:px-8 pb-8" aria-label="What SafeKrit does">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {SURFACES.map((s) => (
              <article key={s.title} className="card overflow-hidden flex flex-col">
                <div className={`${s.tile} h-28 flex items-end p-4`}>
                  <span className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur text-white flex items-center justify-center" aria-hidden="true">
                    <s.icon className="w-5 h-5" />
                  </span>
                </div>
                <div className="p-5 flex-1 flex flex-col">
                  <h2 className="section-title">{s.title}</h2>
                  <p className="text-[13px] text-ink-3 mt-1.5">{s.blurb}</p>
                  <ul className="mt-4 flex flex-wrap gap-1.5" aria-label={`${s.title} highlights`}>
                    {s.points.map((p) => <li key={p} className="pill bg-ground text-ink-2 border border-line">{p}</li>)}
                  </ul>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="mx-auto max-w-[1200px] px-5 md:px-8 py-8" aria-label="How it works">
          <div className="card p-5 md:p-7">
            <div className="flex items-center justify-between gap-3 mb-5">
              <h2 className="section-title">How it works</h2>
              <span className="pill bg-accent-soft text-accent-ink">Four steps</span>
            </div>
            <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {STEPS.map((st, i) => (
                <li key={st.title} className="rounded-2xl bg-ground p-4">
                  <div className="flex items-center gap-3">
                    <span className="w-9 h-9 rounded-xl bg-ink text-white flex items-center justify-center flex-shrink-0" aria-hidden="true">
                      <st.icon className="w-4 h-4" />
                    </span>
                    <div>
                      <div className="stat-label">Step {i + 1}</div>
                      <div className="font-semibold">{st.title}</div>
                    </div>
                  </div>
                  <p className="text-[13px] text-ink-3 mt-3">{st.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Signals */}
        <section className="mx-auto max-w-[1200px] px-5 md:px-8 pb-14" aria-label="Alarms and notifications">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { icon: Bell, title: 'Alarms that reach people', text: 'High, low, range, quality and drift rules; one open event per rule; acknowledgement and a task policy per severity.' },
              { icon: LineChart, title: 'A historian that keeps everything', text: 'Raw samples with minute and hour roll-ups, auto-resolution trends, CSV and Excel exports and period reports.' },
              { icon: ClipboardList, title: 'Tasks with approval', text: 'Open, assigned, in progress, awaiting approval, approved or rejected: a state machine with one write path and a full audit trail.' },
            ].map((f) => (
              <div key={f.title} className="card p-5">
                <span className="w-10 h-10 rounded-xl bg-ground text-ink flex items-center justify-center" aria-hidden="true"><f.icon className="w-5 h-5" /></span>
                <h3 className="font-semibold mt-3">{f.title}</h3>
                <p className="text-[13px] text-ink-3 mt-1">{f.text}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1200px] px-5 md:px-8 py-6 flex flex-wrap items-center gap-3 text-[13px] text-ink-3">
          <span className="font-semibold text-ink">SafeKrit</span>
          <span>Process simulation, live plant monitoring and maintenance.</span>
          <span className="ml-auto">© {new Date().getFullYear()} SafeKrit</span>
        </div>
      </footer>

      {dialog && <AuthDialog mode={dialog} onClose={close} onModeChange={setDialog} />}
    </div>
  );
}
