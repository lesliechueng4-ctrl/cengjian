# Implementation Plan: 音轨跑道（stem-lanes）

## Overview

按 design.md 实现：先写同构纯函数模块 `public/js/vis-lanes.js`（`lanesAt`、`laneLayout`、`laneLabelSpecs`、`onsetsInWindow`、`stackedLayout`），并在 `vis-raster.js` 和 `vis-canvas.js` 中加入 `band` 图元；然后把 `export-service.js` 的 `overlay` 版式替换为 `stacked`（`vstack` 拼接、只渲染跑道帧）；浏览器端改 `readVisSettings` 默认值、录制合成器的上下版式；最后在 `index.html` / `style.css` / `app.js` 接上 `#laneStrip`、标签和导出参数，更新现有测试和 README。

语言为 JavaScript（ES 模块）：浏览器零依赖，Server 只用 Node ≥ 18 内置模块。测试命令 `node --test tests/*.test.mjs`，属性测试用 `tests/helpers/prop.mjs`，每个属性至少 100 轮，注释格式 `// Feature: stem-lanes, Property N: <标题>`。

采用的取值（见 requirements.md「取值」与「假设」）：窗口过去 1 秒 + 未来 3 秒，Playhead 在 25%；Lane_Order 为 drums、perc、bass、vocal、harmony、inst、fx、other；选中 Lane 权重 3；实时跑道高 `clamp(112px, 20cqw, 160px)`，标签门限 14 px；每条 Lane 最多 48 个标记、闪光 150 ms；导出叠放 `OW ≤ 1920`、`PH + SH ≤ 1920`、`SH = max(96, even(round(0.2 × OW)))`，跑道渲染宽度 ≤ 960；浏览器录制框 1280；性能目标 960×192 平均每帧 < 33 ms；视频文件可视化默认打开；`layout=overlay` 删除。

## Tasks

- [x] 1. 跑道纯函数模块
  - [x] 1.1 新建 `public/js/vis-lanes.js`
    - 常量 `LANE_ORDER`、`LANE_PAST_SEC`、`LANE_FUTURE_SEC`、`LANE_SELECTED_WEIGHT`、`LANE_BACKGROUND`、`LANE_ENV_SCALE`、`LANE_ONSET_ENV_SCALE`、`LANE_MAX_SAMPLES`、`LANE_MAX_MARKERS`、`LANE_FLASH_SEC`、`LANE_LABEL_MIN_PX`、`LANE_ALPHA`、`LANE_PAST_DIM`、`PLAYHEAD_COLOR`、`STRIP_RATIO`、`STRIP_MIN`
    - `laneLayout`（按 `LANE_ORDER` 过滤去重、权重 3 / 1、最后一条补齐到 height）、`laneLabelSpecs`（`top = y + h / 2`、`visible = h ≥ 14`）、`onsetsInWindow`（二分查找、限制在 `[0, duration]`）、`stackedLayout`（design「决策 8」的算法，无效尺寸按 1280×720）
    - `lanesAt`：无效尺寸或无 Stem 返回 `[]`；网格采样（`n = clamp(ceil(W / 2), 1, 400)`、`Δ = S / n`、`m0 … mp … m1`，每个网格点只调用一次 `envelopeAt`）；每条 Lane 依次输出 baseline、past / future Band、标记（超过 48 个时保留离 t 最近的）、闪光（非 Reduced_Motion），最后输出 Playhead；透明度乘 `emphasisFor(id, selected).alpha` 并夹到 [0, 1]；Shape 带 `role` / `side`；末尾按 `MAX_SHAPES` 截断
    - 只导入 `./vis-data.js` 和 `./vis-scene.js`，不读任何全局状态
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 7.1, 7.2, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 10.4, 12.2, 12.3, 13.1_
  - [x]* 1.2 编写 Lane 场景确定性属性测试（`tests/vis-lanes.test.mjs`）
    - **Property 1: Lane 场景确定性**
    - **Validates: Requirements 8.1, 3.4, 3.5**
    - 另加同构冒烟：`vis-lanes.js` 源码只有 `./` 相对导入，不出现 `window`、`document`、`self`、`process`、`require`（8.6）
  - [x]* 1.3 编写 Lane 输出界限属性测试（追加到 `tests/vis-lanes.test.mjs`）
    - **Property 2: Lane 输出界限**
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.5, 4.4**
  - [x]* 1.4 编写 Lane 布局属性测试（`tests/vis-lanes-layout.test.mjs`）
    - **Property 3: Lane 布局**
    - **Validates: Requirements 2.1, 2.2, 5.1, 5.2**
    - 另加示例：8 条 Stem、选中 `drums`、高 160 时 drums 为 48、其余为 16
  - [x]* 1.5 编写 Lane_Label 门限属性测试（追加到 `tests/vis-lanes-layout.test.mjs`）
    - **Property 4: Lane_Label 门限**
    - **Validates: Requirements 2.4**
  - [x]* 1.6 编写时间窗口映射与 Onset_Marker 属性测试（追加到 `tests/vis-lanes.test.mjs`）
    - **Property 5: 时间窗口映射与 Onset_Marker**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.6, 4.3, 4.4**
    - 另加示例：`onsetsInWindow` 对恰好落在 `t0`、`t1`、0 和时长上的 Onset 的包含规则
  - [x]* 1.7 编写波形采样属性测试（追加到 `tests/vis-lanes.test.mjs`）
    - **Property 6: 波形采样**
    - **Validates: Requirements 4.1, 4.2, 4.8, 3.6, 10.4**
  - [x]* 1.8 编写颜色与透明度模型属性测试（追加到 `tests/vis-lanes.test.mjs`）
    - **Property 7: 颜色与透明度模型**
    - **Validates: Requirements 2.3, 4.2, 4.5, 5.3, 7.2**
  - [x]* 1.9 编写 Playhead 与闪光属性测试（追加到 `tests/vis-lanes.test.mjs`）
    - **Property 8: Playhead 与闪光**
    - **Validates: Requirements 4.6, 4.7**
  - [x]* 1.10 编写减少动态效果属性测试（追加到 `tests/vis-lanes.test.mjs`）
    - **Property 9: 减少动态效果**
    - **Validates: Requirements 7.1**
  - [x]* 1.11 编写叠放尺寸属性测试（追加到 `tests/vis-lanes-layout.test.mjs`）
    - **Property 13: 叠放尺寸**
    - **Validates: Requirements 12.2, 12.3, 13.1**
    - 另加示例：design「决策 8」表中 1920×1080、1080×1920、3840×2160、640×360 和尺寸无效在 1920 / 1280 两个框下的结果

