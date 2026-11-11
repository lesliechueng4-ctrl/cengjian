# Implementation Plan: separation-accuracy

## Overview

按测试驱动、逐步集成的顺序实现：先建立测试辅助（属性测试工具、Baseline_Separator 副本、Benchmark_Set 与 SDR），再改 `dsp.js` 与 `separator.js`（Fast_Mode 原子掩码划分 → High_Quality_Mode 两级级联 → Worker 传递 mode），然后实现 `decodeWav`、Stem_Mapper、Demucs_Service（含假 Demucs_Command 与 `server.js` 集成）、浏览器端 `remote-separator.js`，最后把 App 流程、设置、取消、分析面板接起来并更新 README。

语言：JavaScript（ES 模块）。浏览器端零依赖，服务器端只用 Node ≥ 18 内置模块。测试命令：`node --test tests/*.test.mjs`。

## Tasks

- [x] 1. 建立测试辅助
  - [x] 1.1 编写属性测试工具 `tests/helpers/prop.mjs`
    - 实现 `mulberry32(seed)`、生成器 `int`、`float`、`string`（含 `../`、绝对路径、空字节、Unicode）、`oneOf`、`array`、`signal`（噪声 / 正弦叠加 / 脉冲串的随机组合）
    - 实现 `forAll(gen, fn, { runs = 100, seed })`：支持异步 `fn`，失败时报告种子与反例；读取环境变量 `PROP_SEED` 复现
    - _Requirements: 10.5, 10.6_

  - [x] 1.2 复制 Baseline_Separator 到 `tests/helpers/baseline-separator.mjs`
    - 在改动 `separator.js` 之前，逐行复制当前 `separateChannels`（2048/512、Hann、contextFrames 16、HPSS 13/13/1.5、Avendano 中置、增益上限 4、单声道跳过中置）
    - 只依赖 `public/js/dsp.js` 的现有导出；增加 `levelMatch` 选项（为 false 时跳过 `scaleToReference`）
    - _Requirements: 9.1, 9.2, 9.3, 10.5_

  - [x] 1.3 编写 Benchmark_Set 与 SDR 工具 `tests/helpers/benchmark.mjs`
    - `makeBenchmarkSet()`：固定种子、44.1 kHz、每个 8 秒；3 个立体声样本（100/118/128 BPM）与 2 个单声道样本，成分、摆位、电平按设计 Testing Strategy 表格合成，混音峰值归一到 0.9，`inst` 参考 = 混音 − 人声参考
    - `sdr(ref, est)`：所有声道拼接，分母下限 1e-12，上限 100 dB
    - `evaluate(separate, sample)`：以 `levelMatch: false` 运行分离器，收集 8 条 Derived_Stems，去掉首尾各 0.1 秒后计算 SDR；另提供结果表格化函数
    - _Requirements: 9.1, 9.2, 9.3, 10.5_

  - [x] 1.4 为测试辅助编写单元测试 `tests/helpers.test.mjs`
    - `sdr` 对相同信号返回 100、对全零估计返回 0 dB 左右
    - 每个 Benchmark_Set 样本的各成分参考之和等于混音（误差 ≤ 1e-6），单声道样本只有 1 个声道
    - 同一种子的 `forAll` 生成序列可复现
    - _Requirements: 10.5_

