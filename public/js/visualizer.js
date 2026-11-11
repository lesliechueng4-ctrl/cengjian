// Live_Visualizer：在练习室的 Vis_Canvas 上按 Player 的 currentTime 实时绘制可视化（Requirement 5、8）。
// 只在 requestAnimationFrame 回调中绘制；播放时每帧绘制并续订，暂停时只在 key 变化时绘制一次。
// 所有全局对象（raf、document、matchMedia、devicePixelRatio）都可注入，导入时不访问任何全局对象，
// 因此可以在没有 DOM 的 Node 中导入和测试。
import { sceneAt as defaultSceneAt } from './vis-scene.js';
import { drawSceneToCanvas as defaultDrawSceneToCanvas } from './vis-canvas.js';

export const VIS_BACKGROUND = Object.freeze([11, 13, 20]); // #0b0d14
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** 设备像素比限制在 [1, 2]（8.4）；非有限 dpr 按 1。 */
export function canvasPixelSize(cssWidth, cssHeight, dpr) {
  const r = Math.min(2, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  const w = Number.isFinite(cssWidth) ? cssWidth : 0;
  const h = Number.isFinite(cssHeight) ? cssHeight : 0;
  return { width: Math.max(1, Math.round(w * r)), height: Math.max(1, Math.round(h * r)) };
}

/** 开关设置（stem-lanes requirements 6.1、6.2）：非布尔值用默认值（visVideo = true、visAudio = true）。 */
export function readVisSettings(s) {
  const obj = s !== null && typeof s === 'object' ? s : null;
  return {
    visVideo: typeof obj?.visVideo === 'boolean' ? obj.visVideo : true,
    visAudio: typeof obj?.visAudio === 'boolean' ? obj.visAudio : true,
  };
}

/**
 * 调度模型（5.2、5.3、8.1–8.3），纯函数：
 * - !enabled || !visible || !hasData → { draw: false, schedule: false }
 * - playing → { draw: true, schedule: true }
 * - 暂停：key 与上次绘制不同 → { draw: true, schedule: false }；否则 { draw: false, schedule: false }
 */
export function visFrameAction({ enabled, visible, hasData, playing, key, lastKey } = {}) {
  if (!enabled || !visible || !hasData) return { draw: false, schedule: false };
  if (playing) return { draw: true, schedule: true };
  if (key !== lastKey) return { draw: true, schedule: false };
  return { draw: false, schedule: false };
}

/** key = `${t.toFixed(3)}|${selected}|${width}x${height}|${reducedMotion}|${dataId}` */
export function visFrameKey({ t, selected, width, height, reducedMotion, dataId }) {
  const tt = Number.isFinite(t) ? t : 0;
  return `${tt.toFixed(3)}|${selected}|${width}x${height}|${!!reducedMotion}|${dataId}`;
}

function globalFn(name) {
  const fn = typeof globalThis !== 'undefined' ? globalThis[name] : undefined;
  return typeof fn === 'function' ? fn.bind(globalThis) : null;
}

/**
 * @param {{ canvas, getTime: () => number, isPlaying: () => boolean, getSelected: () => string,
 *           getVisData: () => object|null, isEnabled: () => boolean,
 *           isTransparent?: () => boolean, background?: [number, number, number],
 *           raf?, caf?, document?, matchMedia?, devicePixelRatio?: () => number,
 *           sceneAt?, drawSceneToCanvas? }} opts
 *   isTransparent：true（默认）时清空画布后绘制（Video_Source 叠加层）；
 *   false 时先填 background（默认 #0b0d14，Audio_Only_Source 封面替换）。
 * @returns {{ invalidate(): void, destroy(): void }}
 */
export function createLiveVisualizer(opts = {}) {
  const {
    canvas,
    getTime = () => 0,
    isPlaying = () => false,
    getSelected = () => 'original',
    getVisData = () => null,
    isEnabled = () => true,
    isTransparent = () => true,
    background = VIS_BACKGROUND,
  } = opts;
  const raf = opts.raf ?? globalFn('requestAnimationFrame');
  const caf = opts.caf ?? (opts.raf ? null : globalFn('cancelAnimationFrame'));
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
  const matchMedia = opts.matchMedia ?? globalFn('matchMedia');
  const getDpr = opts.devicePixelRatio
    ?? (() => (typeof globalThis !== 'undefined' ? Number(globalThis.devicePixelRatio) : 1));
  const scene = opts.sceneAt ?? defaultSceneAt;
  const draw = opts.drawSceneToCanvas ?? defaultDrawSceneToCanvas;

  // Vis_Data 对象 → 自增 id，新对象一定重绘。
  const dataIds = new WeakMap();
  let nextDataId = 1;
  function dataIdOf(data) {
    let id = dataIds.get(data);
    if (id === undefined) { id = nextDataId++; dataIds.set(data, id); }
    return id;
  }

  let mql = null;
  try { mql = matchMedia ? matchMedia(REDUCED_MOTION_QUERY) : null; } catch { mql = null; }

  let pending = false;
  let handle = null;
  let lastKey = null;
  let ctx = null;
  let destroyed = false;

  function isVisible() {
    if (!doc || doc.visibilityState === undefined) return true;
    return doc.visibilityState === 'visible';
  }

  function context() {
    if (!ctx && canvas && typeof canvas.getContext === 'function') ctx = canvas.getContext('2d');
    return ctx;
  }

  function frame() {
    pending = false;
    handle = null;
    if (destroyed) return;

    const enabled = !!isEnabled();
    const visible = isVisible();
    const data = getVisData();
    const hasData = !!data;
    if (!enabled || !hasData) lastKey = null; // 重新打开或数据重新出现时一定重绘

    let width = 1;
    let height = 1;
    if (canvas) {
      const size = canvasPixelSize(Number(canvas.clientWidth), Number(canvas.clientHeight), Number(getDpr()));
      width = size.width;
      height = size.height;
    }
    const t = Number(getTime());
    const time = Number.isFinite(t) ? t : 0;
    const selected = getSelected();
    const reducedMotion = !!mql?.matches;
    const transparent = isTransparent() !== false;
    const key = hasData
      ? `${visFrameKey({ t: time, selected, width, height, reducedMotion, dataId: dataIdOf(data) })}|${transparent}`
      : null;

    const action = visFrameAction({ enabled, visible, hasData, playing: !!isPlaying(), key, lastKey });
    if (action.draw) {
      if (canvas) {
        // 只在尺寸变化时改写（改写会清空画布）。
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      }
      const c = context();
      if (c) {
        const shapes = scene(time, data, { selected, width, height, reducedMotion });
        draw(c, shapes, { transparent, background });
      }
      lastKey = key;
    }
    if (action.schedule) invalidate();
  }

  function invalidate() {
    if (destroyed || pending || !raf) return;
    pending = true;
    handle = raf(frame);
  }

  function onVisibility() {
    if (isVisible()) invalidate();
  }
  function onReducedMotion() {
    invalidate();
  }

  doc?.addEventListener?.('visibilitychange', onVisibility);
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onReducedMotion);
    else if (typeof mql.addListener === 'function') mql.addListener(onReducedMotion);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (pending && caf && handle != null) caf(handle);
    pending = false;
    handle = null;
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    if (mql) {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onReducedMotion);
      else if (typeof mql.removeListener === 'function') mql.removeListener(onReducedMotion);
    }
  }

  return { invalidate, destroy };
}
