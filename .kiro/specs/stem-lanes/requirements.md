# Requirements Document

## Introduction

本功能修订 stem-visualizer 中「视频文件」的可视化显示方式。用户反馈：视频文件的可视化画在画面上方，会挡住跳舞的人（竖屏练舞视频里，红色鼓点圆环和人声波形直接压在身体上）。用户选定的方案是：**在视频画面正下方放一条横向滚动的「音轨跑道」条（Lane_Strip）**，可视化不再覆盖画面。

设计参考 DJ 软件的彩色波形（rekordbox、Serato）和节奏游戏的下落轨道：

1. 每条有数据的 Derived_Stem 占一行 Lane，按固定的 Lane_Order 自上而下排列，颜色沿用 stem-visualizer 的 `LAYER_COLORS`，左侧有中文名标签。
2. 时间从右向左滚过一条固定的竖直 Playhead（位于宽度 25% 处）：Playhead 左边是刚过去的 1 秒，右边是接下来的 3 秒，跳舞的人能提前看到下几个鼓点。
3. 普通音轨画成以 Lane 中线为轴的上下对称填充波形；Onset_Stem（鼓、额外打击乐、效果音、其他音效）在淡波形上画明亮的圆角标记，标记越过 Playhead 时在 Playhead 处闪一下光晕。
4. 选中的音轨所在 Lane 更高、更亮，其余 Lane 压扁、变暗；选「原曲」时所有 Lane 等高。

纯音频文件保持 stem-visualizer 的全画面可视化（替换封面图）不变。

带可视化导出（视频文件）同样改为「画面在上、Lane_Strip 在下」的叠放版式（Stacked_Layout）：Server 只渲染 Lane_Strip 的帧，FFmpeg 把原画面和 Lane_Strip 竖直拼接，不再与画面混合；浏览器录制回退也在一个录制画布上画出同样的上下版式。原来的 `layout=overlay` 删除。

Lane_Strip 的画面由新的纯函数 Lane_Function 算出 Shape 列表，与 Scene_Function 一样交给 Canvas_Backend（实时显示、浏览器录制）和 Software_Rasterizer（服务器导出）绘制。填充波形需要新的图元 Band，两个后端都要支持。

不在范围内：按 BPM 推算的节拍网格、用户自定义时间窗口或 Lane 顺序、纯音频文件的 Lane_Strip、编辑可视化、导出视频中的文字标签。

约束：沿用 stem-visualizer 的全部约束（浏览器零依赖；Server 只用 Node ≥ 18 内置模块、ES 模块、无 npm 依赖；FFmpeg 只以参数数组调用、不经过 shell；`player.js`、`library.js` 不改）；Vis_Data 的格式、计算和缓存不变；测试命令为 `node --test tests/*.test.mjs`；更新 README。

本文档只列出新增或改变的需求。stem-visualizer 的需求中，凡是本文档没有修订的，继续有效；被修订的条目在各需求开头注明。

### 取值

范围已与用户确认。下表中的具体数值是本文档采用的取值，标「假设」的是用户没有明确指定、由本文档决定的取值：