- [x] 2. 在 `dsp.js` 中新增分离用函数（现有导出行为不变）
  - [x] 2.1 实现 `centerMaskPhase`、`freqRamp`、`partitionMasks`、`limitPeak`
    - `limitPeak(channels)`：峰值 > 1 时整体乘 `0.98 / peak`，否则原样返回；放在 `dsp.js`，供 DSP_Separator 与 Stem_Mapper 共用
    - `centerMaskPhase(specL, specR, sharpness = 4, smoothFrames = 0)` 返回 `{ C, S }`：同相 1、反相 0、单侧 0；`smoothFrames > 0` 时先在 ±N 帧上平滑互谱与自谱
    - `freqRamp(bins, binHz, f0, rising)`：log2 频率上 f0·2^(±1/6) 之间的 cos² 过渡
    - `partitionMasks(groups)`：按设计 6.2 节组合谐波组 / 打击组 / 残余组权重，返回非负且逐点和为 1 的原子掩码；含去人声后的重新归一化（分母 < 1e-9 时 `M'_O = 1`）
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 2.2 实现 `bassCrossover`、`decimatedTimeMedian`、`wienerRefine`
    - `bassCrossover`：±8 帧、30–300 Hz 加权质心，`fc_t = clamp(2.2·f̄_t, 150, 320)`，能量 < 1e-10 时 250 Hz；系数放在可配置的 `opts` 中供调参
    - `decimatedTimeMedian(mag, frames, bins, k, step)`：隔帧抽取后做时间中值，再线性插值回每帧
    - `wienerRefine(masks, specs, frames, bins)`：3×3 均值平滑的原子功率比，原地更新且保持和为 1
    - _Requirements: 9.1_

  - [x] 2.3 为新增 dsp 函数编写单元测试（`tests/dsp.test.mjs`）
    - `centerMaskPhase` 对 L = R、L = −R、R = 0 的取值；`freqRamp` 端点为 0/1 且单调
    - `partitionMasks` 与 `wienerRefine` 输出非负且逐点和为 1；`limitPeak` 对峰值 ≤ 1 原样返回、> 1 时压到 0.98
    - `bassCrossover` 的上下限与静音回退值；`decimatedTimeMedian` 对常数输入返回常数
    - 现有 dsp 测试保持通过
    - _Requirements: 9.1, 9.2, 10.4_

- [x] 3. 在 `separator.js` 中实现 Quality_Mode 框架与 Fast_Mode 原子划分
  - [x] 3.1 添加 Quality_Mode 预设、说明文字与输出控制
    - 导出 `QUALITY_MODES`、`QUALITY_LABELS`、`QUALITY_PRESETS`、`STEM_NOTES_BY_MODE`、`stemNotes(mode)`（非法 mode 按 `'fast'`），保留 `STEM_NOTES = STEM_NOTES_BY_MODE.fast`
    - `separateChannels(channels, sampleRate, hooks, { mode = 'fast', levelMatch = true, consumeInput = false })`，返回 `{ bpm, mode }`
    - 每条 Stem 发出前调用 `dsp.js` 的 `limitPeak`，`levelMatch` 为真时仍先走 `scaleToReference`
    - _Requirements: 9.5, 9.6, 8.7_

  - [x] 3.2 用原子掩码划分实现 Fast_Mode 内核
    - 单分辨率 2048/512、contextFrames 16，复用 `hpssMasks`（13/13/1.5），中置改用 `centerMaskPhase`（指数 4），掩码由 `partitionMasks` 组合，自适应贝斯交叉点用 `bassCrossover`
    - 内核输出立体声 12 路 / 单声道 7 路（单声道效果音取 6 kHz 以上残余）；频率划分全部在频谱内完成，去掉时域带通/低通/相减
    - 先算 BPM 再分配输出；按 `vocal → inst → bass → harmony → perc → drums → fx → other` 发出并逐条释放引用；`consumeInput` 为真时才在输入数组上原地 `X_c −= V`
    - 只有传入 `hooks.onAtom` 时才额外输出效果音原子原始相位分量 `F_L/F_R`
    - 确保所有逐帧计算位于 contextFrames 之内，保持分段无关
    - _Requirements: 8.2, 8.3, 9.2, 9.3, 9.4, 9.5_

  - [x] 3.3 为 Fast_Mode 编写单元测试（`tests/separator.test.mjs`）
    - 现有用例保持通过（默认 `mode = 'fast'`、单声道输出 1 声道、单侧高频效果音单声道求和仍可听到）
    - `stemNotes('high')` 与 `stemNotes('fast')` 各含 9 个键且文字不同，`stemNotes('bogus')` 等于 Fast
    - `consumeInput` 默认 false 时调用方数组未被修改；返回值含 `mode`
    - _Requirements: 9.4, 9.6, 10.4_

- [x] 4. Checkpoint - 确保全部测试通过
  - 运行 `node --test tests/*.test.mjs`，确保全部测试通过，有疑问时询问用户。

