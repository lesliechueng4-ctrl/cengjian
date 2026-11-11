# Implementation Plan: 音轨可视化（stem-visualizer）

## Overview

按 design.md 实现：先写同构的数据模块 `vis-data.js` 和分析模块 `vis-analysis.js`，再写 Scene_Function `vis-scene.js`、Software_Rasterizer `vis-raster.js` 和 Canvas_Backend `vis-canvas.js`；然后是浏览器端的计算编排（Worker + `vis-compute.js`）和 Live_Visualizer `visualizer.js`。Server 端在 `export-service.js` 中加入可视化参数、三段分帧和 Vis_Export_Job（逐帧渲染 + `rgb24` 写入 FFmpeg 标准输入），Fake_FFmpeg 增加读帧。浏览器导出在 `export-client.js` 上加可选参数，`vis-record.js` 提供录制画布合成器；最后在 `index.html` / `style.css` / `app.js` 接上画布、开关、设置和导出选项，并更新 README。

语言为 JavaScript（ES 模块）：浏览器零依赖，Server 只用 Node ≥ 18 内置模块。测试命令 `node --test tests/*.test.mjs`，属性测试用 `tests/helpers/prop.mjs`，每个属性至少 100 轮，注释格式 `// Feature: stem-visualizer, Property N: <标题>`。

采用的取值（见 requirements.md「取值」与「假设」）：Envelope 100 Hz、`Uint8Array`；Onset_Stem 为 drums / perc / fx / other，最小间隔 5 帧；Vis_Payload ≤ 16 MB、时长 ≤ 3600 秒；Max_Shapes 400；Server 渲染 30 fps、内部分辨率放进 640×360，Overlay 输出放进 1920×1080，Standalone 输出 1280×720、背景 `#0b0d14`；性能目标平均每帧 < 33 ms（`BENCH_PERF=1`）。

## Tasks

- [x] 1. 可视化数据模型与分析
  - [x] 1.1 新建 `public/js/vis-data.js`
    - 常量 `VIS_VERSION`、`VIS_FRAME_RATE`、`VIS_STEM_IDS`、`ONSET_STEM_IDS`、`ALL_STEM_IDS`、`VIS_MAX_DURATION`、`VIS_MAX_BYTES`、`ONSET_MIN_GAP_FRAMES`
    - `createVisData`（frames 取最大值、短 env 末尾补 0、缺失 Stem 不出现）、`envelopeAt`（帧间线性插值、越界为 0）、`envelopeMean`（300 ms 滑动平均）、`recentOnsets`（只返回 `[0, duration]` 内、由近到远、最多 limit 个）
    - `bytesToBase64` / `base64ToBytes`（模块内置，不用 `Buffer` / `btoa`）、`encodeVisPayload`、`decodeVisPayload`（design 第 1 节的全部严格校验，字节输入用 `TextDecoder` fatal 模式）、`VisPayloadError`
    - 只用 ECMAScript 内置对象和 `TextDecoder`，无 `import`、无导入副作用
    - _Requirements: 2.5, 3.10, 3.12, 10.5, 10.9, 12.4_
  - [x] 1.2 新建 `public/js/vis-analysis.js`
    - `frameRms`（帧边界 `floor(i·sr/100)`，帧数 `ceil(n·100/sr)`）、`envelopeFromRms`（`round(255·sqrt(rms/max))`，`max < 1e-4` 全 0）
    - `detectOnsets`（dB 跃升 ≥ 6 dB 相对前 5 帧平均、门限 5% 最大 RMS、±2 帧局部最大并列取最早、最小间隔 5 帧、静音返回空）
    - `analyzeStem(id, channels, sampleRate)` → `{ env, onsets（仅 Onset_Stem）, duration }`
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7_
  - [x]* 1.3 编写 Envelope 模型属性测试（`tests/vis-analysis.test.mjs`）
    - **Property 1: Envelope 模型**
    - **Validates: Requirements 1.3, 1.4, 1.7, 2.5**
  - [x]* 1.4 编写 Envelope 缩放不变属性测试（追加到 `tests/vis-analysis.test.mjs`）
    - **Property 2: Envelope 缩放不变**
    - **Validates: Requirements 1.4**
  - [x]* 1.5 编写 Onset 不变式属性测试（追加到 `tests/vis-analysis.test.mjs`）
    - **Property 3: Onset 不变式**
    - **Validates: Requirements 1.5, 1.4**
  - [x]* 1.6 编写 Onset 定位属性测试（追加到 `tests/vis-analysis.test.mjs`）
    - **Property 4: Onset 定位**（跃升间隔 ≥ 150 ms，种子噪声 × 30 ms 指数衰减，误差 ≤ 20 ms）
    - **Validates: Requirements 1.6**
  - [x]* 1.7 编写 Vis_Payload 往返与校验属性测试（`tests/vis-data.test.mjs`）
    - **Property 5: Vis_Payload 往返与校验**
    - **Validates: Requirements 10.5, 10.9**
    - 另加示例：`bytesToBase64` 与 Node `Buffer.toString('base64')` 结果一致；`createVisData` 补齐不同长度的 env
  - [x]* 1.8 编写 Envelope 插值属性测试（追加到 `tests/vis-data.test.mjs`）
    - **Property 6: Envelope 插值**
    - **Validates: Requirements 3.10, 3.12**
  - [x] 1.9 新建 `public/js/vis-analysis.worker.js` 和 `public/js/vis-compute.js`
    - Worker：加载后先发 `ready`；收到 `{ id, wav }` 后 `decodeWav` + `analyzeStem`，以转移方式回传 `result`，失败回 `stem-error`
    - `computeVisData(urls, { signal, fetch, createWorker, yieldFn, decodeWav, analyzeStem })`：按 `VIS_STEM_IDS` 顺序逐条读取并分析（一次一条）；Worker 构造失败或 `ready` 前出错 → 主线程逐条分析并在每条之间 `await yieldFn()`；单条失败跳过；全部失败抛 `可视化数据生成失败`；中止时 `terminate()` 并抛 AbortError；不修改、不回收 `urls`
    - _Requirements: 1.1, 1.8, 1.9, 1.10, 2.3, 2.6, 2.8_