| 项目 | 取值 | 说明 |
| --- | --- | --- |
| Past_Window（Playhead 左侧） | 1 秒（媒体时间） | 用户建议值 |
| Future_Window（Playhead 右侧） | 3 秒（媒体时间） | 用户建议值 |
| Playhead 位置 | 距左边 `宽度 × 1 / (1 + 3)` = 25% | 用户建议值；由两个窗口推出，所以每秒对应的像素数 `宽度 / 4` 在 Playhead 两侧相同 |
| Lane_Order（自上而下） | 鼓 `drums`、额外打击乐 `perc`、贝斯 `bass`、人声 `vocal`、和声伴奏 `harmony`、纯伴奏 `inst`、效果音 `fx`、其他音效 `other` | 假设；节奏轨道放在最上面、离画面最近，视线移动最少；贝斯和人声居中；铺底的纯伴奏和稀疏的音效放在下面 |
| Lane 高度分配 | 选中音轨的 Lane 权重 3，其余权重 1，按权重分配 Lane_Strip 高度；选「原曲」或选中的音轨没有数据时全部权重 1 | 假设；8 条时选中 Lane 占 30% |
| Lane 亮度系数 | 沿用 stem-visualizer 的 `EMPHASIS`：选中 1.0、其余 0.35、「原曲」时全部 0.7 | 与 stem-visualizer 一致 |
| 实时 Lane_Strip 高度 | `clamp(112, 0.2 × 卡片宽度, 160)` CSS px | 假设；手机 375 px 宽时为 112 px（8 条等高时每条 14 px），桌面 800 px 以上为 160 px |
| Lane_Label 显示门限 | Lane 高度 ≥ 14 CSS px 时显示标签，字号 10 px | 假设；更矮的 Lane 只靠颜色区分 |
| 波形高度 | 普通音轨半高 = `0.45 × Lane 高度 × 包络值`；Onset_Stem 的淡波形半高 = `0.35 × Lane 高度 × 包络值` | 假设 |
| 波形采样 | 采样间隔 `Δ = 4 秒 / clamp(ceil(宽度 / 2), 1, 400)`，采样时刻对齐到 `Δ` 的整数倍 | 假设；每 2 像素约一个采样，最多 400 个，正好是 100 Hz 包络在 4 秒内的帧数；对齐整数倍让滚动时波形不抖动 |
| Playhead 之前（已播放）部分的亮度 | 波形 × 0.45，Onset_Marker × 0.4 | 假设；参照 DJ 软件「已播放部分变暗」 |
| 每条 Lane 的 Onset_Marker 上限 | 48 个（4 秒窗口内平均每秒 12 个） | 假设；超过时保留离 Playhead 最近的 48 个 |
| Playhead_Flash 时长 | Onset 越过 Playhead 后 150 ms | 假设 |
| 单帧图元上限 | 沿用 `MAX_SHAPES` = 400 | 与 stem-visualizer 一致 |
| Lane_Strip 背景色 | `#0b0d14` | 用户指定 |
| 视频文件可视化默认值 | 打开 | 用户同意；不再遮挡画面 |
| 导出的 Lane_Strip 高度 | `max(96, 偶数(round(0.2 × 输出宽度)))` | 假设；与实时显示的 0.2 比例一致 |
| 导出的叠放输出框（Server） | 输出宽度 ≤ 1920，画面高度 + Lane_Strip 高度 ≤ 1920，宽高都是偶数 | 假设；横屏 1920×1080 → 1920×1464；竖屏 1080×1920 → 970×1918（画面 970×1724 + 跑道 194） |
| Server 的 Lane_Strip 渲染尺寸 | 宽度 = `偶数(min(输出宽度, 960))`，高度按比例缩放取偶数（≥ 2）；FFmpeg 再放大到输出尺寸 | 假设；控制光栅化像素量 |
| 浏览器录制的叠放输出框 | 输出宽度 ≤ 1280，画面高度 + Lane_Strip 高度 ≤ 1280 | 假设；与原来 1280×720 录制框同一量级 |
| 渲染性能 | 960×192 的 Lane_Strip 单帧（Lane_Function + Software_Rasterizer）平均低于 33 ms | 与 stem-visualizer 的「快于实时」目标相同 |

### 假设

1. 视频文件的可视化默认改为打开。localStorage 中已经保存的布尔值 `visVideo` 照常生效（包括以前保存的 `false`），stem-visualizer 6.8 的规则不变。
2. Lane 的切换（选中另一条音轨）在下一帧直接生效，不做高度过渡动画。Lane_Function 是纯函数，没有跨帧状态。
3. 打开开关且 Vis_Data 正在计算时，Lane_Strip 已经占好位置（显示空的深色条），数据就绪时只填入内容，播放控件不再下移。开关关闭或数据生成失败时 Lane_Strip 不占位置。
4. Lane_Label 是 DOM 文字（在 Lane_Strip 左侧），只在实时显示中出现。导出的视频中没有文字标签，Lane 只靠颜色和顺序区分（Software_Rasterizer 没有字体）。
5. Lane_Strip 横跨整个 `.media-card` 宽度，紧贴 `.stage` 下方；`.media-card` 已有的圆角和 `overflow: hidden` 负责外形，Lane_Strip 自身不加圆角。
6. 减少动态效果时 Lane_Strip 继续滚动（滚动本身就是信息），只去掉 Playhead_Flash；其余 Shape 的透明度本来就不随时间变化。
7. 导出视频始终是完整效果（包含 Playhead_Flash），不受「减少动态效果」影响，与 stem-visualizer 假设 3 相同。
8. `layout=overlay` 直接删除，不保留为别名：App 是唯一的调用方，与 Server 同时更新。请求带 `layout=overlay` 时返回 400 `可视化布局参数无效`。
9. 叠放版式的输出帧率仍为 30 fps，与 stem-visualizer 相同。
10. 实时显示与导出画面「一致」指同一 Lane_Function 生成同一组 Shape；两个后端的发光边缘细节允许不同，导出没有文字标签（第 4 条）。

