# Requirements Document

## Introduction

本功能给「层间」的练习室加一层音乐可视化：8 条 Derived_Stem 同时各画一种图形，跳舞的人能直接「看到」鼓点、贝斯和人声在什么位置。当前选中的音轨画得更亮、更大，其他音轨变暗；选「原曲」时 8 层等权显示。

数据来源：分离完成后（以及打开已有缓存的文件时），App 从缓存的每条 Stem WAV 预先算出响度包络（100 Hz）和起音时间（Onset），保存在该文件的分离缓存里。播放时只根据 `player.currentTime` 计算画面，所以变速、拖动和循环天然同步。不用实时 `AnalyserNode`：Player 同一时间只播放一条 Stem，其他 7 条没有声音可分析。

画面由一个纯函数 Scene_Function 算出图元列表，再交给两个后端绘制：浏览器里的 Canvas2D 后端用于实时显示；同构的纯 JS Software_Rasterizer（RGB 像素缓冲、加法混合）在浏览器和 Node 中都能运行，用于导出。两者用同一份数据、同一个 Scene_Function，导出的画面和练习时看到的一致。

显示位置：

1. **视频文件**：画布叠在画面上方，用开关按钮打开，默认关闭。
2. **纯音频文件**：可视化替换现在的封面图（`#audioArt`），默认打开。

导出：

1. **快速离线渲染（首选，需要本地 FFmpeg）**：浏览器把 Export_Stem 的 WAV、可视化数据 JSON 和原文件一起上传给本地 Server；Server 用 Software_Rasterizer 以降低的内部分辨率逐帧渲染，把原始像素通过标准输入送给 FFmpeg，与原画面加法混合（纯音频文件则是深色背景上只有可视化），重新编码为 H.264 MP4。渲染速度快于实时。
2. **浏览器实时录制（回退）**：FFmpeg 不可用或服务器任务失败时，浏览器把视频画面和可视化合成到一个画布上，以 1 倍速实时录制成 WEBM。浏览器不支持录制时，提示无法导出视频并提供 WAV 导出。

不带可视化的「导出视频」和 WAV 导出保持不变。

不在范围内：自定义颜色和样式、上述样式以外的节拍特效、给「原曲」单独画一层、编辑可视化时间线。

约束：浏览器端零依赖；Server 只用 Node ≥ 18 内置模块、ES 模块、无 npm 依赖；FFmpeg 只通过 `execFile` / `spawn` 以参数数组调用、不经过 shell；`player.js` 的同步逻辑、`library.js` 的缓存淘汰规则、Demucs_Service、stem-video-export 的现有行为和全部现有测试保持可用（例外见「假设」第 9 条）；测试命令为 `node --test tests/*.test.mjs`；更新 README。

### 取值

范围已与用户确认。下表中的具体数值是本文档采用的取值，标「假设」的是用户没有明确指定、由本文档决定的取值：

| 项目 | 取值 | 说明 |
| --- | --- | --- |
| 包络帧率 Vis_Frame_Rate | 100 Hz（每 10 ms 一个值） | 用户建议值 |
| 包络取值 | 0 到 255 的整数（存储），使用时除以 255 得到 0..1 | 假设；浏览器和 Server 用同一份量化数据，内存约为 Float32 的 1/4 |
| 计算 Onset 的音轨 | 鼓、额外打击乐、效果音、其他音效 | 用户要求至少鼓和额外打击乐；效果音 / 其他音效的粒子也由 Onset 驱动 |
| Onset 最小间隔 | 50 ms | 假设；16 分音符在 200 BPM 时约 75 ms |
| 可视化数据时长上限 | 3600 秒 | 假设；分离本身在电脑上限 15 分钟 |
| 可视化数据上传上限 `visBytes` | 16 MB | 假设；15 分钟的数据约 2 MB |
| 单帧图元上限 Max_Shapes | 400 个 | 假设 |
| 选中音轨的强调 | 选中层亮度 1.0、尺寸 1.0；其他层亮度 0.35、尺寸 0.8；选「原曲」时 8 层亮度 0.7、尺寸 0.9 | 假设 |
| 服务器内部渲染分辨率 | 按原画面宽高比放进 640×360 的框，宽高取偶数；纯音频为 640×360 | 用户建议值 |
| 服务器渲染帧率 | 30 fps | 用户建议值 |
| 视频文件的输出分辨率 | 原画面尺寸，超过 1920×1080 时按比例缩进 1920×1080 的框，宽高取偶数 | 假设；避免 4K 重新编码过慢 |
| 纯音频文件的输出分辨率 | 1280×720，背景色 `#0b0d14` | 假设 |
| 重新编码参数 | `libx264`，`-preset veryfast`，`-crf 20`，`yuv420p`；音频 AAC 192 kbps | 与 stem-video-export 相同 |
| 渲染性能 | 640×360、30 fps 时单帧平均渲染时间低于 33 ms（即快于实时） | 用户要求快于实时 |
| 浏览器录制画布 | 按原画面宽高比放进 1280×720 的框；纯音频为 1280×720；30 fps | 假设 |
| 实时显示的设备像素比上限 | 2 | 假设 |