- [x] 5. 实现 High_Quality_Mode 两级级联并锁定精确度门槛
  - [x] 5.1 实现 High_Quality_Mode 第 1 级（长窗分谐波）
    - 4096/1024、contextFrames 40，HPSS 17/17/β = 2；`decimatedTimeMedian`（k = 33、step = 2）得到波动线索 φ；`centerMaskPhase` 开启 ±1 帧平滑
    - 人声线索：立体声 `Cv = C·(0.4 + 0.6·φ)`，单声道 `Cv = φ`；原子 V/B/H/Rem，`wienerRefine` 一次
    - 第 1 级结束后发出 `vocal`、`inst`、`bass`、`harmony`，释放输入与这些数组，只保留 `Rem_L/R`
    - _Requirements: 8.1, 8.4, 9.1, 9.3_

  - [x] 5.2 实现 High_Quality_Mode 第 2 级（短窗分打击）并接入 `mode = 'high'`
    - 输入 `Rem_L/R`，1024/256、contextFrames 24，HPSS 17/17/1.5；原子 D/T/F/O，`wienerRefine` 一次；发出 `perc`、`drums`、`fx`、`other`
    - `onAtom('F', …)` 钩子在 HQ 中同样可用；按 `QUALITY_PRESETS.high` 读取全部参数
    - _Requirements: 8.1, 8.4, 9.1, 9.3, 9.4, 9.5_

  - [x] 5.3 编写精确度基准测试 `tests/separation-benchmark.test.mjs`
    - 每个分离器（Baseline、Fast、HQ）在 Benchmark_Set 上只跑一次并缓存，用 `t.diagnostic` 打印 8 条 × 3 个分离器的 SDR 表
    - 断言：HQ 立体声每条平均 SDR ≥ 基线 + 1.0 dB；Fast 立体声每条 ≥ 基线且 8 条均值 ≥ 基线均值 + 0.5 dB；两种模式单声道每条 ≥ 基线；单声道 `fx` 只有 1 声道且 RMS > 0；`levelMatch: true` 下所有 Stem 峰值 ≤ 1
    - 若门槛未达，在 `QUALITY_PRESETS` 与 `bassCrossover` 系数上调参（不得降低门槛），最终值由本测试锁定
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 10.5_

  - [x] 5.4 编写属性测试：原子掩码划分守恒
    - **Property 14: 原子掩码划分守恒**
    - 两种模式、单/立体声随机输入（0.25–0.5 秒、16 kHz），`levelMatch: false`，通过 `hooks.onAtom` 读取 `F_c`
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x] 5.5 编写属性测试：分段无关性
    - **Property 15: 分段无关性**
    - 两种模式、两个随机的合法分段长度（hop 整数倍），逐样本差 ≤ 1e-5
    - **Validates: Requirements 8.3, 8.4, 9.1, 9.2**

  - [x] 5.6 编写属性测试：单声道效果音非零
    - **Property 16: 单声道效果音非零**
    - **Validates: Requirements 9.4**

  - [x] 5.7 编写属性测试：DSP 输出峰值不超过满幅
    - **Property 17: 输出峰值不超过满幅（DSP 部分）**
    - 生成满幅方波、削波噪声、直流偏移、静音等输入，两种模式
    - **Validates: Requirements 9.5**

  - [x] 5.8 编写性能对比测试（必做，`BENCH_PERF=1` 时运行）
    - 新建 `tests/helpers/perf-run.mjs`：在子进程中对 3 分钟 44.1 kHz 立体声合成曲运行一次分离（`consumeInput: true`），在 `onProgress`/`onStem` 时采样 `heapUsed + arrayBuffers`，输出 `{ ms, peakBytes }` JSON
    - 新建 `tests/separation-perf.test.mjs`：未设置 `BENCH_PERF=1` 时 skip；否则基线 / Fast / HQ 各跑 2 次取较小值，断言 Fast ≤ 110% / 110%、HQ ≤ 300% / 150%
    - _Requirements: 8.3, 8.4_

- [x] 6. 把 Quality_Mode 传到 Worker 与 `runSeparation`
  - [x] 6.1 修改 `separator.worker.js` 与 `runSeparation`
    - `runSeparation(audioBuffer, { mode = 'fast', … })`；Worker 消息为 `{ channels, sampleRate, mode }`，`done` 消息回传 `mode`；Worker 与主线程回退都以 `consumeInput: true` 调用 `separateChannels`
    - 主线程回退、`ready` 前失败才回退、`ready` 后出错直接报错、`signal` 取消的逻辑保持不变
    - _Requirements: 8.1, 8.2, 8.7_

  - [x] 6.2 为两种模式编写 Worker 行为单元测试（`tests/separator.test.mjs`）
    - 桩 Worker 下分别验证 `mode = 'high'`、`'fast'`：Worker 不存在 → 主线程；`ready` 前失败 → 回退；`ready` 后失败 → 报错；abort → AbortError 且撤销 URL；`mode` 正确传入并回传
    - _Requirements: 8.7_

