# Requirements Document

## Introduction

本功能在「层间」的练习室里加一个「导出」按钮，把当前选中的那条音轨导出成文件，方便拿去剪辑或分享练舞素材。用户可以选：

1. **导出视频**：原视频画面配上选中的音轨，替换掉原来的声音。
2. **只导出音频（WAV）**：直接保存选中音轨的 WAV。

导出视频有两条路径：

1. **服务器端 FFmpeg 合成（首选）**：浏览器把原视频和音轨 WAV 上传到本地 Node 服务器（新接口，前缀 `/api/export`），由 FFmpeg 合成 MP4。H.264 / HEVC 画面直接复制、不重新编码；VP8、VP9 等不能放进 MP4 的画面重新编码为 H.264。音频编码为 AAC。输出一律是 MP4。
2. **浏览器实时录制（回退）**：服务器没有 FFmpeg、服务器连不上或 FFmpeg 任务失败时，浏览器用 `captureStream` + `MediaRecorder` 从头到尾以 1 倍速实时录制一遍画面和音轨，输出 WEBM。浏览器不支持这两个接口（例如 iOS Safari）时，提示无法导出视频，WAV 导出照常可用。

范围决定：

- 「原曲」就是原文件本身，导出它没有意义。选中「原曲」时「导出」按钮不可用，并提示原因。
- 纯音频文件（没有画面）只能导出 WAV，点「导出」直接保存 WAV，不出现选择项。
- 导出始终是 1 倍速、完整长度，和当前播放速度、播放位置、循环设置无关。

约束：浏览器端保持零依赖；Server 只用 Node ≥ 18 内置模块、ES 模块、无 npm 依赖；文件只发往用户自己电脑上的本地 Server；测试命令为 `node --test tests/*.test.mjs`，FFmpeg 用假的 FFmpeg 脚本（测试夹具）代替；`player.js` 的播放同步、`library.js` 的缓存行为、Demucs_Service 和全部现有测试保持可用；更新 README。

### 已确认的取值

以下取值已由用户确认（上传上限和任务超时按用户要求调整）：

| 项目 | 确认值 | 理由 |
| --- | --- | --- |
| 上传大小上限 `EXPORT_MAX_UPLOAD_MB` | 10240 MB（10 GB，原视频和音轨 WAV 合计） | 用户确认；为较大的原视频留出充足余量 |
| 未完成任务上限 | 4 个（上传中 + 排队中 + 运行中） | 与 Demucs_Service 一致 |
| 同时运行的 FFmpeg 进程 | 1 个 | 与 Demucs_Service 一致 |
| 单个任务超时 `EXPORT_TIMEOUT_MIN` | 30 分钟（含探测和合成） | 用户确认；直接复制画面通常几秒到几十秒，长视频在 CPU 上重新编码为 H.264 可能需要较长时间 |
| 结果保留时间 | 30 分钟（或收到 `DELETE`，先到者为准） | 与 Demucs_Service 一致 |
| 失败 / 取消任务的状态保留 | 5 分钟 | 与 Demucs_Service 一致 |
| FFmpeg 启动检测超时 | 10 秒 | 与 Demucs_Service 一致 |
| Server 状态检测超时（App 侧） | 3 秒 | 与 Demucs 状态检测一致 |
| AAC 码率 | 192 kbps | 常见的高质量设置 |
| 重新编码 H.264 的参数 | `libx264`，`-preset veryfast`，`-crf 20`，`yuv420p` | 兼顾速度和画质，`yuv420p` 让大多数播放器能播 |
| 文件名主体最大长度 | 80 个字符 | 避免超过常见文件系统的长度限制 |

## Glossary

