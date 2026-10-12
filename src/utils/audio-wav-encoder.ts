import { scanMoofBoxes } from "./bilibili-audio";

/**
 * ArrayBuffer ↔ base64：Chrome 扩展消息是 JSON 序列化的，ArrayBuffer 会
 * 变成空对象，音频字节必须以 base64 字符串过消息通道。
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

/**
 * 将 16kHz 单声道浮点采样编码为 16-bit PCM WAV。
 */
export function encodeWav(
	samples: Float32Array,
	sampleRate: number,
): ArrayBuffer {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, dataSize, true);
	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(
			offset,
			clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
			true,
		);
		offset += 2;
	}
	return buffer;
}

/**
 * 共享解码上下文：Chrome 限制每页最多 6 个实时 AudioContext，
 * 并发解码时每次新建会超限（新 context 挂起、decodeAudioData 永不
 * resolve）。decodeAudioData 可在同一 context 上并发复用。
 */
let sharedDecodeContext: AudioContext | null = null;

function getDecodeContext(): AudioContext {
	if (!sharedDecodeContext || sharedDecodeContext.state === "closed") {
		sharedDecodeContext = new AudioContext();
	}
	if (sharedDecodeContext.state === "suspended") {
		void sharedDecodeContext.resume();
	}
	return sharedDecodeContext;
}

const DECODE_TIMEOUT_MS = 90 * 1000;

/**
 * 在页面上下文解码任意音频容器（m4s/AAC/mp3/mp4）并重采样为 16kHz 单声道 PCM。
 * 解码超时抛错（调用方降级），避免消息通道被挂死。
 */
async function decodeToMonoPcm16k(
	arrayBuffer: ArrayBuffer,
): Promise<Float32Array> {
	const ctx = getDecodeContext();
	const decodePromise = ctx.decodeAudioData(arrayBuffer.slice(0));
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("音频解码超时")), DECODE_TIMEOUT_MS),
	);
	const decoded = await Promise.race([decodePromise, timeout]);
	const offline = new OfflineAudioContext(
		1,
		Math.max(1, Math.ceil(decoded.duration * 16000)),
		16000,
	);
	const source = offline.createBufferSource();
	source.buffer = decoded;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0);
}

/**
 * 在页面上下文解码任意音频容器（m4s/AAC）并重采样为 16kHz 单声道 WAV。
 * 依赖 AudioContext，只能在 content script / 页面环境调用。
 */
export async function decodeAudioToWav(
	arrayBuffer: ArrayBuffer,
): Promise<ArrayBuffer> {
	const pcm = await decodeToMonoPcm16k(arrayBuffer);
	return encodeWav(pcm, 16000);
}

// ── VAD 静音切分（纯函数，可单测）────────────────────────────────────────────
//
// ASR 细块边界必须落在静音上：任意位置硬切会切断词句，边界处识别错误率显著
// 上升。切分在解码后的 16kHz 单声道 PCM 上进行，粗块（~5 分钟）解码一次、
// 细块（~30 秒）逐块送 ASR。

export interface AudioSlicePlan {
	startSample: number;
	sampleCount: number;
	startSec: number;
	durationSec: number;
}

export interface VadOptions {
	/** 目标细块时长（秒） */
	targetSec?: number;
	/** 细块下限：低于该值不切，并入前块 */
	minSec?: number;
	/** 细块上限：无合适静音点也必须在此处硬切 */
	maxSec?: number;
	/** 帧长（秒） */
	frameSec?: number;
	/** 帧移（秒） */
	hopSec?: number;
	/** 构成可切点的连续静音最短时长（秒） */
	minSilenceSec?: number;
	/** 静音判定的能量阈值系数：thr = min + ratio×(max−min) */
	silenceThresholdRatio?: number;
}

const DEFAULT_VAD: Required<VadOptions> = {
	targetSec: 30,
	minSec: 10,
	maxSec: 45,
	frameSec: 0.025,
	hopSec: 0.01,
	minSilenceSec: 0.3,
	silenceThresholdRatio: 0.1,
};

/**
 * 逐帧计算短时 RMS 能量。帧移推进、帧长窗口，返回每帧 RMS。
 */
