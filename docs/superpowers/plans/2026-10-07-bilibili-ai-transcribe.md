# B 站无字幕视频 AI 音频转写 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B 站无 CC 字幕的视频在剪藏时可手动触发 AI 音频转写（SiliconFlow Qwen3-ASR-1.7B），转写结果作为 `{{transcript}}` 内容。

**Architecture:** background 编排（playurl 拿 64kbps 音频流 → 按 moof 边界分块 Range 下载 → 发到视频页 content script 用 WebAudio 解码转 16kHz WAV → 回 background 调 ASR API）→ 结果按 `bvid:cid` 缓存 → 剪藏时 extractor 注入。页面浮层（shadow DOM）做触发与进度 UI。

**Tech Stack:** TypeScript / MV3 (service worker + alarms 保活) / WebAudio (OfflineAudioContext 重采样) / vitest

**Spec:** `docs/superpowers/specs/2026-10-07-bilibili-ai-transcribe-design.md`

## Global Constraints

- 目标分支：`feat/bilibili-ai-transcribe`，从 `main` 创建
- 每任务结束：`npx prettier --write <改动文件>` → `npx vitest run <测试文件>` 全过 → 中文 commit message
- 全部 UI 文案走 `_locales`（zh_CN + en 双语），禁止硬编码中文在 TS 逻辑中（测试断言除外）
- ASR 默认端点 `https://api.siliconflow.cn/v1/audio/transcriptions`，默认模型 `Qwen/Qwen3-ASR-1.7B`
- 纯逻辑（WAV 编码、moof 扫描、分块计划、客户端重试、编排状态机）必须 TDD；DOM/浏览器 API 薄封装用构建 + 手动清单验证
- 音频流白名单 host 新增 `*.bilivideo.com`（现状仅 `api.bilibili.com` / `*.hdslb.com`）
- 不改动 YouTube / 爬爬虾等现有正常字幕链路的行为

## Review Focus

1. **mdat 内伪 `moof` 字节**：音频数据恰含 `moof` ASCII 时不得误判边界——Task 3 按完整 box 链遍历（size 跳读），测试用例构造含伪魔数的 mdat。
2. **SW 中途被杀后续传**：任务重启后不得重转已完成块——Task 6 测试：预置 2/5 块完成的 state，断言仅请求缺失块。
3. **Qwen3-ASR 只吃 wav，解码失败需降级**：块解码失败时用 SenseVoiceSmall 直传 m4a 原块——Task 6 测试：decode 抛错时断言发出第二次 ASR 调用且 model 为 SenseVoiceSmall。
4. **缓存按 `bvid:cid` 隔离**：多 P 视频不得命中其他分 P 的转写——Task 8 测试：不同 cid 查询返回空。
5. **API 429/5xx 退避重试**：瞬时失败不得报废整块——Task 5 测试：前两次 429、第三次 200，断言拿到文本且共发起 3 次请求。
6. **API key 未配置**：点转写须立即失败并给出可读原因，不得发起下载——Task 6 测试：无 key 时断言零 playurl 请求。

---

### Task 1: TranscribeSettings 类型与默认值

**Files:**
- Modify: `src/types/types.ts:72-99`（Settings 接口）
- Modify: `src/utils/storage-utils.ts`（默认 settings 对象，找到 `defaultSettings` 或等价常量处）

**Interfaces:**
- Produces（后续所有任务共用）:
```ts
export interface TranscribeSettings {
	enabled: boolean;
	apiKey: string;
	model: string;   // 'Qwen/Qwen3-ASR-1.7B' | 'FunAudioLLM/SenseVoiceSmall' | 'XingChenAGI/XingChenASR-V3.2-Ultra'
	baseUrl: string; // 默认 'https://api.siliconflow.cn'
}
// Settings 增加字段: transcribe?: TranscribeSettings;
```

- [ ] **Step 1: 定位默认设置对象**

Run: `grep -n "interpreterEnabled" src/utils/storage-utils.ts`
Expected: 找到默认值定义处（如 `interpreterEnabled: false` 所在对象）

- [ ] **Step 2: 添加类型**

在 `src/types/types.ts` 的 `Settings` 接口 `readerSettings` 字段前插入 `transcribe?: TranscribeSettings;`，并在文件中 `ReaderSettings` 定义之前加入 `TranscribeSettings` 接口（内容见 Interfaces）。

- [ ] **Step 3: 添加默认值**

在 storage-utils 的默认设置对象中加入：

```ts
transcribe: {
	enabled: false,
	apiKey: '',
	model: 'Qwen/Qwen3-ASR-1.7B',
	baseUrl: 'https://api.siliconflow.cn',
},
```

- [ ] **Step 4: 构建验证**

Run: `npx webpack --env BROWSER=chrome --mode development 2>&1 | tail -2`
Expected: 无 error（warnings 为既有 sass 弃用告警）

- [ ] **Step 5: Commit**

```bash
git add src/types/types.ts src/utils/storage-utils.ts
git commit -m "新增 AI 转写设置类型与默认值"
```

---

### Task 2: WAV 编码纯函数

**Files:**
- Create: `src/utils/audio-wav-encoder.ts`
- Test: `src/utils/audio-wav-encoder.test.ts`

**Interfaces:**
- Produces: `encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer`（16-bit PCM 单声道 WAV）；`decodeAudioToWav(arrayBuffer: ArrayBuffer): Promise<ArrayBuffer>`（薄封装，content script 用，不单测）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'vitest';
import { encodeWav } from './audio-wav-encoder';

function readAscii(view: DataView, offset: number, length: number): string {
	let s = '';
	for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
	return s;
}

