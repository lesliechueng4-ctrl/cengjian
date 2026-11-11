# Implementation Plan: 音轨视频导出（stem-video-export）

## Overview

按 design.md 实现：先把 Demucs_Service 的通用辅助函数搬到 `server-util.js`，再写 `export-service.js` 的纯函数、Fake_FFmpeg 夹具和服务工厂，接入 `server.js`；浏览器端新增零依赖的 `public/js/export-client.js`，最后在 `index.html` / `style.css` / `app.js` 接上导出按钮、选择面板、进度和取消，并更新 README。语言为 JavaScript（ES 模块，Node ≥ 18 内置模块），测试命令 `node --test tests/*.test.mjs`，属性测试用 `tests/helpers/prop.mjs`，每个属性至少 100 轮。

已确认的默认值：`EXPORT_MAX_UPLOAD_MB` = 10240（10 GB，原视频与音轨 WAV 合计），`EXPORT_TIMEOUT_MIN` = 30（覆盖探测 + 合成），未完成任务上限 4 个，同时只运行 1 个 FFmpeg 进程。

## Tasks

- [x] 1. 提取 Server 共用辅助函数
  - [x] 1.1 新建 `server-util.js` 并让 `demucs-service.js` 改为导入
    - 搬出 `JSON_HEADERS`、`sendJson`、`sendError`、`positiveInt`、`positiveNumber`、`truncate`、`lastStderrLine`（新增可选 `ignore` 正则）
    - 把 `rejectAndDrain` 和 `draining` 集合改写为工厂 `createRejectDrainer({ maxExtraBytes, drainMs })`，返回 `reject()` / `killAll()`
    - `demucs-service.js` 只做替换：删除内部定义、改为导入，`close()` 改用 `drainer.killAll()`；导出列表不变
    - 运行现有 `demucs-service.test.mjs`、`demucs-props.test.mjs`、`server.test.mjs` 确认行为不变
    - _Requirements: 9.5, 13.6, 13.7_
  - [x]* 1.2 编写 `tests/server-util.test.mjs`
    - **Property 12: 错误信息取 stderr 最后一行**
    - **Validates: Requirements 9.5**
    - 另加 `createRejectDrainer` 示例：大请求体时客户端仍收到完整错误响应，`killAll()` 销毁未排空的连接
    - _Requirements: 7.4, 7.5, 7.13_

- [x] 2. 实现 `export-service.js` 的纯函数
  - [x] 2.1 配置、路径、上传参数与分帧
    - 新建根目录 `export-service.js`：`EXPORT_API_PREFIX`、`COPYABLE_VIDEO_CODECS`、`AAC_BITRATE`、`X264_ARGS`、`readExportConfig`、`defaultExportTempRoot`
    - `readExportConfig` 默认值：`DEFAULT_MAX_UPLOAD_MB = 10240`（`maxUploadBytes` = 10240 × 1048576）、`DEFAULT_TIMEOUT_MIN = 30`（`timeoutMs` = 1800000）；取值无效时回退默认值
    - `exportJobPaths`（只用 tempRoot、Job_ID、白名单扩展名）、`parseExportQuery`、`isRiffWave`、`createBodySplitter`
    - 从 `demucs-service.js` 导入 `parseDemucsCmd`、`createJobQueue`、`isJobId`、`UPLOAD_EXTS`，从 `server-util.js` 导入辅助函数
    - _Requirements: 6.5, 7.1, 7.4, 10.2, 10.7_
  - [x] 2.2 探测解析、参数构建与进度解析
    - `parseProbeOutput`（跳过 attached pic、记录 Video 流序号、解析 `Duration`）
    - `buildProbeArgs`、`buildMuxArgs`（`-map 0:v:<n>`、`-map 1:a:0`、copy / libx264、`-tag:v hvc1`、AAC 192k、`+faststart`、`-progress pipe:1 -nostats`）、`formatSeconds`
    - 时长对齐（8.5）：始终加 `-af apad`，音轨 WAV 比画面短时用静音补齐；FFmpeg 报告了 `Duration` 时用 `-t <Duration 秒>` 让输出时长等于该值，`Duration` 读不出（`N/A`）时改用 `-shortest`，在画面结束时结束
    - `createProgressParser`（跨 chunk 半行、`out_time_us` / `out_time_ms` 均按微秒）、`progressPercent`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 9.2, 9.3_
  - [x]* 2.3 编写配置、分帧、参数和路径的属性测试（`tests/export-props.test.mjs`）
    - **Property 6: 配置读取回退默认值**（无效值回退到 10240 MB 和 30 分钟） — **Validates: Requirements 6.5**
    - **Property 7: 上传分帧往返** — **Validates: Requirements 7.1**
    - **Property 8: 上传参数与 WAV 头校验** — **Validates: Requirements 7.4**
    - **Property 13: 临时路径只由服务器值组成** — **Validates: Requirements 10.2**
  - [x]* 2.4 编写探测、合成参数和进度的属性测试（追加到 `tests/export-props.test.mjs`）
    - **Property 9: 探测输出解析** — **Validates: Requirements 8.2, 8.3, 8.8, 9.3**
    - **Property 10: 合成参数规则**（含 `-af apad`；有时长时 `-t <时长>` 且无 `-shortest`，无时长时 `-shortest`） — **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7**
    - **Property 11: 进度解析与切分无关** — **Validates: Requirements 9.2, 9.3**
    - **Property 16: 进度百分比** — **Validates: Requirements 9.2, 12.5**

