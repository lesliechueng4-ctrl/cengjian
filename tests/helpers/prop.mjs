// 属性测试工具：种子 PRNG、生成器与 forAll。只用 Node 内置功能，无第三方依赖。
//
// 生成器是形如 (rng) => value 的函数，rng() 返回 [0, 1) 的浮点数。
// forAll 使用一个主种子驱动整个生成序列；失败时报告主种子、失败的轮次与反例，
// 设置环境变量 PROP_SEED=<种子> 即可复现同一序列。

/** mulberry32：32 位种子的确定性 PRNG，返回 [0, 1) 的浮点数。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数，闭区间 [min, max]。 */
export function int(min = 0, max = 100) {
  const lo = Math.ceil(min), hi = Math.floor(max);
  if (hi < lo) throw new RangeError(`int: empty range [${min}, ${max}]`);
  return (rng) => lo + Math.floor(rng() * (hi - lo + 1));
}

/** 浮点数，半开区间 [min, max)。 */
export function float(min = 0, max = 1) {
  if (!(max >= min)) throw new RangeError(`float: invalid range [${min}, ${max}]`);
  return (rng) => min + rng() * (max - min);
}

/** 从若干生成器（或常量）中等概率挑一个，再用它生成值。 */
export function oneOf(...choices) {
  const list = choices.length === 1 && Array.isArray(choices[0]) ? choices[0] : choices;
  if (list.length === 0) throw new RangeError('oneOf: no choices');
  return (rng) => {
    const c = list[Math.floor(rng() * list.length)];
    return typeof c === 'function' ? c(rng) : c;
  };
}

/** 数组：长度在 [minLength, maxLength] 内，元素由 itemGen 生成。 */
export function array(itemGen, { minLength = 0, maxLength = 10 } = {}) {
  const len = int(minLength, maxLength);
  return (rng) => {
    const n = len(rng);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = itemGen(rng);
    return out;
  };
}

const ASCII_SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';
const ASCII_PUNCT = ' !"#$%&\'()*+,;<=>?@[]^`{|}~';
const UNICODE_FRAGMENTS = [
  '层', '间', '音', '乐', 'é', 'ß', 'Ω', 'Ж', 'ي', 'א', '한',
  '\u0301',       // 组合重音符
  '\u200b',       // 零宽空格
  '\u202e',       // 从右到左覆盖
  '\ufeff',       // BOM
  '😀', '🎵',     // 代理对
  '\ud800',       // 孤立代理项
];
const HOSTILE_FRAGMENTS = [
  '../', '..\\', '..', '/', '\\', '/etc/passwd', 'C:\\', 'C:/Windows/', '\\\\server\\share\\',
  '%2e%2e%2f', '%00', '\0', '\n', '\r', '\t', '~', '.', '//', ':', '*', '?',
];

/**
 * 字符串：由普通字符、标点、`../` 等路径穿越片段、绝对路径、空字节、Unicode 片段拼接。
 * 长度按片段计数，范围 [minLength, maxLength]。
 */
export function string({ minLength = 0, maxLength = 24 } = {}) {
  const len = int(minLength, maxLength);
  const pick = (rng, s) => s[Math.floor(rng() * s.length)];
  return (rng) => {
    const n = len(rng);
    let out = '';
    for (let i = 0; i < n; i++) {
      const r = rng();
      if (r < 0.45) out += pick(rng, ASCII_SAFE);
      else if (r < 0.55) out += pick(rng, ASCII_PUNCT);
      else if (r < 0.8) out += pick(rng, HOSTILE_FRAGMENTS);
      else out += pick(rng, UNICODE_FRAGMENTS);
    }
    return out;
  };
}

/**
 * 随机音频信号：噪声、正弦叠加、脉冲串的随机组合（至少一种），峰值归一到 amplitude。
 * - 不指定 channels：返回一条 Float32Array
 * - 指定 channels（数字或 [min, max]）：返回等长 Float32Array 数组，各声道独立随机混合
 */