## Glossary

沿用 stem-visualizer 的术语（App、Server、Export_Service、FFmpeg、Player、Source_File、Video_Source、Audio_Only_Source、Stem、Derived_Stem、Selected_Stem、Stem_Display_Name、Export_Stem、Vis_Data、Envelope、Onset、Onset_Stem、Shape、Scene_Function、Max_Shapes、Emphasis_Weight、Canvas_Backend、Software_Rasterizer、Live_Visualizer、Vis_Toggle、Reduced_Motion、Vis_Export、Vis_Server_Render、Vis_Export_Job、Vis_Payload、Standalone_Layout、Vis_Browser_Recording、Export_Chooser、Fake_FFmpeg）。本功能新增或改变：

- **Lane_Strip**：Video_Source 可视化打开时显示在视频画面正下方的横向条，内含若干 Lane、Playhead 和 Lane_Label。
- **Lane**：Lane_Strip 中的一行，对应 Vis_Data 中一条有数据的 Derived_Stem。
- **Lane_Order**：Lane 自上而下的固定顺序：`drums`、`perc`、`bass`、`vocal`、`harmony`、`inst`、`fx`、`other`。
- **Lane_Layout**：每条 Lane 在 Lane_Strip 中的上边缘 y 和高度 h。
- **Lane_Window**：Lane_Strip 横向显示的媒体时间范围 `[t − Past_Window, t + Future_Window]`，t 为当前播放时刻。
- **Past_Window**：Playhead 左侧的时长，1 秒。
- **Future_Window**：Playhead 右侧的时长，3 秒。
- **Playhead**：Lane_Strip 中位于 `宽度 × Past_Window / (Past_Window + Future_Window)` 处的竖直亮线，表示当前时刻 t。
- **Envelope_Lane**：非 Onset_Stem（`bass`、`vocal`、`harmony`、`inst`）的 Lane，画对称填充波形。
- **Onset_Lane**：Onset_Stem（`drums`、`perc`、`fx`、`other`）的 Lane，画淡波形和 Onset_Marker。
- **Band**：新的 Shape 类型：以水平中线 y 为轴、在 `[x0, x1]` 上按等距采样的半高 `hs[]` 上下对称填充的区域，带发光边缘。
- **Onset_Marker**：Onset_Lane 中表示一个 Onset 的明亮圆角竖条。
- **Playhead_Flash**：Onset 越过 Playhead 后 150 ms 内，在 Playhead 与该 Lane 中线交点处显示的光晕。
- **Lane_Label**：Lane 左侧显示 Stem_Display_Name 的 DOM 文字。
- **Lane_Function**：纯函数 `lanesAt(t, visData, { selected, width, height, reducedMotion, pastSec, futureSec })`，返回时刻 t 的 Lane_Strip Shape 列表。
- **Lane_Canvas**：Lane_Strip 中绘制 Lane_Function 输出的 `<canvas>` 元素（`#laneCanvas`）。
- **Lane_Visualizer**：负责实时绘制 Lane_Canvas 的 Live_Visualizer 实例。
- **Cover_Canvas**：stem-visualizer 的 `#visCanvas`；本功能起只用于 Audio_Only_Source 的封面替换。
- **Stacked_Layout**：Video_Source 带可视化导出的版式：原画面在上，Lane_Strip 在下，两者不重叠。
- **Strip_Render_Size**：Server 渲染 Lane_Strip 帧的像素尺寸。

## Requirements

### Requirement 1: 视频文件的可视化不遮挡画面