- **App**：运行在浏览器中的「层间」前端（`public/js/app.js` 及其加载的模块）。
- **Server**：项目根目录下 `server.js` 提供的本地 Node HTTP 服务器。
- **Export_Service**：Server 内负责检测 FFmpeg、接收导出上传、排队、运行 FFmpeg 并返回结果的部分，接口前缀为 `/api/export`。
- **Demucs_Service**：Server 内已有的 Demucs 分离服务（`demucs-service.js`），接口前缀为 `/api/separate`。
- **FFmpeg**：FFmpeg 命令行工具，由用户自行安装在 Server 所在机器上。
- **FFmpeg_Command**：Server 用来调用 FFmpeg 的可执行文件及固定参数；默认 `ffmpeg`，可通过环境变量 `FFMPEG_CMD` 覆盖，解析规则与 `DEMUCS_CMD` 相同（JSON 字符串数组，或用空白分隔、双引号括住含空格的部分）。
- **Export_Job**：Export_Service 中针对一次导出上传创建的任务，具有 Server 生成的任务 ID 和状态（上传中、排队中、处理中、已完成、失败、已取消）。
- **Job_ID**：Server 用加密安全随机数生成的 32 位小写十六进制字符串。
- **Export_Queue**：Export_Service 中按先进先出顺序保存 Export_Job 的队列，同一时间只运行 1 个 FFmpeg 进程。
- **Export_Temp_Directory**：Export_Service 存放上传文件和 FFmpeg 输出的临时目录，位于 `os.tmpdir()/cengjian-export`。
- **Source_File**：用户在练习室打开的原文件（视频或纯音频）。
- **Video_Source**：带画面的 Source_File。
- **Audio_Only_Source**：没有画面的 Source_File。
- **Stem**：9 个音轨按钮之一对应的音频。
- **Derived_Stem**：除「原曲」外的 8 条 Stem（纯伴奏、人声、鼓、贝斯、和声伴奏、额外打击乐、效果音、其他音效），每条在 App 中是一个 WAV Blob。
- **Selected_Stem**：练习室当前选中的 Stem。
- **Export_Stem**：用户点击 Export_Button 时的 Selected_Stem，是本次导出的目标音轨；导出过程中切换 Selected_Stem 不改变 Export_Stem。本文档中「导出 Selected_Stem」均指导出 Export_Stem。
- **Stem_Display_Name**：Stem 按钮上的中文名，例如「人声」「鼓」「纯伴奏」。
- **Export_Button**：练习室里的「导出」按钮。
- **Export_Chooser**：点 Export_Button 后出现的选择界面，包含「导出视频」和「只导出音频（WAV）」两项。
- **Video_Export**：把 Video_Source 的画面和 Selected_Stem 的音频合成一个视频文件的导出。
- **WAV_Export**：直接保存 Selected_Stem 的 WAV Blob 的导出。
- **Server_Mux**：由 Export_Service 调用 FFmpeg 完成的 Video_Export。
- **Copyable_Video_Codec**：可以不重新编码直接放进 MP4 的画面编码，本功能中指 H.264（`h264`）和 HEVC（`hevc`）。
- **Browser_Recording**：在浏览器里用 `HTMLMediaElement.captureStream()` 和 `MediaRecorder` 以 1 倍速实时录制画面和 Selected_Stem 音频的 Video_Export，输出 WEBM。
- **Export_Progress**：导出进度，取值为 0 到 100 的整数百分比，或「未知」。
- **Export_File_Name**：导出文件名，格式为 `<Source_File 名去扩展名>-<Stem_Display_Name>.<扩展名>`，扩展名为 `mp4`、`webm` 或 `wav`。
- **Unsafe_File_Name_Character**：Windows、macOS、Linux 文件名中不允许或有风险的字符，即 `\ / : * ? " < > |` 和 Unicode 控制字符（U+0000 到 U+001F、U+007F）。
- **Playback_State**：练习室播放器的状态，包括播放位置、播放速度、是否在播放、是否循环、Selected_Stem。
- **Player**：`player.js` 中的同步播放器。
- **Library_Cache**：`library.js` 中按最近使用顺序保存分离结果的缓存。
- **Fake_FFmpeg**：测试夹具中的 Node 脚本，模拟 FFmpeg 的版本输出、编码信息、`-progress` 输出、生成结果文件、失败和超时。