- [x] 7. Checkpoint - 确保全部测试通过
  - 运行 `node --test tests/*.test.mjs`，确保全部测试通过，有疑问时询问用户。

- [x] 8. 在 `wav.js` 中新增 `decodeWav`
  - [x] 8.1 实现 `decodeWav(arrayBuffer)`
    - 支持 PCM 16/24/32 位整数、IEEE float 32 位、WAVE_FORMAT_EXTENSIBLE；跳过未知块，奇数长度块按 RIFF 规则补齐
    - 返回 `{ channels: Float32Array[], sampleRate }`；不支持格式抛 `Error('不支持的 WAV 格式')`，截断抛 `Error('WAV 文件不完整')`；`encodeWav` 行为不变
    - _Requirements: 5.9_

  - [x] 8.2 编写属性测试：WAV 编解码往返
    - **Property 18: WAV 编解码往返**
    - 随机 1–2 声道、长度 0–4096、采样率 8000–96000；另随机生成 16/24/32 位与 float32 WAV（含未知块）
    - **Validates: Requirements 5.9**

  - [x] 8.3 为 `decodeWav` 编写错误条件单元测试（`tests/wav.test.mjs`）
    - 非 RIFF、缺 `fmt`/`data` 块、截断数据、不支持的格式码分别抛出对应错误
    - _Requirements: 5.9_

- [x] 9. 实现 Stem_Mapper（`public/js/stem-mapper.js`）
  - [x] 9.1 实现 `STEM_SOURCES`、`isMonoPair`、`mapDemucsStems`
    - 按设计第 3 节顺序逐条 `load` 与 `emit`：`vocal`、`drums`、`perc = hp(drums, 5000)`、`bass`、6s 模型的 `guitar`/`piano`、`inst` 与 `harmony` 累加器、`fx` 与 `other'`
    - 立体声：`s = hp((otherL − otherR)/2, 1500)`，`fx = [s, s]`，`other' = [otherL − s, otherR + s]`；单声道来源：`s = hp(otherL, 6000)`，`other' = [otherL − s, otherR − s]`
    - 每条发出前调用 `dsp.js` 的 `limitPeak`；用 `drums` 中声道估计 BPM；返回 `{ bpm, sampleRate, mono, duration }`
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9, 5.10_

  - [x] 9.2 为两种 Demucs_Model 编写映射单元测试 `tests/stem-mapper.test.mjs`
    - 用已知正弦输出验证 `htdemucs` 与 `htdemucs_6s` 下 8 条 Stem 的组成、发出 id 集合、`STEM_SOURCES` 含 8 个键
    - 单声道来源的 `fx` 取 6 kHz 以上；相加超过满幅时被 `limitPeak` 压到 ≤ 1
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 10.5_

  - [x] 9.3 编写属性测试：Demucs 输出按模型线性映射
    - **Property 9: Demucs 输出按模型线性映射**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.9**

  - [x] 9.4 编写属性测试：额外打击乐等于 drums 的 5 kHz 高通
    - **Property 10: 额外打击乐等于 drums 的 5 kHz 高通**
    - **Validates: Requirements 5.5**

  - [x] 9.5 编写属性测试：效果音左右同相且与其他音效还原 other
    - **Property 11: 效果音左右同相且与其他音效还原 other**
    - **Validates: Requirements 5.6, 5.7**

  - [x] 9.6 编写属性测试：Stem_Mapper 输出峰值不超过满幅
    - **Property 17: 输出峰值不超过满幅（Demucs 部分）**
    - **Validates: Requirements 9.5**