export function signal({
  minLength = 1024,
  maxLength = 8192,
  sampleRate = 16000,
  amplitude = 0.9,
  channels,
} = {}) {
  const lenGen = int(minLength, maxLength);
  const chGen = channels === undefined ? null
    : Array.isArray(channels) ? int(channels[0], channels[1]) : () => channels;
  return (rng) => {
    const n = lenGen(rng);
    if (!chGen) return makeSignal(rng, n, sampleRate, amplitude);
    const c = chGen(rng);
    const out = [];
    for (let i = 0; i < c; i++) out.push(makeSignal(rng, n, sampleRate, amplitude));
    return out;
  };
}

function makeSignal(rng, n, sampleRate, amplitude) {
  const x = new Float32Array(n);
  let parts = Math.floor(rng() * 8); // 3 位掩码：噪声 / 正弦 / 脉冲
  if (parts === 0) parts = 1 << Math.floor(rng() * 3);
  if (parts & 1) {
    const g = 0.1 + rng();
    for (let i = 0; i < n; i++) x[i] += g * (rng() * 2 - 1);
  }
  if (parts & 2) {
    const k = 1 + Math.floor(rng() * 6);
    const nyq = sampleRate / 2;
    for (let s = 0; s < k; s++) {
      const f = 20 + rng() * (nyq * 0.9 - 20);
      const g = 0.1 + rng();
      const ph = rng() * 2 * Math.PI;
      const w = 2 * Math.PI * f / sampleRate;
      for (let i = 0; i < n; i++) x[i] += g * Math.sin(w * i + ph);
    }
  }
  if (parts & 4) {
    const period = Math.max(2, Math.floor(sampleRate * (0.01 + rng() * 0.25)));
    const decay = Math.max(1, Math.floor(sampleRate * (0.001 + rng() * 0.03)));
    const g = 0.2 + rng();
    for (let start = Math.floor(rng() * period); start < n; start += period) {
      for (let j = 0; j < decay && start + j < n; j++) x[start + j] += g * Math.exp(-5 * j / decay);
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0) {
    const s = amplitude / peak;
    for (let i = 0; i < n; i++) x[i] *= s;
  }
  return x;
}

/** 便于 `gen.int(...)` 风格调用的命名空间。 */
export const gen = { int, float, string, oneOf, array, signal };

function parseSeed(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`PROP_SEED/seed must be a number, got ${JSON.stringify(v)}`);
  return n >>> 0;
}

/** 反例的可读表示：类型化数组只打印长度与前几个值，字符串转义（空字节等可见）。 */
export function describe(value, depth = 0) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value === null || typeof value !== 'object') return String(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const head = Array.from(value.subarray(0, 8), (v) => Number(v).toPrecision(4)).join(', ');
    return `${value.constructor.name}(${value.length}) [${head}${value.length > 8 ? ', …' : ''}]`;
  }
  if (depth > 4) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => describe(v, depth + 1));
    if (value.length > 20) items.push(`… ${value.length - 20} more`);
    return `[${items.join(', ')}]`;
  }
  const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${describe(v, depth + 1)}`);
  return `{${entries.join(', ')}}`;
}

/**
 * 对 runs 个生成值逐一执行 fn（可为 async）。fn 抛错或返回 false 视为失败。
 * 种子优先级：环境变量 PROP_SEED > options.seed > 随机。
 * 返回 { seed, runs }。
 */
export async function forAll(generator, fn, { runs = 100, seed } = {}) {
  const fromEnv = parseSeed(process.env.PROP_SEED);
  const actualSeed = fromEnv ?? parseSeed(seed) ?? ((Math.random() * 4294967296) >>> 0);
  const rng = mulberry32(actualSeed);
  for (let i = 0; i < runs; i++) {
    const value = generator(rng);
    let error;
    try {
      const result = await fn(value, i);
      if (result === false) error = new Error('property returned false');
    } catch (e) {
      error = e;
    }
    if (error) {
      const reason = error && error.message ? error.message : String(error);
      const err = new Error(
        `Property failed on run ${i + 1}/${runs} (seed ${actualSeed}; reproduce with PROP_SEED=${actualSeed})\n` +
        `Counterexample: ${describe(value)}\n` +
        `Cause: ${reason}`,
        { cause: error },
      );
      err.seed = actualSeed;
      err.run = i;
      err.counterexample = value;
      throw err;
    }
  }
  return { seed: actualSeed, runs };
}
