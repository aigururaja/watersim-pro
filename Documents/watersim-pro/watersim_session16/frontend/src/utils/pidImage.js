/**
 * Uploading a P&ID picture for AI reading — shared by the canvas (⋯ → Upload
 * P&ID picture) and the project page (Import from P&ID).
 *
 * The browser downsizes the picture before it is sent, and the stored
 * `placement` says where the drawing's layout lands on the sheet when the AI's
 * blocks are created (see CanvasPage's buildFromPid).
 */
import api from '../services/api';

const MAX_SIDE = 2400;          // longest side after downsizing, in pixels
const MAX_CHARS = 3.5e6;        // stay under the server's 4 MB cap
const DEFAULT_WIDTH = 1200;     // flow units the drawing's layout spans on the sheet

export const PID_ACCEPT = 'image/png,image/jpeg,image/webp';

/** Read a File, downsize it on a canvas, and return a data URL plus its size. */
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file could not be opened as an image.'));
      el.src = url;
    });
    for (const side of [MAX_SIDE, 1800, 1200]) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      // White under transparent PNGs, so the lines stay readable for the AI.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      let data = c.toDataURL('image/webp', 0.9);
      if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/jpeg', 0.9);
      if (data.length <= MAX_CHARS) return { imageData: data, width: w, height: h };
    }
    throw new Error('The image is too large even after shrinking it. Try a smaller file.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Downsize `file` and store it as the flowsheet's P&ID picture.
 * @returns {Promise<{fileName, width, height, placement}>} the stored picture
 */
export async function uploadPidPicture(projectId, flowsheetId, file) {
  const prepared = await prepareImage(file);
  const placement = { x: 0, y: 0, scale: DEFAULT_WIDTH / prepared.width };
  const { data } = await api.put(`/projects/${projectId}/flowsheets/${flowsheetId}/background`,
    { ...prepared, fileName: file.name, placement });
  return data;
}

/** The user-facing message for a failed request or upload. */
export const pidErrorText = (err) => err?.response?.data?.error
  || err?.response?.data?.details?.[0]?.msg
  || err?.message
  || 'Something went wrong';