export function computeFrameRms(
	samples: Float32Array,
	sampleRate: number,
	frameSec: number,
	hopSec: number,
): Float32Array {
	const frameLen = Math.max(1, Math.round(frameSec * sampleRate));
	const hop = Math.max(1, Math.round(hopSec * sampleRate));
	const frameCount = samples.length < frameLen
		? 0
		: 1 + Math.floor((samples.length - frameLen) / hop);
	const rms = new Float32Array(frameCount);
	for (let i = 0; i < frameCount; i++) {
		const start = i * hop;
		let sum = 0;
		for (let j = start; j < start + frameLen; j++) {
			sum += samples[j] * samples[j];
		}
		rms[i] = Math.sqrt(sum / frameLen);
	}
	return rms;
}

/**
 * 找出所有可作为切点的采样位置：连续低于能量阈值 ≥ minSilenceSec 的静音段
 * 取其中点。返回升序采样偏移数组。
 *
 * 阈值取动态范围法 thr = min + ratio×(max−min)：静音占比低于固定分位时
 * 分位法会把语音也判成静音；动态范围法只要求"明显低于本块最高能量"。
 */
export function findSilenceCutPoints(
	samples: Float32Array,
	sampleRate: number,
	frameRms: Float32Array,
	opts: Required<VadOptions>,
): number[] {
	const hop = Math.max(1, Math.round(opts.hopSec * sampleRate));
	let minRms = Infinity;
	let maxRms = -Infinity;
	for (const value of frameRms) {
		if (value < minRms) minRms = value;
		if (value > maxRms) maxRms = value;
	}
	// 能量近均匀（无静音可切，如全程解说+大音量 BGM）：交由上层硬切
	if (!(maxRms - minRms > 1e-6)) return [];
	const threshold = minRms + opts.silenceThresholdRatio * (maxRms - minRms);
	const minSilenceFrames = Math.max(
		1,
		Math.round(opts.minSilenceSec / opts.hopSec),
	);
	const cuts: number[] = [];
	let runStart = -1;
	for (let i = 0; i <= frameRms.length; i++) {
		const silent = i < frameRms.length && frameRms[i] <= threshold;
		if (silent) {
			if (runStart < 0) runStart = i;
		} else if (runStart >= 0) {
			if (i - runStart >= minSilenceFrames) {
				const midFrame = runStart + (i - runStart) / 2;
				cuts.push(Math.min(samples.length, Math.round(midFrame * hop)));
			}
			runStart = -1;
		}
	}
	return cuts;
}

/**
 * 把切点聚合为目标时长的细块：优先取目标附近的切点，受 min/max 约束，
 * 无可用切点时在目标时长处硬切。尾块不足 min 时并入前块。
 */
export function planTranscribeSlices(
	samples: Float32Array,
	sampleRate: number,
	options?: VadOptions,
): AudioSlicePlan[] {
	const opts = { ...DEFAULT_VAD, ...options };
	const plans: AudioSlicePlan[] = [];
	if (!samples.length) return plans;
	const frameRms = computeFrameRms(
		samples,
		sampleRate,
		opts.frameSec,
		opts.hopSec,
	);
	const cuts = findSilenceCutPoints(samples, sampleRate, frameRms, opts);
	const target = Math.round(opts.targetSec * sampleRate);
	const minLen = Math.round(opts.minSec * sampleRate);
	const maxLen = Math.round(opts.maxSec * sampleRate);

	const push = (start: number, end: number) => {
		plans.push({
			startSample: start,
			sampleCount: end - start,
			startSec: start / sampleRate,
			durationSec: (end - start) / sampleRate,
		});
	};

	let start = 0;
	while (start < samples.length) {
		const remaining = samples.length - start;
		if (remaining <= maxLen) {
			// 尾段：不足 min 并入前块，避免产生超短块
			if (remaining < minLen && plans.length) {
				const last = plans[plans.length - 1];
				last.sampleCount = samples.length - last.startSample;
				last.durationSec = last.sampleCount / sampleRate;
			} else {
				push(start, samples.length);
			}
			break;
		}
		const idealEnd = start + target;
		const windowLo = start + minLen;
		const windowHi = start + maxLen;
		let best = -1;
		let bestDist = Infinity;
		for (const cut of cuts) {
			if (cut <= windowLo) continue;
			if (cut > windowHi) break;
			const dist = Math.abs(cut - idealEnd);
			if (dist < bestDist) {
				bestDist = dist;
				best = cut;
			}
		}
		const end = best >= 0 ? best : Math.min(idealEnd, samples.length);
		push(start, end);
		start = end;
	}
	return plans;
}