- [x] 10. 实现 Demucs_Service 并接入 `server.js`
  - [x] 10.1 在根目录新建 `demucs-service.js` 并实现纯函数与配置
    - 导出 `DEMUCS_MODELS`、`MODEL_STEMS`、`UPLOAD_EXTS`、`JOB_ID_RE`、`parseDemucsCmd`（JSON 数组或空白分隔、支持双引号）、`readConfig`（`DEMUCS_CMD`、`DEMUCS_MAX_UPLOAD_MB` 默认 2048、`DEMUCS_TIMEOUT_MIN` 默认 30）、`isAllowedModel`、`isJobId`、`safeExt`、`jobPaths`、`buildDemucsArgs`、`parseProgress`、`defaultTempRoot`
    - _Requirements: 2.2, 2.3, 2.6, 3.4, 3.7_

  - [x] 10.2 实现纯调度器 `createJobQueue({ runner, maxUnfinished = 4 })`
    - `submit`、`finish`、`cancel`、`position`、`unfinished`、`runningId`；单任务运行、FIFO、未完成上限 4（含上传中占位）
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 10.3 编写假 Demucs_Command `tests/fixtures/fake-demucs.mjs`
    - 按 `FAKE_DEMUCS_MODE` 实现 `ok`、`fail`、`hang`、`slow`、`nohelp`、`probehang`；`ok`/`slow` 解析 `-n/-o/--filename` 与输入路径，向 stderr 写 tqdm 格式进度，在 `out/<model>/<stem>.wav` 写 0.5 秒、每条频率不同的立体声正弦
    - _Requirements: 10.5_

  - [x] 10.4 实现 `createDemucsService`：初始化、检测、状态与上传
    - `init()`：`fs.rm` 并重建 `tempRoot`，再用 `execFile(file, [...args, '--help'], { timeout: probeTimeoutMs, windowsHide: true })` 探测；打印启用或回退提示；探测期间 `status()` 返回 `checking: true`
    - `handle(req, res)`：只认领 `/api/separate` 前缀；JSON 响应头含 `no-store`、`nosniff`，不发 CORS 头
    - `GET /status`；`POST` 按设计 1.4 节顺序处理：503 → 400 → 429 → 413（Content-Length）→ 生成随机 ID、`uploading` 占位、流式写入并计数 → 超限时删除目录并回 413 → 客户端断开时清理 → 完成后入队回 202
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.2_

  - [x] 10.5 实现任务运行、进度、结果下载、取消与清理
    - `pump()`：`execFile(command.file, buildDemucsArgs(...), { windowsHide, maxBuffer, env })`，解析 stderr 进度，超时 kill 并标记失败；按设计 1.5 节处理 `onExit`（失败原因、缺文件、完成后删除上传文件并设置保留计时器）
    - `GET /<id>`（JobJson）、`GET /<id>/<stem>.wav`（仅已完成且属于该模型，流式输出带 `Content-Length`）、`DELETE /<id>`（四种状态的取消）、其他方法 405、非法或不存在 ID 404
    - 失败立即删目录；失败与取消记录作为墓碑保留 `tombstoneMs`；`close()` 终止进程并清计时器；`console.error` 不记录客户端文件名
    - _Requirements: 2.6, 2.7, 3.1, 3.3, 3.4, 3.7, 4.1, 4.3, 4.4, 5.1_

  - [x] 10.6 在 `server.js` 中集成 Demucs_Service
    - `createServer(root, { demucs })`：先交给 `demucs.handle`，其余静态逻辑保持不变；不传 `demucs` 时行为与现在一致
    - 主入口：`createDemucsService({ ...readConfig(), tempRoot: defaultTempRoot() })`，监听后调用 `init()`
    - _Requirements: 1.1, 1.4, 2.9, 4.6, 10.6_

  - [x] 10.7 编写 Demucs_Service 集成测试 `tests/demucs-service.test.mjs`
    - 使用假 Demucs_Command（`process.execPath` + fixture）、每个测试独立的 `fs.mkdtemp` tempRoot，调小 `probeTimeoutMs`、`timeoutMs`、`retentionMs`
    - 覆盖：探测 `ok`/`nohelp`/不存在命令/`probehang` 及终端提示；`/status` 字段；不可用时 POST 503 且无文件；完整成功流程（进度递增、每个输出名 200、上传文件已删、DELETE 后目录被删）；保留到期 404；`fail` 立即清理且含原因；`hang` 超时失败；`slow` × 5 的 429 与 FIFO 与 `position`；排队中与运行中 DELETE；`init()` 清理遗留文件；上传中途断开清理
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.5, 3.1, 3.2, 3.3, 3.4, 3.7, 4.1, 4.3, 4.4, 4.6, 5.1, 10.5_

  - [x] 10.8 扩展 `tests/server.test.mjs`
    - 传入 `demucs` 后静态 MIME、路径穿越 403、404、HEAD、POST `/` 405 的行为与不传时一致
    - 断言 `package.json` 没有 `dependencies` / `devDependencies`
    - _Requirements: 2.9, 10.4, 10.6_

  - [x] 10.9 编写属性测试：任务文件路径只由服务器值组成
    - **Property 2: 任务文件路径只由服务器值组成**
    - **Validates: Requirements 2.2, 2.6**

  - [x] 10.10 编写属性测试：超限上传被拒且不留文件
    - **Property 3: 超限上传被拒且不留文件**
    - 真实 HTTP 服务，`maxUploadBytes` 取 1–64 KB 随机值，带或不带 `Content-Length`
    - **Validates: Requirements 2.1, 2.3**

  - [x] 10.11 编写属性测试：非法模型被拒
    - **Property 4: 非法模型被拒**
    - **Validates: Requirements 2.4**

  - [x] 10.12 编写属性测试：非法任务 ID 与音轨名返回 404
    - **Property 5: 非法任务 ID 与音轨名返回 404**
    - 20 次 HTTP 请求打一个已完成任务，其余在 `isJobId` / 音轨名校验纯函数上进行
    - **Validates: Requirements 2.7, 5.1**

  - [x] 10.13 编写属性测试：队列先进先出、单进程、未完成上限 4
    - **Property 6: 队列先进先出、单进程、未完成上限 4**
    - 在 `createJobQueue` 上用随机的提交 / 结束 / 取消序列
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 10.14 编写属性测试：进度解析取最后一个值
    - **Property 7: 进度解析取最后一个值**
    - **Validates: Requirements 3.4**