### 假设

1. 「纯伴奏」也是 8 层之一，用户没有指定样式。本文档定为「背景辉光」：画面中心一大片柔和的径向光，亮度随纯伴奏包络起伏。
2. 导出视频里被强调的是 Export_Stem（导出的那条音轨），与实时显示时强调 Selected_Stem 的规则相同。
3. 导出视频一律使用完整动效，不受浏览器「减少动态效果」设置影响；减少动态效果只影响练习室里的实时显示。
4. 打开文件时会在后台计算可视化数据，即使开关关闭也计算，这样打开开关时立即可用。计算失败只影响可视化，不影响播放和导出。
5. 可视化数据保存在文件的分离缓存（`entry.cache.vis`）里，随 Library_Cache 的淘汰一起释放，不单独计数。
6. 纯音频文件的「可视化视频」导出仍然上传原文件，Server 用它读出时长，保证输出时长规则与 stem-video-export 一致。
7. 快速离线渲染需要运行 Server 的电脑上装有 FFmpeg；没有 FFmpeg 时只能走浏览器实时录制，耗时等于文件长度。
8. 实时显示与导出画面「一致」指同一 Scene_Function 生成同一组图元；两个后端的抗锯齿和发光边缘细节允许有差别，不要求逐像素相同。
9. 纯音频文件点「导出」的行为有一处有意的改变：可视化数据已就绪时，App 显示选择面板（WAV / 可视化视频），不再直接下载 WAV；可视化数据未就绪或生成失败时仍和原来一样直接下载 WAV。`tests/export-app.test.mjs` 中对应的用例按新行为更新，其余现有测试不改。

## Glossary

- **App**：运行在浏览器中的「层间」前端（`public/js/app.js` 及其加载的模块）。
- **Server**：项目根目录下 `server.js` 提供的本地 Node HTTP 服务器。
- **Export_Service**：Server 中已有的视频导出服务（`export-service.js`，接口前缀 `/api/export`），本功能在其中加入 Vis_Export_Job。
- **FFmpeg**：用户自行安装在 Server 所在机器上的 FFmpeg 命令行工具，由 stem-video-export 中定义的 `FFMPEG_CMD` 指定。
- **Player**：`player.js` 中的 `SyncPlayer`，以原媒体元素为主时钟，同一时间只播放 Selected_Stem。
- **Source_File**：用户在练习室打开的原文件。
- **Video_Source**：带画面的 Source_File。
- **Audio_Only_Source**：没有画面的 Source_File。
- **Stem**：9 个音轨按钮之一对应的音频，id 为 `original`、`inst`、`vocal`、`drums`、`bass`、`harmony`、`perc`、`fx`、`other`。
- **Derived_Stem**：除「原曲」外的 8 条 Stem，在 App 中各是一个缓存的 WAV Blob URL（`entry.cache.urls`）。
- **Selected_Stem**：练习室当前选中的 Stem。
- **Stem_Display_Name**：Stem 按钮上的中文名，例如「人声」「鼓」「纯伴奏」。
- **Export_Stem**：用户点击「导出」时的 Selected_Stem（定义同 stem-video-export）。
- **Library_Cache**：`library.js` 中按最近使用顺序保存分离结果的缓存（每个文件的 `entry.cache`）。
- **Vis_Frame_Rate**：包络的帧率，100 Hz。
- **Envelope**：一条 Derived_Stem 的响度包络，长度为 Vis_Frame_Count 的 0 到 255 整数序列。
- **Vis_Frame_Count**：`ceil(时长秒 × Vis_Frame_Rate)`，时长取该 Stem WAV 的采样数除以采样率。
- **Onset**：一条 Derived_Stem 中起音（鼓点、敲击等突然变响）的时间，单位秒。
- **Onset_Stem**：需要计算 Onset 的 Derived_Stem：`drums`、`perc`、`fx`、`other`。
- **Vis_Data**：一个 Source_File 的可视化数据：版本号、Vis_Frame_Rate、时长、每条 Derived_Stem 的 Envelope 及 Onset_Stem 的 Onset 列表。
- **Vis_Analyzer**：从 Stem WAV 计算 Vis_Data 的纯函数模块（`public/js/vis-analysis.js`）及运行它的 Web Worker。
- **Vis_Layer**：一条 Derived_Stem 在画面中对应的图形层。
- **Layer_Style**：Vis_Layer 的视觉样式（见 Requirement 3）。
- **Shape**：Scene_Function 输出的图元：圆环、圆斑、折线或矩形光带，带位置、尺寸、颜色、透明度和发光宽度。
- **Scene_Function**：纯函数 `sceneAt(t, visData, { selected, width, height, reducedMotion })`，返回时刻 `t` 的 Shape 列表。
- **Max_Shapes**：单帧 Shape 数上限，400。
- **Emphasis_Weight**：根据选中音轨给每个 Vis_Layer 的亮度和尺寸系数。
- **Canvas_Backend**：在浏览器 Canvas2D 上绘制 Shape 列表的模块。
- **Software_Rasterizer**：纯 JS 的同构模块，把 Shape 列表加法混合绘制到 RGB 像素缓冲区，浏览器和 Node 都能运行。
- **Live_Visualizer**：练习室中负责实时显示可视化的控制器（画布、开关、调度绘制）。
- **Vis_Canvas**：练习室里显示可视化的 `<canvas>` 元素。
- **Vis_Toggle**：练习室里打开或关闭可视化的开关按钮。
- **Reduced_Motion**：浏览器报告 `prefers-reduced-motion: reduce` 时的状态。
- **Vis_Export**：带可视化的视频导出，包括 Vis_Server_Render 和 Vis_Browser_Recording。
- **Vis_Server_Render**：由 Export_Service 用 Software_Rasterizer 渲染帧并经 FFmpeg 合成 MP4 的 Vis_Export。
- **Vis_Export_Job**：Export_Service 中针对一次 Vis_Export 上传创建的任务，状态、排队、超时和清理规则与 stem-video-export 的 Export_Job 相同。
- **Vis_Payload**：随上传发送的可视化数据 JSON（Vis_Data 加上要强调的 Stem id）。
- **Overlay_Layout**：Video_Source 的版式：可视化与原画面加法混合。
- **Standalone_Layout**：Audio_Only_Source 的版式：深色背景上只有可视化。
- **Render_Resolution**：Server 渲染可视化帧的内部分辨率。
- **Vis_Browser_Recording**：在浏览器中把画面和可视化合成到一个画布，用 `HTMLCanvasElement.captureStream` 和 `MediaRecorder` 以 1 倍速实时录制成 WEBM 的 Vis_Export。
- **Export_Chooser**：stem-video-export 中点「导出」后出现的选择面板（`#exportSheet`）。
- **Playback_State**：播放位置、播放速度、是否在播放、是否循环、Selected_Stem（定义同 stem-video-export）。
- **Fake_FFmpeg**：测试夹具 `tests/fixtures/fake-ffmpeg.mjs`。

