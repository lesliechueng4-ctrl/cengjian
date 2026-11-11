# Requirements Document

## Introduction

本功能提高「层间 · 音乐练习」的音轨分离精确度，采用两条路径：

1. **服务器端 AI 分离**：本地 Node 服务器检测到已安装 Demucs 时，浏览器把文件上传到本地服务器，由 Demucs 分离，结果映射到 9 个音轨按钮。
2. **改进的浏览器端 DSP 分离**：服务器没有 Demucs、Demucs 任务失败或服务器不可达时，回退到浏览器内的 DSP 分离器。DSP 分离器按设备分档：电脑使用高质量模式（更慢、更准），手机使用快速模式（耗时和内存与现状基本一致）。

改进覆盖全部 9 个音轨按钮（原曲、纯伴奏、人声、鼓、贝斯、和声伴奏、额外打击乐、效果音、其他音效），其中「原曲」保持为未处理的原始音频。

现有基线（用于对比）：STFT 窗长 2048、跳步 512、Hann 窗、分段上下文 16 帧；HPSS 软掩码 kTime=13、kFreq=13、beta=1.5；Avendano 中置掩码；增益匹配上限 4；单声道跳过中置掩码。3 分钟立体声歌曲在开发机 Node 环境约 26 秒、峰值内存约 800 MB；长度限制为手机 6 分钟 / 500 MB、电脑 15 分钟 / 2 GB。

约束：浏览器端保持零依赖；Node ≥ 18、ES 模块、无 npm 依赖；测试命令为 `node --test tests/*.test.mjs`；`player.js` 的播放同步、`library.js` 的缓存行为和全部现有测试保持可用。

## Glossary

- **App**：运行在浏览器中的「层间」前端（`public/js/app.js` 及其加载的模块）。
- **Server**：项目根目录下 `server.js` 提供的本地 Node HTTP 服务器。
- **Demucs_Service**：Server 内负责检测 Demucs、接收上传、排队、运行 Demucs 并返回结果的部分。
- **Demucs**：facebookresearch/demucs 命令行工具，由用户自行安装在 Server 所在机器上。
- **Demucs_Command**：Server 用来调用 Demucs 的可执行文件及固定参数；默认 `demucs`，可通过环境变量 `DEMUCS_CMD` 覆盖。
- **Demucs_Model**：Demucs 模型名，允许值为 `htdemucs`（输出 vocals / drums / bass / other 4 轨）和 `htdemucs_6s`（另加 guitar / piano，共 6 轨）。
- **Separation_Job**：Demucs_Service 中针对一次上传创建的分离任务，具有随机生成的任务 ID 和状态（排队中、处理中、已完成、失败、已取消）。
- **Job_Queue**：Demucs_Service 中按先进先出顺序保存 Separation_Job 的队列。
- **Temp_Directory**：Demucs_Service 存放上传文件和 Demucs 输出的临时目录，位于操作系统临时目录下。
- **DSP_Separator**：浏览器端的 DSP 音轨分离器（`separator.js`、`separator.worker.js`、`dsp.js`）。
- **Quality_Mode**：DSP_Separator 的处理档位，取值为 High_Quality_Mode 或 Fast_Mode。
- **High_Quality_Mode**：电脑（非触屏设备）上使用的 DSP 档位，允许更长耗时和更高内存以换取精确度。
- **Fast_Mode**：手机（触屏设备）上使用的 DSP 档位，耗时和内存与基线基本一致。
- **Baseline_Separator**：本功能实施前的 DSP 分离算法（参数见 Introduction），保留在测试中作为对比基准。
- **Stem_Mapper**：把 Demucs 输出映射为 9 条音轨的模块，并用 DSP 从 Demucs 输出派生出额外打击乐、效果音、其他音效。
- **Stem**：9 个音轨按钮之一对应的音频。
- **Derived_Stems**：除「原曲」外的 8 条 Stem（纯伴奏、人声、鼓、贝斯、和声伴奏、额外打击乐、效果音、其他音效）。
- **Benchmark_Set**：测试中用程序生成的合成混音集合，每个混音由已知的各 Stem 参考信号（合成人声谐波、鼓击、贝斯低频音、和弦铺底、高频打击、立体声两侧效果、噪声残余）相加而成，包含立体声和单声道样本。
- **SDR**：信号失真比（Signal-to-Distortion Ratio），单位 dB，按 10·log10(‖参考‖² / ‖参考 − 估计‖²) 计算，越高越准。
- **Settings_Page**：App 中的「我的」页面，设置保存在浏览器 localStorage。
- **Analysis_Panel**：App 中的「真实分析」面板。
- **Library_Cache**：`library.js` 中按最近使用顺序保存分离结果的缓存（电脑 3 个、手机 2 个）。
- **Player**：`player.js` 中的同步播放器。