- [x] 2. Band 图元
  - [x] 2.1 在 `public/js/vis-raster.js` 中加入 `band`
    - `drawShape` 增加 `case 'band'`：`x0`、`x1`、`y` 非有限数或 `hs` 为空、含非有限数 / 负数时跳过
    - `drawBand(x0, x1, y, hs, glow)`：列范围和每列插值与 `drawWave` 的算术完全一致，行范围 `y ± (h + glow)`，`d = |py + 0.5 − y| − h`，`cov(d)` 累加
    - _Requirements: 9.1, 9.2, 9.3, 9.5_
  - [x]* 2.2 编写 Band 光栅化属性测试（`tests/vis-raster.test.mjs`）
    - **Property 10: Band 光栅化**
    - **Validates: Requirements 9.1, 9.2, 9.5**
  - [x]* 2.3 编写 Band 与 wave 等价属性测试（追加到 `tests/vis-raster.test.mjs`）
    - **Property 11: Band 与 wave 等价**
    - **Validates: Requirements 9.3**
  - [x]* 2.4 编写含 Band 的光栅化顺序无关与单调属性测试（修改 `tests/vis-raster.test.mjs`）
    - **Property 12: 含 Band 的光栅化顺序无关与单调**
    - **Validates: Requirements 9.1, 9.2**
    - 把 stem-visualizer Property 25、26 的 Shape 生成器扩展为包含 `band`；另加示例：常数 hs 的 Band 中心像素等于背景 + color × alpha
  - [x] 2.5 在 `public/js/vis-canvas.js` 中加入 `band`
    - `drawBand`：`hs` 无效时跳过；轮廓为上边缘从左到右、下边缘从右到左并 `closePath`；`glow > 0` 时先以 `alpha × 0.25` 填充外扩 glow 的轮廓，再以 `alpha` 填充核心轮廓；注册到 `DRAWERS`
    - _Requirements: 9.4, 9.5_
  - [x]* 2.6 编写 Canvas_Backend 的 Band 示例测试（修改 `tests/vis-canvas.test.mjs`）
    - 假 ctx：`glow > 0` 时两次 `fill` 且第一次透明度为 0.25 倍、`lineTo` 次数 `2n − 1`、有 `closePath`；`hs` 为空或含 NaN 时无绘制调用；`'lighter'` 与合成模式恢复；同构冒烟的文件列表加入 `vis-lanes.js`
    - _Requirements: 9.4, 9.5, 8.6_