## Requirements

### Requirement 1: 可视化数据的计算

**User Story:** 作为练舞的人，我希望分离完成后自动准备好可视化数据，这样打开可视化时马上就能看到每条音轨的动静。

#### Acceptance Criteria

1. WHEN 一个 Source_File 的分离完成，THE App SHALL 用 Vis_Analyzer 从该文件 8 条 Derived_Stem 的缓存 WAV 计算 Vis_Data。
2. WHEN 用户打开一个已有分离缓存但没有 Vis_Data 的 Source_File，THE App SHALL 计算该文件的 Vis_Data。
3. THE Vis_Analyzer SHALL 为每条 Derived_Stem 生成长度为 Vis_Frame_Count 的 Envelope，第 i 个值表示从 `i / 100` 秒开始的 10 ms 内各声道均方根响度的归一化值。
4. THE Vis_Analyzer SHALL 把每条 Envelope 按该 Stem 自身的最大响度归一化，使最大值为 255；IF 一条 Stem 的最大均方根响度低于 1e-4，THEN THE Vis_Analyzer SHALL 把该 Stem 的 Envelope 全部设为 0。
5. THE Vis_Analyzer SHALL 为每条 Onset_Stem 生成按时间严格递增的 Onset 列表，每个 Onset 位于 0 到该 Stem 时长之间，相邻 Onset 的间隔不小于 50 ms。
6. WHEN 一条 Onset_Stem 中出现一次突然变响（前 50 ms 安静、随后响度跃升），THE Vis_Analyzer SHALL 报告一个与跃升时刻相差不超过 20 ms 的 Onset。
7. THE Vis_Analyzer SHALL 对相同的输入采样产生逐字节相同的 Vis_Data。
8. WHERE 浏览器支持模块 Web Worker，THE App SHALL 在 Web Worker 中运行 Vis_Analyzer，并且一次只解码和分析一条 Stem。
9. IF 浏览器不支持模块 Web Worker，或 Worker 启动失败，THEN THE App SHALL 在主线程中逐条分析 Stem，每条 Stem 之间让出主线程。
10. IF 某条 Derived_Stem 的 WAV 无法读取或解码，THEN THE Vis_Analyzer SHALL 跳过该 Stem，Vis_Data 中不包含该 Stem 的数据，其余 Stem 照常计算。

### Requirement 2: 可视化数据的生命周期和内存