- [x] 11. Checkpoint - 确保全部测试通过
  - 运行 `node --test tests/*.test.mjs`，确保全部测试通过，有疑问时询问用户。

- [x] 12. 实现浏览器端 Demucs 客户端（`public/js/remote-separator.js`）
  - [x] 12.1 实现设置清洗、状态查询与文字函数
    - `DEFAULT_DEMUCS_MODEL`、`API`、`sanitizeDemucsModel`、`fetchDemucsStatus`（默认 3 秒超时，任何异常/非 2xx/无效 JSON/`checking` 返回 null 或不可用，从不抛错）、`remoteProgressText`、`fallbackNotice`、`DemucsError`
    - `separateWithFallback({ fetchStatus, runDemucs, runDsp, onNotice, stillCurrent })`：状态未确认可用 → 只调 `runDsp`；`runDemucs` 抛 AbortError → 原样抛出且不调 `runDsp`；其他错误 → `onNotice(fallbackNotice(err))` 后调 `runDsp`
    - _Requirements: 1.5, 1.6, 2.8, 3.5, 6.1, 6.2, 6.4, 7.2, 7.4_

  - [x] 12.2 实现 `runDemucsSeparation`
    - POST（`application/octet-stream`，`model` 与 `ext` 查询参数）→ 每 `pollMs` 轮询（连续 5 次网络失败才算失败）→ `done` 后经 `decodeWav` 与 `mapDemucsStems` 逐条下载、映射、`encode` 为 Blob URL → 全部完成后 DELETE
    - 下载或解码失败：撤销已建 Blob URL、DELETE、抛 `DemucsError({ stage: 'download' })`；`failed`/`cancelled`/404 抛 `DemucsError({ stage: 'job' })`
    - `signal` 中止：`keepalive` DELETE、撤销 Blob URL、停止轮询、抛 `AbortError`
    - 返回 `{ urls, bpm, model, sources, sampleRate, mono, duration }`
    - _Requirements: 3.5, 4.2, 4.5, 5.9, 6.1, 6.2, 6.3, 6.4_

  - [x] 12.3 编写单元测试 `tests/remote-separator.test.mjs`
    - 状态请求永不返回且 `timeoutMs = 50` → null；轮询间隔为 1000 ms（假 `sleep`）；第 3 条下载失败 → Blob URL 被撤销、发出 DELETE、抛 DemucsError；运行中 abort → `keepalive` DELETE、停止轮询、抛 AbortError；全部下载完成后发出 DELETE
    - _Requirements: 1.5, 3.5, 4.2, 4.5, 6.3, 6.4, 10.5_

  - [x] 12.4 编写属性测试：进度文字包含位置和百分比
    - **Property 8: 进度文字包含位置和百分比**
    - **Validates: Requirements 3.5**