- [x] 3. Checkpoint - 确保纯函数和两个后端的测试全部通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Server 端叠放导出
  - [x] 4.1 修改 `export-service.js`
    - 从 `./public/js/vis-lanes.js` 导入 `lanesAt`、`stackedLayout`、`LANE_BACKGROUND`
    - `VIS_LAYOUTS = ['stacked', 'standalone']`；新增 `VIS_STACK_BOX`、`VIS_STRIP_RENDER_MAX_W`、`VIS_DEFAULT_PICTURE`；删除只给 overlay 用的 `VIS_OUTPUT_BOX`
    - `visRenderPlan`：stacked 分支返回 `picture`、`strip`、`output`、`render`（design 第 6 节）；standalone 不变
    - `buildVisMuxArgs`：overlay 分支替换为 stacked 滤镜图（`scale` + `pad` + `format=yuv420p`、跑道 `scale=OW:SH:flags=bicubic`、`vstack=inputs=2`、`apad`）；standalone 不变
    - `runVisJob`：`layout === 'stacked' && !info.video` → `文件里没有画面`；只在 stacked 时解析画面尺寸；stacked 的 `renderInto` 用 `lanesAt(k / 30, …, reducedMotion: false)` + `LANE_BACKGROUND`；其余流程不改
    - _Requirements: 11.2, 11.3, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 15.4, 15.5_
  - [x]* 4.2 编写布局参数校验属性测试（修改 `tests/vis-export-props.test.mjs` 的 Property 19 用例）
    - **Property 16: 布局参数校验**
    - **Validates: Requirements 11.2**
  - [x]* 4.3 编写叠放渲染计划属性测试（修改 `tests/vis-export-props.test.mjs` 的 Property 22 用例）
    - **Property 14: 叠放渲染计划**
    - **Validates: Requirements 12.3, 12.4, 12.5**
    - standalone 分支的断言保留
  - [x]* 4.4 编写叠放合成参数属性测试（修改 `tests/vis-export-props.test.mjs` 的 Property 23 用例）
    - **Property 15: 叠放合成参数**
    - **Validates: Requirements 12.6, 12.7**
    - standalone 分支的断言保留
  - [x]* 4.5 更新 `tests/vis-export-service.test.mjs` 集成测试
    - overlay 完整流程改为 stacked（`size=1280x720`、2 秒 → `stdin.frames === 60`、`stdin.size === '960x192'`、参数含 `vstack=inputs=2`、`scale=1280:720`、`scale=1280:256`、不含 `blend`）；`rotate=90` + `size=1920x1080` → 970×1918 输出、`960x192` 渲染；stacked + `codec=none` → `文件里没有画面`；新增 `layout=overlay` → 400 `可视化布局参数无效` 且不写文件；背压、`stdinexit`、取消、超时、排队用例改用 `stacked`；standalone 和不带可视化参数的用例不改
    - _Requirements: 16.3, 16.5, 11.2, 11.3, 12.1, 12.5, 12.6, 12.7, 12.8, 15.4_
  - [x]* 4.6 在 `tests/vis-perf.test.mjs` 中加入跑道性能测试
    - `{ skip: !process.env.BENCH_PERF }`；3 分钟、8 条 Stem、鼓和额外打击乐每秒 4 个 Onset；960×192 下均匀抽 900 帧，`lanesAt` + `render` 平均每帧 < 33 ms，输出平均值和 P95；原 640×360 的 `sceneAt` 用例保留
    - _Requirements: 14.1, 14.2_