- [x] 2. Scene_Function 与两个绘制后端
  - [x] 2.1 新建 `public/js/vis-scene.js`
    - `MAX_SHAPES`、`LAYER_COLORS`、`EMPHASIS`、`REDUCED_ALPHA_MAX`、`emphasisFor`、`hash01`
    - `sceneAt(t, visData, { selected, width, height, reducedMotion })`：按 design 第 5 节表格实现 8 种 Layer_Style（inst 背景辉光、drums 光晕圆环、perc 火花、bass 底部光带、vocal 波形、harmony 色斑、fx / other 粒子）和 Reduced_Motion 版本；透明度乘亮度系数、尺寸字段乘尺寸系数；`alpha` 夹到 [0, 1]；末尾按 `MAX_SHAPES` 截断
    - 只导入 `./vis-data.js`，不读任何全局状态
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.11, 3.12, 4.1, 4.2, 4.4, 7.1, 7.2, 12.4_
  - [x]* 2.2 编写场景确定性属性测试（`tests/vis-scene.test.mjs`）
    - **Property 7: 场景确定性**
    - **Validates: Requirements 3.9, 5.1, 5.4, 5.5**
  - [x]* 2.3 编写场景输出界限属性测试（追加到 `tests/vis-scene.test.mjs`）
    - **Property 8: 场景输出界限**
    - **Validates: Requirements 3.11, 3.12**
  - [x]* 2.4 编写每条 Stem 一层属性测试（追加到 `tests/vis-scene.test.mjs`）
    - **Property 9: 每条 Stem 一层**
    - **Validates: Requirements 3.1**
  - [x]* 2.5 编写 Onset 窗口图形属性测试（追加到 `tests/vis-scene.test.mjs`）
    - **Property 10: Onset 窗口图形**
    - **Validates: Requirements 3.2, 3.3, 3.7**
  - [x]* 2.6 编写随包络单调属性测试（追加到 `tests/vis-scene.test.mjs`）
    - **Property 11: 随包络单调**
    - **Validates: Requirements 3.4, 3.5, 3.6, 3.8**
  - [x]* 2.7 编写选中音轨强调属性测试（追加到 `tests/vis-scene.test.mjs`）
    - **Property 12: 选中音轨强调**
    - **Validates: Requirements 4.1, 4.2, 4.4**
  - [x]* 2.8 编写减少动态效果属性测试（追加到 `tests/vis-scene.test.mjs`）
    - **Property 13: 减少动态效果**
    - **Validates: Requirements 7.1, 7.2**
    - 另加示例：每种 Layer_Style 在典型时刻的 Shape 数量、`kind` 和 `layer`
  - [x] 2.9 新建 `public/js/vis-raster.js`
    - `createRasterizer(width, height)`：创建时分配一次 `Float32Array` 累加缓冲和 `Uint8Array(frameBytes)` 输出缓冲
    - `render(shapes, background, out?)`：填背景 → 每个 Shape 只遍历外接框与画面的交集 → 按 `cov(d)` 累加 `color × alpha × cov` → 取整并限制到 0–255 写入 `out`
    - 实现 `disc`、`ring`、`wave`（竖直距离）、`rect`（盒 SDF）四种距离函数；无 `import`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_
  - [x]* 2.10 编写光栅化背景、单调与范围属性测试（`tests/vis-raster.test.mjs`）
    - **Property 25: 光栅化背景、单调与范围**
    - **Validates: Requirements 12.1, 12.3**
  - [x]* 2.11 编写光栅化确定性与顺序无关属性测试（追加到 `tests/vis-raster.test.mjs`）
    - **Property 26: 光栅化确定性与顺序无关**
    - **Validates: Requirements 12.2, 12.5**
    - 另加示例：单个 `disc` 中心像素等于背景 + color × alpha，外接框之外不变
  - [x] 2.12 新建 `public/js/vis-canvas.js`
    - `drawSceneToCanvas(ctx, shapes, { background, transparent })`：背景填充或清空；`globalCompositeOperation = 'lighter'`；`disc` / `ring` 用径向渐变、`wave` 两次描边、`rect` 竖直线性渐变；结束时恢复合成模式
    - _Requirements: 12.6_
  - [x]* 2.13 编写 Canvas_Backend 示例与同构冒烟测试（`tests/vis-canvas.test.mjs`）
    - 用记录调用的假 ctx 检查 `'lighter'`、四种 Shape 的绘制调用和合成模式恢复
    - 读取 `vis-data.js`、`vis-scene.js`、`vis-raster.js` 源码：只有 `./` 相对导入，不出现 `window`、`document`、`self`、`process`、`require`
    - _Requirements: 12.4, 12.6, 15.5_