**User Story:** 作为练舞的人，我希望打开可视化后仍能完整看到视频里的动作，这样我能边看动作边看节奏。

修订 stem-visualizer Requirement 6.1。

#### Acceptance Criteria

1. WHILE Source_File 为 Video_Source，THE App SHALL 隐藏 Cover_Canvas，并且不在视频画面区域内绘制任何可视化内容。
2. WHILE Source_File 为 Video_Source 且可视化已打开，THE App SHALL 在 `.media-card` 内、`.stage` 与 `.controls` 之间显示 Lane_Strip，宽度等于 `.media-card` 的宽度。
3. THE App SHALL 让 Lane_Strip 与 `.stage` 在页面上没有重叠的区域。
4. WHILE Source_File 为 Audio_Only_Source，THE App SHALL 隐藏 Lane_Strip，并按 stem-visualizer Requirement 6.2、6.3 显示 Cover_Canvas。
5. THE App SHALL 把 Lane_Strip 的显示高度设为 `clamp(112, 0.2 × .media-card 宽度, 160)` CSS 像素，背景色为 `#0b0d14`。

### Requirement 2: Lane 的布局、顺序和标签

**User Story:** 作为练舞的人，我希望每条音轨固定占一行、颜色和名字一眼能认出，这样我能同时看清鼓、贝斯和人声。

#### Acceptance Criteria

1. THE Lane_Function SHALL 为 Vis_Data 中每条有数据的 Derived_Stem 生成一条 Lane，Lane 自上而下的顺序与 Lane_Order 相同。
2. THE Lane_Function SHALL 让全部 Lane 的高度之和等于 Lane_Strip 高度，相邻 Lane 首尾相接、互不重叠。
3. THE Lane_Function SHALL 用 stem-visualizer `LAYER_COLORS` 中该 Stem 的颜色绘制该 Lane 的全部 Shape。
4. WHILE Lane_Strip 显示中，THE App SHALL 在每条高度不低于 14 CSS 像素的 Lane 左侧显示 Lane_Label，文字为该 Stem 的 Stem_Display_Name，字号 10 CSS 像素，竖直方向位于该 Lane 中线。
5. WHEN Lane_Layout 因 Selected_Stem、Vis_Data 或 Lane_Strip 尺寸变化而改变，THE App SHALL 在同一次界面更新中移动或隐藏 Lane_Label，使每个 Lane_Label 与其 Lane 对齐。

### Requirement 3: 时间窗口与滚动

**User Story:** 作为练舞的人，我希望看到接下来几秒的鼓点从右边移过来，这样我能提前准备下一个动作。

#### Acceptance Criteria

1. THE Lane_Function SHALL 把媒体时刻 τ 映射到横坐标 `x(τ) = playheadX + (τ − t) × width / (pastSec + futureSec)`，其中 `playheadX = width × pastSec / (pastSec + futureSec)`。
2. THE Lane_Function SHALL 在未指定 `pastSec` 和 `futureSec` 时使用 Past_Window 1 秒和 Future_Window 3 秒。
3. THE Lane_Function SHALL 只为落在 Lane_Window 内的 Onset 生成 Onset_Marker。
4. THE Live_Visualizer SHALL 以 Player 的 `currentTime` 作为 Lane_Function 的时刻 t，使播放速度改变时滚动速度按相同倍数改变。
5. WHEN 用户拖动进度条或 Player 因循环跳回开头，THE Lane_Visualizer SHALL 在下一次绘制时显示新 t 对应的 Lane_Window。
6. IF Lane_Window 有一部分在 0 之前或 Vis_Data 时长之后，THEN THE Lane_Function SHALL 把该部分的包络值视为 0，并且只为 0 到时长之间的 Onset 生成 Onset_Marker。

### Requirement 4: Lane 中的图形

**User Story:** 作为练舞的人，我希望每条音轨的起伏和鼓点都画得清楚好看，像 DJ 软件里的彩色波形一样。

#### Acceptance Criteria

