/**
 * WaterSim Pro — useReport hook
 * Fetches structured report JSON for a completed simulation run.
 */
import { useState, useEffect } from 'react';
import api from '../services/api';

export function useReport(projectId, flowsheetId, runId) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!projectId || !flowsheetId || !runId) return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    api.get(`/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate/${runId}/report`)
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [projectId, flowsheetId, runId]);

  const downloadPdf = async () => {
    const url = `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate/${runId}/report/pdf`;
    const token = sessionStorage.getItem('accessToken');
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`PDF download failed: ${resp.status}`);
    const blob   = await resp.blob();
    const link   = document.createElement('a');
    link.href    = URL.createObjectURL(blob);
    const cd     = resp.headers.get('Content-Disposition') || '';
    const m      = cd.match(/filename="([^"]+)"/);
    link.download = m ? m[1] : `watersim_report.pdf`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return { data, loading, error, downloadPdf };
}