- [x] 5. Checkpoint - 确保 Server 端测试全部通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. 浏览器端设置与录制合成
  - [x] 6.1 修改 `public/js/visualizer.js` 的 `readVisSettings`
    - `visVideo` 默认改为 `true`，`visAudio` 仍为 `true`；保存的布尔值照常使用；`createLiveVisualizer` 不改
    - _Requirements: 6.1, 6.2_
  - [x]* 6.2 编写开关设置默认值属性测试（修改 `tests/visualizer.test.mjs` 的 Property 16 用例）
    - **Property 17: 开关设置默认值**
    - **Validates: Requirements 6.1, 6.2**
  - [x] 6.3 修改 `public/js/vis-record.js` 和 `public/js/export-client.js`
    - `createVisCompositor` 增加可注入的 `lanesAt`；Video_Source 时画布为 `stackedLayout(videoWidth, videoHeight, 1280, 1280)` 的 `width × (pictureHeight + stripHeight)`；每帧：画面区域填黑、跑道区域填 `LANE_BACKGROUND` → `drawImage` 按 contain 放进画面区域（抛错时保留黑色）→ `save`、`translate(0, PH)`、`rect` + `clip`、`drawSceneToCanvas(ctx, lanesAt(t, visData, { selected: stemId, width, height: SH, reducedMotion: false }), { clear: false })`、`restore`
    - Audio_Only_Source 的合成不变
    - `export-client.js`：`runServerMux` 的 JSDoc 改为 `layout: 'stacked' | 'standalone'`，逻辑不改
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 11.4_
  - [x]* 6.4 更新 `tests/vis-export-client.test.mjs`
    - stem-visualizer Property 18 的 `layout` 生成器改为 `stacked` / `standalone`；`createVisCompositor` 示例：视频 1920×1080 → 画布 1280×976，调用顺序为填充 → `drawImage`（目标矩形在 `[0, 720]` 内）→ `save` / `translate(0, 720)` / `clip` / 跑道绘制 / `restore`，`lanesAt` 收到 `{ width: 1280, height: 256, selected: stemId, reducedMotion: false }`；纯音频示例不改
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 16.5_

- [x] 7. 练习室界面接入
  - [x] 7.1 修改 `public/index.html` 和 `public/css/style.css`
    - `.stage` 之后、`.controls` 之前加 `<div class="lane-strip" id="laneStrip" hidden>`，内含 `<canvas class="lane-canvas" id="laneCanvas" aria-hidden="true">` 和 `<div class="lane-labels" id="laneLabels" aria-hidden="true">`
    - CSS：`.media-card { container-type: inline-size; }`；`.lane-strip` 普通文档流、`height: 128px; height: clamp(112px, 20cqw, 160px)`、背景 `#0b0d14`；`.lane-canvas` 铺满；`.lane-labels`、`.lane-label`（10 px、左侧 6 px、竖直居中、半透明深色底）
    - _Requirements: 1.2, 1.3, 1.5, 2.4, 7.4_
  - [x] 7.2 在 `public/js/app.js` 中接入 Lane_Strip 显示
    - `els.laneStrip`、`els.laneCanvas`、`els.laneLabels`，全部做 null 判断
    - `coverOn()`（纯音频 + `visAudio` + 就绪）与 `laneOn()`（视频 + `visVideo` + 计算中或就绪）；原 `visualizer` 只在 `coverOn()` 时绘制、`isTransparent: () => false`；新建 `laneVisualizer = createLiveVisualizer({ canvas: els.laneCanvas, sceneAt: lanesAt, isEnabled: laneOn, isTransparent: () => false, background: LANE_BACKGROUND, getTime: () => player.currentTime, … })`；`invalidateVis()` 同时刷新两个实例
    - `renderVis()`：`#visCanvas.hidden = !coverOn()`、`#laneStrip.hidden = !laneOn()`、`vis-on` 类只跟随 `coverOn()`，开关和提示不变，末尾调用 `renderLaneLabels()`
    - `renderLaneLabels()`：用 `laneLabelSpecs(laneLayout(Object.keys(data.stems), state.selected, laneStrip.clientHeight))` 复用每个 id 的 `<span class="lane-label">`，设置文字（STEMS 的 label）、`top`、颜色（`LAYER_COLORS`）和 `hidden`；在 `renderVis()`、`selectStem()` 和窗口 `resize` 中调用
    - _Requirements: 1.1, 1.2, 1.4, 2.4, 2.5, 3.4, 3.5, 5.4, 6.3, 6.4, 6.5, 6.6, 6.7, 7.3, 10.1, 10.2, 10.3, 15.1, 15.2, 15.3_
  - [x] 7.3 在 `public/js/app.js` 中把视频文件的 Vis_Export 改为 `layout: 'stacked'`
    - `startVisExport` 的 `vis.layout` 为 `isVideo ? 'stacked' : 'standalone'`；文件名、进度、取消和回退录制不变
    - _Requirements: 11.1, 11.4_
  - [x]* 7.4 更新 `tests/vis-app.test.mjs`
    - 假 DOM 加入 `#laneStrip`、`#laneCanvas`、`#laneLabels`；覆盖 design「需要更新的现有测试文件」中 `vis-app.test.mjs` 一行的全部用例：视频默认打开、`#visCanvas` 隐藏且不绘制、计算中占位且不绘制、就绪后绘制与像素尺寸、关闭和失败时隐藏、切换音轨后标签更新（160 px 全部可见；112 px 选中一条时只有选中的可见）、减少动态效果变化、上传 `layout=stacked`、已保存的 `visVideo: false` 保持关闭；原「overlay shown and drawn」用例改写为 Lane_Strip 用例；纯音频用例不改
    - 冒烟：读取 `index.html` 和 `style.css`，`#laneStrip` 位于 `#stage` 之后、`.controls` 之前，`aria-hidden="true"`，`.lane-strip` 含 `clamp(112px, 20cqw, 160px)`、`#0b0d14` 且不含 `position: absolute`
    - _Requirements: 16.4, 16.5, 1.1, 1.2, 1.3, 1.4, 1.5, 2.4, 2.5, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 7.3, 7.4, 10.1, 10.2, 10.3, 11.1_
  - [x] 7.5 确保 `tests/app.test.mjs` 和 `tests/export-app.test.mjs` 不改即可通过
    - 运行这两个文件；如有失败，只在 `app.js` 中补充对新元素的 null 判断，不改这两个测试文件
    - _Requirements: 15.1, 15.2, 16.5_

