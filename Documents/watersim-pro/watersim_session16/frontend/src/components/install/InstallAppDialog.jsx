/**
 * InstallAppDialog — the landing page's "Install the SafeKrit app" popup.
 *
 * What it offers depends on where it is opened:
 *   - a browser that installs apps in one tap (Chrome, Edge; computers and
 *     Android): an Install button that opens the browser's own confirmation;
 *     on Android the app file is offered underneath as well;
 *   - Android without that: the Android app file and the three install steps;
 *   - iPhone and iPad: Safari's Share, then Add to Home Screen;
 *   - any other computer browser: use Chrome or Edge, or get the phone app.
 * Whatever is installed opens the app itself, never this landing page.
 */
import { useEffect, useState } from 'react';
import { X, Droplets, Download, Share, PlusSquare, Check, Smartphone, MonitorDown } from 'lucide-react';
import { useFocusTrap } from '../AccessibilityProvider';
import { APK, canPromptInstall, onInstallChange, platform as detectPlatform, promptInstall } from '../../utils/appMode';

function Steps({ items }) {
  return (
    <ol className="space-y-3" aria-label="Steps">
      {items.map((s, i) => (
        <li key={s.text} className="flex items-start gap-3">
          <span className="w-7 h-7 rounded-full bg-ink text-white text-[13px] font-bold flex items-center justify-center flex-shrink-0" aria-hidden="true">{i + 1}</span>
          <span className="text-[14px] pt-0.5 flex items-center gap-1.5 flex-wrap">{s.text}{s.icon && <s.icon className="w-4 h-4 text-ink-2" aria-hidden="true" />}</span>
        </li>
      ))}
    </ol>
  );
}

export default function InstallAppDialog({ onClose, onNotNow, platform: forcedPlatform }) {
  const trapRef = useFocusTrap(true);
  const [available, setAvailable] = useState(canPromptInstall);
  const [status, setStatus] = useState('idle'); // idle | installing | installed | declined
  const where = forcedPlatform || detectPlatform();

  useEffect(() => onInstallChange(() => setAvailable(canPromptInstall())), []);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') (onNotNow || onClose)?.(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [onClose, onNotNow]);

  const install = async () => {
    setStatus('installing');
    const outcome = await promptInstall();
    setStatus(outcome === 'accepted' ? 'installed' : outcome === 'dismissed' ? 'declined' : 'idle');
  };

  const apkLink = (primary) => (
    <a href={APK.href} download className={primary ? 'btn-primary btn-lg w-full' : 'inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-2 hover:text-ink'} data-testid="apk-download">
      <Download className="w-4 h-4" aria-hidden="true" /> {primary ? 'Download for Android' : 'Or download the Android app file'}
    </a>
  );

  let body;
  if (status === 'installed') {
    body = (
      <div className="rounded-2xl bg-ok-soft text-ok px-4 py-4 flex items-start gap-3" role="status">
        <Check className="w-5 h-5 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="text-[14px]">
          <div className="font-semibold">SafeKrit is installed</div>
          <div className="mt-0.5">{where === 'android' ? 'Open it from your home screen.' : 'Open it from your Start menu, Dock or desktop.'} It opens straight to sign-in.</div>
        </div>
      </div>
    );
  } else if (available) {
    body = (
      <>
        <button type="button" onClick={install} disabled={status === 'installing'} className="btn-primary btn-lg w-full" data-testid="install-app">
          {where === 'desktop' ? <MonitorDown className="w-4 h-4" aria-hidden="true" /> : <Smartphone className="w-4 h-4" aria-hidden="true" />}
          {status === 'installing' ? 'Installing…' : 'Install app'}
        </button>
        {status === 'declined' && <p className="text-[13px] text-ink-3 mt-3 text-center">Not installed. You can install it any time from this page.</p>}
        {where === 'android' && <div className="mt-4 text-center">{apkLink(false)}</div>}
      </>
    );
  } else if (where === 'android') {
    body = (
      <>
        {apkLink(true)}
        <p className="text-[12px] text-ink-3 mt-2 text-center">Version {APK.version} · {APK.size} · Android 5 or newer</p>
        <div className="mt-5">
          <Steps items={[
            { text: 'Open the downloaded file.' },
            { text: 'Allow installs from your browser when Android asks.' },
            { text: 'Tap Install, then Open.' },
          ]} />
        </div>
      </>
    );
  } else if (where === 'ios') {
    body = (
      <>
        <Steps items={[
          { text: 'In Safari, tap Share', icon: Share },
          { text: 'Choose Add to Home Screen', icon: PlusSquare },
          { text: 'Tap Add. SafeKrit appears on your home screen.' },
        ]} />
        <button type="button" onClick={onClose} className="btn-primary btn-lg w-full mt-6">Got it</button>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-[14px] text-ink-2">
          This browser does not install apps. Open this page in <b>Chrome</b> or <b>Edge</b> to install SafeKrit on this computer.
        </p>
        <div className="mt-5 rounded-2xl bg-ground p-4">
          <div className="stat-label">On an Android phone</div>
          <p className="text-[13px] text-ink-3 mt-1 mb-3">Open this site on the phone, or download the app file and move it across.</p>
          {apkLink(false)}
        </div>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Install the SafeKrit app" data-testid="install-dialog">
      <div className="absolute inset-0 bg-ink/40" onClick={onNotNow || onClose} aria-hidden="true" />
      <div ref={trapRef} className="relative w-full sm:max-w-[440px] bg-white rounded-t-3xl sm:rounded-3xl max-h-[92vh] flex flex-col shadow-float ws-page-enter">
        <div className="flex items-center justify-between px-6 pt-5 pb-1">
          <span className="w-12 h-12 rounded-2xl bg-ink text-white flex items-center justify-center" aria-hidden="true">
            <Droplets className="w-6 h-6" />
          </span>
          <button type="button" onClick={onNotNow || onClose} aria-label="Close"
            className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-ground text-ink hover:bg-line transition">
            <X className="w-[18px] h-[18px]" aria-hidden="true" />
          </button>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">
          <h2 className="text-[24px] font-extrabold tracking-tight leading-tight text-ink mt-3">Install the SafeKrit app</h2>
          <p className="text-ink-3 mt-1 mb-6">
            Alarms, tasks and the live plant from your {where === 'desktop' ? 'desktop' : 'home screen'}, full screen, without the browser. The app opens straight to sign-in.
          </p>
          {body}
          {status !== 'installed' && where !== 'ios' && (
            <button type="button" onClick={onNotNow || onClose} className="btn-ghost w-full mt-3">Not now</button>
          )}
          {status === 'installed' && <button type="button" onClick={onClose} className="btn-secondary w-full mt-4">Close</button>}
        </div>
      </div>
    </div>
  );
}