## Requirements

### Requirement 1: Demucs 可用性检测

**User Story:** 作为练舞的人，我希望 App 自动知道本地服务器能不能用 AI 分离，这样有 Demucs 时用 AI，没有时也能照常用浏览器分离。

#### Acceptance Criteria

1. WHEN Server 启动时，THE Demucs_Service SHALL 使用 `child_process.execFile` 以参数数组方式运行 Demucs_Command 的帮助命令，并在 10 秒内得出“可用”或“不可用”的检测结果。
2. WHEN Server 收到 `GET /api/separate/status` 请求时，THE Demucs_Service SHALL 返回 JSON，包含 Demucs 是否可用、允许的 Demucs_Model 列表、上传大小上限（字节）和 Job_Queue 中当前任务数。
3. IF Demucs_Command 不存在、退出码非 0 或检测超过 10 秒，THEN THE Demucs_Service SHALL 将 Demucs 标记为不可用，并在终端打印一行说明 Demucs 不可用、将使用浏览器分离的提示。
4. WHEN Demucs 检测结果为可用时，THE Server SHALL 在启动信息中打印一行说明已启用 Demucs AI 分离。
5. WHEN App 准备分离一个新打开的文件时，THE App SHALL 请求 `GET /api/separate/status` 并等待最多 3 秒。
6. IF `GET /api/separate/status` 请求失败、超时或返回 Demucs 不可用，THEN THE App SHALL 使用 DSP_Separator 分离该文件，且不上传该文件。

### Requirement 2: 上传与安全处理

**User Story:** 作为在局域网里运行服务器的用户，我希望上传接口安全可控，这样文件只发到我自己的服务器，且不会留下垃圾文件或被恶意请求利用。

#### Acceptance Criteria

1. WHILE Demucs 可用，WHEN Server 收到 `POST /api/separate` 请求时，THE Demucs_Service SHALL 将请求体流式写入 Temp_Directory 中以随机 ID 命名的文件，并返回新建 Separation_Job 的任务 ID。
2. THE Demucs_Service SHALL 只使用服务器生成的随机 ID 命名上传文件、输出目录和结果文件，不使用客户端提供的文件名。
3. IF `POST /api/separate` 请求体超过上传大小上限（默认 2 GB，可通过环境变量 `DEMUCS_MAX_UPLOAD_MB` 配置），THEN THE Demucs_Service SHALL 停止接收、删除已写入的部分文件并返回 HTTP 413。
4. IF `POST /api/separate` 请求指定的 Demucs_Model 不在允许值列表中，THEN THE Demucs_Service SHALL 返回 HTTP 400 且不创建 Separation_Job。
5. IF Demucs 不可用时 Server 收到 `POST /api/separate` 请求，THEN THE Demucs_Service SHALL 返回 HTTP 503 且不写入任何文件。
6. THE Demucs_Service SHALL 通过 `child_process.execFile` 以参数数组方式运行 Demucs，参数中的路径和模型名均来自服务器生成的值或允许值列表。
7. IF 任务 ID 参数不符合服务器生成的随机 ID 格式或不对应已存在的 Separation_Job，THEN THE Demucs_Service SHALL 返回 HTTP 404。
8. WHERE App 使用 DSP_Separator 分离文件，THE App SHALL 只在浏览器内处理该文件，不向任何服务器上传该文件。
9. THE Demucs_Service SHALL 保持现有静态文件服务的行为不变，包括 MIME 类型、路径穿越拦截和 404 响应。