1. THE Lane_Function SHALL 为每条 Envelope_Lane 生成以 Lane 中线为轴的上下对称 Band，横坐标 x 处的半高等于 `0.45 × Lane 高度 × 包络值(x 对应的时刻)`。
2. THE Lane_Function SHALL 为每条 Onset_Lane 生成以 Lane 中线为轴的淡 Band，半高等于 `0.35 × Lane 高度 × 包络值`，透明度不高于同一 Lane 中 Onset_Marker 透明度的 0.3 倍。
3. THE Lane_Function SHALL 为 Lane_Window 内每个 Onset 在其 Onset_Lane 中生成一个 Onset_Marker，Onset_Marker 的水平中心位于 `x(Onset 时刻)`，高度为 Lane 高度的 0.7 倍，竖直居中于 Lane 中线。
4. IF 一条 Onset_Lane 在 Lane_Window 内的 Onset 超过 48 个，THEN THE Lane_Function SHALL 只为离 t 最近的 48 个 Onset 生成 Onset_Marker（距离相同时取较早的 Onset）。
5. THE Lane_Function SHALL 以完整亮度绘制 Playhead 右侧（尚未播放）的 Band 和 Onset_Marker，以 0.45 倍亮度绘制 Playhead 左侧的 Band，以 0.4 倍亮度绘制 Playhead 左侧的 Onset_Marker。
6. THE Lane_Function SHALL 生成一条贯穿 Lane_Strip 全高的 Playhead，位于 `playheadX`，颜色为白色。
7. WHILE Reduced_Motion 未生效，WHEN 一条 Onset_Lane 的某个 Onset 时刻 τ 满足 `t − 0.15 < τ ≤ t`，THE Lane_Function SHALL 在 `(playheadX, 该 Lane 中线)` 处生成一个 Playhead_Flash，透明度为 `0.9 × (1 − (t − τ) / 0.15)²` 乘以该 Lane 的亮度系数；每条 Lane 最多一个，取最近的 Onset。
8. THE Lane_Function SHALL 在 Envelope 采样时只在对齐到采样间隔整数倍的时刻取值，使 t 变化时同一媒体时刻的波形高度保持不变。

### Requirement 5: 突出选中音轨

**User Story:** 作为练舞的人，我希望正在听的那条音轨在跑道里最大、最亮，其他音轨作为参考。

修订 stem-visualizer Requirement 4 在 Lane_Strip 中的含义。

#### Acceptance Criteria

1. WHILE Selected_Stem 是 Vis_Data 中有数据的一条 Derived_Stem 且 Lane 数大于 1，THE Lane_Function SHALL 让该 Stem 的 Lane 高度等于其他每条 Lane 高度的 3 倍。
2. WHILE Selected_Stem 为「原曲」或 Selected_Stem 在 Vis_Data 中没有数据，THE Lane_Function SHALL 让全部 Lane 等高。
3. THE Lane_Function SHALL 把 stem-visualizer `emphasisFor(该 Lane 的 Stem, selected)` 的亮度系数乘到该 Lane 每个 Shape 的透明度上。
4. WHEN 用户切换 Selected_Stem，THE Lane_Visualizer SHALL 在下一次绘制时使用新的 Lane_Layout 和亮度系数。

### Requirement 6: 开关、默认值和占位

**User Story:** 作为练舞的人，我希望视频文件默认就能看到跑道，并且它出现时不会让播放按钮突然跳位置。

修订 stem-visualizer Requirement 6.3、6.6。

#### Acceptance Criteria

1. WHERE 用户没有保存过视频文件的开关设置，THE App SHALL 对 Video_Source 默认打开可视化，对 Audio_Only_Source 默认打开可视化。
2. IF localStorage 中 `visVideo` 或 `visAudio` 缺失或不是布尔值，THEN THE App SHALL 使用 6.1 中的默认值；IF 是布尔值，THEN THE App SHALL 使用保存的值。
3. WHILE Source_File 为 Video_Source、可视化已打开且 Vis_Data 正在计算或已就绪，THE App SHALL 显示 Lane_Strip 并保留其高度。
4. WHILE Source_File 为 Video_Source 且 Vis_Data 正在计算，THE App SHALL 让 Lane_Canvas 只显示背景色 `#0b0d14`，并在 Vis_Toggle 旁显示「可视化准备中…」。
5. WHILE 可视化已关闭、Vis_Data 生成失败或尚未开始计算，THE App SHALL 隐藏 Lane_Strip，Lane_Strip 不占页面高度。
6. THE App SHALL 保留 Vis_Toggle 的位置、文字「可视化」、`aria-pressed`、不可点击条件和提示文字（stem-visualizer Requirement 6.4、6.5、2.6、2.7）。
7. WHEN 用户点击 Vis_Toggle，THE App SHALL 按 stem-visualizer Requirement 6.7 切换并保存当前文件类型的开关状态。