- [x] 3. Live_Visualizer
  - [x] 3.1 新建 `public/js/visualizer.js`
    - `canvasPixelSize`（dpr 限制在 [1, 2]）、`readVisSettings`（`visVideo` 默认 false、`visAudio` 默认 true）、`visFrameAction`（调度模型）
    - `createLiveVisualizer({ canvas, getTime, isPlaying, getSelected, getVisData, isEnabled, raf, document, matchMedia, devicePixelRatio, sceneAt, drawSceneToCanvas })` → `{ invalidate, destroy }`：至多一个挂起的动画帧；只在 `raf` 回调中绘制；播放时每帧绘制并续订，暂停时只在 key 变化时绘制；隐藏、关闭或无数据时不绘制不续订；监听 `visibilitychange` 和 `prefers-reduced-motion` 的 `change`；全局对象全部可注入
    - _Requirements: 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 6.6, 6.8, 7.3, 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x]* 3.2 编写实时绘制调度模型属性测试（`tests/visualizer.test.mjs`）
    - **Property 14: 实时绘制调度模型**
    - **Validates: Requirements 5.2, 5.3, 4.3, 7.3, 8.1, 8.2, 8.3**
  - [x]* 3.3 编写画布像素尺寸属性测试（追加到 `tests/visualizer.test.mjs`）
    - **Property 15: 画布像素尺寸**
    - **Validates: Requirements 8.4**
  - [x]* 3.4 编写开关设置默认值属性测试（追加到 `tests/visualizer.test.mjs`）
    - **Property 16: 开关设置默认值**
    - **Validates: Requirements 6.6, 6.8**
  - [x]* 3.5 编写 `computeVisData` 示例测试（`tests/vis-compute.test.mjs`）
    - 假 Worker：一次只收到一条 Stem；`ready` 前出错回退主线程且每条之间调用 `yieldFn`；单条 `stem-error` 跳过；全部失败抛错；中止时 `terminate` 并抛 AbortError；`urls` 对象和其中的 URL 不变
    - _Requirements: 1.8, 1.9, 1.10, 2.3, 2.6, 2.8_

