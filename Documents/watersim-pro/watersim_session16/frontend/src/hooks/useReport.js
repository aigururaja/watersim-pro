/**
 * WaterSim Pro — useReport hook
 * Fetches structured report JSON for a completed simulation run.
 */
import { useState, useEffect } from 'react';
import api from '../services/api';
import { downloadFile } from '../utils/download';

export function useReport(projectId, flowsheetId, runId) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!projectId || !flowsheetId || !runId) return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    api.get(`/projects/${projectId}/flowsheets/${flowsheetId}/simulate/${runId}/report`)
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [projectId, flowsheetId, runId]);

  const downloadPdf = async () => {
    await downloadFile(
      `/projects/${projectId}/flowsheets/${flowsheetId}/simulate/${runId}/report/pdf`,
      'watersim_report.pdf',
    );
  };

  return { data, loading, error, downloadPdf };
}
