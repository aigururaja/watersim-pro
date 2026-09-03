/**
 * WaterSim Pro — authenticated file downloads.
 *
 * Every export/download in the app goes through the unified axios client so
 * the Authorization header (and token refresh on 401) applies. A bare
 * <a href> cannot send the Bearer token and 401s.
 */
import api from '../services/api';

/** Extract a filename from a Content-Disposition header, or null. */
export function filenameFromDisposition(header) {
  if (!header) return null;
  // RFC 5987: filename*=UTF-8''encoded%20name.ext
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); }
    catch { /* fall through to the plain form */ }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

/**
 * Download a file from the API and trigger a browser save.
 *
 * @param {string} url                Path relative to the API base (e.g. `/reports/${id}/excel`).
 * @param {string} [filename]         Fallback name when the server sends no Content-Disposition.
 * @param {object} [options]
 * @param {string} [options.method]   HTTP method (default 'GET').
 * @param {object} [options.data]     Request body (for POST exports).
 * @returns {Promise<string>}         The filename used for the save.
 */
export async function downloadFile(url, filename, { method = 'GET', data } = {}) {
  const response = await api.request({ url, method, data, responseType: 'blob' });
  const cd = response.headers?.['content-disposition'] || '';
  const name = filenameFromDisposition(cd) || filename || 'download';

  const objectUrl = URL.createObjectURL(response.data);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
  return name;
}

export default downloadFile;