### Requirement 7: 无障碍和减少动态效果

**User Story:** 作为对闪烁敏感的人，我希望在开启「减少动态效果」时跑道仍然滚动、但不再闪光。

#### Acceptance Criteria

1. WHILE Reduced_Motion 生效，THE Lane_Function SHALL 输出与 Reduced_Motion 未生效时相同的 Shape 列表，只去掉全部 Playhead_Flash。
2. THE Lane_Function SHALL 让除 Playhead_Flash 外每个 Shape 的透明度只取决于其 Lane 的 Stem、Selected_Stem、Shape 的类别（Band、Onset_Marker、Playhead）以及它位于 Playhead 左侧还是右侧。
3. WHEN 浏览器的 `prefers-reduced-motion` 设置变化，THE Lane_Visualizer SHALL 在下一次绘制时使用新的设置。
4. THE App SHALL 给 Lane_Canvas 和 Lane_Label 的容器设置 `aria-hidden="true"`。

### Requirement 8: Lane_Function 的输出约束

**User Story:** 作为维护者，我希望跑道画面由一个可预测、有界的纯函数生成，便于测试和导出。

#### Acceptance Criteria

1. THE Lane_Function SHALL 对相同的 t、Vis_Data 和选项返回深度相等的 Shape 列表，并且不修改参数和 Vis_Data。
2. THE Lane_Function SHALL 每帧输出不超过 Max_Shapes 个 Shape，每个 Shape 的数值都是有限数，透明度在 0 到 1 之间，颜色分量是 0 到 255 的整数，半径、宽度、高度、半高和发光宽度不小于 0。
3. THE Lane_Function SHALL 让每个 Band 和 Onset_Marker 的核心区域（不含发光）在竖直方向上位于其所属 Lane 的 `[y, y + h]` 之内。
4. THE Lane_Function SHALL 让每个 Band 的 `x0` 不小于 `−Δ × width / (pastSec + futureSec)`、`x1` 不大于 `width + Δ × width / (pastSec + futureSec)`，其中 Δ 为采样间隔。
5. IF `width` 或 `height` 不是不小于 1 的有限数，或 Vis_Data 中没有任何 Stem，THEN THE Lane_Function SHALL 返回空列表。
6. THE Lane_Function SHALL 只使用 ECMAScript 内置对象和同构模块（`vis-data.js`、`vis-scene.js`），使同一模块能在浏览器和 Node 中导入。

### Requirement 9: Band 图元

**User Story:** 作为维护者，我希望填充波形在实时画面和导出视频里有一致的外观。

#### Acceptance Criteria

1. THE Software_Rasterizer SHALL 绘制 Band：在 `[x0, x1]` 内每个像素列按等距采样的 `hs` 线性插值得到半高 h，像素中心到中线的竖直距离为 dy 时，覆盖率为 stem-visualizer 的 `cov(dy − h)`。
2. THE Software_Rasterizer SHALL 只修改 Band 外接范围（`[x0, x1]` 乘以 `[y − max(hs) − glow, y + max(hs) + glow]`）内的像素。
3. THE Software_Rasterizer SHALL 对 `hs` 全部等于 h 的 Band 与 `ys` 全部等于 y、`width = 2h` 的 `wave` 产生逐字节相同的缓冲区（发光宽度、颜色、透明度和横向范围相同）。
4. THE Canvas_Backend SHALL 以加法合成绘制 Band：先填充半高加 glow 的轮廓、透明度乘 0.25，再填充半高轮廓。
5. IF Band 的 `hs` 为空或含非有限数，THEN THE Software_Rasterizer 与 Canvas_Backend SHALL 跳过该 Band。

### Requirement 10: 实时显示的调度与性能

**User Story:** 作为用手机练舞的人，我希望加了跑道以后播放依然流畅。

#### Acceptance Criteria