- [x] 3. Fake_FFmpeg 测试夹具
  - [x] 3.1 新建 `tests/fixtures/fake-ffmpeg.mjs`
    - 识别 `-version`、探测（只有 `-i` 没有输出）和合成三种调用
    - 支持 `FAKE_FFMPEG_MODE` = `ok` / `probefail` / `probehang` / `inspecthang` / `slow` / `fail` / `hang` / `nooutput`；`inspecthang` 让探测调用永不退出，用于测试任务超时覆盖探测阶段（9.4）
    - 按原文件首行 `FAKEVIDEO codec=… duration=… [attached=1]` 输出探测信息；非 `FAKEVIDEO` 输入只输出 `Invalid data found when processing input`
    - 合成时按真实格式写进度块（故意拆成多次 `write`），输出文件为 `FAKEMP4 ` + `{ argv, inputs: [{ bytes, sha256 }] }`
    - _Requirements: 14.1, 9.4_

- [x] 4. Export_Service 服务工厂与 HTTP 接口
  - [x] 4.1 实现 `createExportService`
    - `init()`：清空并重建 Export_Temp_Directory，`execFile` 运行 `-version` 检测（10 秒），日志写可用或不可用原因
    - `handle()`：`GET /api/export/status`、`POST /api/export`、`GET /api/export/<id>`、`GET /api/export/<id>/result.mp4`、`DELETE /api/export/<id>`，其他方法 405
    - 上传处理按 design 的 10 步顺序：503 → 400 → 429 → 413 / 400 → 写两个流（背压）→ RIFF 校验 → 结束校验 → 202；断线走 `abortUpload`
    - 写盘失败（7.13）：建任务目录失败或任一写流 `error`（如 `ENOSPC`）→ `abortUpload`（关闭写流后删目录、释放名额）+ `drainer.reject(..., 500, '服务器无法保存上传文件')`
    - `runJob`：开始运行时启动一个覆盖探测和合成全过程的 `timeoutMs` 计时器（9.4），到时终止当前子进程（探测或合成）并标记失败「合成视频超过 N 分钟未完成，已终止」；探测（退出码 1 正常）、`spawn` 合成（无 shell）、stderr 末尾 64 KB、成功后删上传文件并保留结果 30 分钟、失败走 `failJob` 并保留状态 5 分钟
    - `cancelJob`、`scheduleExpire`、`close()`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.13, 8.1, 8.5, 8.8, 9.1, 9.4, 9.5, 10.1, 10.3, 10.4, 10.5_
  - [x] 4.2 在 `server.js` 中接入 Export_Service
    - `createServer(root, { demucs, exporter })` 先交给 `demucs.handle`，再交给 `exporter.handle`，最后是静态文件
    - 启动时 `createExportService({ ...readExportConfig(), tempRoot: defaultExportTempRoot() })` 并调用 `init()`
    - _Requirements: 6.1, 6.5, 6.7, 10.1, 10.7, 13.7_
  - [x]* 4.3 编写 `tests/export-service.test.mjs` 集成测试
    - 用 `listenFetchable` + Fake_FFmpeg 覆盖 design「export-service.test.mjs」一节的全部用例：启动检测、503 不写文件、完整上传→下载→DELETE（sha256 一致，参数含 `-af apad` 和 `-t 2`）、H.264 / HEVC / VP9 / `N/A`（含 `-shortest`）/ attached pic / 无画面、400 / 404 / 413 / 429、排队顺序、取消排队中和运行中任务、失败、`nooutput`、过期、启动清理、上传中途断开、无 `shell: true`
    - 超时：`hang`（合成阶段）和 `inspecthang`（探测阶段）配 `timeoutMs: 300` 都得到 failed 且进程被终止（9.4）
    - 写盘失败：`init()` 后把 tempRoot 换成普通文件使 `mkdir` 失败 → 500 `服务器无法保存上传文件`，`queueLength` 回到 0（7.13）
    - _Requirements: 14.2, 6.1–6.7, 7.2–7.13, 8.1–8.8, 9.1–9.5, 10.1–10.5_
  - [x]* 4.4 在 `tests/server.test.mjs` 增加回归用例
    - `GET /export-service.js`、`/server-util.js` 返回 404；FFmpeg 不可用时静态文件和 `/api/separate/status` 正常
    - _Requirements: 6.7, 10.7, 13.7_

