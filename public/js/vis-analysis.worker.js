// Module Worker for the Vis_Analyzer. Same convention as separator.worker.js:
// post 'ready' once the module graph has loaded, so the main thread can tell a
// startup failure (fall back to the main thread) from a failure during work.
//
// Request:  { id, wav: ArrayBuffer }
// Response: { type: 'result', id, env, onsets, duration }  (buffers transferred)
//           { type: 'stem-error', id, message }
import { decodeWav } from './wav.js';
import { analyzeStem } from './vis-analysis.js';

self.postMessage({ type: 'ready' });

self.onmessage = ({ data }) => {
  const id = data && data.id;
  try {
    const { channels, sampleRate } = decodeWav(data.wav);
    const r = analyzeStem(id, channels, sampleRate);
    const transfer = [r.env.buffer, ...(r.onsets ? [r.onsets.buffer] : [])];
    const msg = { type: 'result', id, env: r.env, onsets: r.onsets, duration: r.duration };
    if (r.marks) msg.marks = r.marks; // small arrays: copied, not transferred
    self.postMessage(msg, transfer);
  } catch (err) {
    self.postMessage({ type: 'stem-error', id, message: String((err && err.message) || err) });
  }
};