**User Story:** 作为练舞的人，我希望可视化不会拖慢播放或占用越来越多的内存，换文件时也不会串数据。

#### Acceptance Criteria

1. WHEN Vis_Data 计算完成且对应的 Source_File 仍是当前文件，THE App SHALL 把 Vis_Data 保存为该文件分离缓存的一部分（`entry.cache.vis`）。
2. WHEN 用户再次打开一个 `entry.cache.vis` 已存在的 Source_File，THE App SHALL 直接使用已保存的 Vis_Data，不重新计算。
3. WHEN 用户在 Vis_Data 计算过程中打开另一个 Source_File 或取消分离，THE App SHALL 停止该计算（终止 Worker 或停止主线程循环）并丢弃已算出的部分结果。
4. WHEN Library_Cache 淘汰一个文件的分离缓存，THE App SHALL 随缓存一起释放该文件的 Vis_Data。
5. THE App SHALL 以每条 Envelope 每个值 1 字节的方式在内存中保存 Vis_Data，每个 Source_File 的 Envelope 合计不超过 `8 × Vis_Frame_Count` 字节。
6. IF Vis_Data 计算失败，THEN THE App SHALL 在 Vis_Toggle 旁显示「可视化数据生成失败」，并保持播放、分离结果和导出可用。
7. WHILE Vis_Data 正在计算，THE App SHALL 在 Vis_Toggle 旁显示「可视化准备中…」。
8. THE Vis_Analyzer SHALL 读取 Stem WAV 时保持 `entry.cache.urls` 中的 Blob URL 不变。

### Requirement 3: 图层样式

**User Story:** 作为练舞的人，我希望每条音轨有自己一眼能认出的图形，这样我能同时看出鼓点、贝斯和人声。

#### Acceptance Criteria

1. THE Scene_Function SHALL 为 Vis_Data 中每条有数据的 Derived_Stem 生成一个 Vis_Layer，每条 Derived_Stem 使用一种不同的 Layer_Style。
2. WHEN 时刻 t 前 0.6 秒内有鼓（`drums`）的 Onset，THE Scene_Function SHALL 为每个这样的 Onset 生成一个以画面中心为圆心的发光圆环，半径随距离该 Onset 的时间增大，透明度随之减小。
3. WHEN 时刻 t 前 0.4 秒内有额外打击乐（`perc`）的 Onset，THE Scene_Function SHALL 为每个这样的 Onset 生成一组从中心附近向外飞散的小亮点，亮点数量和方向由该 Onset 的序号决定。
4. THE Scene_Function SHALL 为贝斯（`bass`）在画面底部生成一条矩形光带，光带高度和亮度随贝斯 Envelope 变化。
5. THE Scene_Function SHALL 为人声（`vocal`）生成一条横贯画面的波形折线，折线各点的起伏幅度随人声 Envelope 在 t 附近的取值变化。
6. THE Scene_Function SHALL 为和声伴奏（`harmony`）生成若干缓慢移动的柔和色斑，色斑亮度随和声伴奏 Envelope 变化，位置随 t 平滑移动。
7. THE Scene_Function SHALL 为效果音（`fx`）和其他音效（`other`）各生成一组散布的粒子，粒子亮度随该 Stem 的 Envelope 变化，并在该 Stem 的 Onset 后 0.3 秒内增亮。
8. THE Scene_Function SHALL 为纯伴奏（`inst`）在画面中心生成一片大范围的柔和径向光，亮度随纯伴奏 Envelope 变化。
9. THE Scene_Function SHALL 只用 t、Vis_Data、Stem id 和 Shape 序号作为随机元素（粒子、亮点、色斑）的种子，使相同的输入始终生成相同的 Shape 列表。
10. THE Scene_Function SHALL 在 Envelope 两个相邻帧之间按 t 线性插值取值。
11. THE Scene_Function SHALL 每帧输出不超过 Max_Shapes 个 Shape，每个 Shape 的数值都是有限数，透明度在 0 到 1 之间，颜色分量是 0 到 255 的整数，半径和宽度不小于 0。
12. IF t 小于 0 或大于 Vis_Data 的时长，THEN THE Scene_Function SHALL 把各 Envelope 取值视为 0、只考虑落在 0 到时长之间的 Onset。

### Requirement 4: 突出选中音轨

**User Story:** 作为练舞的人，我希望正在听的那条音轨在画面里最显眼，其他音轨作为背景。

#### Acceptance Criteria

1. WHILE Selected_Stem 是一条 Derived_Stem，THE Scene_Function SHALL 以亮度系数 1.0、尺寸系数 1.0 绘制该 Stem 的 Vis_Layer，以亮度系数 0.35、尺寸系数 0.8 绘制其他 Vis_Layer。
2. WHILE Selected_Stem 为「原曲」，THE Scene_Function SHALL 以相同的亮度系数 0.7 和尺寸系数 0.9 绘制全部 Vis_Layer。
3. WHEN 用户切换 Selected_Stem，THE Live_Visualizer SHALL 在下一次绘制时使用新的 Emphasis_Weight。
4. THE Scene_Function SHALL 将 Emphasis_Weight 的亮度系数乘到该 Vis_Layer 每个 Shape 的透明度上，将尺寸系数乘到半径、宽度和起伏幅度上。