- [x] 5. Checkpoint - 确保 Server 端测试全部通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. 浏览器端 `public/js/export-client.js`
  - [x] 6.1 文件名、按钮状态、文字、状态检测和下载
    - `UNSAFE_FILE_NAME_RE`、`MAX_FILE_BODY`、`fileNameFor`（按码点计数，截短 base 后再去尾部空格和句点；Stem 名取自 Export_Stem）
    - `exportButtonState`、`EXPORT_API`、`fetchExportStatus`（3 秒超时，失败返回 null）、`exportProgressText`、`exportFallbackNotice`、`UNSUPPORTED_TEXT`、`ExportError`
    - `readStemBlob`（`fetch(blob URL)`，不访问 Server）、`triggerDownload`（只回收自己创建的 URL）
    - 所有全局对象（`fetch`、`document`、`URL`、`setTimeout`）可注入
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 2.6, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 9.6_
  - [x] 6.2 实现 `runServerMux` 和 `sourceExt`
    - `POST /api/export?ext=&wavBytes=`，`body: new Blob([wavBlob, sourceFile])`（WAV 为 Export_Stem 的 Blob）；每 `pollMs` 轮询；下载 `result.mp4` 后 `DELETE`；中止时 `keepalive` DELETE 并抛 AbortError；`job` / `download` 失败也发 DELETE
    - 413 / 429 / 500（服务器无法保存上传文件）/ 503 / 网络错误 → `ExportError('upload')`，带服务器返回的 `error`；连续 5 次轮询失败、404、cancelled → `ExportError('job')`
    - URL 只含 `ext` 和 `wavBytes`，为相对路径
    - _Requirements: 2.6, 4.6, 5.4, 5.6, 7.1, 7.13, 9.6, 10.6, 11.2_
  - [x] 6.3 实现浏览器录制
    - `RECORDER_TYPES`、`pickRecorderMime`、`canBrowserRecord`、`capturePlaybackState`、`restorePlaybackState`
    - `runBrowserRecording({ player, video, stemId, stemUrl, selected, signal, onProgress, env })`：`stemId` / `stemUrl` 是导出开始时记录的 Export_Stem，`selected` 是录制开始那一刻用户当前的 Selected_Stem（Server_Mux 失败回退时可能已和 Export_Stem 不同）
    - `saved = capturePlaybackState(player, selected)`；专用 `recAudio`（`src = stemUrl`）+ `AudioContext` 取音频轨，`captureStream` / `mozCaptureStream` 只取视频轨；`player.select(stemId)`、`seek(0)`、1 倍速、关循环；漂移超过 0.25 秒拉回；`ended` 返回 WEBM Blob；错误、自动播放被拒、取消都不返回数据
    - `finally` 释放资源并 `restorePlaybackState(player, saved)`，把选中音轨恢复为 `selected`（而不是 Export_Stem），同时恢复位置、速度、播放状态和循环；不回收 Stem Blob URL
    - _Requirements: 2.6, 5.5, 11.3, 12.1, 12.2, 12.3, 12.4, 12.5, 12.7, 12.8, 12.9, 13.1_
  - [x] 6.4 实现 `exportVideoWithFallback`
    - 状态 `available && !checking` 才调用 `runServer`；非 Abort 失败（含 500 写盘失败、任务失败、下载失败）时 `onNotice` 后回退；AbortError 原样抛出；需要录制但 `canRecord()` 为假时抛 `ExportError('unsupported')`
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 7.13, 11.2, 12.4_
  - [x]* 6.5 编写文件名和按钮状态的属性测试（`tests/export-client.test.mjs`）
    - **Property 1: 导出文件名不变式** — **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
    - **Property 2: 安全短名保持不变** — **Validates: Requirements 4.1**
    - **Property 4: 导出按钮状态模型** — **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 3.4**
    - 示例：`exportProgressText` 每种文字、`triggerDownload` 只回收自己的 URL、`fetchExportStatus` 超时返回 null
  - [x]* 6.6 编写 `runServerMux` 的属性与示例测试（追加到 `tests/export-client.test.mjs`）
    - **Property 3: 发往 Server 的请求不含文件名且只发往本地** — **Validates: Requirements 4.6, 5.6**
    - 示例：轮询间隔、`onPhase` 顺序、完成后 DELETE、中止时 keepalive DELETE、413 / 429 / 500 / 503 / 网络错误 → `ExportError('upload')`
    - _Requirements: 7.13, 9.6, 10.6, 11.2_
  - [x]* 6.7 编写路径选择和录制的属性与示例测试（追加到 `tests/export-client.test.mjs`）
    - **Property 5: 视频导出路径选择模型** — **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 11.2, 12.4**
    - **Property 14: 录制格式选择** — **Validates: Requirements 12.3, 12.4**
    - **Property 15: 录制结束后恢复 Playback_State**（`selected` 与 `stemId` 可以不同：录制中选中 `stemId`，结束后恢复为 `selected`） — **Validates: Requirements 2.6, 12.1, 12.9**
    - 示例：录制流只含视频元素的视频轨和 `dest` 的音频轨；`recAudio.src` 为 Export_Stem 的 URL；取消不返回数据；错误抛 `ExportError('record')`
    - _Requirements: 12.2, 12.7, 12.8, 11.3_