- [x] 4. Checkpoint - 确保浏览器端纯模块的测试全部通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Server 端可视化渲染
  - [x] 5.1 扩展 `tests/fixtures/fake-ffmpeg.mjs`
    - `FAKEVIDEO` 首行支持 `size=<W>x<H>` 和 `rotate=90`，探测输出的 Video 流行带尺寸，`rotate=90` 时追加 `displaymatrix: rotation of -90.00 degrees`
    - 合成调用含 `-i pipe:0` 时读取标准输入，按 `-s` 和 `rgb24` 计算帧数，在 `FAKEMP4` JSON 中加入 `stdin: { bytes, frames, remainder, size, sha256 }`；进度按已读帧数 / 30 输出
    - 新模式 `slowstdin`（每 64 KB 暂停 20 ms）和 `stdinexit`（读完 1 帧后写 `Error while decoding stream` 并退出 1）；原有模式与输出不变
    - _Requirements: 16.4_
  - [x] 5.2 在 `export-service.js` 中加入可视化纯函数
    - 从 `./public/js/vis-data.js`、`./public/js/vis-scene.js`、`./public/js/vis-raster.js` 导入
    - 常量 `VIS_FPS`、`VIS_RENDER_BOX`、`VIS_OUTPUT_BOX`、`VIS_STANDALONE_OUTPUT`、`VIS_BACKGROUND`、`VIS_LAYOUTS`
    - `parseVisQuery`、`createPartSplitter`、`parseProbeVideoSize`（±90 / 270 交换宽高）、`fitEven`、`visRenderPlan`、`buildVisMuxArgs`（design「决策 5」的滤镜图，无 `-nostdin`、无 `-shortest`、`apad` 在滤镜图中）、`pumpFrames`（缓冲池、写回调后复用、`false` 时等 `drain`、每帧 `yieldFn`、`error` / `close` / 中止时停止）
    - 现有导出函数和 `createBodySplitter`、`parseExportQuery`、`exportJobPaths` 不改
    - _Requirements: 10.1, 10.4, 11.1, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.12, 11.14_
  - [x]* 5.3 编写可视化查询参数校验属性测试（`tests/vis-export-props.test.mjs`）
    - **Property 19: 可视化查询参数校验**
    - **Validates: Requirements 10.4**
  - [x]* 5.4 编写三段分帧往返属性测试（追加到 `tests/vis-export-props.test.mjs`）
    - **Property 20: 三段分帧往返**
    - **Validates: Requirements 10.1, 10.7**
  - [x]* 5.5 编写尺寸解析与渲染分辨率属性测试（追加到 `tests/vis-export-props.test.mjs`）
    - **Property 21: 尺寸解析与渲染分辨率**
    - **Validates: Requirements 11.1, 11.5**
  - [x]* 5.6 编写帧计划属性测试（追加到 `tests/vis-export-props.test.mjs`）
    - **Property 22: 帧计划**
    - **Validates: Requirements 11.3, 11.4, 11.5, 11.9**
  - [x]* 5.7 编写可视化合成参数属性测试（追加到 `tests/vis-export-props.test.mjs`）
    - **Property 23: 可视化合成参数**
    - **Validates: Requirements 11.6, 11.8, 11.9, 11.10**
  - [x]* 5.8 编写帧泵背压属性测试（追加到 `tests/vis-export-props.test.mjs`）
    - **Property 24: 帧泵背压**
    - **Validates: Requirements 11.7, 11.12, 11.13, 11.14**
  - [x] 5.9 在 `createExportService` 中接入 Vis_Export_Job
    - `handleUpload`：`parseVisQuery` 返回 `vis: null` 时原流程不变；否则 `Content-Length` 检查（400 / 413）、`createPartSplitter([wavBytes, visBytes])`、Payload 只在内存拼接、收满后 `decodeVisPayload`（失败 → `abortUpload` + 400 `可视化数据无效`）、结束时按缺少的部分返回 400 并删目录；413 / 429 / 503 / 500 / 断线共用原代码
    - 把状态、超时计时器、`failJob`、`scheduleExpire`、取消分支和成功清理抽成内部辅助函数，原任务行为不变
    - `runVisJob`：探测 → overlay 无画面失败 → `visRenderPlan` → `createRasterizer` → `spawn`（`stdio: ['pipe','pipe','pipe']`，无 `shell`）→ stdout 进度用 `createProgressParser(plan.D)` → `stdin` 的 `error` 吞掉 → `pumpFrames`（`renderInto` 调 `sceneAt(k / 30, …, reducedMotion: false)` + `raster.render`，`yieldFn` 为 `setImmediate`）→ `close` 判定（取消 → 超时 → 退出码 → 无输出 → 帧泵 `stopped` 而退出码 0 为 `FFmpeg 提前结束` → 成功）
    - 取消和超时先中止帧泵再终止进程；结束时 `job.vis = null`；`_internal` 暴露渲染帧计数供测试
    - _Requirements: 10.3, 10.5, 10.6, 10.7, 10.8, 10.10, 11.1, 11.2, 11.3, 11.4, 11.6, 11.7, 11.11, 11.12, 11.13, 11.14, 15.3, 15.5_
  - [x]* 5.10 编写 `tests/vis-export-service.test.mjs` 集成测试
    - 用 `listenFetchable` + Fake_FFmpeg 覆盖 design「vis-export-service.test.mjs」一节的全部用例：overlay 完整流程（`stdin.frames === 60`、`size === '640x360'`、`blend`、`scale=1280:720`、`-t 2`、无 Payload 文件）、standalone、`duration=N/A`、overlay 无画面、`rotate=90`、各种 400、413、不带可视化参数的回归、`slowstdin` 背压期间状态请求 500 ms 内响应、`stdinexit`、取消、超时、与普通 Export_Job 共用名额
    - _Requirements: 16.5, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.10, 11.2, 11.3, 11.4, 11.7, 11.12, 11.13, 11.14_
  - [x]* 5.11 编写渲染性能测试（`tests/vis-perf.test.mjs`）
    - `{ skip: !process.env.BENCH_PERF }`；合成 3 分钟、8 条 Stem 都有数据、鼓和打击乐每秒 4 个 Onset 的 Vis_Data；640×360 下均匀抽 900 帧，`sceneAt` + `render` 平均每帧 < 33 ms，输出平均值和 P95
    - _Requirements: 13.1, 13.2_