### Requirement 5: 与播放同步

**User Story:** 作为练舞的人，我希望可视化和听到的声音严格对齐，放慢、拖动或循环时也不跑偏。

#### Acceptance Criteria

1. THE Live_Visualizer SHALL 以 Player 的 `currentTime` 作为 Scene_Function 的时刻 t。
2. WHILE Player 正在播放，THE Live_Visualizer SHALL 在每个浏览器动画帧中按当前 t 绘制一帧。
3. WHILE Player 暂停，THE Live_Visualizer SHALL 显示当前 t 对应的静止画面，并且只在 t、Selected_Stem、画布尺寸或开关状态变化时重新绘制。
4. WHEN 用户拖动进度条或 Player 因循环跳回开头，THE Live_Visualizer SHALL 在下一次绘制时显示新 t 对应的画面。
5. WHILE 播放速度不是 1 倍，THE Live_Visualizer SHALL 按 Player 报告的 `currentTime` 绘制，使画面与变速后的声音对齐。
6. THE Live_Visualizer SHALL 保持 Player 的同步逻辑和播放行为不变。

### Requirement 6: 显示位置、开关和默认值

**User Story:** 作为练舞的人，我希望看视频时可视化不挡画面，听纯音频时有东西可看，开关状态下次还在。

#### Acceptance Criteria

1. WHILE Source_File 为 Video_Source 且可视化已打开，THE App SHALL 把 Vis_Canvas 叠在视频画面上方，大小与画面区域相同，并让点击穿透到原有的播放 / 暂停区域。
2. WHILE Source_File 为 Audio_Only_Source 且可视化已打开且 Vis_Data 已就绪，THE App SHALL 用 Vis_Canvas 替换 `#audioArt` 中的封面图形，并继续显示文件名。
3. WHILE 可视化已关闭或 Vis_Data 未就绪，THE App SHALL 隐藏 Vis_Canvas，Audio_Only_Source 显示原来的封面图。
4. THE App SHALL 在练习室的播放控制区显示 Vis_Toggle，按钮文字为「可视化」，并用 `aria-pressed` 表示开关状态。
5. WHILE Vis_Data 未就绪，THE App SHALL 将 Vis_Toggle 设为不可点击。
6. WHERE 用户没有保存过开关设置，THE App SHALL 对 Video_Source 默认关闭可视化，对 Audio_Only_Source 默认打开可视化。
7. WHEN 用户点击 Vis_Toggle，THE App SHALL 切换当前文件类型（视频或纯音频）的开关状态，并把两种类型的开关状态与现有设置一起保存到 localStorage（键 `cengjian.settings`）。
8. IF localStorage 中的开关设置缺失或不是布尔值，THEN THE App SHALL 使用 6.6 中的默认值。

### Requirement 7: 无障碍和减少动态效果

**User Story:** 作为对闪烁和快速运动敏感的人，我希望可视化在我开启「减少动态效果」时变得平缓。

#### Acceptance Criteria

1. WHILE Reduced_Motion 生效，THE Scene_Function SHALL 让每个 Shape 的位置和尺寸不随 t 和 Onset 变化，只让透明度变化。
2. WHILE Reduced_Motion 生效，THE Scene_Function SHALL 用前 300 ms 的 Envelope 平均值代替瞬时值，使任一 Shape 在相隔 1/30 秒的两帧之间透明度变化不超过 0.05。
3. WHEN 浏览器的 `prefers-reduced-motion` 设置变化，THE Live_Visualizer SHALL 在下一次绘制时使用新的设置。
4. THE App SHALL 给 Vis_Canvas 设置 `aria-hidden="true"`，让屏幕阅读器跳过纯装饰的画面。
5. THE App SHALL 让 Vis_Toggle 可以用键盘聚焦和操作，并有可读的名称「可视化」。

### Requirement 8: 实时显示的性能

**User Story:** 作为用手机练舞的人，我希望打开可视化后播放依然流畅、手机不发烫。

#### Acceptance Criteria

1. THE Live_Visualizer SHALL 只在 `requestAnimationFrame` 回调中绘制 Vis_Canvas。
2. WHILE 页面不可见（`document.visibilityState` 不是 `visible`）或可视化已关闭，THE Live_Visualizer SHALL 不绘制，并且不安排新的动画帧。
3. WHILE Player 暂停且 5.3 中列出的输入都没有变化，THE Live_Visualizer SHALL 不安排新的动画帧。
4. THE Live_Visualizer SHALL 把 Vis_Canvas 的像素尺寸设为显示尺寸乘以设备像素比，设备像素比最多取 2。
5. THE Live_Visualizer SHALL 在主线程只运行 Scene_Function 和 Canvas_Backend，不在播放期间解码 WAV 或计算 Envelope。