1. THE App SHALL 用 stem-visualizer 的 `createLiveVisualizer` 创建 Lane_Visualizer，以 Lane_Canvas 为画布、Lane_Function 为场景函数，调度规则与 stem-visualizer Requirement 5.2、5.3、8.1–8.3 相同。
2. THE Lane_Visualizer SHALL 把 Lane_Canvas 的像素尺寸设为显示尺寸乘以设备像素比，设备像素比最多取 2。
3. WHILE Source_File 为 Video_Source，THE App SHALL 只让 Lane_Visualizer 绘制，Cover_Canvas 对应的 Live_Visualizer 不绘制、不安排动画帧。
4. THE Lane_Function SHALL 每帧对每条 Lane 最多计算 402 个包络采样。

### Requirement 11: 带可视化导出的上传参数

**User Story:** 作为练舞的人，我希望导出的带可视化视频也不挡画面。

修订 stem-visualizer Requirement 10.1、10.2、10.4。

#### Acceptance Criteria

1. THE App SHALL 对 Video_Source 的 Vis_Export 使用 `layout=stacked`，对 Audio_Only_Source 使用 `layout=standalone`。
2. IF `layout` 不是 `stacked` 或 `standalone`（区分大小写，包括 `overlay`），THEN THE Export_Service SHALL 返回 400 `可视化布局参数无效`，并且不写入任何文件。
3. THE Export_Service SHALL 对 `layout=stacked` 的请求使用 stem-visualizer Requirement 10 中除 10.2、10.4 外的全部分帧、校验、上限和清理规则。
4. THE App SHALL 保持 Vis_Export 的文件名规则（`-<Stem_Display_Name>-可视化.<扩展名>`）、进度文字和取消行为不变。

### Requirement 12: 服务器端叠放合成

**User Story:** 作为练舞的人，我希望导出的视频上半部分是完整的原画面，下半部分是跑道。

修订 stem-visualizer Requirement 11.2、11.4、11.5、11.8。

#### Acceptance Criteria

1. IF `layout=stacked` 而 Source_File 中找不到画面流，THEN THE Export_Service SHALL 将 Vis_Export_Job 标记为失败，`error` 为「文件里没有画面」。
2. THE Export_Service SHALL 由画面显示尺寸 (w, h) 计算输出宽度 OW、画面高度 PH 和 Lane_Strip 高度 SH：三者都是不小于 2 的偶数，`OW ≤ 1920`，`PH + SH ≤ 1920`，`SH = max(96, 偶数(round(0.2 × OW)))`，画面按原宽高比缩小（不放大）。
3. IF 画面显示尺寸无法读出，THEN THE Export_Service SHALL 按 1280×720 的画面计算 OW、PH 和 SH，并在画面区域内保持原宽高比、用黑边补齐。
4. THE Export_Service SHALL 以 Strip_Render_Size 渲染 Lane_Strip：宽度为 `偶数(min(OW, 960))`，高度为 `max(2, 偶数(round(SH × 宽度 / OW)))`。
5. THE Export_Service SHALL 以 30 fps 渲染 `ceil(D × 30)` 帧，第 k 帧为 Lane_Function 在 `t = k / 30` 的输出，使用 Vis_Payload 中的强调 Stem id、关闭的 Reduced_Motion 和背景色 `#0b0d14`，像素以 `rgb24` 写入 FFmpeg 标准输入。
6. WHERE `layout=stacked`，THE Export_Service SHALL 把原画面缩放并补边到 OW×PH、把 Lane_Strip 帧缩放到 OW×SH，再竖直拼接为 OW×(PH + SH) 的画面，输出中不使用任何混合滤镜。
7. THE Export_Service SHALL 对 `layout=stacked` 使用 stem-visualizer Requirement 11.6、11.7、11.10–11.14 中的输入格式、背压、编码参数、进度、错误、取消、超时和让出事件循环规则。
8. WHERE `layout=standalone`，THE Export_Service SHALL 保持 stem-visualizer 中 Standalone_Layout 的渲染和合成行为不变。

### Requirement 13: 浏览器录制回退的叠放版式

**User Story:** 作为没有装 FFmpeg 的练舞的人，我希望浏览器录出来的视频版式和快速导出一样。

修订 stem-visualizer Requirement 14.3。

#### Acceptance Criteria