### Requirement 3: 任务排队与进度

**User Story:** 作为练舞的人，我希望 AI 分离在 CPU 上要好几分钟时能看到排队位置和进度，这样我知道还要等多久，并且可以先播放原曲。

#### Acceptance Criteria

1. THE Demucs_Service SHALL 同一时间只运行 1 个 Demucs 进程，其余 Separation_Job 在 Job_Queue 中按先进先出顺序等待。
2. IF Job_Queue 中已有 4 个未完成的 Separation_Job 时收到新的 `POST /api/separate` 请求，THEN THE Demucs_Service SHALL 返回 HTTP 429 且不写入上传文件。
3. WHEN Server 收到 `GET /api/separate/{任务ID}` 请求时，THE Demucs_Service SHALL 返回 JSON，包含任务状态、排队位置（排队中时）、0 到 100 的进度百分比（处理中时）和错误说明（失败时）。
4. WHILE Separation_Job 处于处理中，THE Demucs_Service SHALL 从 Demucs 的标准错误输出中解析进度百分比，并在每次解析到新值时更新该 Separation_Job 的进度。
5. WHILE Separation_Job 处于排队中或处理中，THE App SHALL 每 1 秒查询一次任务状态，并在分离进度区显示“排队中（第 N 位）”或“AI 分离中 N%”。
6. WHILE Separation_Job 未完成，THE App SHALL 允许播放「原曲」，并保持其余 8 个音轨按钮不可点击。
7. IF Demucs 进程运行超过任务超时时间（默认 30 分钟，可通过环境变量 `DEMUCS_TIMEOUT_MIN` 配置），THEN THE Demucs_Service SHALL 终止该进程并将 Separation_Job 标记为失败。

### Requirement 4: 取消与临时文件清理

**User Story:** 作为服务器所在电脑的使用者，我希望任务结束后临时文件被删掉，换文件时旧任务被取消，这样磁盘不会被占满、CPU 不会白白忙。

#### Acceptance Criteria

1. WHEN Server 收到 `DELETE /api/separate/{任务ID}` 请求时，THE Demucs_Service SHALL 将该 Separation_Job 移出 Job_Queue 或终止其 Demucs 进程，标记为已取消，并删除该任务的全部临时文件。
2. WHEN 用户在 Separation_Job 未完成时打开另一个文件或取消分离时，THE App SHALL 发送 `DELETE /api/separate/{任务ID}` 请求并停止轮询该任务。
3. WHEN Separation_Job 失败时，THE Demucs_Service SHALL 立即删除该任务的上传文件和输出目录。
4. WHEN Separation_Job 完成时，THE Demucs_Service SHALL 立即删除该任务的上传文件，并保留结果文件直到 App 发送 `DELETE` 请求或结果保留时间（30 分钟）到期，以先发生者为准。
5. WHEN App 下载完 Separation_Job 的全部结果文件时，THE App SHALL 发送 `DELETE /api/separate/{任务ID}` 请求。
6. WHEN Server 启动时，THE Demucs_Service SHALL 删除 Temp_Directory 中上次运行遗留的文件。

### Requirement 5: Demucs 结果映射到 9 个音轨按钮

**User Story:** 作为练舞的人，我希望 AI 分离后 9 个按钮都能用，这样我照旧按人声、鼓、贝斯等来听。

#### Acceptance Criteria