- [x] 6. Checkpoint - 确保 Server 端测试全部通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. 浏览器端带可视化导出
  - [x] 7.1 修改 `public/js/export-client.js`
    - `runServerMux` 增加可选参数 `vis: { payload, layout }`：URL 加 `visBytes`、`layout`，请求体 `new Blob([wavBlob, payload, sourceFile])`，运行阶段报告 `{ stage: 'rendering', progress }`；不传 `vis` 时行为不变
    - `exportProgressText` 增加 `rendering`：`渲染可视化视频 N%` / `渲染可视化视频中…`
    - `runBrowserRecording` 增加可选参数 `frameSource`：画面轨取自 `frameSource.stream`，`player.play()` 前 `start()`，`finally` 中 `stop()`；不传时行为不变
    - 新增 `visFileLabel(label)` → `<label>-可视化`
    - _Requirements: 9.5, 9.6, 9.8, 10.1, 10.2, 10.9, 14.2, 14.4, 14.7_
  - [x] 7.2 新建 `public/js/vis-record.js`
    - `VIS_BACKGROUND`、`RECORD_BOX`、`canBrowserVisRecord(env)`（画布 `captureStream` + `MediaRecorder` 且 `pickRecorderMime` 非 null + `AudioContext` / `webkitAudioContext`）
    - `createVisCompositor({ document, video, visData, stemId, getTime, raf, cancelRaf, sceneAt, drawSceneToCanvas })`：画布按 `videoWidth/Height` 放进 1280×720（偶数），纯音频为 1280×720；每帧 `drawImage(video)` 或填背景，再以 Export_Stem 强调、关闭 Reduced_Motion 绘制场景；`stream = canvas.captureStream(30)`；`stop()` 取消动画帧、停止轨道、释放画布
    - _Requirements: 14.3, 14.4, 14.5, 14.7_
  - [x]* 7.3 编写可视化导出文件名属性测试（`tests/vis-export-client.test.mjs`）
    - **Property 17: 可视化导出文件名**
    - **Validates: Requirements 9.5**
  - [x]* 7.4 编写可视化上传请求属性测试（追加到 `tests/vis-export-client.test.mjs`）
    - **Property 18: 可视化上传请求**
    - **Validates: Requirements 10.1, 10.2, 10.9, 9.8**
  - [x]* 7.5 编写画布录制能力检测属性测试（追加到 `tests/vis-export-client.test.mjs`）
    - **Property 27: 画布录制能力检测**
    - **Validates: Requirements 14.5**
  - [x]* 7.6 编写可视化录制后恢复 Playback_State 属性测试（追加到 `tests/vis-export-client.test.mjs`）
    - **Property 28: 可视化录制后恢复 Playback_State**
    - **Validates: Requirements 14.2, 14.4, 14.7**
  - [x]* 7.7 编写导出客户端示例测试（追加到 `tests/vis-export-client.test.mjs`）
    - `exportProgressText` 的 `rendering` 两种文字；`createVisCompositor` 用假 canvas 每帧先 `drawImage` 再画场景、纯音频先填 `#0b0d14`、`stop()` 后不再请求动画帧；录制错误时抛 `ExportError('record')` 且调用 `frameSource.stop()`
    - _Requirements: 9.6, 14.3, 14.8_