/** 解码后的 ASR 细块：WAV 字节 + 在粗块内的真实时间偏移。 */
export interface TranscribeAudioSlice {
	startSec: number;
	durationSec: number;
	wav: ArrayBuffer;
}

/**
 * 把规范 44 字节头的 WAV 对半拆分（样本对齐）：用于服务端对特定音频载荷
 * 确定性 500 的兜底——坏段拆两半分别转写，触发错误的部分只损失一半。
 * 仅识别本扩展编码器产出的规范布局（RIFF/WAVE/data），非常规布局返回 null。
 */
export function splitWavInHalf(
	buffer: ArrayBuffer,
): [ArrayBuffer, ArrayBuffer] | null {
	if (buffer.byteLength < 44 + 16) return null;
	const view = new DataView(buffer);
	const ascii = (offset: number) =>
		String.fromCharCode(
			view.getUint8(offset),
			view.getUint8(offset + 1),
			view.getUint8(offset + 2),
			view.getUint8(offset + 3),
		);
	if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE" || ascii(36) !== "data") {
		return null;
	}
	const dataSize = view.getUint32(40, true);
	if (dataSize < 16 || 44 + dataSize > buffer.byteLength) return null;
	let halfBytes = Math.floor(dataSize / 2);
	if (halfBytes % 2) halfBytes -= 1; // 16-bit 样本对齐
	const makeHalf = (start: number, length: number): ArrayBuffer => {
		const out = new ArrayBuffer(44 + length);
		const outBytes = new Uint8Array(out);
		outBytes.set(new Uint8Array(buffer, 0, 44), 0);
		const outView = new DataView(out);
		outView.setUint32(4, 36 + length, true);
		outView.setUint32(40, length, true);
		outBytes.set(new Uint8Array(buffer, start, length), 44);
		return out;
	};
	return [makeHalf(44, halfBytes), makeHalf(44 + halfBytes, dataSize - halfBytes)];
}

/**
 * 把「init segment + 字节区间」的块重对齐为可解码形态。
 * 分块计划按字节硬拆时块起点可能落在 fragment 中间（缺少所属 moof 头，
 * decodeAudioData 直接 EncodingError——实测部分音频流的 box 链扫描只能
 * 找到极少数真实边界，整个计划都落在硬拆网格上）。处理：保留 box 链完整
 * 的头部（init segment），丢弃链断点处的半个 box，从其后首个完整的 moof
 * 续接。被丢弃的半个 fragment（数秒音频）在块间形成小缺口，时间轴按
 * 真实解码时长累计依然自洽。
 * 非 fMP4（mp3/progressive mp4）无 moof 魔数，原样返回。
 */
export function realignFragmentedAudio(buffer: ArrayBuffer): ArrayBuffer {
	const bytes = new Uint8Array(buffer);
	const scan = scanMoofBoxes(bytes);
	if (scan.end >= bytes.length) return buffer; // box 链完整，本就对齐
	const view = new DataView(buffer);
	for (let pos = scan.end; pos + 8 <= bytes.length; pos++) {
		if (
			bytes[pos + 4] === 0x6d &&
			bytes[pos + 5] === 0x6f &&
			bytes[pos + 6] === 0x6f &&
			bytes[pos + 7] === 0x66
		) {
			const size = view.getUint32(pos, false);
			if (size >= 8 && pos + size <= bytes.length) {
				const out = new Uint8Array(scan.end + (bytes.length - pos));
				out.set(bytes.subarray(0, scan.end), 0);
				out.set(bytes.subarray(pos), scan.end);
				return out.buffer;
			}
		}
	}
	return buffer;
}

/**
 * 页面端一步完成「重对齐 → 解码 → 16kHz 单声道 → VAD 静音切分 → 逐块 WAV」。
 * startSec/durationSec 来自解码后的真实 PCM，供上层累计出无漂移的时间轴。
 */
export async function decodeAudioToTranscribeSlices(
	arrayBuffer: ArrayBuffer,
	options?: VadOptions,
): Promise<TranscribeAudioSlice[]> {
	const pcm = await decodeToMonoPcm16k(realignFragmentedAudio(arrayBuffer));
	return planTranscribeSlices(pcm, 16000, options).map((plan) => ({
		startSec: plan.startSec,
		durationSec: plan.durationSec,
		wav: encodeWav(
			pcm.subarray(
				plan.startSample,
				plan.startSample + plan.sampleCount,
			),
			16000,
		),
	}));
}