### Requirement 9: 带可视化导出的界面

**User Story:** 作为练舞的人，我希望能直接导出一段带可视化的视频，拿去发给别人看。

#### Acceptance Criteria

1. WHILE Source_File 为 Video_Source 且 Vis_Data 已就绪，THE App SHALL 在 Export_Chooser 中「导出视频」之后显示「导出视频（带可视化）」选项。
2. WHEN 用户在 Source_File 为 Audio_Only_Source 且 Vis_Data 已就绪时点击「导出」，THE App SHALL 显示 Export_Chooser，包含「只导出音频（WAV）」「可视化视频」和「取消」三项，不显示「导出视频」。
3. WHEN 用户在 Source_File 为 Audio_Only_Source 且 Vis_Data 未就绪时点击「导出」，THE App SHALL 直接开始 WAV 导出，与 stem-video-export 的行为相同。
4. WHEN 用户选择「导出视频（带可视化）」或「可视化视频」，THE App SHALL 开始 Vis_Export，使用点击「导出」时记录的 Export_Stem。
5. THE App SHALL 以 `<Source_File 名去扩展名>-<Stem_Display_Name>-可视化.<扩展名>` 命名 Vis_Export 结果，文件名清理规则与 stem-video-export Requirement 4 相同，Vis_Server_Render 扩展名为 `mp4`，Vis_Browser_Recording 为 `webm`。
6. WHILE Vis_Export 进行中，THE App SHALL 显示与 stem-video-export 相同的进度文字和「取消导出」按钮，Server 渲染阶段显示「渲染可视化视频 N%」（进度未知时为「渲染可视化视频中…」）。
7. WHEN 用户在 Vis_Export 进行中点击「取消导出」或打开另一个 Source_File，THE App SHALL 按 stem-video-export Requirement 11 的规则取消导出。
8. THE App SHALL 保持 Export_Chooser 中「导出视频」和「只导出音频（WAV）」的行为不变。

### Requirement 10: 可视化上传的分帧和校验

**User Story:** 作为在自己电脑上运行服务器的人，我希望可视化数据上传有明确的格式和上限，坏数据会被拒绝。

#### Acceptance Criteria

1. WHEN App 提交 Vis_Export，THE App SHALL 发送 `POST /api/export?ext=<ext>&wavBytes=<n>&visBytes=<m>&layout=<overlay|standalone>`，请求体依次为 Export_Stem 的 WAV（n 字节）、Vis_Payload（m 字节）和 Source_File。
2. THE App SHALL 对 Video_Source 使用 `layout=overlay`，对 Audio_Only_Source 使用 `layout=standalone`。
3. WHEN 请求中没有 `visBytes` 和 `layout` 参数，THE Export_Service SHALL 按 stem-video-export 的规则处理该请求，行为与本功能加入前相同。
4. IF `visBytes` 不是 2 到 16777216 之间的十进制整数，或只出现 `visBytes` 与 `layout` 其中之一，或 `layout` 不是 `overlay` / `standalone`，THEN THE Export_Service SHALL 返回 400，并且不写入任何文件。
5. IF Vis_Payload 不是合法的 UTF-8 JSON，或不符合 Vis_Payload 格式（版本、帧率、时长、Stem id、Envelope 长度、Onset 顺序和范围、强调的 Stem id），THEN THE Export_Service SHALL 返回 400 `可视化数据无效`，并删除该请求已写入的文件。
6. IF WAV、Vis_Payload 与 Source_File 的总字节数超过 `EXPORT_MAX_UPLOAD_MB`，THEN THE Export_Service SHALL 返回 413，删除已写入的部分。
7. IF 请求体在 Source_File 部分之前结束，THEN THE Export_Service SHALL 返回 400，并删除已写入的文件。
8. THE Export_Service SHALL 把 Vis_Payload 只保存在内存中，不写入磁盘，Vis_Export_Job 结束时释放。
9. THE App SHALL 只把 Stem id、数值数据和 Base64 编码的 Envelope 放进 Vis_Payload，不包含 Source_File 名。
10. THE Export_Service SHALL 对 Vis_Export_Job 使用 stem-video-export 中 Export_Job 的排队上限、单进程、超时、临时目录、结果保留和清理规则。

### Requirement 11: 服务器端渲染和 FFmpeg 合成

**User Story:** 作为练舞的人，我希望带可视化的视频几十秒就能导出好，而不是等整首歌放完。

#### Acceptance Criteria

