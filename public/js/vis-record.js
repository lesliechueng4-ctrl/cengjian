// Vis_Browser_Recording 的录制画布合成器（Requirement 14.3、14.4、14.5、14.7）。
// Video_Source：画面在上、Lane_Strip 在下的叠放版式（stem-lanes Requirement 13）。
// Audio_Only_Source：填 #0b0d14 背景，再以 'lighter' 叠加可视化（不变）。
// 所有全局对象都可注入；导入时不访问 DOM。

import { pickRecorderMime } from './export-client.js';
import { sceneAt as defaultSceneAt } from './vis-scene.js';
import { drawSceneToCanvas as defaultDrawSceneToCanvas } from './vis-canvas.js';
import { lanesAt as defaultLanesAt, stackedLayout, LANE_BACKGROUND } from './vis-lanes.js';

export const VIS_BACKGROUND = Object.freeze([11, 13, 20]); // #0b0d14
export const RECORD_BOX = Object.freeze([1280, 720]);
/** Video_Source 叠放版式的录制框：宽和总高都不超过 1280（stem-lanes Requirement 13.1）。 */
export const RECORD_STACK_BOX = 1280;
const RECORD_FPS = 30;

/**
 * 浏览器支持 HTMLCanvasElement.prototype.captureStream、MediaRecorder（pickRecorderMime 非 null）
 * 和 AudioContext / webkitAudioContext（14.5）。
 * @param {object} [env]
 * @returns {boolean}
 */
export function canBrowserVisRecord(env = globalThis) {
  if (!env) return false;
  const Canvas = env.HTMLCanvasElement;
  if (!Canvas || !Canvas.prototype || typeof Canvas.prototype.captureStream !== 'function') return false;
  if (typeof env.MediaRecorder !== 'function') return false;
  if (pickRecorderMime(env.MediaRecorder) === null) return false;
  return typeof env.AudioContext === 'function' || typeof env.webkitAudioContext === 'function';
}

const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/**
 * 把 vw×vh 按原宽高比放进 boxW×boxH（contain、居中）；vw、vh 无效时铺满整个框。
 * @returns {[number, number, number, number]}  [x, y, w, h]
 */
function containRect(vw, vh, boxW, boxH) {
  const w = Number(vw);
  const h = Number(vh);
  if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) return [0, 0, boxW, boxH];
  const k = Math.min(boxW / w, boxH / h);
  const dw = w * k;
  const dh = h * k;
  return [(boxW - dw) / 2, (boxH - dh) / 2, dw, dh];
}

/**
 * 录制画布。
 * Video_Source（stem-lanes Requirement 13）：画布为
 *   stackedLayout(videoWidth, videoHeight, 1280, 1280) 的 width × (pictureHeight + stripHeight)；
 *   每个动画帧：画面区域填黑、跑道区域填 LANE_BACKGROUND → drawImage(video) 按 contain 放进画面区域
 *   （抛错时保留黑色）→ save、translate(0, PH)、裁剪到跑道区域、
 *   drawSceneToCanvas(lanesAt(t, visData, { selected: stemId, width, height: SH, reducedMotion: false }),
 *   { clear: false })、restore。
 * Audio_Only_Source（stem-visualizer 14.3，不变）：1280×720，填 VIS_BACKGROUND 后叠加
 *   sceneAt(getTime(), visData, { selected: stemId, width, height, reducedMotion: false })。
 * stop()：停止动画帧、停止 stream 轨道、释放画布（14.7）。
 * @returns {{ canvas, stream: MediaStream, start(): void, stop(): void }}
 */
export function createVisCompositor({
  document = globalThis.document,
  video = null,
  visData,
  stemId,
  getTime,
  raf = (cb) => globalThis.requestAnimationFrame(cb),
  cancelRaf = (id) => globalThis.cancelAnimationFrame(id),
  sceneAt = defaultSceneAt,
  lanesAt = defaultLanesAt,
  drawSceneToCanvas = defaultDrawSceneToCanvas,
} = {}) {
  const stack = video
    ? stackedLayout(video.videoWidth, video.videoHeight, RECORD_STACK_BOX, RECORD_STACK_BOX)
    : null;
  const width = stack ? stack.width : RECORD_BOX[0];
  const height = stack ? stack.pictureHeight + stack.stripHeight : RECORD_BOX[1];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(RECORD_FPS);
  const bg = rgb(VIS_BACKGROUND);
  const laneBg = rgb(LANE_BACKGROUND);

  let rafId = null;
  let running = false;
  let stopped = false;

  function currentTime() {
    const t = Number(getTime ? getTime() : 0);
    return Number.isFinite(t) ? t : 0;
  }

  function drawStacked() {
    const PH = stack.pictureHeight;
    const SH = stack.stripHeight;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, PH);
    ctx.fillStyle = laneBg;
    ctx.fillRect(0, PH, width, SH);
    try {
      const [x, y, w, h] = containRect(video.videoWidth, video.videoHeight, width, PH);
      ctx.drawImage(video, x, y, w, h);
    } catch {
      // 画面尚未就绪：保留黑色
    }
    const shapes = lanesAt(currentTime(), visData, {
      selected: stemId,
      width,
      height: SH,
      reducedMotion: false,
    });
    ctx.save();
    try {
      ctx.translate(0, PH);
      ctx.beginPath();
      ctx.rect(0, 0, width, SH);
      ctx.clip();
      drawSceneToCanvas(ctx, shapes, { background: LANE_BACKGROUND, clear: false });
    } finally {
      ctx.restore();
    }
  }

  function drawAudioOnly() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    const shapes = sceneAt(currentTime(), visData, {
      selected: stemId,
      width,
      height,
      reducedMotion: false,
    });
    drawSceneToCanvas(ctx, shapes, { background: VIS_BACKGROUND, clear: false });
  }

  function drawFrame() {
    if (stack) drawStacked();
    else drawAudioOnly();
  }

  function frame() {
    rafId = null;
    if (!running) return;
    drawFrame();
    if (running) rafId = raf(frame);
  }

  function start() {
    if (running || stopped) return;
    running = true;
    drawFrame(); // 首帧立即可用，录制开头不是空白
    rafId = raf(frame);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    running = false;
    if (rafId !== null) {
      cancelRaf(rafId);
      rafId = null;
    }
    const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // 忽略
      }
    }
    canvas.width = 0;
    canvas.height = 0;
  }

  return { canvas, stream, start, stop };
}