## Requirements

### Requirement 1: 导出按钮的可用条件

**User Story:** 作为练舞的人，我希望「导出」按钮只在能导出时可点，这样我不会点了之后才发现导不出来。

#### Acceptance Criteria

1. THE App SHALL 在练习室的音轨区显示一个 Export_Button，按钮文字为「导出」。
2. WHILE Source_File 的分离未完成，THE App SHALL 将 Export_Button 设为不可点击。
3. WHILE Selected_Stem 为「原曲」，THE App SHALL 将 Export_Button 设为不可点击，并在按钮旁显示提示「原曲就是原文件，无需导出」。
4. WHILE 分离已完成且 Selected_Stem 为一条已生成 WAV Blob 的 Derived_Stem，THE App SHALL 将 Export_Button 设为可点击。
5. IF Selected_Stem 是 Derived_Stem 但对应的 WAV Blob 不存在，THEN THE App SHALL 将 Export_Button 设为不可点击。
6. WHILE 一次导出正在进行，THE App SHALL 将 Export_Button 设为不可点击。
7. WHEN 用户在导出进行中打开另一个 Source_File，THE App SHALL 取消当前导出，取消方式与 Requirement 11 相同。

### Requirement 2: 选择导出方式

**User Story:** 作为练舞的人，我希望能选导出带画面的视频还是只导出音频，这样我可以按用途拿到合适的文件。

#### Acceptance Criteria

1. WHEN 用户在 Source_File 为 Video_Source 时点击 Export_Button，THE App SHALL 显示 Export_Chooser，包含「导出视频」「只导出音频（WAV）」和「取消」三项。
2. WHEN 用户在 Source_File 为 Audio_Only_Source 时点击 Export_Button，THE App SHALL 直接开始 WAV_Export，不显示 Export_Chooser。
3. WHEN 用户在 Export_Chooser 中选择「只导出音频（WAV）」，THE App SHALL 开始 WAV_Export。
4. WHEN 用户在 Export_Chooser 中选择「导出视频」，THE App SHALL 开始 Video_Export。
5. WHEN 用户在 Export_Chooser 中选择「取消」，THE App SHALL 关闭 Export_Chooser 并保持 Playback_State 不变。
6. WHEN 一次导出开始，THE App SHALL 记录 Export_Stem 及其 WAV Blob URL，并在本次导出的全部步骤（含改用 Browser_Recording 和生成 Export_File_Name）中使用记录的 Export_Stem。

### Requirement 3: WAV 导出

**User Story:** 作为练舞的人，我希望马上拿到选中音轨的 WAV 文件，这样我可以导入剪辑软件。

#### Acceptance Criteria

1. WHEN WAV_Export 开始，THE App SHALL 以 Export_File_Name（扩展名 `wav`）下载 Selected_Stem 的 WAV Blob，Blob 内容与播放用的 WAV Blob 逐字节相同。
2. THE App SHALL 在浏览器内完成 WAV_Export，不向 Server 发送请求。
3. WHEN WAV_Export 的下载触发完成，THE App SHALL 回收本次导出创建的 Blob URL，并保留 Player 和 Library_Cache 使用的 Blob URL。
4. WHILE 浏览器不支持 Browser_Recording 且 Export_Service 不可用，THE App SHALL 保持 WAV_Export 可用。

### Requirement 4: 导出文件名

**User Story:** 作为练舞的人，我希望导出的文件名一看就知道是哪首歌的哪条音轨，并且在任何系统上都能保存。

#### Acceptance Criteria

