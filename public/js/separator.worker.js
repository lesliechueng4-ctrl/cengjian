// Module worker: runs stem separation off the main thread and streams back WAV stems.
import { separateChannels } from './separator.js';
import { encodeWav } from './wav.js';

// Tells the page the module graph loaded, so later failures are real errors
// and not a reason to fall back to the main thread.
self.postMessage({ type: 'ready' });

self.onmessage = async ({ data }) => {
  const { channels, sampleRate } = data;
  try {
    let last = -1;
    const { bpm } = await separateChannels(channels, sampleRate, {
      onProgress: (p) => {
        const pct = Math.floor(p * 100);
        if (pct !== last) { last = pct; self.postMessage({ type: 'progress', value: p }); }
      },
      onStem: (id, chs) => {
        const wav = encodeWav(chs, sampleRate);
        self.postMessage({ type: 'stem', id, wav }, [wav]);
      },
    });
    self.postMessage({ type: 'done', bpm });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