- [x] 13. 在 `app.js` 中接入分离流程、设置、取消与分析面板
  - [x] 13.1 添加 Demucs_Model 设置
    - `loadSettings` 增加 `demucsModel: sanitizeDemucsModel(s.demucsModel)`，损坏 JSON 时回到默认；`saveSettings` 写入同一 `SETTINGS_KEY`
    - `index.html`「我的」页面加 `#demucsModel` 下拉框与 `#demucsHint`；`style.css` 补样式；`change` 时清洗并保存
    - App 启动时调用一次 `fetchDemucsStatus` 并 `renderDemucsHint()`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 13.2 实现 `separateEntry` 并接入 `openEntry`
    - 缓存命中分支不变；未命中时保留原有大小/元数据时长检查与 `evictStemCaches`，再调用 `separateEntry`
    - 通过 `separateWithFallback` 组合：`fetchStatus` 调 `fetchDemucsStatus` 并刷新 `#demucsHint`；`runDemucs` 调 `runDemucsSeparation`（`onPhase` 更新 `state.progressText`，`onProgress` 更新进度）；元数据时长未知时用下载结果长度再跑 `separationLimitMessage`
    - `onNotice` 写入 `state.notice` 并重置进度；AbortError 直接结束，不跑 DSP
    - DSP 路径 `mode = mobile ? 'fast' : 'high'`；结果以 `{ urls, analysis }` 交给 `player.setStems` 与 `entry.cache`（`analysis.engine`、`model`/`sources` 或 `qualityMode`）
    - 进度区渲染 `state.progressText` 与 `state.notice`；分离中只有「原曲」可点
    - _Requirements: 1.5, 1.6, 2.8, 3.5, 3.6, 5.8, 5.9, 6.1, 6.2, 6.3, 6.4, 8.1, 8.2, 8.5, 10.1, 10.2, 10.3_

  - [x] 13.3 添加「取消分离」按钮
    - 进度区按钮仅在 `state.separating` 时显示；点击执行 `state.abort.abort()`、设置 `state.separating = false` 与提示「已取消分离，原曲可以正常播放。」；`index.html` 与 `style.css` 同步修改
    - 打开另一个文件时沿用原有 `state.abort.abort()`，由 `runDemucsSeparation` 发 DELETE 并停止轮询
    - _Requirements: 4.2, 6.4_

  - [x] 13.4 更新 Analysis_Panel
    - `engine === 'demucs'` 显示「分离方式：Demucs AI（模型名）」，音轨说明用 `analysis.sources`
    - `engine === 'dsp'` 显示「分离方式：浏览器 DSP（高质量模式 / 快速模式）」，音轨说明用 `stemNotes(analysis.qualityMode)`；「原曲」说明不变
    - _Requirements: 5.10, 8.6, 9.6_

  - [x] 13.5 扩展 App 测试 `tests/app.test.mjs`
    - 现有两个测试不变（Node 下相对 URL `fetch` 失败 → 走 DSP）
    - 注入 `globalThis.fetch` 桩：Demucs 完成后 8 个按钮可用、`analysis.engine === 'demucs'`、分析面板含模型名；再次打开同一文件不发 POST；分离中只有「原曲」可点；POST 500 → 走 DSP 且提示含「浏览器分离」；点击「取消分离」→ 发出 DELETE 且 `runSeparation` 未被调用
    - `mobile = true/false` 时 `runSeparation` 收到 `'fast'`/`'high'`，分析面板显示对应模式名；状态不可用时 `#demucsHint` 可见；改下拉框后 localStorage 更新
    - _Requirements: 1.6, 3.6, 5.9, 5.10, 6.1, 6.4, 7.3, 7.5, 8.1, 8.2, 8.6, 10.3, 10.4, 10.5_

  - [x] 13.6 编写属性测试：模型设置的保存往返与清洗
    - **Property 13: 模型设置的保存往返与清洗**
    - `sanitizeDemucsModel` 部分放在 `tests/remote-separator.test.mjs`，`loadSettings` 部分在 `tests/app.test.mjs` 用桩 localStorage
    - **Validates: Requirements 7.2, 7.3, 7.4**

  - [x] 13.7 编写属性测试：状态未确认可用时不上传
    - **Property 1: 状态未确认可用时不上传**
    - 在 `tests/remote-separator.test.mjs` 中测试 `separateWithFallback`：经假 `fetch` 驱动 `fetchDemucsStatus`，生成网络错误、超时、非 2xx、无效 JSON、`available` 非真、`checking` 为真等状态；断言只调用 `runDsp` 桩且 `fetch` 未收到 POST
    - **Validates: Requirements 1.6, 2.8**

  - [x] 13.8 编写属性测试：回退时给出提示并带上失败原因
    - **Property 12: 回退时给出提示并带上失败原因**
    - 在 `tests/remote-separator.test.mjs` 中用假 `fetch` 驱动 `separateWithFallback` + 真实 `runDemucsSeparation`，生成 400–599 状态码、网络异常与任意非空失败原因；断言 `runDsp` 被调用、提示含「浏览器分离」且任务失败时含原因
    - **Validates: Requirements 6.1, 6.2**