1. THE App SHALL 按 `<Source_File 名去掉最后一个扩展名>-<Stem_Display_Name>.<扩展名>` 生成 Export_File_Name，Server_Mux 的扩展名为 `mp4`，Browser_Recording 为 `webm`，WAV_Export 为 `wav`。
2. THE App SHALL 将文件名主体中的每个 Unsafe_File_Name_Character 替换为 `_`。
3. THE App SHALL 去掉文件名主体首尾的空格和句点。
4. IF 处理后的 Source_File 名为空，THEN THE App SHALL 用「导出」代替 Source_File 名。
5. IF 文件名主体超过 80 个字符，THEN THE App SHALL 截短 Source_File 名部分，使文件名主体不超过 80 个字符，并完整保留 `-<Stem_Display_Name>`。
6. THE App SHALL 只在浏览器端使用 Export_File_Name，发往 Server 的请求中不包含 Source_File 名。

### Requirement 5: 选择视频导出路径

**User Story:** 作为练舞的人，我希望 app 自动用最好的方式导出视频，失败时自动换一种方式，不用我来判断。

#### Acceptance Criteria

1. WHEN Video_Export 开始，THE App SHALL 请求 `GET /api/export/status`，并在 3 秒内未收到响应时视为 Export_Service 不可达。
2. WHEN 状态响应表明 FFmpeg 可用，THE App SHALL 使用 Server_Mux。
3. IF 状态响应表明 FFmpeg 不可用，或 Export_Service 不可达，THEN THE App SHALL 改用 Browser_Recording。
4. IF Server_Mux 的上传失败（包括 413、429、500、503 和网络错误）、Export_Job 状态为失败、或下载结果失败，THEN THE App SHALL 改用 Browser_Recording，并显示失败原因和「改用浏览器录制」的提示。
5. IF 需要使用 Browser_Recording 而浏览器不支持 `HTMLMediaElement.captureStream`（含带前缀的 `mozCaptureStream`）或 `MediaRecorder`，THEN THE App SHALL 显示「当前浏览器无法导出视频，可以选择只导出音频（WAV）」并提供 WAV_Export 入口。
6. THE App SHALL 只向提供当前页面的本地 Server 发送导出文件。

### Requirement 6: 服务器端 FFmpeg 检测和配置

**User Story:** 作为在自己电脑上运行服务器的人，我希望服务器启动时自动检测 FFmpeg，并能通过环境变量指定 FFmpeg 路径和限制。

#### Acceptance Criteria

1. WHEN Server 启动，THE Export_Service SHALL 用 FFmpeg_Command 加参数 `-version` 运行一次检测，检测超时为 10 秒。
2. WHEN 检测进程以退出码 0 结束，THE Export_Service SHALL 将 FFmpeg 标记为可用。
3. IF 检测进程退出码非 0、命令不存在、超时，或 `FFMPEG_CMD` 无法解析，THEN THE Export_Service SHALL 将 FFmpeg 标记为不可用，并在 Server 日志中记录原因。
4. THE Export_Service SHALL 通过 `child_process.execFile` 或 `child_process.spawn` 以参数数组方式运行 FFmpeg，不经过 shell。
5. THE Export_Service SHALL 从环境变量 `EXPORT_MAX_UPLOAD_MB`（正整数，单位 MB，默认 10240）读取上传大小上限，从 `EXPORT_TIMEOUT_MIN`（正数，单位分钟，默认 30）读取单个任务超时；IF 取值无效，THEN THE Export_Service SHALL 使用默认值。
6. WHEN App 请求 `GET /api/export/status`，THE Export_Service SHALL 返回 JSON，包含 `available`（FFmpeg 是否可用）、`checking`（是否仍在检测）、`maxUploadBytes` 和 `queueLength`。
7. THE Server SHALL 在 FFmpeg 不可用时继续提供静态文件和 Demucs_Service。

### Requirement 7: 导出任务的上传与接口语义

**User Story:** 作为在自己电脑上运行服务器的人，我希望导出接口的行为和 AI 分离接口一致，出错时有明确的状态码。

#### Acceptance Criteria