- [x] 8. 文档
  - [x] 8.1 更新 `README.md`
    - 「可视化」一节：视频文件改为画面下方的音轨跑道且默认打开；Lane 顺序；过去 1 秒 / 未来 3 秒、Playhead 在 25%、随播放速度变化；波形、鼓点标记和闪光；选中音轨更高更亮；矮 Lane 不显示文字；减少动态效果时继续滚动但不闪光；以前保存的关闭设置仍有效
    - 「带可视化导出」一节：画面在上、跑道在下的尺寸规则和例子，导出不带文字标签；`layout=<stacked|standalone>`，`overlay` 已删除并返回 400；浏览器录制同样是上下版式
    - 「测试」一节：新增 `vis-lanes.test.mjs`、`vis-lanes-layout.test.mjs`，更新的测试文件，`BENCH_PERF=1 node --test tests/vis-perf.test.mjs` 同时测跑道
    - _Requirements: 16.6_

- [x] 9. Final checkpoint - 确保全部测试通过
  - 运行 `node --test tests/*.test.mjs`，确认新旧测试全部通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标 `*` 的子任务是测试任务，可跳过以更快完成 MVP；7.5 不是可选任务，它保证未修改的现有测试继续通过
- 4.2–4.5、6.2、6.4、7.4 修改的是 stem-visualizer 已有的测试用例：断言 overlay 或「视频默认关闭」的部分按本文档的新行为改写，其余断言保留
- `vis-lanes.js`、`vis-raster.js` 是同构模块，Server 从 `./public/js/` 直接导入，修改时不能引入 DOM 或 Node 专有 API
- 每个任务标注了对应的需求编号，便于追溯
- 同一文件的任务放在不同的执行波次，避免并行写冲突

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.5", "6.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.2", "2.6", "4.1", "6.2", "6.3", "7.2"] },
    { "id": 2, "tasks": ["1.3", "1.5", "2.3", "4.2", "4.5", "4.6", "6.4", "7.3"] },
    { "id": 3, "tasks": ["1.6", "1.11", "2.4", "4.3", "7.4", "8.1"] },
    { "id": 4, "tasks": ["1.7", "4.4", "7.5"] },
    { "id": 5, "tasks": ["1.8"] },
    { "id": 6, "tasks": ["1.9"] },
    { "id": 7, "tasks": ["1.10"] }
  ]
}
```
