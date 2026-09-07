// Vitest global test setup — registers jest-dom matchers (toBeInTheDocument, …)
import '@testing-library/jest-dom/vitest';

// ── Object URLs ──────────────────────────────────────────────────────────────
// jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL`, so any
// component that hands a Blob to an <img> or an <a download> throws in tests
// while working perfectly in every browser. PlantPage's flow diagram renders the
// generated SVG sheet through exactly that route — deliberately, because an
// <img> cannot execute script the way injected markup could.
//
// The stub is counted rather than silent: `url` is a real blob: URL so `src`
// assertions are meaningful, and revoked handles are tracked so a test can
// assert the cleanup actually ran.
let objectUrlSeq = 0;
const liveObjectUrls = new Set();

if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => {
    objectUrlSeq += 1;
    const url = `blob:vitest/${objectUrlSeq}`;
    liveObjectUrls.add(url);
    return url;
  };
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = (url) => { liveObjectUrls.delete(url); };
}

/** Object URLs created and not yet revoked — a leak check for tests that want it. */
export const outstandingObjectUrls = () => [...liveObjectUrls];