1. WHEN App 向 Export_Service 提交一次导出，THE App SHALL 上传 Source_File 和 Selected_Stem 的 WAV，并以白名单扩展名（与 Demucs_Service 的上传扩展名白名单相同）告知 Source_File 的格式。
2. WHEN 导出上传完整接收，THE Export_Service SHALL 创建 Export_Job，返回 202 和 `{ id, status: "queued", position }`，其中 `id` 为 Job_ID。
3. IF FFmpeg 不可用，THEN THE Export_Service SHALL 返回 503，并且不写入任何文件。
4. IF 请求缺少 Source_File 或 WAV、扩展名参数缺失，或上传的 WAV 不是 RIFF/WAVE 格式，THEN THE Export_Service SHALL 返回 400，并删除该请求已写入的文件。
5. IF 上传数据总量超过 `EXPORT_MAX_UPLOAD_MB`，THEN THE Export_Service SHALL 停止接收、删除已写入的部分并返回 413。
6. IF 上传中、排队中和运行中的 Export_Job 合计已有 4 个，THEN THE Export_Service SHALL 对新的导出请求返回 429，并且不写入任何文件。
7. IF 请求中的任务 ID 不符合 Job_ID 格式或不存在，THEN THE Export_Service SHALL 返回 404。
8. IF 上传连接在接收完成前断开，THEN THE Export_Service SHALL 删除该请求已写入的文件并释放其在 Export_Queue 中占用的名额。
9. WHEN App 请求 `GET /api/export/<id>`，THE Export_Service SHALL 返回任务状态：`queued`（带排队位置 `position`）、`running`（带 Export_Progress `progress`）、`done`、`failed`（带 `error`）或 `cancelled`。
10. WHEN App 请求已完成任务的结果，THE Export_Service SHALL 以 `video/mp4` 类型返回 MP4 文件。
11. IF App 请求未完成任务的结果，THEN THE Export_Service SHALL 返回 404。
12. WHEN App 对某个 Export_Job 发送 `DELETE /api/export/<id>`，THE Export_Service SHALL 取消该任务（运行中则终止 FFmpeg 进程）并删除该任务的全部文件。
13. IF 创建任务目录或写入上传文件失败（例如磁盘已满），THEN THE Export_Service SHALL 返回 500，删除该请求已写入的文件并释放其在 Export_Queue 中占用的名额。

### Requirement 8: FFmpeg 合成规则

**User Story:** 作为练舞的人，我希望导出的视频画质不损失、能在手机和电脑上直接播放。

#### Acceptance Criteria

1. THE Export_Service SHALL 以 MP4 格式输出 Server_Mux 结果，结果包含 Source_File 的第一条画面流和上传 WAV 的音频，不包含 Source_File 原有的音频。
2. WHEN Source_File 第一条画面流的编码是 Copyable_Video_Codec，THE Export_Service SHALL 直接复制画面流，不重新编码。
3. WHEN Source_File 第一条画面流的编码不是 Copyable_Video_Codec（例如 VP8、VP9、AV1、MPEG-4 Part 2），THE Export_Service SHALL 将画面重新编码为 H.264（`libx264`，`-preset veryfast`，`-crf 20`，像素格式 `yuv420p`）。
4. THE Export_Service SHALL 将上传 WAV 的音频编码为 192 kbps 的 AAC。
5. THE Export_Service SHALL 让输出时长等于 FFmpeg 报告的 Source_File 时长（`Duration`），音轨 WAV 较短时用静音补齐；IF 时长无法读出，THEN THE Export_Service SHALL 让输出在画面结束时结束。
6. THE Export_Service SHALL 在 MP4 输出中把索引信息放在文件开头（`-movflags +faststart`）。
7. WHEN Source_File 的画面编码为 HEVC，THE Export_Service SHALL 将画面流标记为 `hvc1`，使 Apple 设备能播放。
8. IF Source_File 中找不到画面流，THEN THE Export_Service SHALL 将 Export_Job 标记为失败，`error` 说明「文件里没有画面」。

### Requirement 9: 服务器端进度、排队和超时

**User Story:** 作为练舞的人，我希望看到导出进度，排队时知道前面还有几个。

#### Acceptance Criteria