- [x] 7. 练习室界面接入
  - [x] 7.1 修改 `public/index.html` 和 `public/css/style.css`
    - 在 `.stem-status-row` 之后加 `.export-row`（`#exportBtn`、`#exportHint`、`#exportStatus`、`#cancelExport`、`#exportWavFallback`）
    - 加 `#exportSheet`（`role="dialog"`）和 `#exportBackdrop`，三个 `data-export` 按钮，复用分析面板的 sheet 样式
    - _Requirements: 1.1, 2.1, 11.1_
  - [x] 7.2 在 `public/js/app.js` 中实现导出流程
    - 新增 `state.exporting`、`state.exportNotice`、`state.exportUnsupported`；`renderExport()` 在 `renderStems()` 末尾调用
    - 点击 `#exportBtn` 的那一刻记录 Export_Stem：`target = { entry, stemId: state.selected, label, url: entry.cache.urls[stemId] }`（2.6）；之后的 WAV 读取、上传、录制和 Export_File_Name 都只用 `target`，不再读 `state.selected`
    - `entry.kind === 'audio'` 直接 `startWavExport()`，否则打开选择面板
    - `startVideoExport()` 调用 `exportVideoWithFallback`；`runBrowser` 在真正开始录制时才读取 `selected: state.selected`（用户在 Server_Mux 期间切换后的当前选择），并传 `stemId` / `stemUrl` = `target`；成功按 `mp4` / `webm` 命名下载
    - 处理 unsupported、AbortError（「已取消导出」）和其他失败；Server_Mux 上传失败（含 500 `服务器无法保存上传文件`）、任务失败、下载失败时显示原因和「改用浏览器录制」提示后回退；每次回调检查 `stillCurrent()`
    - `cancelExport()`；`openEntry()` 开头取消进行中的导出；录制期间锁定播放、暂停、进度条、变速、循环、音轨按钮和快捷键
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 5.4, 5.5, 7.13, 11.1, 11.2, 11.3, 11.4, 12.1, 12.6, 12.9, 13.1, 13.2, 13.3, 13.4, 13.5_
  - [x]* 7.3 编写 `tests/export-app.test.mjs`
    - 沿用 `app.test.mjs` 的 FakeEl 假 DOM，加可控假 `fetch`、假 `MediaRecorder` / `captureStream`
    - 覆盖按钮可用条件和「原曲」提示、纯音频直接下载 WAV（无 `/api/export` 请求）、不可用和失败时回退录制、POST 返回 500 时显示原因并回退录制、不支持录制时的提示与 WAV 按钮、两种取消、录制期间控件锁定与结束后恢复、`entry.cache.urls` 不变、导出中打开另一个文件会取消导出
    - Export_Stem：Server_Mux 期间切换音轨不改变上传的 WAV 和文件名；随后回退录制时 `player.select` 收到 Export_Stem，录制结束后选中音轨恢复为用户切换后的音轨
    - _Requirements: 14.4, 1.7, 2.6, 5.4, 7.13, 12.1, 12.9, 13.1, 13.2, 13.3_