1. WHEN Vis_Export_Job 开始运行，THE Export_Service SHALL 用 stem-video-export 的探测命令读出 Source_File 的时长、第一条画面流及其尺寸。
2. IF `layout=overlay` 而 Source_File 中找不到画面流，THEN THE Export_Service SHALL 将 Vis_Export_Job 标记为失败，`error` 为「文件里没有画面」。
3. THE Export_Service SHALL 以 Source_File 时长作为输出时长 D；IF 时长无法读出，THEN THE Export_Service SHALL 使用 Vis_Payload 中的时长作为 D。
4. THE Export_Service SHALL 以 30 fps 渲染 `ceil(D × 30)` 帧，第 k 帧使用 Scene_Function 在 `t = k / 30` 的输出、Vis_Payload 中的强调 Stem id 和关闭的 Reduced_Motion。
5. THE Export_Service SHALL 在 Render_Resolution 下渲染：Overlay_Layout 为按原画面显示宽高比放进 640×360 框内的偶数尺寸，Standalone_Layout 为 640×360。
6. THE Export_Service SHALL 用 `spawn` 以参数数组启动 FFmpeg，以 `-f rawvideo -pix_fmt rgb24 -s <W>x<H> -r 30 -i pipe:0` 作为可视化输入，并把每帧 `W × H × 3` 字节的像素写入 FFmpeg 标准输入。
7. WHEN 对 FFmpeg 标准输入的写入返回 false，THE Export_Service SHALL 暂停渲染，直到标准输入发出 `drain` 事件后再渲染下一帧。
8. WHERE `layout=overlay`，THE Export_Service SHALL 把原画面和可视化缩放到 Overlay 输出尺寸后加法混合，输出画面中不包含 Source_File 原有的音频。
9. WHERE `layout=standalone`，THE Export_Service SHALL 输出 1280×720 的画面，内容为 `#0b0d14` 背景上的可视化。
10. THE Export_Service SHALL 将 Vis_Export_Job 的画面编码为 H.264（`libx264`，`-preset veryfast`，`-crf 20`，`yuv420p`），音频为上传 WAV 编码的 192 kbps AAC 并用静音补齐，输出时长用 `-t D` 截为 D，MP4 带 `-movflags +faststart`。
11. WHILE Vis_Export_Job 正在运行，THE Export_Service SHALL 用 stem-video-export 的进度解析规则，以 D 为分母报告 Export_Progress。
12. IF FFmpeg 在全部帧写完前退出、标准输入报告 `EPIPE` 或其他写入错误，THEN THE Export_Service SHALL 停止渲染，并按 FFmpeg 的退出码和标准错误把任务标记为失败。
13. WHEN Vis_Export_Job 被取消或超时，THE Export_Service SHALL 停止渲染、终止 FFmpeg 进程并按 stem-video-export 的规则清理任务。
14. THE Export_Service SHALL 在渲染每帧之后让出事件循环，使渲染期间 Server 仍能响应状态查询和静态文件请求。

### Requirement 12: 软件光栅化器

**User Story:** 作为维护者，我希望导出画面由一个能在 Node 里测试的纯 JS 模块画出，结果可预测。

#### Acceptance Criteria

1. THE Software_Rasterizer SHALL 把 Shape 列表绘制到 `W × H × 3` 字节的 RGB 缓冲区，先用背景色填充，再把每个 Shape 的颜色乘以透明度和覆盖率后加到像素上，结果限制在 0 到 255。
2. THE Software_Rasterizer SHALL 对相同的 Shape 列表、尺寸和背景色产生逐字节相同的缓冲区。
3. THE Software_Rasterizer SHALL 只修改 Shape 外接范围（位置加半径、宽度和发光宽度）内的像素。
4. THE Software_Rasterizer SHALL 只使用 ECMAScript 内置对象，不依赖 DOM、Node 内置模块或浏览器 API，使同一模块能在浏览器和 Node 中导入。
5. THE Software_Rasterizer SHALL 在多次绘制之间复用同一个像素缓冲区，每帧不分配新的帧缓冲。
6. THE Canvas_Backend SHALL 用 Canvas2D 的加法合成（`globalCompositeOperation = 'lighter'`）绘制与 Software_Rasterizer 相同的 Shape 类型。

### Requirement 13: 渲染性能

**User Story:** 作为练舞的人，我希望快速导出确实比实时录制快。

#### Acceptance Criteria

1. WHEN 在开发机上以 640×360 渲染一段 3 分钟、8 条 Stem 都有数据、鼓和打击乐每秒 4 个 Onset 的 Vis_Data，THE Software_Rasterizer 与 Scene_Function SHALL 以平均每帧少于 33 ms 的速度生成帧。
2. THE 测试套件 SHALL 用环境变量 `BENCH_PERF=1` 开启 13.1 的性能测试，未设置时跳过。

### Requirement 14: 回退：浏览器实时录制带可视化