1. THE Export_Service SHALL 同一时间只运行 1 个 FFmpeg 合成进程，其余 Export_Job 按先进先出顺序排队。
2. WHILE Export_Job 正在运行，THE Export_Service SHALL 用 FFmpeg `-progress` 输出中最近一次的 `out_time_us`（或 `out_time_ms`）除以 Source_File 时长，计算出取整并限制在 0 到 100 之间的 Export_Progress。
3. IF Source_File 时长无法从 FFmpeg 输出中读出，THEN THE Export_Service SHALL 将 Export_Progress 报告为未知（`null`）。
4. IF Export_Job 从开始运行（含探测和合成）起超过 `EXPORT_TIMEOUT_MIN` 仍未结束，THEN THE Export_Service SHALL 终止当前 FFmpeg 进程，将 Export_Job 标记为失败，`error` 说明超时。
5. IF FFmpeg 合成进程以非 0 退出码结束，THEN THE Export_Service SHALL 将 Export_Job 标记为失败，并在 `error` 中给出 FFmpeg 标准错误的最后一行（不超过 200 个字符）。
6. WHILE Server_Mux 进行中，THE App SHALL 每秒查询一次任务状态，并显示「上传到本地服务器…」「排队中（第 N 位）」「合成视频 N%」或「合成视频中…」（进度未知时）。

### Requirement 10: 临时文件和安全

**User Story:** 作为在自己电脑上运行服务器的人，我希望导出不会在电脑上留下垃圾文件，也不会因为文件名被利用。

#### Acceptance Criteria

1. WHEN Server 启动，THE Export_Service SHALL 清空 Export_Temp_Directory。
2. THE Export_Service SHALL 只用 Export_Temp_Directory、Job_ID 和白名单扩展名拼出文件路径，App 提供的任何名称都不进入文件路径。
3. WHEN Export_Job 完成，THE Export_Service SHALL 立即删除该任务的上传文件，只保留 MP4 结果。
4. WHEN App 下载完结果后发送 `DELETE`，或结果已保留 30 分钟，THE Export_Service SHALL 删除该任务目录，以先到者为准。
5. WHEN Export_Job 失败或被取消，THE Export_Service SHALL 立即删除该任务目录，并保留任务状态 5 分钟供 App 查询。
6. WHEN App 下载完 Server_Mux 结果，THE App SHALL 发送 `DELETE /api/export/<id>`。
7. THE Server SHALL 把 Export_Service 的代码放在 `public/` 目录之外，使其不会作为静态文件被访问。

### Requirement 11: 取消导出

**User Story:** 作为练舞的人，我希望随时能取消正在进行的导出。

#### Acceptance Criteria

1. WHILE Video_Export 进行中，THE App SHALL 显示 Export_Progress 和一个「取消导出」按钮。
2. WHEN 用户在 Server_Mux 进行中点击「取消导出」，THE App SHALL 中止上传或停止轮询，发送 `DELETE /api/export/<id>`（已获得 Job_ID 时），并且不改用 Browser_Recording。
3. WHEN 用户在 Browser_Recording 进行中点击「取消导出」，THE App SHALL 停止录制、丢弃已录制的数据且不下载任何文件。
4. WHEN 一次导出被取消，THE App SHALL 显示「已取消导出」，并恢复 Export_Button 的可用状态。

### Requirement 12: 浏览器实时录制

**User Story:** 作为没有装 FFmpeg 的练舞的人，我希望仍然能在浏览器里导出带画面的视频。

#### Acceptance Criteria