1. WHILE Vis_Browser_Recording 对 Video_Source 进行中，THE App SHALL 使用宽度不超过 1280、总高度不超过 1280 的录制画布，按 12.2 的规则（以 1280 代替 1920）计算画面区域高度和 Lane_Strip 高度。
2. WHILE Vis_Browser_Recording 对 Video_Source 进行中，THE App SHALL 在每个动画帧把当前视频画面按原宽高比画进录制画布上方的画面区域，再在下方区域画出以 Export_Stem 为强调、关闭 Reduced_Motion 的 Lane_Function 输出。
3. THE App SHALL 让录制画布的 Lane_Strip 区域只包含 Lane_Function 的绘制结果，画面区域只包含视频画面和黑边。
4. WHILE Vis_Browser_Recording 对 Audio_Only_Source 进行中，THE App SHALL 保持 stem-visualizer Requirement 14.3 中纯音频的合成方式不变。

### Requirement 14: 渲染性能

**User Story:** 作为练舞的人，我希望带跑道的快速导出仍然快于实时。

#### Acceptance Criteria

1. WHEN 在开发机上以 960×192 渲染一段 3 分钟、8 条 Stem 都有数据、鼓和额外打击乐每秒 4 个 Onset 的 Vis_Data，THE Lane_Function 与 Software_Rasterizer SHALL 以平均每帧少于 33 ms 的速度生成帧。
2. THE 测试套件 SHALL 用环境变量 `BENCH_PERF=1` 开启 14.1 的性能测试，未设置时跳过。

### Requirement 15: 不影响现有功能

**User Story:** 作为练舞的人，我希望改了视频的可视化以后，纯音频的可视化、播放、分离和普通导出都照常工作。

#### Acceptance Criteria

1. THE App SHALL 保持 Audio_Only_Source 的封面替换可视化、Scene_Function 和 Standalone_Layout 导出的行为不变。
2. THE App SHALL 在可视化关闭时保持视频文件练习室的画面、控件和播放行为与 stem-visualizer 加入前相同。
3. THE App SHALL 保持 Vis_Data 的计算、缓存（`entry.cache.vis`）、Vis_Payload 格式和 `entry.cache.urls` 不变。
4. THE Export_Service SHALL 保持不带可视化参数的 `/api/export` 请求和 Demucs_Service 的行为不变。
5. THE App SHALL 不引入任何浏览器端第三方依赖，THE Export_Service SHALL 只使用 Node ≥ 18 内置模块和项目内的相对模块。

### Requirement 16: 测试和文档

**User Story:** 作为维护者，我希望跑道有自动化测试覆盖，README 说明新的显示方式和导出版式。

#### Acceptance Criteria

1. THE 测试套件 SHALL 用属性测试覆盖 Lane_Function 的确定性、Shape 数和数值范围、时间窗口映射、Lane 顺序与高度、亮度系数和 Reduced_Motion 规则。
2. THE 测试套件 SHALL 测试 Band 在 Software_Rasterizer 中的覆盖率、影响范围、与 `wave` 的等价和绘制顺序无关，以及 Canvas_Backend 绘制 Band 的调用。
3. THE 测试套件 SHALL 用属性测试覆盖叠放尺寸计算和 `layout=stacked` 的合成参数，并用真实 HTTP 服务和 Fake_FFmpeg 测试 `layout=stacked` 的完整导出流程和 `layout=overlay` 的 400。
4. THE 测试套件 SHALL 用模拟的 DOM 测试 App：视频文件在画面下方显示 Lane_Strip 而 Cover_Canvas 隐藏、纯音频文件显示 Cover_Canvas、视频文件默认打开、计算中占位、Lane_Label 的显示门限和导出时使用 `layout=stacked`。
5. THE 测试套件 SHALL 更新 stem-visualizer 中断言 overlay 行为或视频默认关闭的现有测试，使其断言本文档的新行为，其余现有测试继续通过。
6. THE README SHALL 更新「可视化」一节（Lane_Strip 的位置、Lane_Order、时间窗口、标记和闪光、选中音轨、默认值、减少动态效果）和「带可视化导出」一节（叠放版式和尺寸、`layout=stacked`、`overlay` 已删除、浏览器录制版式），并列出新增测试和性能测试的开启方式。