1. WHEN Separation_Job 完成时，THE Demucs_Service SHALL 通过 `GET /api/separate/{任务ID}/{音轨名}.wav` 提供该 Demucs_Model 输出的每条 WAV 文件，音轨名只接受该模型的输出名。
2. THE Stem_Mapper SHALL 将「人声」映射为 Demucs 的 `vocals`，「鼓」映射为 `drums`，「贝斯」映射为 `bass`。
3. WHERE Demucs_Model 为 `htdemucs`，THE Stem_Mapper SHALL 将「纯伴奏」生成为 `drums + bass + other`，将「和声伴奏」映射为 `other`。
4. WHERE Demucs_Model 为 `htdemucs_6s`，THE Stem_Mapper SHALL 将「纯伴奏」生成为 `drums + bass + other + guitar + piano`，将「和声伴奏」生成为 `guitar + piano + other`。
5. THE Stem_Mapper SHALL 用 DSP 对 `drums` 做 5 kHz 高通得到「额外打击乐」。
6. THE Stem_Mapper SHALL 用 DSP 取 `other` 在 1.5 kHz 以上的立体声两侧成分并左右同相输出，得到「效果音」；单声道输入时改取 `other` 在 6 kHz 以上的成分。
7. THE Stem_Mapper SHALL 将「其他音效」生成为 `other` 减去「效果音」后的残余。
8. THE App SHALL 将「原曲」保持为上传文件自带的原始音频，由视频或音频元素本身播放。
9. WHEN Stem_Mapper 完成映射时，THE App SHALL 把 8 条 Derived_Stems 以与 DSP_Separator 相同的数据格式交给 Player 和 Library_Cache。
10. WHEN 一个文件由 Demucs 分离时，THE Analysis_Panel SHALL 显示所用 Demucs_Model，以及每条 Stem 由哪些 Demucs 输出或 DSP 步骤得到。

### Requirement 6: Demucs 失败时回退

**User Story:** 作为练舞的人，我希望 AI 分离出问题时自动改用浏览器分离，这样我总能拿到可用的音轨。

#### Acceptance Criteria

1. IF `POST /api/separate` 返回错误状态码或网络请求失败，THEN THE App SHALL 使用 DSP_Separator 分离该文件，并显示一条说明已改用浏览器分离的提示。
2. IF Separation_Job 状态变为失败，THEN THE App SHALL 使用 DSP_Separator 分离该文件，并在提示中显示失败原因。
3. IF 下载 Demucs 结果文件失败，THEN THE App SHALL 发送 `DELETE /api/separate/{任务ID}` 请求，并使用 DSP_Separator 分离该文件。
4. IF Separation_Job 被用户取消，THEN THE App SHALL 停止该文件的分离流程，且不启动 DSP_Separator。

### Requirement 7: 在「我的」中选择 Demucs 模型

**User Story:** 作为练舞的人，我希望在「我的」里选 4 轨或 6 轨模型，这样我可以在速度和吉他/钢琴细分之间自己取舍。

#### Acceptance Criteria

1. THE Settings_Page SHALL 提供 Demucs_Model 选项，可选 `htdemucs`（4 轨，较快）和 `htdemucs_6s`（6 轨，含吉他和钢琴）。
2. THE App SHALL 在 localStorage 中没有已保存的 Demucs_Model 时使用 `htdemucs`。
3. WHEN 用户在 Settings_Page 中更改 Demucs_Model 时，THE App SHALL 将新值保存到 localStorage，并在之后新开始的分离中使用新值。
4. IF localStorage 中保存的 Demucs_Model 不在允许值列表中，THEN THE App SHALL 使用 `htdemucs`。
5. WHILE Demucs 不可用，THE Settings_Page SHALL 在 Demucs_Model 选项旁显示“服务器未安装 Demucs，当前使用浏览器分离”。

### Requirement 8: DSP 分离器按设备分档

**User Story:** 作为练舞的人，我希望电脑上用更准的分离、手机上保持现在的速度，这样各设备都好用且手机不会因内存不足刷新页面。

#### Acceptance Criteria