1. WHEN Browser_Recording 开始，THE App SHALL 把 Player 切换到 Export_Stem、播放位置设为 0、播放速度设为 1 倍、关闭循环，并从头播放到 Source_File 结束。
2. THE App SHALL 录制 Source_File 的画面和 Export_Stem 的音频，录制结果中不包含 Source_File 原有的音频。
3. THE App SHALL 以 WEBM 格式输出 Browser_Recording 结果，并从 `MediaRecorder.isTypeSupported` 返回 true 的 WEBM 类型中选择（依次尝试 `video/webm;codecs=vp9,opus`、`video/webm;codecs=vp8,opus`、`video/webm`）。
4. IF 上述 WEBM 类型均不受支持，THEN THE App SHALL 按 Requirement 5.5 提示无法导出视频并提供 WAV_Export 入口。
5. WHILE Browser_Recording 进行中，THE App SHALL 显示「浏览器录制中 N%」，N 为当前播放位置除以 Source_File 时长后取整的百分比，并提示录制需要和视频一样长的时间。
6. WHILE Browser_Recording 进行中，THE App SHALL 将播放、暂停、拖动进度、变速、循环和音轨按钮设为不可操作。
7. WHEN Source_File 播放到结尾，THE App SHALL 停止录制并以 Export_File_Name（扩展名 `webm`）下载结果。
8. IF 录制过程中出现 `MediaRecorder` 错误或媒体元素播放错误，THEN THE App SHALL 停止录制、不下载文件，并显示失败原因。
9. WHEN Browser_Recording 结束（完成、取消或失败），THE App SHALL 将 Playback_State 恢复到录制开始前的值。

### Requirement 13: 不影响现有功能

**User Story:** 作为练舞的人，我希望导出不会打乱我正在练的内容。

#### Acceptance Criteria

1. THE App SHALL 在导出过程中保持 Library_Cache 中的分离结果和 Blob URL 不变。
2. WHEN Server_Mux 进行中，THE App SHALL 保持 Player 的播放、变速、拖动和切换音轨可用。
3. THE App SHALL 在 WAV_Export 和 Server_Mux 结束后保持 Playback_State 不变。
4. IF 导出失败，THEN THE App SHALL 在练习室显示失败原因，并保持 Export_Button 可用以便重试。
5. THE App SHALL 不引入任何浏览器端第三方依赖。
6. THE Export_Service SHALL 只使用 Node ≥ 18 内置模块。
7. THE Server SHALL 保持 Demucs_Service 的接口和行为不变。

### Requirement 14: 测试和文档

**User Story:** 作为维护者，我希望导出功能有自动化测试覆盖，README 说明怎么用。

#### Acceptance Criteria

1. THE 测试套件 SHALL 包含 Fake_FFmpeg 夹具，覆盖版本检测成功、检测失败、画面编码为 H.264 / HEVC / VP9、没有画面流、`-progress` 输出、生成结果文件、非 0 退出和超时。
2. THE 测试套件 SHALL 用真实 HTTP 服务和 Fake_FFmpeg 测试 Export_Service：启动检测、不可用时 503 且不写文件、完整的上传到下载再 `DELETE` 流程、H.264 / HEVC 直接复制和 VP9 重新编码的参数选择、400 / 404 / 413 / 429 / 500 状态码、排队顺序、取消排队中和运行中的任务、探测阶段和合成阶段的超时、结果 30 分钟过期、启动时清理临时目录、上传中途断开。
3. THE 测试套件 SHALL 测试 Export_File_Name 的生成，包括 Unsafe_File_Name_Character 替换、空名称、超长名称和多个扩展名。
4. THE 测试套件 SHALL 用模拟的 DOM 测试 App 的导出流程：Export_Button 可用条件、Audio_Only_Source 直接导出 WAV、FFmpeg 不可用和失败时改用 Browser_Recording、不支持录制时的提示、取消、Browser_Recording 后 Playback_State 恢复、Library_Cache 不变。
5. THE README SHALL 说明导出功能的用法、两条视频导出路径、FFmpeg 的安装和 `FFMPEG_CMD` / `EXPORT_MAX_UPLOAD_MB` / `EXPORT_TIMEOUT_MIN` 环境变量、`/api/export` 接口、临时文件规则、浏览器录制的限制（需要和视频一样长的时间、iOS 不支持），以及新增测试文件的说明。
6. THE 测试套件 SHALL 在加入导出功能后让全部现有测试继续通过。