- [x] 14. 更新 README
  - [x] 14.1 在 `README.md` 中说明新功能
    - Demucs 安装与启用（`DEMUCS_CMD` 格式、Windows 用 `demucs.exe` 或 `python -m demucs`，不支持 `.cmd`/`.bat`；需另装 FFmpeg 才能读取 MP4/M4A/MOV 等格式，缺少时任务失败并自动回退浏览器分离）
    - 只有使用 Demucs 时文件才上传到本地 Server，DSP 分离只在浏览器内处理
    - Demucs_Model 设置、Quality_Mode 分档（电脑高质量 / 手机快速）、环境变量 `DEMUCS_CMD`、`DEMUCS_MAX_UPLOAD_MB`、`DEMUCS_TIMEOUT_MIN`，以及可选的 `BENCH_PERF=1` 性能测试
    - _Requirements: 10.7_

- [x] 15. Final checkpoint - 确保全部测试通过
  - 运行 `node --test tests/*.test.mjs`，确保全部测试通过；再以 `BENCH_PERF=1` 运行一次 `tests/separation-perf.test.mjs`，确认 Requirement 8.3、8.4 的耗时与内存预算。有疑问时询问用户。

## Notes

- 标有 `*` 的子任务（属性测试、部分单元测试）可以跳过以加快 MVP；Requirement 10.5 明确要求的测试（任务 10.7、9.2、13.5、12.3、5.3）和验证 Requirement 8.3/8.4 的性能对比测试（任务 5.8）为必做
- 任务 1.2 必须在任何 `separator.js` 改动之前完成，保证 Baseline_Separator 是原算法的忠实副本
- 每条属性测试至少 100 次迭代，测试名形如 `Feature: separation-accuracy, Property N: …`，失败时可用 `PROP_SEED` 复现
- 性能对比测试默认跳过，只在设置 `BENCH_PERF=1` 时运行
- 每个任务都引用具体的需求条款，便于追溯

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "8.1", "10.1", "10.3"] },
    { "id": 1, "tasks": ["1.4", "2.2", "8.2", "9.1", "10.2", "12.1"] },
    { "id": 2, "tasks": ["2.3", "3.1", "8.3", "9.2", "10.4", "12.2"] },
    { "id": 3, "tasks": ["3.2", "9.3", "10.5", "12.3"] },
    { "id": 4, "tasks": ["3.3", "9.4", "10.6", "12.4"] },
    { "id": 5, "tasks": ["5.1", "9.5", "10.7", "10.8"] },
    { "id": 6, "tasks": ["5.2", "9.6", "10.9"] },
    { "id": 7, "tasks": ["6.1", "10.10"] },
    { "id": 8, "tasks": ["5.3", "6.2", "10.11", "13.1"] },
    { "id": 9, "tasks": ["5.4", "5.8", "10.12", "13.2"] },
    { "id": 10, "tasks": ["5.5", "10.13", "13.3"] },
    { "id": 11, "tasks": ["5.6", "10.14", "13.4"] },
    { "id": 12, "tasks": ["5.7", "13.5"] },
    { "id": 13, "tasks": ["13.6", "14.1"] },
    { "id": 14, "tasks": ["13.7"] },
    { "id": 15, "tasks": ["13.8"] }
  ]
}
```