1. WHEN App 在非触屏设备上启动 DSP_Separator 时，THE DSP_Separator SHALL 使用 High_Quality_Mode。
2. WHEN App 在触屏设备上启动 DSP_Separator 时，THE DSP_Separator SHALL 使用 Fast_Mode。
3. WHILE 使用 Fast_Mode，THE DSP_Separator SHALL 对 3 分钟立体声 44.1 kHz 输入的处理耗时不超过 Baseline_Separator 在同一环境下耗时的 110%，峰值内存不超过 Baseline_Separator 峰值内存的 110%。
4. WHILE 使用 High_Quality_Mode，THE DSP_Separator SHALL 对 3 分钟立体声 44.1 kHz 输入的处理耗时不超过 Baseline_Separator 在同一环境下耗时的 300%，峰值内存不超过 Baseline_Separator 峰值内存的 150%。
5. THE App SHALL 保持现有长度限制不变：触屏设备 6 分钟 / 500 MB，非触屏设备 15 分钟 / 2 GB。
6. WHEN 一个文件由 DSP_Separator 分离时，THE Analysis_Panel SHALL 显示所用 Quality_Mode。
7. WHILE DSP_Separator 处于 High_Quality_Mode 或 Fast_Mode，THE DSP_Separator SHALL 保持 Worker 启动失败时改在主线程运行、Worker 启动后出错直接报错、支持取消的现有行为。

### Requirement 9: DSP 分离精确度提升

**User Story:** 作为练舞的人，我希望没有 AI 时浏览器分离出来的 8 条音轨也更干净，这样扒舞时串音更少。

#### Acceptance Criteria

1. WHILE 使用 High_Quality_Mode，THE DSP_Separator SHALL 在 Benchmark_Set 的立体声样本上使 8 条 Derived_Stems 中每一条的平均 SDR 比 Baseline_Separator 高至少 1.0 dB。
2. WHILE 使用 Fast_Mode，THE DSP_Separator SHALL 在 Benchmark_Set 的立体声样本上使 8 条 Derived_Stems 中每一条的平均 SDR 不低于 Baseline_Separator，且 8 条各自平均 SDR 的均值比 Baseline_Separator 的对应均值高至少 0.5 dB。
3. WHEN 输入为单声道时，THE DSP_Separator SHALL 在 High_Quality_Mode 和 Fast_Mode 下都使 Benchmark_Set 单声道样本上 8 条 Derived_Stems 中每一条的平均 SDR 不低于 Baseline_Separator 在同一样本上的结果。
4. WHEN 输入为单声道时，THE DSP_Separator SHALL 使「效果音」输出为单声道且非零。
5. THE DSP_Separator SHALL 使每条 Derived_Stem 的峰值绝对值不超过 1.0。
6. WHEN 一个文件由 DSP_Separator 分离时，THE Analysis_Panel SHALL 显示与所用 Quality_Mode 对应的每条 Stem 说明文字（STEM_NOTES），描述该模式实际采用的做法。

### Requirement 10: 兼容现有播放、缓存与测试

**User Story:** 作为维护者，我希望新功能不破坏现有的播放同步、音乐台缓存和测试，这样改动可以安全上线。

#### Acceptance Criteria

1. THE App SHALL 对 Demucs 结果和 DSP_Separator 结果使用相同的 Player 接口，保持切换音轨不丢位置、变速保持音高、漂移校正和循环的现有行为。
2. THE Library_Cache SHALL 对 Demucs 结果和 DSP_Separator 结果使用相同的缓存数量、释放顺序和 Blob URL 回收规则。
3. WHEN 用户重新打开 Library_Cache 中有分离结果的文件时，THE App SHALL 直接使用缓存结果，且不发送 `POST /api/separate` 请求。
4. THE App SHALL 使执行 `node --test tests/*.test.mjs` 时全部现有测试通过。
5. THE App SHALL 为 Demucs_Service（状态检测、上传大小限制、模型校验、排队上限、取消、临时文件清理、任务 ID 校验）、Stem_Mapper（两种 Demucs_Model 的映射）、App 回退流程和 DSP_Separator 的 Benchmark_Set SDR 对比提供 `node --test` 自动化测试，测试中用假的 Demucs_Command 代替真实 Demucs。
6. THE App SHALL 保持浏览器端代码零依赖，Server 端代码仅使用 Node.js 18 内置模块。
7. WHEN 本功能完成时，THE README SHALL 说明 Demucs 的安装与启用方式（含读取 MP4 等压缩格式所需的 FFmpeg）、文件仅在使用 Demucs 时上传到本地 Server、Demucs_Model 设置、Quality_Mode 分档和新的环境变量。