**User Story:** 作为没有装 FFmpeg 的练舞的人，我希望仍然能导出带可视化的视频，哪怕要多等一会。

#### Acceptance Criteria

1. IF Export_Service 不可达、FFmpeg 不可用、Vis_Server_Render 上传失败、Vis_Export_Job 失败或下载结果失败，THEN THE App SHALL 改用 Vis_Browser_Recording，并显示失败原因和「改用浏览器录制」的提示。
2. WHEN Vis_Browser_Recording 开始，THE App SHALL 把 Player 切换到 Export_Stem、播放位置设为 0、速度设为 1 倍、关闭循环，并从头播放到结束。
3. WHILE Vis_Browser_Recording 进行中，THE App SHALL 在每个动画帧把当前视频画面（Audio_Only_Source 为 `#0b0d14` 背景）和以 Export_Stem 为强调、关闭 Reduced_Motion 的可视化合成到同一个录制画布上。
4. THE App SHALL 录制录制画布的画面轨和 Export_Stem 的音频，结果为 stem-video-export Requirement 12.3 中选出的 WEBM 类型。
5. IF 需要 Vis_Browser_Recording 而浏览器不支持 `HTMLCanvasElement.captureStream`、`MediaRecorder` 或 `AudioContext`，THEN THE App SHALL 显示「当前浏览器无法导出视频，可以选择只导出音频（WAV）」并提供 WAV 导出入口。
6. WHILE Vis_Browser_Recording 进行中，THE App SHALL 锁定播放控制，显示「浏览器录制中 N%（需要和视频一样长的时间）」。
7. WHEN Vis_Browser_Recording 结束（完成、取消或失败），THE App SHALL 将 Playback_State 恢复到录制开始前的值，并释放录制画布、捕获流和音频上下文。
8. IF 录制过程中出现 `MediaRecorder` 错误或媒体播放错误，THEN THE App SHALL 停止录制、不下载文件，并显示失败原因。

### Requirement 15: 不影响现有功能

**User Story:** 作为练舞的人，我希望加了可视化以后，原来的播放、分离和导出照常工作。

#### Acceptance Criteria

1. THE App SHALL 在可视化关闭时保持练习室的画面、控件和播放行为与本功能加入前相同。
2. THE App SHALL 保持 `entry.cache.urls` 中的 Blob URL、Library_Cache 的淘汰规则和 `STEM_CACHE_LIMITS` 不变。
3. THE Export_Service SHALL 保持 `/api/export` 不带可视化参数的请求、Demucs_Service 的接口和行为不变。
4. THE App SHALL 不引入任何浏览器端第三方依赖。
5. THE Export_Service SHALL 只使用 Node ≥ 18 内置模块和项目内的相对模块。
6. THE Server SHALL 在 FFmpeg 不可用时继续提供静态文件、Demucs_Service 和实时可视化所需的全部模块。

### Requirement 16: 测试和文档

**User Story:** 作为维护者，我希望可视化有自动化测试覆盖，README 说明怎么用。

#### Acceptance Criteria

1. THE 测试套件 SHALL 用属性测试覆盖 Envelope 的长度、取值范围和归一化，Onset 的顺序、间隔和定位精度，以及 Vis_Analyzer 的确定性。
2. THE 测试套件 SHALL 用属性测试覆盖 Scene_Function 的确定性、Shape 数和数值范围、Emphasis_Weight、Reduced_Motion 规则，以及 Vis_Payload 的编码解码往返。
3. THE 测试套件 SHALL 测试 Software_Rasterizer 的背景填充、加法混合、绘制顺序无关、影响范围和缓冲区复用。
4. THE Fake_FFmpeg SHALL 支持从标准输入读取原始帧，并在结果文件中记录标准输入的字节数、帧数和每帧尺寸，以及一个慢速读取标准输入的模式和一个读到一半退出的模式。
5. THE 测试套件 SHALL 用真实 HTTP 服务和 Fake_FFmpeg 测试 Vis_Export_Job：完整的上传到下载流程、写入的帧数等于 `ceil(D × 30)`、Overlay 与 Standalone 的参数、400 / 413 校验、不带可视化参数的请求不受影响、标准输入背压、FFmpeg 提前退出、取消和超时。
6. THE 测试套件 SHALL 用模拟的 DOM 测试 App：Vis_Toggle 的默认值、保存和不可用状态，Audio_Only_Source 的封面替换，换文件时取消计算，Export_Chooser 的新选项，Vis_Export 回退录制和不支持录制的提示。
7. THE README SHALL 说明可视化的用法、各音轨的样式、开关和默认值、减少动态效果、带可视化导出的两条路径（快速渲染需要本地 FFmpeg）、上传接口的新参数、性能测试的开启方式和新增测试文件。
8. THE 测试套件 SHALL 在加入本功能后让全部现有测试继续通过，「假设」第 9 条中说明的用例按新行为更新。