- [x] 8. 练习室界面接入
  - [x] 8.1 修改 `public/index.html` 和 `public/css/style.css`
    - `.stage` 内加 `<canvas id="visCanvas" class="vis-canvas" aria-hidden="true" hidden>`（在 `#stageTap` 之前）；`.controls` 内加 `#visToggle`（「可视化」、`aria-pressed`、初始 `disabled`）和 `#visHint`
    - `#exportSheet` 中 `data-export="video"` 之后加 `data-export="visvideo"` 按钮（初始 `hidden`）
    - CSS：`.vis-canvas` 绝对定位铺满、`pointer-events: none`；`.media-card.vis-on.audio-only` 隐藏 `.bars`、显示画布并保留文件名；开关按钮的按下样式和键盘焦点样式
    - _Requirements: 6.1, 6.2, 6.4, 7.4, 7.5, 9.1_
  - [x] 8.2 在 `public/js/app.js` 中接入可视化显示
    - `loadSettings` 合并 `readVisSettings` 的 `visVideo` / `visAudio`；`state.vis = { status, abort }`
    - `openEntry` 开头中止进行中的计算；缓存已有 `vis` 时直接就绪；分离完成或缓存无 `vis` 时 `startVisCompute(entry)`；结果只在 `state.current === entry && entry.cache` 时写入 `entry.cache.vis`
    - `renderVis()`：画布显隐、`vis-on` 类、开关 `disabled` / `aria-pressed`、「可视化准备中…」/「可视化数据生成失败」
    - 创建 `createLiveVisualizer`（`getTime: () => player.currentTime`、`getSelected: () => state.selected`），在 `render()` 末尾、`selectStem()`、开关点击和窗口 `resize` 时 `invalidate()`；开关点击翻转当前类型的设置并 `saveSettings()`
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 4.3, 5.1, 5.2, 5.4, 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 15.1, 15.2_
  - [x] 8.3 在 `public/js/app.js` 中接入带可视化导出
    - `onExportClick`：纯音频且 `state.vis.status === 'ready'` 时以音频模式打开选择面板（隐藏「导出视频」，`visvideo` 文字为「可视化视频」），未就绪时直接 WAV；视频文件在就绪时显示「导出视频（带可视化）」
    - `onExportOption('visvideo')` → `startVisExport(target)`：结构同 `startVideoExport`；`runServer` 传 `vis: { payload: new Blob([encodeVisPayload(entry.cache.vis, target.stemId)]), layout }`；`canRecord` 为 `canBrowserVisRecord(window)`；`runBrowser` 用 `createVisCompositor` 作 `frameSource`、`video: player.master`；文件名用 `visFileLabel(target.label)`
    - 点击时取一次 Vis_Data 引用；取消、换文件、控件锁定和 Playback_State 恢复沿用现有 `state.exporting` 机制
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 14.1, 14.2, 14.5, 14.6, 14.7, 14.8_
  - [x] 8.4 确保 `tests/export-app.test.mjs` 的现有用例在新行为下通过
    - 「纯音频文件点导出直接下载 WAV」用例在可视化数据未就绪的前提下保持原断言（必要时在该用例的假环境中让 Vis_Data 计算不完成），其余用例不改
    - _Requirements: 9.3, 16.8_
  - [x]* 8.5 编写 `tests/vis-app.test.mjs`
    - 沿用 `app.test.mjs` 的 FakeEl 假 DOM，注入假 Worker、假 `matchMedia`、假 `requestAnimationFrame`；覆盖 design「vis-app.test.mjs」一节的全部用例：默认值与保存、准备中 / 失败提示、纯音频封面替换、换文件时 `terminate`、缓存复用不再创建 Worker、选择面板的新选项、回退录制、不支持录制的提示、取消、`entry.cache.urls` 不变
    - _Requirements: 16.6, 1.1, 1.2, 2.2, 2.3, 2.6, 2.7, 6.2, 6.6, 6.7, 9.1, 9.2, 9.3, 14.1, 14.5, 15.2_