- [x] 8. 文档
  - [x] 8.1 更新 `README.md`
    - 新增「导出」一节：按钮用法与「原曲」不可导出、导出的是点击「导出」时选中的音轨、两条视频导出路径和自动回退（含服务器写盘失败时回退）、FFmpeg 安装、`FFMPEG_CMD` / `EXPORT_MAX_UPLOAD_MB`（默认 10240，即 10 GB）/ `EXPORT_TIMEOUT_MIN`（默认 30 分钟，含探测和合成）、`/api/export` 接口表（含 500）、输出时长规则（等于原视频时长，音轨短时补静音）、临时文件规则、浏览器录制的限制（耗时等于视频长度、iOS Safari 不支持）、HEVC 播放兼容性提示、新增测试文件说明
    - _Requirements: 14.5_

- [x] 9. Final checkpoint - 确保全部测试通过
  - 运行 `node --test tests/*.test.mjs`，确认新旧测试全部通过（14.6）
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标 `*` 的子任务是测试任务，可跳过以更快完成 MVP
- 每个任务标注了对应的需求编号，便于追溯
- 属性测试注释格式：`// Feature: stem-video-export, Property N: <标题>`
- 同一文件的任务放在不同的执行波次，避免并行写冲突

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "6.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "6.2"] },
    { "id": 2, "tasks": ["2.2", "6.3", "6.5"] },
    { "id": 3, "tasks": ["2.3", "6.4", "6.6"] },
    { "id": 4, "tasks": ["2.4", "4.1", "6.7"] },
    { "id": 5, "tasks": ["4.2", "7.2"] },
    { "id": 6, "tasks": ["4.3", "4.4", "7.3", "8.1"] }
  ]
}
```