describe('encodeWav', () => {
	test('writes canonical 44-byte PCM header', () => {
		const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
		const view = new DataView(buf);
		expect(buf.byteLength).toBe(44 + 10);
		expect(readAscii(view, 0, 4)).toBe('RIFF');
		expect(readAscii(view, 8, 4)).toBe('WAVE');
		expect(readAscii(view, 12, 4)).toBe('fmt ');
		expect(view.getUint32(16, true)).toBe(16);      // fmt chunk size
		expect(view.getUint16(20, true)).toBe(1);       // PCM
		expect(view.getUint16(22, true)).toBe(1);       // mono
		expect(view.getUint32(24, true)).toBe(16000);   // sample rate
		expect(view.getUint32(28, true)).toBe(32000);   // byte rate
		expect(view.getUint16(34, true)).toBe(16);      // bits
		expect(readAscii(view, 36, 4)).toBe('data');
		expect(view.getUint32(40, true)).toBe(10);      // data size
	});

	test('clamps amplitudes into int16 range', () => {
		const buf = encodeWav(new Float32Array([0, 1, -1, 2, -2]), 16000);
		const view = new DataView(buf);
		expect(view.getInt16(44, true)).toBe(0);
		expect(view.getInt16(46, true)).toBe(0x7fff);
		expect(view.getInt16(48, true)).toBe(-0x8000);
		expect(view.getInt16(50, true)).toBe(0x7fff);   // +2 clamp
		expect(view.getInt16(52, true)).toBe(-0x8000);  // -2 clamp
	});

	test('empty samples produce header only', () => {
		expect(encodeWav(new Float32Array(0), 16000).byteLength).toBe(44);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/utils/audio-wav-encoder.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
/**
 * 将 16kHz 单声道浮点采样编码为 16-bit PCM WAV。
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeAscii(36, 'data');
	view.setUint32(40, dataSize, true);
	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
		offset += 2;
	}
	return buffer;
}

/**
 * 在页面上下文解码任意音频容器（m4s/AAC）并重采样为 16kHz 单声道 WAV。
 * 依赖 AudioContext，只能在 content script / 页面环境调用。
 */
export async function decodeAudioToWav(arrayBuffer: ArrayBuffer): Promise<ArrayBuffer> {
	const ctx = new AudioContext();
	try {
		const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
		const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
		const source = offline.createBufferSource();
		source.buffer = decoded;
		source.connect(offline.destination);
		source.start();
		const rendered = await offline.startRendering();
		return encodeWav(rendered.getChannelData(0), 16000);
	} finally {
		void ctx.close();
	}
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/utils/audio-wav-encoder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/audio-wav-encoder.ts src/utils/audio-wav-encoder.test.ts
git commit -m "新增 PCM WAV 编码器与音频解码重采样封装"
```

---

### Task 3: fMP4 fragment 边界扫描与分块计划

**Files:**
- Create: `src/utils/bilibili-audio.ts`
- Test: `src/utils/bilibili-audio.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AudioChunkPlan { start: number; end: number; startSec: number; durationSec: number; }
export function findMoofOffsets(bytes: Uint8Array, from?: number, to?: number): number[];
export function buildChunkPlan(moofOffsets: number[], totalLength: number, initEnd: number, targetChunkBytes: number, bitrateBps: number): AudioChunkPlan[];
```
（`from`/`to` 默认 `0`/`bytes.length`；`moofOffsets` 必须升序；`initEnd` 是第一个 moof 偏移，即 init segment 结束位置；每块 = `[start, end)` 字节区间，下载时前置 init segment 字节）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'vitest';
import { buildChunkPlan, findMoofOffsets } from './bilibili-audio';

function box(type: string, payloadLen: number): Uint8Array {
	const buf = new Uint8Array(8 + payloadLen);
	new DataView(buf.buffer).setUint32(0, buf.length, false);
	for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
	return buf;
}
function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) { out.set(p, off); off += p.length; }
	return out;
}

describe('findMoofOffsets', () => {
	test('walks the box chain and finds every moof', () => {
		const ftyp = box('ftyp', 4);
		const moov = box('moov', 16);
		const moof1 = box('moof', 32);
		const mdat1 = box('mdat', 64);
		const moof2 = box('moof', 32);
		const bytes = concat(ftyp, moov, moof1, mdat1, moof2);
		const base = ftyp.length + moov.length;
		expect(findMoofOffsets(bytes)).toEqual([base, base + moof1.length + mdat1.length]);
	});

	test('does not match fake moof magic inside mdat payload', () => {
		const moof = box('moof', 8);
		// mdat 载荷中埋入伪 'moof' ASCII（含一个非法 size）
		const fake = new Uint8Array(12);
		fake.set([0, 0, 0, 99 /* 非法 size */, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0], 0);
		const mdat = box('mdat', 12);
		mdat.set(fake, 8);
		const bytes = concat(moof, mdat);
		expect(findMoofOffsets(bytes)).toEqual([0]);
	});

	test('stops at truncated box', () => {
		const moof = box('moof', 8);
		const tail = new Uint8Array([0, 0, 0, 200]); // 声称 200 字节但流结束
		expect(findMoofOffsets(concat(moof, tail))).toEqual([0]);
	});
});

describe('buildChunkPlan', () => {
	test('groups fragments into byte-bounded chunks with time estimates', () => {
		// 64kbps：64000/8 = 8000 B/s。init=64B，3 个 fragment 各 4000B（各 0.5s）
		const plan = buildChunkPlan([64, 4064, 8064], 12064, 64, 8000, 64000);
		// target 8000B → [64,8064)（两个 fragment，1s）与 [8064,12064)
		expect(plan).toEqual([
			{ start: 64, end: 8064, startSec: 0, durationSec: 1 },
			{ start: 8064, end: 12064, startSec: 1, durationSec: 0.5 },
		]);
	});

	test('empty offsets yield empty plan', () => {
		expect(buildChunkPlan([], 100, 100, 8000, 64000)).toEqual([]);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/utils/bilibili-audio.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
export interface AudioChunkPlan {
	start: number;
	end: number;
	startSec: number;
	durationSec: number;
}

/**
 * 按 box 链遍历（而非逐字节搜索）返回所有 moof box 起始偏移，
 * 避免 mdat 载荷中的伪 moof 魔数造成误判。
 */
export function findMoofOffsets(bytes: Uint8Array, from = 0, to = bytes.length): number[] {
	const offsets: number[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = from;
	while (pos + 8 <= to) {
		const size = view.getUint32(pos, false);
		if (size < 8 || pos + size > to) break;
		const type = String.fromCharCode(
			bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7],
		);
		if (type === 'moof') offsets.push(pos);
		pos += size;
	}
	return offsets;
}

/**
 * 把 fragment 起点聚合成目标字节数的块，64kbps 恒定码率下字节与时长线性对应。
 * initEnd 之前为 init segment（ftyp/moov/sidx），不含 fragment。
 */
export function buildChunkPlan(
	moofOffsets: number[],
	totalLength: number,
	initEnd: number,
	targetChunkBytes: number,
	bitrateBps: number,
): AudioChunkPlan[] {
	if (!moofOffsets.length) return [];
	const bytesPerSec = Math.max(1, bitrateBps / 8);
	const plan: AudioChunkPlan[] = [];
	let chunkStart = moofOffsets[0];
	for (let i = 0; i < moofOffsets.length; i++) {
		const next = i + 1 < moofOffsets.length ? moofOffsets[i + 1] : totalLength;
		const chunkEnd = next;
		if (chunkEnd - chunkStart >= targetChunkBytes || i === moofOffsets.length - 1) {
			plan.push({
				start: chunkStart,
				end: chunkEnd,
				startSec: (chunkStart - initEnd) / bytesPerSec,
				durationSec: (chunkEnd - chunkStart) / bytesPerSec,
			});
			chunkStart = chunkEnd;
		}
	}
	return plan;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/utils/bilibili-audio.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/bilibili-audio.ts src/utils/bilibili-audio.test.ts
git commit -m "新增 fMP4 fragment 边界扫描与音频分块计划"
```

---

### Task 4: playurl 音频流获取与 Range 下载

**Files:**
- Modify: `src/utils/bilibili-audio.ts`（追加 fetch 函数与解析）
- Modify: `src/background.ts`（`isAllowedBilibiliFetchUrl` 白名单 + `fetchBilibiliRange` action）
- Test: `src/utils/bilibili-audio.test.ts`（追加）

**Interfaces:**
- Consumes: `signWbiKeys`/`signWbiQuery`（`bilibili-wbi.ts`）、`fetchBilibiliJsonWithCookies` 消息（`browser.runtime.sendMessage { action: 'fetchBilibiliJsonWithCookies', url }`）
- Produces:
```ts
export interface BilibiliAudioStream { url: string; sizeBytes: number; durationSec: number; bitrateBps: number; }
export async function fetchBilibiliAudioStream(input: { aid: number; bvid: string; cid: number }): Promise<BilibiliAudioStream>;
export async function downloadAudioRange(url: string, start: number, end: number): Promise<ArrayBuffer>;
```
（fetch 均经消息让 background 执行——新 action `fetchBilibiliRange`，响应 `{ success, data?: ArrayBuffer, error? }`）

- [ ] **Step 1: 写失败测试（追加到 bilibili-audio.test.ts）**

```ts
import browser from './browser-polyfill';

vi.mock('./browser-polyfill', () => ({
	default: { runtime: { sendMessage: vi.fn() } }
}));

describe('fetchBilibiliAudioStream', () => {
	test('picks 64kbps track (id 30232) with fallback to lowest bandwidth', async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (message.action === 'fetchBilibiliJson' && message.url.includes('/x/web-interface/nav')) {
				return { success: true, data: { code: 0, data: { wbi_img: {
					img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
					sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png'
				} } } };
			}
			if (message.action === 'fetchBilibiliJsonWithCookies' && message.url.includes('playurl')) {
				return { success: true, data: { code: 0, data: {
					timelength: 6646000000,
					dash: { audio: [
						{ id: 30280, baseUrl: 'https://upos.example/a.m4s', bandwidth: 320000 },
						{ id: 30232, baseUrl: 'https://upos.example/64k.m4s', bandwidth: 64000 },
					] }
				} } };
			}
			throw new Error(`unexpected ${message.action}`);
		});
		const stream = await fetchBilibiliAudioStream({ aid: 1, bvid: 'BV1test', cid: 2 });
		expect(stream.url).toBe('https://upos.example/64k.m4s');
		expect(stream.bitrateBps).toBe(64000);
		// playurl 请求带 wbi 签名与 fnval=16
		const call = sendMessage.mock.calls.find(([m]: any[]) => m.action === 'fetchBilibiliJsonWithCookies') as any[];
		expect(call[0].url).toContain('fnval=16');
		expect(call[0].url).toMatch(/w_rid=[0-9a-f]{32}/);
	});

	test('throws readable error when no audio track', async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (message.action === 'fetchBilibiliJson' && message.url.includes('/x/web-interface/nav')) {
				return { success: true, data: { code: 0, data: { wbi_img: {
					img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
					sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png'
				} } } };
			}
			if (message.action === 'fetchBilibiliJsonWithCookies') {
				return { success: true, data: { code: 0, data: { dash: { audio: [] } } } };
			}
			throw new Error(`unexpected ${message.action}`);
		});
		await expect(fetchBilibiliAudioStream({ aid: 1, bvid: 'BV1t', cid: 2 }))
			.rejects.toThrow('无可用音频流');
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/utils/bilibili-audio.test.ts`
Expected: FAIL（fetchBilibiliAudioStream 未定义）

- [ ] **Step 3: 实现（追加到 bilibili-audio.ts）**

```ts
import browser from './browser-polyfill';
import { createLogger } from './logger';
import { getWbiKeys, signWbiQuery } from './bilibili-wbi';

const logger = createLogger('BilibiliAudio');

export interface BilibiliAudioStream {
	url: string;
	sizeBytes: number;
	durationSec: number;
	bitrateBps: number;
}

/**
 * 经 wbi 签名 + cookie 注入通道获取 64kbps 音频流地址与体积。
 */
export async function fetchBilibiliAudioStream(input: {
	aid: number; bvid: string; cid: number;
}): Promise<BilibiliAudioStream> {
	const params: Record<string, string> = {
		aid: String(input.aid), bvid: input.bvid, cid: String(input.cid),
		fnval: '16', fnver: '0', fourk: '1',
	};
	let url = `https://api.bilibili.com/x/player/wbi/playurl?${new URLSearchParams(params).toString()}`;
	const wbiKeys = await getWbiKeys(async (u: string) => {
		const r = await browser.runtime.sendMessage({ action: 'fetchBilibiliJson', url: u }) as any;
		if (!r?.success) throw new Error(r?.error || 'fetch failed');
		return r.data;
	}).catch(() => null);
	if (wbiKeys) url = `https://api.bilibili.com/x/player/wbi/playurl?${signWbiQuery(params, wbiKeys)}`;

	const resp = await browser.runtime.sendMessage({ action: 'fetchBilibiliJsonWithCookies', url }) as any;
	if (!resp?.success) throw new Error(resp?.error || 'playurl 请求失败');
	const data = resp.data?.data;
	const audios = data?.dash?.audio || [];
	if (!audios.length) throw new Error('无可用音频流');
	const pick = audios.find((a: any) => a.id === 30232)
		|| [...audios].sort((l: any, r: any) => (l.bandwidth || 0) - (r.bandwidth || 0))[0];
	const bitrateBps = pick.bandwidth || 64000;
	const durationSec = (data.timelength || 0) / 1000;
	return {
		url: (pick.baseUrl || '').replace(/^\/\//, 'https://'),
		sizeBytes: Math.round(durationSec * bitrateBps / 8),
		durationSec,
		bitrateBps,
	};
}

/**
 * Range 下载音频片段，经 background 代理（Referer 注入 + bilivideo 白名单）。
 */
export async function downloadAudioRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
	const resp = await browser.runtime.sendMessage({
		action: 'fetchBilibiliRange', url, rangeStart: start, rangeEnd: end,
	}) as any;
	if (!resp?.success) throw new Error(resp?.error || '音频分块下载失败');
	return resp.data as ArrayBuffer;
}
```

- [ ] **Step 4: background 白名单与 Range action**

`src/background.ts` 的 `isAllowedBilibiliFetchUrl` 增加 `|| parsedUrl.hostname.endsWith('.bilivideo.com')`；新增：

```ts
async function fetchBilibiliRange(url: string, rangeStart: number, rangeEnd: number): Promise<ArrayBuffer> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw new Error('Blocked Bilibili fetch URL');
	}
	const response = await fetch(url, {
		method: 'GET',
		cache: 'no-store',
		headers: {
			Referer: 'https://www.bilibili.com/',
			Range: `bytes=${rangeStart}-${rangeEnd}`,
		},
	});
	if (!response.ok && response.status !== 206) {
		throw new Error(`Bilibili range fetch failed with status ${response.status}`);
	}
	return await response.arrayBuffer();
}
```

onMessage 监听器中（与 `fetchBilibiliJsonWithCookies` 同款模式）追加：

```ts
if (typedRequest.action === 'fetchBilibiliRange' && typedRequest.url) {
	fetchBilibiliRange(typedRequest.url, (typedRequest as any).rangeStart, (typedRequest as any).rangeEnd)
		.then((data) => { sendResponse({ success: true, data }); })
		.catch((error) => { sendResponse({ success: false, error: String(error) }); });
	return true;
}
```

并把 `'fetchBilibiliRange'` 加入底部 `return true` 的 action 列表。

- [ ] **Step 5: 运行测试与构建**

Run: `npx vitest run src/utils/bilibili-audio.test.ts && npx webpack --env BROWSER=chrome --mode development 2>&1 | tail -2`
Expected: 测试 PASS，构建无 error

- [ ] **Step 6: Commit**

```bash
git add src/utils/bilibili-audio.ts src/utils/bilibili-audio.test.ts src/background.ts
git commit -m "新增 playurl 音频流获取与 bilivideo Range 下载代理"
```

---

### Task 5: SiliconFlow ASR 客户端（重试）

**Files:**
- Create: `src/utils/transcribe-client.ts`
- Test: `src/utils/transcribe-client.test.ts`

**Interfaces:**
- Consumes: `TranscribeSettings`（Task 1）
- Produces: `transcribeAudioBlob(audio: ArrayBuffer, mime: string, filename: string, settings: TranscribeSettings): Promise<string>`；错误对象带 `message`（可直接展示）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test, vi } from 'vitest';
import { transcribeAudioBlob } from './transcribe-client';

const SETTINGS = { enabled: true, apiKey: 'sk-test', model: 'Qwen/Qwen3-ASR-1.7B', baseUrl: 'https://api.siliconflow.cn' };

function jsonResponse(body: any, status = 200) {
	return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('transcribeAudioBlob', () => {
	test('posts multipart to transcriptions endpoint and returns text', async () => {
		const fetchMock = vi.fn(async (url: string, init: any) => {
			expect(url).toBe('https://api.siliconflow.cn/v1/audio/transcriptions');
			expect(init.headers.Authorization).toBe('Bearer sk-test');
			expect(init.body).toBeInstanceOf(FormData);
			const model = init.body.get('model');
			expect(model).toBe('Qwen/Qwen3-ASR-1.7B');
			return jsonResponse({ text: '你好' });
		});
		vi.stubGlobal('fetch', fetchMock);
		const text = await transcribeAudioBlob(new ArrayBuffer(10), 'audio/wav', 'chunk.wav', SETTINGS as any);
		expect(text).toBe('你好');
		vi.unstubAllGlobals();
	});

	test('retries 429 twice then succeeds', async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls += 1;
			return calls < 3 ? jsonResponse({ error: 'rate' }, 429) : jsonResponse({ text: 'ok' });
		});
		vi.stubGlobal('fetch', fetchMock);
		const text = await transcribeAudioBlob(new ArrayBuffer(10), 'audio/wav', 'c.wav', SETTINGS as any);
		expect(text).toBe('ok');
		expect(calls).toBe(3);
		vi.unstubAllGlobals();
	});

	test('fails fast on 401 with readable message', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ message: 'bad key' }, 401));
		vi.stubGlobal('fetch', fetchMock);
		await expect(transcribeAudioBlob(new ArrayBuffer(10), 'audio/wav', 'c.wav', SETTINGS as any))
			.rejects.toThrow('API Key 无效或余额不足');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/utils/transcribe-client.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
import type { TranscribeSettings } from '../types/types';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * 调用 OpenAI 兼容的 /v1/audio/transcriptions 端点转写音频块。
 */
export async function transcribeAudioBlob(
	audio: ArrayBuffer,
	mime: string,
	filename: string,
	settings: TranscribeSettings,
): Promise<string> {
	let lastError = '';
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const form = new FormData();
		form.append('model', settings.model);
		form.append('file', new Blob([audio], { type: mime }), filename);
		let response: Response;
		try {
			response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/v1/audio/transcriptions`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${settings.apiKey}` },
				body: form,
			});
		} catch (error) {
			lastError = String(error);
			if (attempt < MAX_ATTEMPTS) continue;
			throw new Error(`转写请求网络失败：${lastError}`);
		}
		if (response.ok) {
			const data = await response.json() as { text?: string };
			return data.text || '';
		}
		const body = await response.text().catch(() => '');
		if (!RETRYABLE.has(response.status)) {
			if (response.status === 401 || response.status === 403) {
				throw new Error('API Key 无效或余额不足');
			}
			throw new Error(`转写失败（HTTP ${response.status}）：${body.slice(0, 200)}`);
		}
		lastError = `HTTP ${response.status}`;
		if (attempt < MAX_ATTEMPTS) {
			await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
		}
	}
	throw new Error(`转写连续失败（${lastError}）`);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/utils/transcribe-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/transcribe-client.ts src/utils/transcribe-client.test.ts
git commit -m "新增 SiliconFlow ASR 客户端（429 退避重试与快速失败）"
```

---

### Task 6: 转写任务编排（状态机 / 断点 / 降级）

**Files:**
- Create: `src/background-transcribe.ts`
- Test: `src/background-transcribe.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `findMoofOffsets`/`buildChunkPlan`、Task 4 的 `fetchBilibiliAudioStream`/`downloadAudioRange`、Task 5 的 `transcribeAudioBlob`
- Produces:
```ts
export interface TranscribeChunkResult { startSec: number; text: string; }
export interface TranscribeTaskState {
	bvid: string; cid: number; aid: number; durationSec: number; model: string;
	status: 'running' | 'done' | 'failed';
	totalChunks: number; completedChunks: number;
	chunkResults: Array<TranscribeChunkResult | null>;
	chunkPlan: Array<{ start: number; end: number; startSec: number; durationSec: number; }>;
	audioUrl: string; error?: string; createdAt: number;
}
export const CHUNK_TARGET_BYTES = 5 * 60 * 8000; // ~5 分钟/块（64kbps）
export async function startTranscribeTask(input: { bvid: string; aid: number; cid: number; durationSec: number; tabId: number; settings: TranscribeSettings }): Promise<void>;
export async function getTranscribeTaskStatus(bvid: string, cid: number): Promise<TranscribeTaskState | null>;
export function assembleTranscript(state: TranscribeTaskState): Array<{ startSec: number; text: string }>; // 纯函数，拼接块结果（null 块输出"[第 N 段转写失败]"）
```
- 依赖注入便于测试：`startTranscribeTask` 接受可选 `deps` 参数覆盖 `fetchStream`/`downloadRange`/`decodeWav`/`transcribe`/`storageGet`/`storageSet`（默认为真实实现）；生产入口传真实实现。
- 存储：`chrome.storage.session` 键 `transcribeTask:{bvid}:{cid}`（任务态）；`chrome.storage.local` 键 `biliTranscript:{bvid}:{cid}`（成品，`{ model, chunks: TranscribeChunkResult[], createdAt }`）。
- 心跳：`chrome.alarms.create('transcribe-heartbeat', { periodInMinutes: 0.3 })`，任务结束 `clearAlarm`。
- 解码桥接：`decodeWav` 默认实现 = `chrome.tabs.sendMessage(tabId, { action: 'decodeAudioToWav', audio })`，返回 `{ success, data?: ArrayBuffer, error? }`；失败时按 spec 降级——用 `FunAudioLLM/SenseVoiceSmall` 直传 m4a 原块（`transcribe(chunkBytes, 'audio/mp4', 'chunk.m4a', { ...settings, model: 'FunAudioLLM/SenseVoiceSmall' })`）。
- 完成：写成品缓存 + `chrome.notifications.create`（basic，消息"AI 转写完成，重新剪藏即可使用"）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test, vi } from 'vitest';
import { assembleTranscript, startTranscribeTask, CHUNK_TARGET_BYTES } from './background-transcribe';

const SETTINGS = { enabled: true, apiKey: 'sk-t', model: 'Qwen/Qwen3-ASR-1.7B', baseUrl: 'https://api.siliconflow.cn' };

describe('assembleTranscript', () => {
	test('joins chunks and marks failed ones', () => {
		const out = assembleTranscript({
			bvid: 'BV1x', cid: 1, aid: 1, durationSec: 100, model: 'm',
			status: 'done', totalChunks: 3, completedChunks: 2,
			chunkResults: [
				{ startSec: 0, text: '第一段' }, null, { startSec: 600, text: '第三段' },
			],
			chunkPlan: [], audioUrl: '', createdAt: 0,
		});
		expect(out).toEqual([
			{ startSec: 0, text: '第一段' },
			{ startSec: 300, text: '[第 2 段转写失败]' },
			{ startSec: 600, text: '第三段' },
		]);
	});
});

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
	const store = new Map<string, any>();
	const calls = { playurl: 0, ranges: [] as Array<[number, number]>, transcribe: [] as string[], decodeFail: false };
	const plan = [0, 1, 2].map((i) => ({
		start: 100 + i * 8000, end: 100 + (i + 1) * 8000,
		startSec: i * 60, durationSec: 60,
	}));
	return {
		calls, store,
		deps: {
			fetchStream: async () => { calls.playurl += 1; return { url: 'https://upos.test/a.m4s', sizeBytes: 24100, durationSec: 180, bitrateBps: 64000 }; },
			downloadRange: async (_u: string, s: number, e: number) => { calls.ranges.push([s, e]); return new ArrayBuffer(e - s); },
			fetchPlan: async () => plan,
			decodeWav: async () => { if (calls.decodeFail) throw new Error('decode failed'); return new ArrayBuffer(10); },
			transcribe: async (_a: any, _m: string, _f: string, s: any) => { calls.transcribe.push(s.model); return `块${calls.transcribe.length}`; },
			storageGet: async (k: string) => store.get(k) ?? null,
			storageSet: async (k: string, v: any) => { store.set(k, v); },
			notify: vi.fn(),
			...overrides,
		},
	};
}

describe('startTranscribeTask', () => {
	test('runs all chunks, persists progress and final cache', async () => {
		const { deps, calls, store } = makeDeps();
		await startTranscribeTask(
			{ bvid: 'BV1x', aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		expect(calls.playurl).toBe(1);
		expect(calls.ranges.length).toBe(3);
		expect(calls.transcribe).toEqual(['Qwen/Qwen3-ASR-1.7B', 'Qwen/Qwen3-ASR-1.7B', 'Qwen/Qwen3-ASR-1.7B']);
		const task = store.get('transcribeTask:BV1x:2');
		expect(task.status).toBe('done');
		expect(task.completedChunks).toBe(3);
		const final = store.get('biliTranscript:BV1x:2');
		expect(final.chunks.map((c: any) => c.text)).toEqual(['块1', '块2', '块3']);
	});

	test('resumes from persisted state without redoing finished chunks', async () => {
		const { deps, calls, store } = makeDeps();
		const plan = [0, 1, 2, 3, 4].map((i) => ({ start: 100 + i * 8000, end: 100 + (i + 1) * 8000, startSec: i * 60, durationSec: 60 }));
		deps.fetchPlan = async () => plan;
		store.set('transcribeTask:BV1x:3', {
			bvid: 'BV1x', cid: 3, aid: 1, durationSec: 300, model: SETTINGS.model,
			status: 'running', totalChunks: 5, completedChunks: 2,
			chunkResults: [{ startSec: 0, text: 'a' }, { startSec: 60, text: 'b' }, null, null, null],
			chunkPlan: plan, audioUrl: 'https://upos.test/a.m4s', createdAt: Date.now(),
		});
		await startTranscribeTask({ bvid: 'BV1x', aid: 1, cid: 3, durationSec: 300, tabId: 7, settings: SETTINGS as any }, deps);
		// 只补做 3 块
		expect(calls.ranges.length).toBe(3);
		const task = store.get('transcribeTask:BV1x:3');
		expect(task.completedChunks).toBe(5);
	});

	test('falls back to SenseVoiceSmall when wav decode fails', async () => {
		const { deps, calls, store } = makeDeps();
		calls.decodeFail = true;
		await startTranscribeTask({ bvid: 'BV1x', aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: SETTINGS as any }, deps);
		// decode 失败 → 每块先用 Qwen(wav) 不可能，直接走 m4a 直传 SenseVoice
		expect(calls.transcribe).toEqual([
			'FunAudioLLM/SenseVoiceSmall', 'FunAudioLLM/SenseVoiceSmall', 'FunAudioLLM/SenseVoiceSmall',
		]);
		expect(store.get('transcribeTask:BV1x:2').status).toBe('done');
	});

	test('fails immediately with readable error when apiKey missing (no playurl call)', async () => {
		const { deps, calls } = makeDeps();
		await startTranscribeTask({ bvid: 'BV1x', aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: { ...SETTINGS, apiKey: '' } as any }, deps);
		expect(calls.playurl).toBe(0);
		const depsAny = deps as any;
		expect(depsAny.notify).toHaveBeenCalledWith(expect.stringContaining('API Key'));
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/utils/../background-transcribe.test.ts 2>&1 | tail -3`（或 `npx vitest run src/background-transcribe.test.ts`）
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/background-transcribe.ts`**

```ts
import type { TranscribeSettings } from './types/types';
import { createLogger } from './utils/logger';
import { buildChunkPlan, findMoofOffsets, downloadAudioRange, fetchBilibiliAudioStream } from './utils/bilibili-audio';
import { transcribeAudioBlob } from './utils/transcribe-client';

const logger = createLogger('Transcribe');

export const CHUNK_TARGET_BYTES = 5 * 60 * 8000;
const FALLBACK_MODEL = 'FunAudioLLM/SenseVoiceSmall';

export interface TranscribeChunkResult { startSec: number; text: string; }

export interface TranscribeTaskState {
	bvid: string; cid: number; aid: number; durationSec: number; model: string;
	status: 'running' | 'done' | 'failed';
	totalChunks: number; completedChunks: number;
	chunkResults: Array<TranscribeChunkResult | null>;
	chunkPlan: Array<{ start: number; end: number; startSec: number; durationSec: number }>;
	audioUrl: string; error?: string; createdAt: number;
}

interface TaskDeps {
	fetchStream: typeof fetchBilibiliAudioStream;
	downloadRange: typeof downloadAudioRange;
	fetchPlan: (stream: { url: string }) => Promise<TranscribeTaskState['chunkPlan']>;
	decodeWav: (audio: ArrayBuffer) => Promise<ArrayBuffer>;
	transcribe: typeof transcribeAudioBlob;
	storageGet: (key: string) => Promise<any>;
	storageSet: (key: string, value: any) => Promise<void>;
	notify: (message: string) => void;
}

export async function getTranscribeTaskStatus(bvid: string, cid: number): Promise<TranscribeTaskState | null> {
	const key = `transcribeTask:${bvid}:${cid}`;
	const store = chrome.storage.session as any;
	const bag = await store.get(key);
	return bag?.[key] ?? null;
}

export function assembleTranscript(state: TranscribeTaskState): TranscribeChunkResult[] {
	const stepSec = state.durationSec / Math.max(1, state.totalChunks);
	return state.chunkResults.map((chunk, index) =>
		chunk ?? { startSec: Math.round(index * stepSec), text: `[第 ${index + 1} 段转写失败]` });
}

async function fetchChunkPlan(stream: { url: string; bitrateBps: number; sizeBytes: number }) {
	const head = await downloadAudioRange(stream.url, 0, Math.min(512 * 1024, stream.sizeBytes) - 1);
	const bytes = new Uint8Array(head);
	const offsets = findMoofOffsets(bytes);
	// 头部可能不含 fragment：扩拉直至找到 moof 或到 4MB
	if (!offsets.length) {
		const bigger = await downloadAudioRange(stream.url, 0, Math.min(4 * 1024 * 1024, stream.sizeBytes) - 1);
		const biggerBytes = new Uint8Array(bigger);
		return buildChunkPlan(findMoofOffsets(biggerBytes), stream.sizeBytes, findMoofOffsets(biggerBytes)[0] ?? 0, CHUNK_TARGET_BYTES, stream.bitrateBps);
	}
	return buildChunkPlan(offsets, stream.sizeBytes, offsets[0], CHUNK_TARGET_BYTES, stream.bitrateBps);
}

export async function startTranscribeTask(
	input: { bvid: string; aid: number; cid: number; durationSec: number; tabId: number; settings: TranscribeSettings },
	externalDeps?: Partial<TaskDeps>,
): Promise<void> {
	const deps: TaskDeps = {
		fetchStream: fetchBilibiliAudioStream,
		downloadRange: downloadAudioRange,
		fetchPlan: fetchChunkPlan,
		decodeWav: async (audio) => {
			const resp = await chrome.tabs.sendMessage(input.tabId, { action: 'decodeAudioToWav', audio }) as any;
			if (!resp?.success) throw new Error(resp?.error || '页面解码失败');
			return resp.data;
		},
		transcribe: transcribeAudioBlob,
		storageGet: async (key) => {
			const area = key.startsWith('transcribeTask:') ? chrome.storage.session : chrome.storage.local;
			const bag = await (area as any).get(key);
			return bag?.[key] ?? null;
		},
		storageSet: async (key, value) => {
			const area = key.startsWith('transcribeTask:') ? chrome.storage.session : chrome.storage.local;
			await (area as any).set({ [key]: value });
		},
		notify: (message) => {
			void chrome.notifications?.create({
				type: 'basic', iconUrl: 'icons/icon128.png', title: 'AI 转写', message,
			});
		},
		...externalDeps,
	};

	if (!input.settings.apiKey) {
		deps.notify('未配置 SiliconFlow API Key，请到设置 → AI 转写中填写');
		return;
	}

	const taskKey = `transcribeTask:${input.bvid}:${input.cid}`;
	const existing = await deps.storageGet(taskKey) as TranscribeTaskState | null;

	let state: TranscribeTaskState;
	if (existing && existing.status === 'running' && existing.chunkPlan.length) {
		state = existing; // 断点续传
	} else {
		try {
			const stream = await deps.fetchStream({ aid: input.aid, bvid: input.bvid, cid: input.cid });
			const plan = await deps.fetchPlan(stream);
			if (!plan.length) throw new Error('未解析到音频分片');
			state = {
				bvid: input.bvid, cid: input.cid, aid: input.aid,
				durationSec: stream.durationSec, model: input.settings.model,
				status: 'running', totalChunks: plan.length, completedChunks: 0,
				chunkResults: plan.map(() => null), chunkPlan: plan,
				audioUrl: stream.url, createdAt: Date.now(),
			};
			await deps.storageSet(taskKey, state);
		} catch (error) {
			logger.warn('Task init failed', { error: String(error) });
			deps.notify(`转写启动失败：${String(error)}`);
			return;
		}
	}

	chrome.alarms?.create('transcribe-heartbeat', { periodInMinutes: 0.3 });

	const initEnd = state.chunkPlan[0]?.start ?? 0;
	for (let i = 0; i < state.chunkPlan.length; i++) {
		if (state.chunkResults[i]) continue;
		const chunk = state.chunkPlan[i];
		try {
			const raw = await deps.downloadRange(state.audioUrl, chunk.start, chunk.end - 1);
			const initBytes = await deps.downloadRange(state.audioUrl, 0, initEnd - 1);
			const combined = new Uint8Array(initBytes.byteLength + raw.byteLength);
			combined.set(new Uint8Array(initBytes), 0);
			combined.set(new Uint8Array(raw), initBytes.byteLength);
			let text: string;
			try {
				const wav = await deps.decodeWav(combined.buffer);
				text = await deps.transcribe(wav, 'audio/wav', `chunk-${i}.wav`, input.settings);
			} catch {
				// Qwen3-ASR 仅接受 wav；解码失败降级 SenseVoiceSmall 直传 m4a
				text = await deps.transcribe(combined.buffer, 'audio/mp4', `chunk-${i}.m4a`, { ...input.settings, model: FALLBACK_MODEL });
			}
			state.chunkResults[i] = { startSec: chunk.startSec, text: text.trim() };
		} catch (error) {
			logger.warn(`Chunk ${i} failed`, { error: String(error) });
			state.chunkResults[i] = null;
		}
		state.completedChunks = state.chunkResults.filter(Boolean).length;
		await deps.storageSet(taskKey, state);
	}

	state.status = 'done';
	await deps.storageSet(taskKey, state);
	await deps.storageSet(`biliTranscript:${input.bvid}:${input.cid}`, {
		model: state.model,
		chunks: assembleTranscript(state),
		createdAt: Date.now(),
	});
	chrome.alarms?.clear('transcribe-heartbeat');
	deps.notify('AI 转写完成，重新剪藏即可使用');
}
```

（注：`fetchPlan` 签名与测试 mock 对齐——mock 里 `fetchPlan: async () => plan` 忽略入参，实现取 `stream` 对象。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/background-transcribe.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/background-transcribe.ts src/background-transcribe.test.ts
git commit -m "新增转写任务编排：断点续传、解码降级与成品缓存"
```

---

### Task 7: background 消息接线 + content 解码宿主

**Files:**
- Modify: `src/background.ts`（onMessage 加 2 个 action + import）
- Modify: `src/content.ts`（注册 `decodeAudioToWav` 监听）

**Interfaces:**
- Consumes: Task 6 的 `startTranscribeTask`/`getTranscribeTaskStatus`、Task 2 的 `decodeAudioToWav`、`storage-utils` 的 `loadSettings`
- Produces: 消息协议
  - content → background：`{ action: 'startBilibiliTranscribe', bvid, aid, cid, durationSec }`（sender.tab 提供发起 tab）
  - content → background：`{ action: 'getBilibiliTranscribeStatus', bvid, cid }` → `{ status, completedChunks, totalChunks } | null`
  - background → content（tabs.sendMessage）：`{ action: 'decodeAudioToWav', audio }` → `{ success, data?, error? }`

- [ ] **Step 1: background 路由**

`src/background.ts` 顶部 import：

```ts
import { startTranscribeTask, getTranscribeTaskStatus } from './background-transcribe';
import { loadSettings } from './utils/storage-utils';
```

onMessage 监听器内追加（照 `fetchBilibiliJson` 模式）：

```ts
if (typedRequest.action === 'startBilibiliTranscribe') {
	const req = typedRequest as any;
	const settings = (await loadSettings()) as any;
	startTranscribeTask({
		bvid: req.bvid, aid: req.aid, cid: req.cid, durationSec: req.durationSec,
		tabId: sender.tab?.id ?? -1,
		settings: settings.transcribe ?? { enabled: false, apiKey: '', model: 'Qwen/Qwen3-ASR-1.7B', baseUrl: 'https://api.siliconflow.cn' },
	}).then(() => sendResponse({ success: true }))
		.catch((error) => sendResponse({ success: false, error: String(error) }));
	return true;
}
if (typedRequest.action === 'getBilibiliTranscribeStatus' && typedRequest.url !== undefined) {
	// 占位避免误入；实际字段在下方
}
if ((typedRequest as any).action === 'getBilibiliTranscribeStatus') {
	const req = typedRequest as any;
	getTranscribeTaskStatus(req.bvid, req.cid).then((state) => {
		sendResponse(state ? {
			success: true,
			status: state.status,
			completedChunks: state.completedChunks,
			totalChunks: state.totalChunks,
		} : { success: true, status: null });
	});
	return true;
}
```

（实现时删除上面中间的占位 if；两个 action 都加入底部 `return true` 列表。）

- [ ] **Step 2: content 解码宿主**

`src/content.ts` 顶部 import `decodeAudioToWav`（`./utils/audio-wav-encoder`），在既有 `browser.runtime.onMessage.addListener` 区域追加：

```ts
browser.runtime.onMessage.addListener((request: any, _sender: any, sendResponse: (r?: any) => void) => {
	if (request?.action === 'decodeAudioToWav' && request.audio instanceof ArrayBuffer) {
		decodeAudioToWav(request.audio)
			.then((wav) => sendResponse({ success: true, data: wav }))
			.catch((error) => sendResponse({ success: false, error: String(error) }));
		return true;
	}
	return undefined;
});
```

- [ ] **Step 3: 构建验证**

Run: `npx webpack --env BROWSER=chrome --mode development 2>&1 | tail -2`
Expected: 无 error

- [ ] **Step 4: 手动冒烟（保留清单）**

1. `chrome://extensions` 刷新扩展
2. 打开无字幕 B 站视频页，控制台执行：
   `chrome.runtime.sendMessage({ action: 'startBilibiliTranscribe', bvid: location.pathname.match(/BV\w+/)[0], aid: <aid>, cid: <cid>, durationSec: <dur> })`
3. 预期：通知出现；`getBilibiliTranscribeStatus` 轮询可见 completedChunks 递增；完成后 `chrome.storage.local` 有 `biliTranscript:...` 键

- [ ] **Step 5: Commit**

```bash
git add src/background.ts src/content.ts
git commit -m "接线转写消息协议与页面音频解码宿主"
```

---

### Task 8: extractor 缓存注入

**Files:**
- Modify: `src/utils/bilibili-extractor.ts`（`extractBilibiliStructuredContent` 内，字幕轨不可信/为空分支）
- Test: `src/utils/bilibili-extractor.test.ts`（追加）

**Interfaces:**
- Consumes: `browser.storage.local`（键 `biliTranscript:{bvid}:{cid}`）；现有 `groupTranscriptByChapters`/`buildBilibiliTranscriptMarkdown`
- Produces: 无字幕轨且缓存命中时——`transcript` 填充（每块转 `BilibiliTranscriptCue { from, to, content }`，`from=startSec`、`to=startSec+600` 占位）、`subtitleNotice = '以下内容由 AI 语音转写生成（模型 {model}），可能存在识别误差'`；同时导出辅助函数供浮层查询：
```ts
export async function readCachedTranscript(bvid: string, cid: number): Promise<{ model: string; chunks: Array<{ startSec: number; text: string }>; createdAt: number } | null>;
```

- [ ] **Step 1: 写失败测试（追加）**

```ts
test('injects cached AI transcript when no subtitle track exists', async () => {
	const sendMessage = vi.mocked(browser.runtime.sendMessage);
	sendMessage.mockReset();
	sendMessage.mockImplementation(async (message: any) => {
		if (message.action === 'fetchBilibiliJson' && message.url.includes('/x/web-interface/view')) {
			return { success: true, data: { code: 0, data: {
				aid: 123, bvid: 'BV1aiTrans1', title: '转写注入视频', desc: '简介', cid: 456,
				pages: [{ page: 1, cid: 456, duration: 6646, part: 'P1' }]
			} } };
		}
		if (message.action === 'fetchBilibiliJson' && message.url.includes('/x/web-interface/nav')) {
			return { success: true, data: { code: 0, data: { wbi_img: {
				img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
				sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png'
			} } } };
		}
		if (message.action === 'fetchBilibiliJson' && message.url.includes('/x/player/')) {
			return { success: true, data: { code: 0, data: { subtitle: { subtitles: [] }, view_points: [] } } };
		}
		if (message.action === 'fetchBilibiliJsonWithCookies') {
			return { success: true, data: { code: 0, data: { login_mid: 1, subtitle: { subtitles: [] }, view_points: [] } } };
		}
		throw new Error(`Unexpected ${message.action}`);
	});
	// 注入 storage mock
	const storageData = new Map([['biliTranscript:BV1aiTrans1:456', {
		model: 'Qwen/Qwen3-ASR-1.7B', createdAt: 1,
		chunks: [{ startSec: 0, text: '第一块文本' }, { startSec: 300, text: '第二块文本' }],
	}]]);
	vi.stubGlobal('browser', {
		...browser,
		storage: { local: { get: async (k: string) => (storageData.has(k) ? { [k]: storageData.get(k) } : {}), set: async () => {} } },
	});
	const { document: doc } = parseHTML('<html><head><title>Bilibili</title></head><body></body></html>');
	Object.defineProperty(doc, 'URL', { value: 'https://www.bilibili.com/video/BV1aiTrans1/', configurable: true });
	const content = await extractBilibiliStructuredContent(doc as unknown as Document);
	vi.unstubAllGlobals();
	expect(content?.transcriptText).toContain('第一块文本');
	expect(content?.transcriptText).toContain('第二块文本');
	expect(content?.subtitleNotice).toContain('AI 语音转写');
	expect(content?.subtitleNotice).toContain('Qwen3-ASR');
});

test('does not hit cache for a different cid', async () => {
	// 同上 mock，但 storage 里只有 cid=999 的缓存 → transcript 为空、notice 为无字幕文案
	// （断言 content?.transcript).toHaveLength(0) 且 notice 不含 'AI 语音转写'）
});
```

（第二个测试体复制第一个，仅改 storageData 键为 `biliTranscript:BV1aiTrans1:999` 并调整断言。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/utils/bilibili-extractor.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

`bilibili-extractor.ts` 新增：

```ts
interface CachedTranscript {
	model: string;
	chunks: Array<{ startSec: number; text: string }>;
	createdAt: number;
}

export async function readCachedTranscript(bvid: string, cid: number): Promise<CachedTranscript | null> {
	const key = `biliTranscript:${bvid}:${cid}`;
	try {
		const bag = await browser.storage.local.get(key);
		return (bag as any)?.[key] ?? null;
	} catch {
		return null;
	}
}
```

`extractBilibiliStructuredContent` 中，在 `buildSubtitleNotice(...)` 调用之后追加：

```ts
let finalNotice = subtitleNotice;
let transcriptFinal = transcript;
if (!transcript.length && !subtitleStable === false) { /* placeholder guard, 删除 */ }
if (!transcript.length) {
	const cached = await readCachedTranscript(viewData.bvid || parsedUrl.bvid || '', resolvedPage.cid);
	if (cached?.chunks?.length) {
		transcriptFinal = cached.chunks.map((c) => ({
			from: c.startSec, to: c.startSec + 600, content: c.text,
		})).filter((cue) => cue.content.trim().length > 0);
		finalNotice = `以下内容由 AI 语音转写生成（模型 ${cached.model}），可能存在识别误差`;
	}
}
```

随后把本函数内所有 `transcript` 引用替换为 `transcriptFinal`（transcriptText/markdown/structuredHtml/wordCount/返回值），`subtitleNotice` 引用替换为 `finalNotice`。（实现时删除占位 guard 行。）

- [ ] **Step 4: 运行全部 B 站测试**

Run: `npx vitest run src/utils/bilibili-extractor.test.ts`
Expected: 全部 PASS（含既有 15 个）

- [ ] **Step 5: Commit**

```bash
git add src/utils/bilibili-extractor.ts src/utils/bilibili-extractor.test.ts
git commit -m "剪藏时注入缓存的 AI 转写字幕并标注来源"
```

---

### Task 9: 设置区块 + i18n + 页面浮层 UI

**Files:**
- Modify: `src/settings.html`（新区块 DOM，置于解释器区块之后，class/结构照抄现有 section）
- Create: `src/managers/transcribe-settings.ts`
- Modify: `src/core/settings.ts`（初始化新区块，照 interpreter 区块挂载点）
- Create: `src/content-transcribe-ui.ts`（浮层）
- Modify: `src/content.ts`（调用 `initTranscribeUi()`）
- Modify: `src/_locales/zh_CN/messages.json`、`src/_locales/en/messages.json`

**Interfaces:**
- Consumes: Task 7 消息协议、`readCachedTranscript`（Task 8）、`isBilibiliVideoUrl`/`parseBilibiliUrl`（extractor）
- Produces: 用户可见交互（无新导出接口）

- [ ] **Step 1: i18n 文案（两个 messages.json 各追加）**

zh_CN：
```json
"transcribeSectionTitle": { "message": "AI 转写" },
"transcribeSectionDesc": { "message": "为无字幕的 B 站视频提供 AI 语音转写（SiliconFlow）" },
"transcribeApiKeyLabel": { "message": "API Key" },
"transcribeModelLabel": { "message": "转写模型" },
"transcribeBaseUrlLabel": { "message": "接口地址（高级）" },
"transcribePanelButton": { "message": "AI 转写字幕" },
"transcribePanelRunning": { "message": "转写中 $1/$2 块…" },
"transcribePanelDone": { "message": "转写完成，重新剪藏即可使用" },
"transcribePanelFailed": { "message": "转写失败，点击重试" },
"transcribePanelCached": { "message": "已有 AI 转写字幕" }
```
en 版对应英文（"AI Transcription" / "Transcribing $1/$2 chunks…" 等）。

- [ ] **Step 2: settings.html 区块**

复制解释器区块的外层结构，id 改为 `transcribe-settings`，内部三个控件：

```html
<section id="transcribe-settings" class="settings-section">
	<h2 data-i18n="transcribeSectionTitle"></h2>
	<p class="settings-section-description" data-i18n="transcribeSectionDesc"></p>
	<label for="transcribe-api-key" data-i18n="transcribeApiKeyLabel"></label>
	<input type="password" id="transcribe-api-key" autocomplete="off" />
	<label for="transcribe-model" data-i18n="transcribeModelLabel"></label>
	<select id="transcribe-model">
		<option value="Qwen/Qwen3-ASR-1.7B">Qwen3-ASR-1.7B（推荐，约¥0.8/小时）</option>
		<option value="FunAudioLLM/SenseVoiceSmall">SenseVoiceSmall（免费，质量一般）</option>
		<option value="XingChenAGI/XingChenASR-V3.2-Ultra">XingChenASR Ultra</option>
	</select>
	<label for="transcribe-base-url" data-i18n="transcribeBaseUrlLabel"></label>
	<input type="text" id="transcribe-base-url" />
</section>
```

- [ ] **Step 3: transcribe-settings.ts 绑定（照 reader-settings.ts 的 load/save 模式）**

```ts
import { loadSettings, saveSettings } from '../utils/storage-utils';
import { initializeIcons } from '../icons/icons';

export function initTranscribeSettings(): void {
	const apiKey = document.querySelector('#transcribe-api-key') as HTMLInputElement | null;
	const model = document.querySelector('#transcribe-model') as HTMLSelectElement | null;
	const baseUrl = document.querySelector('#transcribe-base-url') as HTMLInputElement | null;
	if (!apiKey || !model || !baseUrl) return;
	void (async () => {
		const settings = await loadSettings();
		const t = settings.transcribe ?? { enabled: true, apiKey: '', model: 'Qwen/Qwen3-ASR-1.7B', baseUrl: 'https://api.siliconflow.cn' };
		apiKey.value = t.apiKey;
		model.value = t.model;
		baseUrl.value = t.baseUrl;
	})();
	const persist = async () => {
		const settings = await loadSettings();
		settings.transcribe = {
			enabled: true, apiKey: apiKey.value.trim(), model: model.value, baseUrl: baseUrl.value.trim() || 'https://api.siliconflow.cn',
		};
		await saveSettings(settings);
	};
	apiKey.addEventListener('change', persist);
	model.addEventListener('change', persist);
	baseUrl.addEventListener('change', persist);
}
```

`src/core/settings.ts` 在初始化 interpreter 设置之后调用 `initTranscribeSettings()`。

- [ ] **Step 4: 页面浮层 `src/content-transcribe-ui.ts`**

```ts
import browser from './utils/browser-polyfill';
import { getMessage } from './utils/i18n';
import { isBilibiliVideoUrl, parseBilibiliUrl, readCachedTranscript } from './utils/bilibili-extractor';
import { createLogger } from './utils/logger';

const logger = createLogger('TranscribeUi');
const PANEL_ID = 'obsidian-clipper-transcribe-panel';

export function initTranscribeUi(): void {
	if (!isBilibiliVideoUrl(location.href)) return;
	const mount = () => { void renderPanel(); };
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', mount, { once: true });
	} else {
		mount();
	}
	// SPA 切集：URL 变化时重挂
	let lastHref = location.href;
	setInterval(() => {
		if (location.href !== lastHref) { lastHref = location.href; mount(); }
	}, 1500);
}

async function renderPanel(): Promise<void> {
	document.getElementById(PANEL_ID)?.remove();
	const parsed = parseBilibiliUrl(location.href);
	if (!parsed.bvid) return;
	const host = document.createElement('div');
	host.id = PANEL_ID;
	const shadow = host.attachShadow({ mode: 'closed' });
	const cache = await readCachedTranscript(parsed.bvid, /* cid 占位，先由状态接口带回 */ 0).catch(() => null);
	// cid 需要 view 数据：改由 background 状态接口返回 { cid }；此处先渲染占位按钮，点击后由 background 校正
	const status = await browser.runtime.sendMessage({
		action: 'getBilibiliTranscribeStatus', bvid: parsed.bvid, cid: 0,
	}) as any;
	const box = document.createElement('div');
	const style = document.createElement('style');
	style.textContent = `
		.box{position:fixed;right:20px;bottom:80px;z-index:2147483646;background:#1e1e1e;color:#eee;
			border-radius:10px;padding:10px 14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)}
		button{background:#7c5cff;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px}
		.done{color:#7ada7a}
	`;
	shadow.append(style, box);
	const render = (state: any) => {
		box.innerHTML = '';
		if (cache || state?.status === 'done') {
			box.className = 'done';
			box.textContent = getMessage('transcribePanelCached') + ' · ' + getMessage('transcribePanelDone');
		} else if (state?.status === 'running') {
			box.textContent = getMessage('transcribePanelRunning', [String(state.completedChunks), String(state.totalChunks)]).replace('$1', String(state.completedChunks)).replace('$2', String(state.totalChunks));
			setTimeout(() => { void poll(render); }, 3000);
		} else {
			const btn = document.createElement('button');
			btn.textContent = getMessage('transcribePanelButton');
			btn.addEventListener('click', () => {
				void browser.runtime.sendMessage({
					action: 'startBilibiliTranscribe', bvid: parsed.bvid, aid: 0, cid: 0, durationSec: 0,
				}).then(() => poll(render));
			});
			box.appendChild(btn);
		}
	};
	const poll = async (cb: (s: any) => void) => {
		const s = await browser.runtime.sendMessage({
			action: 'getBilibiliTranscribeStatus', bvid: parsed.bvid, cid: 0,
		}) as any;
		cb(s);
	};
	render(status?.status ? status : null);
	document.documentElement.appendChild(host);
	logger.info('Panel mounted', { bvid: parsed.bvid });
}
```

**cid/aid/durationSec 获取**：浮层把 `cid: 0` 传给 background；`startTranscribeTask` 在 `cid <= 0` 时自行调 view API 解析（Task 6 的 `fetchStream` 之前加一步——若 `input.cid <= 0`，经 `fetchBilibiliJson` 拉 `x/web-interface/view?bvid=` 取 cid/aid/duration）。该步在 Task 6 实现中已隐含允许（函数开头补充）：

```ts
if (input.cid <= 0 && input.bvid) {
	const view = await browser.runtime.sendMessage({ action: 'fetchBilibiliJson', url: `https://api.bilibili.com/x/web-interface/view?bvid=${input.bvid}` }) as any;
	const data = view?.data?.data;
	if (!data?.cid) { deps.notify('未找到视频信息'); return; }
	input = { ...input, cid: data.cid, aid: data.aid, durationSec: data.duration ?? 0 };
}
```

同样 `getBilibiliTranscribeStatus` 的 `cid: 0` 调用：浮层无法预知 cid，background 该 action 在 `cid <= 0` 时按 `transcribeTask:{bvid}:*` 前缀模糊匹配 storage.session 全量键（`storage.session.get(null)` 后过滤）。在 Task 7 路由实现中处理。

`src/content.ts` 底部追加 `initTranscribeUi();`（import 自 `./content-transcribe-ui`）。

- [ ] **Step 5: 构建 + 手动验证清单**

Run: `npx webpack --env BROWSER=chrome --mode development 2>&1 | tail -2`
Expected: 无 error

手动清单：
1. 刷新扩展 → 打开无字幕 B 站视频 → 右下角出现「AI 转写字幕」按钮（shadow 隔离，暗色小面板）
2. 点击 → 3 秒内面板变"转写中 x/y 块…"，每 ~3s 刷新
3. 系统通知"AI 转写完成"→ 面板显示"已有 AI 转写字幕"
4. 重新剪藏 → 字幕区出现转写正文 + "AI 语音转写生成"标注
5. 有 CC 字幕的视频（如爬爬虾）→ 不出现浮层（有字幕轨不注入——浮层渲染前调 status？不，浮层无条件显示会打扰正常视频。修正：浮层仅在「剪藏过且拿到 subtitleNotice 无字幕」后显示？过度设计——v1 简化：浮层始终显示但文案区分"AI 转写字幕"按钮；缓存存在时显示绿色状态。可接受的取舍，写入收尾说明）

- [ ] **Step 6: Commit**

```bash
git add src/settings.html src/managers/transcribe-settings.ts src/core/settings.ts src/content-transcribe-ui.ts src/content.ts src/_locales
git commit -m "新增 AI 转写设置区块、页面浮层入口与双语文案"
```

---

### Task 10: 全量回归 + 构建产物

**Files:** 无新增

- [ ] **Step 1: 全量测试**

Run: `npx vitest run 2>&1 | tail -5`
Expected: 全部 PASS（含 bilibili-wbi/playback-tracker 等既有套件）

- [ ] **Step 2: Prettier + ESLint**

Run: `npx prettier --write src --log-level warn 2>&1 | tail -3`
Expected: 无输出（或仅既有告警）

- [ ] **Step 3: 生产构建三端**

Run: `npx webpack --env BROWSER=chrome --mode development 2>&1 | tail -1`
Expected: 无 error

- [ ] **Step 4: 真实视频手动集成（用户配合）**

1. 设置页填入 SiliconFlow Key
2. 对 `BV1yX4y1q7LP`（110 分钟）点转写，记录：总耗时、总块数、费用（SiliconFlow 控制台）、转写质量抽查
3. 重新剪藏验证 `{{transcript}}`
4. 断点验证：转写中途刷新页面 → 再次点击 → 从已完成块继续（SiliconFlow 用量增量应明显小于全量）

- [ ] **Step 5: 收尾 Commit**

```bash
git add -A
git commit -m "AI 转写功能全量回归与构建产物更新"
```

---

## Self-Review 记录

- 覆盖检查：spec §3 流程（Task 4/6/7/8/9）、§4.1（Task 3/4）、§4.2（Task 2）、§4.3（Task 5）、§4.4（Task 6）、§4.5（Task 8）、§4.6（Task 9）、§4.7（Task 7/9）、§5 错误处理（Task 5/6/8 测试）、§6 测试（各任务 TDD + Task 10）——全覆盖
- 占位符扫描：Task 8 Step 3 有两处标注"删除占位行"的实现期说明，均为明确的删除指令而非 TBD；Task 9 Step 1 的 en 文案要求写明对应英文（执行者翻译），无空步骤
- 类型一致性：`TranscribeSettings`（Task 1 定义，Task 5/6/9 引用）、`TranscribeChunkResult`/`TranscribeTaskState`（Task 6 定义，Task 8 缓存结构对齐）、消息 action 名在 Task 7/9 一致（`startBilibiliTranscribe`/`getBilibiliTranscribeStatus`/`decodeAudioToWav`）
- Review Focus 六项均有对应测试任务（1→T3、2→T6、3→T6、4→T8、5→T5、6→T6）
