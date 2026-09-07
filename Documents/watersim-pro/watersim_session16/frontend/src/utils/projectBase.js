/**
 * Projects live under two routes: `/projects` (Digital Twin) and
 * `/monitoring/projects` (Operations). The API is the same — `kind` on the
 * project says which it is — only the surface differs. Pages that move
 * between a project and its flowsheets keep the base the person arrived
 * through, so they stay on their surface.
 */
import { useLocation } from 'react-router-dom';

export const MONITORING_BASE = '/monitoring/projects';
export const TWIN_BASE = '/projects';

/** The projects base for a path: `/monitoring/projects/…` → monitoring, else twin. */
export const projectBase = (pathname = '') => (String(pathname).startsWith(MONITORING_BASE) ? MONITORING_BASE : TWIN_BASE);

/** The projects base a project of this kind is opened under. */
export const baseForKind = (kind) => (kind === 'monitoring' ? MONITORING_BASE : TWIN_BASE);

export function useProjectBase() {
  const { pathname } = useLocation();
  return projectBase(pathname);
}