- [x] 9. 文档
  - [x] 9.1 更新 `README.md`
    - 新增「可视化」一节：开关位置与默认值、8 条音轨各自的样式、选中音轨更亮、减少动态效果、数据在分离后计算并随缓存释放
    - 「导出」一节加入「导出视频（带可视化）」/「可视化视频」、快速渲染需要本地 FFmpeg（H.264 MP4、30 fps、加法混合）、无 FFmpeg 时实时录制 WEBM、`visBytes` / `layout` 参数与 400 规则；「测试」一节列出新增测试文件和 `BENCH_PERF=1 node --test tests/vis-perf.test.mjs`
    - _Requirements: 16.7_

- [x] 10. Final checkpoint - 确保全部测试通过
  - 运行 `node --test tests/*.test.mjs`，确认新旧测试全部通过（16.8）
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标 `*` 的子任务是测试任务，可跳过以更快完成 MVP；8.4 不是可选任务，它保证现有测试继续通过
- 每个任务标注了对应的需求编号，便于追溯
- `vis-data.js`、`vis-scene.js`、`vis-raster.js` 是同构模块，Server 从 `./public/js/` 直接导入，修改时不能引入 DOM 或 Node 专有 API
- 同一文件的任务放在不同的执行波次，避免并行写冲突

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.9", "2.12", "5.1", "8.1"] },
    { "id": 1, "tasks": ["1.3", "1.7", "1.9", "2.1", "2.10", "5.2"] },
    { "id": 2, "tasks": ["1.4", "1.8", "2.2", "2.11", "2.13", "3.1", "3.5", "5.3", "5.11", "7.1", "7.2"] },
    { "id": 3, "tasks": ["1.5", "2.3", "3.2", "5.4", "5.9", "7.3", "8.2"] },
    { "id": 4, "tasks": ["1.6", "2.4", "3.3", "5.5", "5.10", "7.4", "8.3"] },
    { "id": 5, "tasks": ["2.5", "3.4", "5.6", "7.5", "8.4", "9.1"] },
    { "id": 6, "tasks": ["2.6", "5.7", "7.6", "8.5"] },
    { "id": 7, "tasks": ["2.7", "5.8", "7.7"] },
    { "id": 8, "tasks": ["2.8"] }
  ]
}
```
