import type { TranscribeSettings } from "./types/types";
import { DEFAULT_TRANSCRIBE_SETTINGS } from "./types/types";
import {
	fetchBilibiliJsonDirect,
	fetchBilibiliJsonWithCookiesDirect,
	fetchBilibiliRangeDirect,
} from "./background-bilibili-fetch";
import {
	fetchDouyinAwemeAudio,
	fetchDouyinAudioDirect,
} from "./background-douyin-fetch";
import { loadSettings } from "./utils/storage-utils";
import { createLogger } from "./utils/logger";
import {
	buildChunkPlan,
	downloadAudioRange,
	fetchBilibiliAudioStream,
	parseSidxFragmentOffsets,
	scanMoofBoxes,
} from "./utils/bilibili-audio";
import {
	transcribeAudioBlob,
	isNetworkFailure,
} from "./utils/transcribe-client";
import type { TranscribeAudioSlice } from "./utils/audio-wav-encoder";
import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	splitWavInHalf,
} from "./utils/audio-wav-encoder";
import { transcriptCacheKey } from "./utils/bilibili-extractor";

const logger = createLogger("Transcribe");

/**
 * 两级分块：下载/解码按粗块（~5 分钟，减少请求与解码次数），页面端解码后按
 * VAD 静音切分为 ~30s 的 ASR 细块（短块转写更快更准，且块起点即真实时间锚）。
 */
export const CHUNK_TARGET_BYTES = 5 * 60 * 8000;
const FALLBACK_MODEL = "FunAudioLLM/SenseVoiceSmall";
/** 解码并发（下载+解码在页面上下文，占用页面内存，不宜过高） */
const DECODE_CONCURRENCY = 2;
/** ASR 细块并发（纯网络请求，可高于解码并发） */
const ASR_CONCURRENCY = 5;
/** 转写 API 鉴权类失败的固定文案片段（见 transcribe-client）。 */
const AUTH_FAILURE_HINT = "API Key 无效";
/** 抖音整段音频下载上限：扩展消息通道 64MiB，音频以 base64 过通道膨胀
 * 4/3 倍，40MB 原始字节 → ~53MB base64，留出余量。 */
export const DOUYIN_AUDIO_MAX_BYTES = 40 * 1024 * 1024;
/** 抖音可转写的视频时长上限（decodeAudioData 全量解码，30 分钟即数百 MB 浮点）。 */
export const DOUYIN_DURATION_LIMIT_SEC = 20 * 60;

/** 页面解码宿主丢失（视频页被关闭/导航），任务应暂停而非静默降级。 */
export class TranscribeHostLostError extends Error {
	constructor(message = "视频页已关闭") {
		super(message);
		this.name = "TranscribeHostLostError";
	}
}

/** 成品缓存（schema v2）：细块真实时间锚 + 块时长。 */
export interface TranscriptSegment {
	startSec: number;
	durationSec: number;
	text: string;
}

/** ASR 细块进度（存于任务状态；音频字节只留内存，不入 storage）。 */
export interface AsrSliceMeta {
	startSec: number;
	durationSec: number;
	text: string | null;
	/** 细块转写失败的简要原因（透出给占位符/通知，便于定位 API 侧问题） */
	error?: string | null;
}

/** 单个下载/解码粗块的结果。decodedSec 为该块真实解码时长（时间轴累计用）。 */
export interface BlockResult {
	slices: AsrSliceMeta[];
	decodedSec: number;
}

export interface TranscribeBlockPlan {
	start: number;
	end: number;
	startSec: number;
	durationSec: number;
}

export type TranscribePlatform = "bilibili" | "douyin";

export interface TranscribeTaskState {
	platform: TranscribePlatform;
	/** 稳定业务键：`BVxx:cid` / `dy:{awemeId}`（task/heartbeat/cache 键统一派生） */
	targetKey: string;
	/** douyin 下为 awemeId、cid=0（保留字段名便于日志与旧状态识别） */
	bvid: string;
	cid: number;
	aid: number;
	page: number;
	durationSec: number;
	model: string;
	status: "running" | "done" | "failed";
	chunkPlan: TranscribeBlockPlan[];
	/** 与 chunkPlan 对齐；null = 该块未完成（失败/待重做） */
	blockResults: Array<BlockResult | null>;
	totalSlices: number;
	completedSlices: number;
	promptContext: string;
	audioUrl: string;
	/** 解码宿主页（恢复中断任务时重连）。 */
	tabId?: number;
	error?: string;
	/** 最近一次细块转写失败的原因（通知透出用） */
	lastSliceError?: string;
	createdAt: number;
}

/** 心跳键前缀：任务循环每块更新时间戳，过期即视为被 SW 休眠杀死。 */
export const TRANSCRIBE_HEARTBEAT_PREFIX = "transcribeHeartbeat:";
/** 心跳超过该时长未更新，判定任务已死，由 alarm 唤醒恢复。 */
export const TRANSCRIBE_HEARTBEAT_STALE_MS = 90 * 1000;
/** 成品段落中的失败占位标记：含此标记的缓存视为不完整，允许重新转写。 */
export const TRANSCRIBE_FAILURE_MARK = "转写失败";
/**
 * 本 SW 生命周期内正在运行的任务目标：overlay 重试、alarm 唤醒恢复等并发
 * 触发会被此守卫挡下（历史 bug：同一视频多引擎并发，完成通知弹多次、重复计费）。
 */
const activeTranscribeTargets = new Set<string>();

function stateHasFailures(state: TranscribeTaskState): boolean {
	return state.blockResults.some(
		(result, index) =>
			!result ||
			(state.chunkPlan[index] &&
				result.slices.some((slice) => slice.text === null)),
	);
}

function cachedResultIsClean(cached: any): boolean {
	if (cached?.segments?.length) {
		return cached.segments.every(
			(segment: any) => !String(segment?.text || "").includes(TRANSCRIBE_FAILURE_MARK),
		);
	}
	if (cached?.chunks?.length) {
		return cached.chunks.every(
			(chunk: any) => !String(chunk?.text || "").includes(TRANSCRIBE_FAILURE_MARK),
		);
	}
	return false;
}

async function clearHeartbeat(targetKey: string): Promise<void> {
	await (globalThis as any).chrome?.storage?.session?.remove(
		`${TRANSCRIBE_HEARTBEAT_PREFIX}${targetKey}`,
	);
}

interface SliceQueueItem {
	block: number;
	slice: number;
	/** 解码失败的块整块直传 SenseVoice 时使用降级模型 */
	fallbackModel: boolean;
}

interface TaskDeps {
	decodeSlices: (audio: ArrayBuffer) => Promise<TranscribeAudioSlice[]>;
	transcribe: typeof transcribeAudioBlob;
	storageGet: (key: string) => Promise<any>;
	storageSet: (key: string, value: any) => Promise<void>;
	notify: (message: string) => void;
	/** B 站源（缺省用真实实现） */
	fetchStream?: typeof fetchBilibiliAudioStream;
	downloadRange?: (
		url: string,
		start: number,
		end: number,
	) => Promise<ArrayBuffer>;
	fetchPlan?: (stream: {
		url: string;
		bitrateBps: number;
		sizeBytes: number;
	}) => Promise<TranscribeBlockPlan[]>;
	fetchPromptContext?: (bvid: string) => Promise<string>;
	/** 抖音源 */
	fetchDouyinAweme?: typeof fetchDouyinAwemeAudio;
	downloadDouyinAudio?: (url: string) => Promise<ArrayBuffer>;
}

type StopReason = "host-lost" | "fatal" | "network" | null;

/**
 * 连续网络失败达到该次数即暂停任务：分钟级断流下继续重试只会烧完所有
 * 预算并把失败写死进成品，暂停后由用户在网络恢复时点击续传（已完成部分
 * 保留，不重复计费）。
 */
const NETWORK_PAUSE_THRESHOLD = 8;

function isAuthFailure(error: unknown): boolean {
	return String((error as Error)?.message || error).includes(
		AUTH_FAILURE_HINT,
	);
}

/** ASR 输出清洗：音乐/事件标记不属于语音内容；幻觉循环折叠。 */
export function sanitizeAsrText(text: string): string {
	const cleaned = text
		.replace(/[🎼🎵🎶♪♫♩♬]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	// ASR 幻觉循环：同一片段（≥6 字，避免误伤正常叠词）连续重复 ≥4 次折叠为 1 次
	return cleaned.replace(/(.{6,}?)\1{3,}/gu, "$1").trim();
}

/**
 * 由标题/作者/简介构建 ASR 热词上下文（Qwen3-ASR contextual prompting）。
 * 控制在 cap 内：提示过长会把提示内容幻觉进正文。
 */
export function buildPromptContext(
	parts: Array<string | undefined | null>,
	cap = 300,
): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const raw of parts) {
		const text = String(raw || "")
			.replace(/[#*`>\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		lines.push(text);
	}
	return lines.join("；").slice(0, cap);
}

/** 断点续传重解码时，按时间戳匹配回填已完成细块的文本。 */
function carryOverSliceTexts(
	previous: BlockResult | null,
	freshSlices: TranscribeAudioSlice[],
): AsrSliceMeta[] {
	return freshSlices.map((slice) => {
		const matched = previous?.slices.find(
			(old) =>
				old.text !== null &&
				Math.abs(old.startSec - slice.startSec) < 1,
		);
		return {
			startSec: slice.startSec,
			durationSec: slice.durationSec,
			text: matched?.text ?? null,
		};
	});
}

/**
 * 汇总任务结果：按「已完成块的真实解码时长累计 + 块内 PCM 偏移」生成无漂移
 * 时间轴；未完成块回退到计划时长估算并标注失败。失败占位带时间区间，
 * 便于定位是哪一段音频出了问题。
 */
export function assembleTranscript(
	state: TranscribeTaskState,
): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	let cursorSec = 0;
	state.chunkPlan.forEach((block, index) => {
		const result = state.blockResults[index];
		if (result && result.slices.length) {
			for (const slice of result.slices) {
				segments.push({
					startSec: cursorSec + slice.startSec,
					durationSec: slice.durationSec,
					text:
						slice.text ??
						`[${formatSegmentTimestamp(cursorSec + slice.startSec)} 起转写失败${
							slice.error ? `（${slice.error}）` : ""
						}]`,
				});
			}
			cursorSec += result.decodedSec;
			return;
		}
		segments.push({
			startSec: cursorSec,
			durationSec: block.durationSec,
			text: `[${formatSegmentTimestamp(cursorSec)}-${formatSegmentTimestamp(
				cursorSec + block.durationSec,
			)} 转写失败]`,
		});
		cursorSec += block.durationSec;
	});
	return segments.sort((left, right) => left.startSec - right.startSec);
}

function formatSegmentTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}
	return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function transcribeTaskKey(targetKey: string): string {
	return `transcribeTask:${targetKey}`;
}

function recomputeProgress(state: TranscribeTaskState): void {
	let done = 0;
	let total = 0;
	state.blockResults.forEach((result, index) => {
		if (result) {
			total += result.slices.length;
			done += result.slices.filter((slice) => slice.text !== null)
				.length;
		} else if (state.chunkPlan[index]) {
			// 失败块最终会以占位段落计入成品
			total += 1;
		}
	});
	state.completedSlices = done;
	state.totalSlices = total;
}

/**
 * 平台无关的音频源：引擎只依赖该接口，B 站（fMP4 分块）与抖音（整段文件）
 * 各自实现。
 */
export interface TranscribeAudioSource {
	platform: TranscribePlatform;
	targetKey: string;
	cacheKey: string;
	durationSec: number;
	promptContext: string;
	audioUrl: string;
	/** 解码失败整块直传时的兜底格式 */
	fallbackMime: string;
	fallbackExt: string;
	planBlocks(): Promise<TranscribeBlockPlan[]>;
	downloadBlockAudio(block: TranscribeBlockPlan): Promise<ArrayBuffer>;
	/** 恢复中断任务时刷新签名 URL（best-effort，失败保持原 URL）。 */
	refreshAudioUrl(): Promise<void>;
	/** 断点续传：采用已持久化的分块计划与音频 URL（源内部闭包状态恢复）。 */
	adoptResume(resumed: {
		chunkPlan: TranscribeBlockPlan[];
		audioUrl: string;
	}): void;
}

/**
 * 生成分块计划：优先解析 init segment 的 sidx 索引（一次头部读取即得全量
 * fragment 边界）；无 sidx 时按窗口渐进扫描 moof（box 链衔接，避免窗口边界
 * 截断错位）。两类边界都会经 buildChunkPlan 的 maxBlockBytes 硬拆分兜底，
 * 保证单块解码后的消息不会超出扩展 64MiB 通道上限（历史 bug：头部 4MB 扫描
 * 后把剩余整个文件聚成一个巨型块，长视频解码响应数百 MB 直接撑爆通道）。
 */
async function fetchBilibiliChunkPlan(
	stream: {
		url: string;
		bitrateBps: number;
		sizeBytes: number;
	},
	rangeFn?: (u: string, s: number, e: number) => Promise<ArrayBuffer>,
): Promise<TranscribeBlockPlan[]> {
	// 1) sidx：init segment 通常在首个 fragment 前，1MB 头部足够覆盖
	const headBytes = Math.min(
		1024 * 1024,
		Math.max(1, stream.sizeBytes),
	);
	const head = await downloadAudioRange(
		stream.url,
		0,
		headBytes - 1,
		rangeFn,
	);
	const headBytesArr = new Uint8Array(head);
	const sidx = parseSidxFragmentOffsets(headBytesArr);
	if (sidx?.offsets.length) {
		const last = sidx.offsets[sidx.offsets.length - 1];
		if (last < stream.sizeBytes) {
			return buildChunkPlan(
				sidx.offsets,
				stream.sizeBytes,
				sidx.initEnd,
				CHUNK_TARGET_BYTES,
				stream.bitrateBps,
			);
		}
		// sidx 边界超出文件长度（解析异常）：回退扫描
	}

	// 2) 渐进 moof 扫描：窗口间以完整 box 链末尾衔接。
	// 扫描预算有限（≤8MB）：其余区域交由 buildChunkPlan 的字节网格硬拆 +
	// 解码前重对齐兜底——历史 bug：box 链早断的流会把整个文件（可达 70MB+）
	// 预下载一遍才建好计划，init 窗口拉长到分钟级，任何一次网络抖动即整体失败。
	const SCAN_WINDOW = 4 * 1024 * 1024;
	const SCAN_BUDGET = 8 * 1024 * 1024;
	const offsets: number[] = [];
	let pos = 0;
	while (pos < stream.sizeBytes && pos < SCAN_BUDGET) {
		const windowEnd = Math.min(stream.sizeBytes, pos + SCAN_WINDOW) - 1;
		const window = await downloadAudioRange(
			stream.url,
			pos,
			windowEnd,
			rangeFn,
		);
		const scan = scanMoofBoxes(new Uint8Array(window));
		for (const offset of scan.offsets) {
			if (!offsets.length || offset > offsets[offsets.length - 1]) {
				offsets.push(pos + offset);
			}
		}
		pos = scan.end > 0 ? pos + scan.end : windowEnd + 1;
	}
	if (!offsets.length) return [];
	return buildChunkPlan(
		offsets,
		stream.sizeBytes,
		offsets[0],
		CHUNK_TARGET_BYTES,
		stream.bitrateBps,
	);
}

async function fetchBilibiliPromptContext(bvid: string): Promise<string> {
	if (!bvid) return "";
	try {
		const resp = (await fetchBilibiliJsonDirect(
			`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
		)) as any;
		const data = resp?.data;
		if (!data) return "";
		return buildPromptContext([
			data.title,
			data.owner?.name,
			String(data.desc || "").slice(0, 200),
		]);
	} catch {
		return "";
	}
}

/** B 站音频源：playurl(wbi+cookie) → fMP4 fragment 粗块（init segment 复用）。 */
function createBilibiliSource(
	input: { bvid: string; aid: number; cid: number },
	deps: TaskDeps,
): TranscribeAudioSource {
	const fetchStream =
		deps.fetchStream ??
		((args: { aid: number; bvid: string; cid: number }) =>
			fetchBilibiliAudioStream(args, {
				json: fetchBilibiliJsonDirect,
				jsonWithCookies: fetchBilibiliJsonWithCookiesDirect,
			}));
	const downloadRange =
		deps.downloadRange ??
		((url: string, start: number, end: number) =>
			fetchBilibiliRangeDirect(url, start, end, {
				skipAllowList: true,
			}));
	const fetchPlan =
		deps.fetchPlan ??
		(async (stream: {
			url: string;
			bitrateBps: number;
			sizeBytes: number;
		}) =>
			// rangeFetch 自带候选轮换（忽略传入的 url 参数）
			fetchBilibiliChunkPlan(stream, (_url, start, end) =>
				rangeFetch(start, end),
			));

	let stream: {
		url: string;
		urls: string[];
		bitrateBps: number;
		sizeBytes: number;
		durationSec: number;
	} | null = null;
	let plan: TranscribeBlockPlan[] = [];
	// 粘住的首个可用 CDN 地址（失败轮换后更新），后续请求不再逐个探测
	let activeUrl: string | null = null;
	// 并发 worker 共享 init segment：单一 promise 缓存避免竞态重复下载
	let initPromise: Promise<ArrayBuffer> | null = null;

	// CDN 候选轮换：部分节点（PCDN/mcdn 族）会随机拒绝 Range 请求（实测
	// 403 直接卡死 init），失败时依次换用 playurl 给出的备用地址。
	const rangeFetch = async (start: number, end: number): Promise<ArrayBuffer> => {
		if (!stream) throw new Error("audio stream not resolved");
		const preferred = activeUrl ?? stream.url;
		const candidates = [
			preferred,
			...(stream.urls || []).filter((u) => u !== preferred),
		];
		let lastError = "";
		for (const url of candidates) {
			try {
				const buffer = await downloadRange(url, start, end);
				if (url !== activeUrl) {
					activeUrl = url;
					logger.info("Audio cdn candidate selected", {
						host: new URL(url).hostname,
					});
				}
				return buffer;
			} catch (error) {
				lastError = String(error);
				logger.warn("Audio cdn candidate failed, rotating", {
					host: new URL(url).hostname,
					error: lastError.slice(0, 80),
				});
			}
		}
		throw new Error(
			`音频下载全部地址被拒绝（${lastError.slice(0, 60)}）：可能为充电专属视频或 CDN 风控，稍后重试`,
		);
	};

	const source: TranscribeAudioSource = {
		platform: "bilibili",
		targetKey: `${input.bvid}:${input.cid}`,
		cacheKey: transcriptCacheKey(input.bvid, input.cid),
		durationSec: 0,
		promptContext: "",
		audioUrl: "",
		fallbackMime: "audio/mp4",
		fallbackExt: "m4a",
		async planBlocks() {
			// background 内部一律直调 fetch 模块——runtime.sendMessage 发给自己不投递。
			// 下载 URL 均来自 playurl 响应（可信来源），跳过静态域名白名单：
			// B 站 CDN 域名族谱庞大（mcdn/akamaized/bilivideo.cn…）无法穷举。
			stream = (await fetchStream(input)) as NonNullable<typeof stream>;
			plan = await fetchPlan(stream);
			source.audioUrl = stream.url;
			source.durationSec = stream.durationSec;
			return plan;
		},
		async downloadBlockAudio(block) {
			if (!stream) throw new Error("audio stream not resolved");
			const initEnd = plan[0]?.start ?? 0;
			if (!initPromise) {
				initPromise = (async () =>
					initEnd > 0
						? await rangeFetch(0, initEnd - 1)
						: new ArrayBuffer(0))();
				initPromise.catch(() => {
					initPromise = null;
				});
			}
			const init = await initPromise;
			const raw = await rangeFetch(block.start, block.end - 1);
			const combined = new Uint8Array(init.byteLength + raw.byteLength);
			combined.set(new Uint8Array(init), 0);
			combined.set(new Uint8Array(raw), init.byteLength);
			return combined.buffer;
		},
		async refreshAudioUrl() {
			try {
				const fresh = (await fetchStream(input)) as NonNullable<
					typeof stream
				>;
				if (stream) {
					stream.url = fresh.url;
					stream.urls = fresh.urls;
				}
				// 刷新后重置粘住节点，重新探测可用候选
				activeUrl = null;
				initPromise = null;
				source.audioUrl = fresh.url;
			} catch (error) {
				logger.warn("Resume stream refresh failed", {
					error: String(error),
				});
			}
		},
		adoptResume(resumed) {
			plan = resumed.chunkPlan;
			stream = {
				url: resumed.audioUrl,
				urls: [resumed.audioUrl],
				bitrateBps: 0,
				sizeBytes: 0,
				durationSec: 0,
			};
			source.audioUrl = resumed.audioUrl;
		},
	};
	return source;
}

/** 抖音音频源：页面数据取原声/播放地址 → 整段单块下载。 */
function createDouyinSource(
	input: { awemeId: string; tabId: number },
	deps: TaskDeps,
): TranscribeAudioSource {
	const fetchAweme = deps.fetchDouyinAweme ?? fetchDouyinAwemeAudio;
	const downloadAudio =
		deps.downloadDouyinAudio ??
		((url: string) => fetchDouyinAudioDirect(url, DOUYIN_AUDIO_MAX_BYTES));
	const source: TranscribeAudioSource = {
		platform: "douyin",
		targetKey: `dy:${input.awemeId}`,
		cacheKey: `dyTranscript:${input.awemeId}`,
		durationSec: 0,
		promptContext: "",
		audioUrl: "",
		fallbackMime: "audio/mpeg",
		fallbackExt: "mp3",
		async planBlocks() {
			const aweme = await fetchAweme(input.tabId, input.awemeId);
			if (aweme.durationSec > DOUYIN_DURATION_LIMIT_SEC) {
				throw new Error(
					`视频时长 ${Math.round(aweme.durationSec / 60)} 分钟，超过抖音转写上限（约 20 分钟）`,
				);
			}
			source.audioUrl = aweme.audioUrl;
			source.durationSec = aweme.durationSec;
			source.promptContext = buildPromptContext(aweme.promptParts);
			source.fallbackMime = aweme.audioMime;
			source.fallbackExt = aweme.audioExt;
			return [
				{
					start: 0,
					end: Math.max(1, aweme.sizeBytes),
					startSec: 0,
					durationSec: aweme.durationSec,
				},
			];
		},
		async downloadBlockAudio() {
			return downloadAudio(source.audioUrl);
		},
		async refreshAudioUrl() {
			// 抖音播放地址由页面数据提供：重新向页面取一次（best-effort，
			// tab 已死时保持旧 URL——引擎首个解码请求会以宿主丢失暂停并给出
			// 可读提示，而非在恢复阶段裸抛）
			try {
				const aweme = await fetchAweme(input.tabId, input.awemeId);
				source.audioUrl = aweme.audioUrl;
			} catch (error) {
				logger.warn("Douyin url refresh failed", {
					error: String(error),
				});
			}
		},
		adoptResume(resumed) {
			source.audioUrl = resumed.audioUrl;
		},
	};
	return source;
}

/** 扩展消息通道的单条消息上限（Chrome 102+）：超出即抛该文案的 TypeError。 */
export const MESSAGE_SIZE_LIMIT_HINT = "maximum allowed size";

/**
 * 判定解码链路错误是否为「消息超限」而非「宿主丢失」：超限时 sendResponse
 * 在页面侧同步抛错并打断消息通道，background 侧 sendMessage 随之 reject——
 * 误判为宿主丢失会错误地把任务暂停成"视频页已关闭"（历史 bug）。
 */
export function isOversizeMessageError(error: unknown): boolean {
	return String((error as Error)?.message || error).includes(
		MESSAGE_SIZE_LIMIT_HINT,
	);
}

function defaultDeps(tabId: number): TaskDeps {
	return {
		decodeSlices: async (audio) => {
			let resp: any;
			try {
				logger.info("Sending decode request", {
					tabId,
					bytes: audio.byteLength,
				});
				// 扩展消息是 JSON 序列化的：ArrayBuffer 会变空对象，必须 base64
				const audioBase64 = arrayBufferToBase64(audio);
				resp = (await (globalThis as any).chrome?.tabs?.sendMessage?.(
					tabId,
					{
						action: "decodeAudioToSlices",
						audioBase64,
					},
				)) as any;
			} catch (error) {
				if (isOversizeMessageError(error)) {
					// 消息超限是分块/配置问题（单块过大）：按块失败处理可续传重试，
					// 不能误判为宿主丢失暂停整个任务
					throw new Error(
						`音频块超出消息通道上限（64MB）：${String(error).slice(0, 80)}`,
					);
				}
				// tabs.sendMessage 拒绝 = 解码宿主（视频页）已丢失
				throw new TranscribeHostLostError(
					`RECEIVER_UNAVAILABLE: ${String(error)}`,
				);
			}
			if (!resp?.success) {
				if (isOversizeMessageError(resp?.error)) {
					throw new Error(
						`音频块超出消息通道上限（64MB）：${String(resp.error).slice(0, 80)}`,
					);
				}
				throw new Error(resp?.error || "页面解码失败");
			}
			if (!Array.isArray(resp.slices) || !resp.slices.length) {
				throw new Error("页面解码响应缺少 slices");
			}
			return resp.slices.map((slice: any) => ({
				startSec: Number(slice.startSec) || 0,
				durationSec: Number(slice.durationSec) || 0,
				wav: base64ToArrayBuffer(String(slice.wavBase64 || "")),
			}));
		},
		transcribe: transcribeAudioBlob,
		storageGet: async (key) => {
			const area = (key.startsWith("transcribeTask:")
				? (globalThis as any).chrome?.storage?.session
				: (globalThis as any).chrome?.storage?.local) ?? {
				get: async () => ({}),
			};
			const bag = await area.get(key);
			return bag?.[key] ?? null;
		},
		storageSet: async (key, value) => {
			const area = key.startsWith("transcribeTask:")
				? (globalThis as any).chrome?.storage?.session
				: (globalThis as any).chrome?.storage?.local;
			await area?.set({ [key]: value });
		},
		notify: (message) => {
			void (globalThis as any).chrome?.notifications?.create({
				type: "basic",
				iconUrl: "icons/icon128.png",
				title: "AI 转写",
				message,
			});
		},
	};
}

export async function getTranscribeTaskStatus(
	targetKey: string,
): Promise<TranscribeTaskState | null> {
	if (!targetKey) return null;
	const taskKey = transcribeTaskKey(targetKey);
	const session = (globalThis as any).chrome?.storage?.session;
	const bag = await session?.get(taskKey);
	const exact = bag?.[taskKey] as TranscribeTaskState | undefined;
	if (exact) return exact;
	// 浮层发起时 cid 未知（只知 bvid）：按前缀匹配运行中任务
	const all = (await session?.get(null)) as Record<string, unknown>;
	const prefix = `${taskKey}:`;
	for (const [key, value] of Object.entries(all ?? {})) {
		if (key.startsWith(prefix)) return value as TranscribeTaskState;
	}
	// 无任务：查成品缓存（bvid 前缀 / dy 精确），命中则合成 done 态
	const local = (await (globalThis as any).chrome?.storage?.local?.get(
		null,
	)) as Record<string, unknown>;
	const cachePrefix = targetKey.startsWith("dy:")
		? `dyTranscript:${targetKey.slice(3)}`
		: `biliTranscript:${targetKey.split(":")[0]}:`;
	for (const key of Object.keys(local ?? {})) {
		if (key.startsWith(cachePrefix)) {
			return {
				platform: targetKey.startsWith("dy:") ? "douyin" : "bilibili",
				targetKey,
				bvid: "",
				cid: 0,
				aid: 0,
				page: 1,
				durationSec: 0,
				model: "",
				status: "done",
				chunkPlan: [],
				blockResults: [],
				totalSlices: 0,
				completedSlices: 0,
				promptContext: "",
				audioUrl: "",
				createdAt: 0,
			};
		}
	}
	return null;
}

/**
 * alarm 唤醒时扫描心跳：超过阈值未更新的 running 任务视为被 SW 休眠杀死，
 * 从断点自动恢复（含重新获取签名音频 URL）。
 */
export async function resumeInterruptedTranscribe(): Promise<void> {
	const session = (globalThis as any).chrome?.storage?.session;
	if (!session) return;
	const all = (await session.get(null)) as Record<string, unknown>;
	const now = Date.now();
	for (const [key, stamp] of Object.entries(all)) {
		if (!key.startsWith(TRANSCRIBE_HEARTBEAT_PREFIX)) continue;
		if (typeof stamp !== "number") continue;
		if (now - stamp < TRANSCRIBE_HEARTBEAT_STALE_MS) continue;
		const taskKey = key.replace(
			TRANSCRIBE_HEARTBEAT_PREFIX,
			"transcribeTask:",
		);
		const bag = (await session.get(taskKey)) as Record<
			string,
			TranscribeTaskState
		>;
		const state = bag?.[taskKey];
		if (!state || state.status !== "running" || !state.chunkPlan?.length) {
			await session.remove(key);
			continue;
		}
		logger.info("Resuming interrupted transcribe", {
			targetKey: state.targetKey,
			platform: state.platform,
		});
		const settings = await loadSettings();
		const transcribeSettings =
			settings.transcribe ??
			({ ...DEFAULT_TRANSCRIBE_SETTINGS } as TranscribeSettings);
		const resumeInput: StartTranscribeInput =
			state.platform === "douyin"
				? {
						platform: "douyin",
						awemeId: state.bvid,
						tabId: state.tabId ?? -1,
						settings: transcribeSettings,
					}
				: {
						platform: "bilibili",
						bvid: state.bvid,
						aid: state.aid,
						cid: state.cid,
						page: state.page ?? 1,
						durationSec: state.durationSec,
						tabId: state.tabId ?? -1,
						settings: transcribeSettings,
					};
		await startTranscribeTask(resumeInput).catch((error) => {
			logger.warn("Resume failed", { error: String(error) });
		});
		return; // 一次只恢复一个（alarm 每 30s 会再触发）
	}
}

/** 解析视频信息：cid 未知时经 view API，多 P 视频按 page 参数取对应分 P。 */
async function resolveBilibiliVideoInfo(
	input: { bvid: string; aid: number; cid: number; page: number },
	deps: TaskDeps,
): Promise<{ aid: number; cid: number; durationSec: number } | null> {
	if (input.cid > 0) {
		return { aid: input.aid, cid: input.cid, durationSec: 0 };
	}
	// background 内部必须直调 fetch 模块——runtime.sendMessage 发给自己不投递
	const resp = (await fetchBilibiliJsonDirect(
		`https://api.bilibili.com/x/web-interface/view?bvid=${input.bvid}`,
	)) as any;
	const data = resp?.data;
	if (!data?.cid) {
		return null;
	}
	// 多 P：按 page 匹配分 P cid，避免恒取 P1
	const pages = Array.isArray(data.pages) ? data.pages : [];
	const matched = pages.find((p: any) => p.page === input.page) ?? pages[0];
	const cid = matched?.cid ?? data.cid;
	return {
		cid,
		aid: data.aid ?? input.aid,
		durationSec: matched?.duration ?? data.duration ?? 0,
	};
}

/**
 * 转写引擎：解码 worker 与 ASR worker 流水线并行。音频字节只存在于本函数
 * 生命周期内的内存 Map（storage 只存文本进度），SW 死亡后未完成块重做。
 */
async function runTranscribeEngine(
	state: TranscribeTaskState,
	source: TranscribeAudioSource,
	deps: TaskDeps,
	settings: TranscribeSettings,
): Promise<void> {
	const taskKey = transcribeTaskKey(state.targetKey);
	const sliceQueue: SliceQueueItem[] = [];
	const payloads = new Map<
		string,
		{
			bytes: ArrayBuffer;
			mime: string;
			filename: string;
			fallbackModel: boolean;
		}
	>();
	let decodeDone = false;
	let stopped: StopReason = null;
	let consecutiveNetworkFailures = 0;

	const heartbeatKey = `${TRANSCRIBE_HEARTBEAT_PREFIX}${state.targetKey}`;
	const persistProgress = async () => {
		recomputeProgress(state);
		await deps.storageSet(taskKey, state);
		// 心跳：alarm 唤醒时据此判断任务是否已被 SW 休眠杀死
		await (globalThis as any).chrome?.storage?.session?.set({
			[heartbeatKey]: Date.now(),
		});
	};
	await persistProgress();

	// 单块处理：下载 → 解码 → 细块入队。失败抛错由 worker 决定重试策略。
	const processBlock = async (blockIndex: number): Promise<void> => {
		const block = state.chunkPlan[blockIndex];
		const tryDecode = async (
			audio: ArrayBuffer,
		): Promise<TranscribeAudioSlice[] | null> => {
			try {
				return await deps.decodeSlices(audio);
			} catch (error) {
				if (error instanceof TranscribeHostLostError) throw error;
				return null;
			}
		};
		let audio = await source.downloadBlockAudio(block);
		let slices = await tryDecode(audio);
		if (!slices) {
			// 解码失败先重新下载重试一次（瞬时损坏/对端 Range 异常假设），
			// 仍失败才整块直传降级
			logger.warn(`Block ${blockIndex} decode failed, re-downloading`, {
				start: block.start,
				end: block.end,
			});
			audio = await source.downloadBlockAudio(block);
			slices = await tryDecode(audio);
		}
		if (!slices) {
			// 仅"解码失败"降级整块直传 SenseVoice（Qwen3-ASR 只接受 wav）
			logger.warn(`Block ${blockIndex} decode retry failed, falling back`, {
				start: block.start,
				end: block.end,
			});
			state.blockResults[blockIndex] = {
				slices: [
					{
						startSec: 0,
						durationSec: block.durationSec,
						text: null,
					},
				],
				decodedSec: block.durationSec,
			};
			payloads.set(`${blockIndex}:0`, {
				bytes: audio,
				mime: source.fallbackMime,
				filename: `block-${blockIndex}.${source.fallbackExt}`,
				fallbackModel: true,
			});
			sliceQueue.push({ block: blockIndex, slice: 0, fallbackModel: true });
		} else {
			const existing = state.blockResults[blockIndex];
			const previous: BlockResult | null = existing ?? null;
			const metas = carryOverSliceTexts(
				previous && previous.slices.some((s) => s.text !== null)
					? previous
					: null,
				slices,
			);
			state.blockResults[blockIndex] = {
				slices: metas,
				decodedSec: slices.reduce((n, s) => n + s.durationSec, 0),
			};
			metas.forEach((meta, sliceIndex) => {
				if (meta.text !== null) return; // 已回填的细块不重转写
				payloads.set(`${blockIndex}:${sliceIndex}`, {
					bytes: slices[sliceIndex].wav,
					mime: "audio/wav",
					filename: `block-${blockIndex}-${sliceIndex}.wav`,
					fallbackModel: false,
				});
				sliceQueue.push({
					block: blockIndex,
					slice: sliceIndex,
					fallbackModel: false,
				});
			});
		}
		await persistProgress();
	};

	const decodeWorker = async (): Promise<void> => {
		while (!stopped) {
			const blockIndex = decodeWorker.nextIndex;
			decodeWorker.nextIndex += 1;
			if (blockIndex === undefined || blockIndex >= state.chunkPlan.length)
				return;
			// 块已全部完成才跳过；部分完成的块重做（SW 死后音频字节已丢失），
			// 重解码后按时间戳匹配回填已完成细块的文本，避免重复付费。
			const existing = state.blockResults[blockIndex];
			if (existing && existing.slices.every((slice) => slice.text !== null)) {
				continue;
			}
			try {
				await processBlock(blockIndex);
			} catch (error) {
				if (error instanceof TranscribeHostLostError) {
					logger.warn(`Block ${blockIndex} host lost`, {
						error: String(error),
					});
					stopped = "host-lost";
					return;
				}
				// 长任务中后段失败的头号原因是签名 URL 过期（实测 57 分钟视频
				// 后半程整块 403）：刷新签名 URL 后原地重试一次
				logger.warn(`Block ${blockIndex} failed, refreshing url`, {
					error: String(error),
				});
				try {
					await source.refreshAudioUrl();
					state.audioUrl = source.audioUrl || state.audioUrl;
					await processBlock(blockIndex);
				} catch (retryError) {
					if (retryError instanceof TranscribeHostLostError) {
						logger.warn(`Block ${blockIndex} host lost on retry`, {
							error: String(retryError),
						});
						stopped = "host-lost";
						return;
					}
					// 块失败：保持 null，成品以占位段标注，续传时自动重试
					logger.warn(`Block ${blockIndex} retry failed`, {
						error: String(retryError),
					});
				}
			}
		}
	};
	decodeWorker.nextIndex = 0;

	const asrWorker = async (): Promise<void> => {
		while (!stopped) {
			const item = sliceQueue.shift();
			if (!item) {
				if (decodeDone) return;
				await new Promise((resolve) => setTimeout(resolve, 120));
				continue;
			}
			const key = `${item.block}:${item.slice}`;
			const payload = payloads.get(key);
			const slice = state.blockResults[item.block]?.slices[item.slice];
			if (!payload || !slice || slice.text !== null) continue;
			try {
				const effectiveSettings = payload.fallbackModel
					? { ...settings, model: FALLBACK_MODEL }
					: settings;
				// wav 上传失败（429 耗尽/5xx/401）不降级，落到 catch
				const text = await deps.transcribe(
					payload.bytes,
					payload.mime,
					payload.filename,
					effectiveSettings,
					{ prompt: state.promptContext },
				);
				slice.text = sanitizeAsrText(text);
				slice.error = null;
				payloads.delete(key); // 释放内存
				consecutiveNetworkFailures = 0;
				await persistProgress();
			} catch (error) {
				if (isAuthFailure(error)) {
					logger.warn(`Slice ${key} auth failure`, {
						error: String(error),
					});
					stopped = "fatal";
					return;
				}
				if (isNetworkFailure(error)) {
					consecutiveNetworkFailures += 1;
					if (
						consecutiveNetworkFailures >= NETWORK_PAUSE_THRESHOLD &&
						!stopped
					) {
						logger.warn(
							`Network outage suspected after ${consecutiveNetworkFailures} consecutive failures, pausing`,
						);
						stopped = "network";
						return;
					}
				} else {
					consecutiveNetworkFailures = 0;
				}
				logger.warn(`Slice ${key} failed`, { error: String(error) });
				// 失败原因落状态：占位符与完成通知透出，便于定位 API 侧问题
				// （剥掉客户端错误文案里与占位符重复的"转写失败"前缀）
				const reason = String(error)
					.replace(/^Error:\s*/, "")
					.replace(/^转写失败（/, "")
					.replace(/）\s*$/, "")
					.slice(0, 60);
				slice.error = reason;
				state.lastSliceError = reason;
				await persistProgress();
			}
		}
	};

	// 解码与 ASR 两级流水线并行：解码 worker 产细块入队，ASR worker 即时消费
	const decodePromises = Array.from({ length: DECODE_CONCURRENCY }, () =>
		decodeWorker(),
	);
	const asrPromises = Array.from({ length: ASR_CONCURRENCY }, () =>
		asrWorker(),
	);
	await Promise.all(decodePromises);
	decodeDone = true;
	await Promise.all(asrPromises);

	// 失败补救两轮：
	// ① 立即重试——429 限流抖动等瞬时故障，同模型再来一次；
	// ② 冷却 45s 后换 SenseVoice 补救——对主模型确定性失败的载荷
	//   （实测同一段音频每次都 500），换免费模型往往能过。
	const collectFailedItems = (): SliceQueueItem[] => {
		const items: SliceQueueItem[] = [];
		state.blockResults.forEach((result, blockIndex) => {
			if (!result) return;
			result.slices.forEach((slice, sliceIndex) => {
				const key = `${blockIndex}:${sliceIndex}`;
				if (slice.text === null && payloads.has(key)) {
					items.push({
						block: blockIndex,
						slice: sliceIndex,
						fallbackModel: payloads.get(key)!.fallbackModel,
					});
				}
			});
		});
		return items;
	};
	const runRetryRound = async (useFallbackModel: boolean): Promise<void> => {
		const items = collectFailedItems();
		if (!items.length) return;
		logger.info("Retrying failed slices", {
			count: items.length,
			useFallbackModel,
		});
		if (useFallbackModel) {
			items.forEach((item) => {
				const payload = payloads.get(`${item.block}:${item.slice}`);
				if (payload) payload.fallbackModel = true;
			});
		}
		sliceQueue.push(...items);
		await Promise.all(
			Array.from({ length: ASR_CONCURRENCY }, () => asrWorker()),
		);
	};

	if (!stopped) {
		await runRetryRound(false);
	}
	if (!stopped && collectFailedItems().length) {
		// 冷却期间保持心跳新鲜，避免 alarm 误判任务已死触发重复恢复
		for (let waited = 0; waited < 45_000 && !stopped; waited += 5_000) {
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			await (globalThis as any).chrome?.storage?.session?.set({
				[heartbeatKey]: Date.now(),
			});
		}
		if (!stopped) {
			await runRetryRound(true);
		}
	}

	// 第三级补救：对换模型仍失败的细块做 WAV 对半拆分——服务端对特定音频
	// 载荷的确定性 500 与模型无关（实测 Qwen 与 SenseVoice 同段同错），
	// 拆半后未触发错误的一半仍能产出文本。逐半独立容错，成功一半保一半。
	if (!stopped) {
		const stuckItems = collectFailedItems();
		for (const item of stuckItems) {
			if (stopped) break;
			const key = `${item.block}:${item.slice}`;
			const payload = payloads.get(key);
			const slice = state.blockResults[item.block]?.slices[item.slice];
			if (!payload || !slice || slice.text !== null) continue;
			const halves = splitWavInHalf(payload.bytes);
			if (!halves) continue;
			let combined = "";
			for (const [halfIndex, half] of halves.entries()) {
				try {
					const halfText = await deps.transcribe(
						half,
						"audio/wav",
						`${payload.filename.replace(/\.wav$/, "")}-h${halfIndex + 1}.wav`,
						{ ...settings, model: FALLBACK_MODEL },
						{ prompt: state.promptContext },
					);
					combined += sanitizeAsrText(halfText);
				} catch (halfError) {
					logger.warn(`Slice ${key} half ${halfIndex + 1} failed`, {
						error: String(halfError),
					});
				}
			}
			if (combined.trim()) {
				slice.text = combined;
				slice.error = null;
			}
			payloads.delete(key);
			await persistProgress();
		}
	}

	const finishFailed = async (error: string, notice: string) => {
		state.status = "failed";
		state.error = error;
		await deps.storageSet(taskKey, state);
		(globalThis as any).chrome?.alarms?.clear("transcribe-heartbeat");
		await (globalThis as any).chrome?.storage?.session?.remove(
			heartbeatKey,
		);
		deps.notify(notice);
	};

	if (stopped === "host-lost") {
		await finishFailed("视频页已关闭", "转写已暂停：视频页已关闭，重开后点击转写续传");
		return;
	}
	if (stopped === "fatal") {
		await finishFailed("API Key 无效或余额不足", "转写失败：API Key 无效或余额不足");
		return;
	}
	if (stopped === "network") {
		await finishFailed(
			"网络中断",
			"转写因网络中断暂停，网络恢复后点击转写续传",
		);
		return;
	}

	recomputeProgress(state);
	if (state.completedSlices === 0) {
		// 全部失败：不写成品缓存，避免占位符污染剪藏
		await finishFailed("全部音频块转写失败", "转写失败：所有音频块均未成功，请稍后重试");
		return;
	}

	state.status = "done";
	await deps.storageSet(taskKey, state);
	await deps.storageSet(source.cacheKey, {
		schemaVersion: 2,
		model: state.model,
		segments: assembleTranscript(state),
		createdAt: Date.now(),
	});
	(globalThis as any).chrome?.alarms?.clear("transcribe-heartbeat");
	await (globalThis as any).chrome?.storage?.session?.remove(heartbeatKey);
	const failedCount = state.blockResults.reduce(
		(count, result, index) =>
			count +
			(result
				? result.slices.filter((slice) => slice.text === null).length
				: state.chunkPlan[index]
					? 1
					: 0),
		0,
	);
	deps.notify(
		failedCount
			? `AI 转写完成：${failedCount} 段失败，点击转写可补齐`
			: "AI 转写完成，重新剪藏即可使用",
	);
}

export type StartTranscribeInput =
	| {
			platform: "bilibili";
			bvid: string;
			aid: number;
			cid: number;
			page?: number;
			durationSec: number;
			tabId: number;
			settings: TranscribeSettings;
	  }
	| {
			platform: "douyin";
			awemeId: string;
			tabId: number;
			settings: TranscribeSettings;
	  };

export async function startTranscribeTask(
	input: StartTranscribeInput,
	externalDeps?: Partial<TaskDeps>,
): Promise<void> {
	const deps: TaskDeps = { ...defaultDeps(input.tabId), ...externalDeps };

	if (!input.settings.apiKey) {
		deps.notify("未配置 SiliconFlow API Key，请到设置 → AI 转写中填写");
		return;
	}

	let source: TranscribeAudioSource;
	let resolvedBiliCid = 0;
	let resolvedBiliAid = 0;
	if (input.platform === "douyin") {
		source = createDouyinSource(
			{ awemeId: input.awemeId, tabId: input.tabId },
			deps,
		);
	} else {
		const resolved = await resolveBilibiliVideoInfo(
			{
				bvid: input.bvid,
				aid: input.aid,
				cid: input.cid,
				page: input.page ?? 1,
			},
			deps,
		);
		if (!resolved) {
			deps.notify("未找到视频信息，无法开始转写");
			return;
		}
		resolvedBiliCid = resolved.cid;
		resolvedBiliAid = resolved.aid;
		source = createBilibiliSource(
			{
				bvid: input.bvid,
				aid: resolved.aid,
				cid: resolved.cid,
			},
			deps,
		);
	}

	// 并发守卫：同一目标的任务在本 SW 内只允许一个实例（overlay 重试与
	// alarm 恢复并发触发时，避免多引擎重复转写、完成通知弹多次）。
	// 检查即登记（原子），finally 兜底释放——中途任何 return 都不会泄漏。
	if (activeTranscribeTargets.has(source.targetKey)) {
		logger.warn("Transcribe task already active", {
			targetKey: source.targetKey,
		});
		return;
	}
	activeTranscribeTargets.add(source.targetKey);
	try {
		await runLockedTargetTask();
	} finally {
		activeTranscribeTargets.delete(source.targetKey);
	}

	async function runLockedTargetTask(): Promise<void> {
	const cached = await deps.storageGet(source.cacheKey);
	// 仅完整成品才短路：带失败占位符的缓存允许重新转写补齐（历史 bug：
	// 半成品缓存把后续重试全部挡在"已有转写"之外，失败片段永远无法补全）
	if (cachedResultIsClean(cached)) {
		deps.notify("该视频已有 AI 转写字幕，重新剪藏即可使用");
		return;
	}

	const taskKey = transcribeTaskKey(source.targetKey);
	const existing = (await deps.storageGet(taskKey)) as
		| TranscribeTaskState
		| null;

	let state: TranscribeTaskState;
	if (
		existing &&
		// running 可续传；done/failed 但有未完成片段也可续传（点击补齐
		// 场景：已完成细块的文本保留，只重做失败部分；网络中断暂停也走此路径）
		(existing.status === "running" ||
			((existing.status === "done" || existing.status === "failed") &&
				stateHasFailures(existing))) &&
		Array.isArray(existing.chunkPlan) &&
		existing.chunkPlan.length &&
		Array.isArray(existing.blockResults) &&
		// 旧版（头部 4MB 扫描）遗留的巨型单块计划不可续传：重跑只会再次
		// 撞上消息上限，直接作废走全新任务（新版计划已保证单块 ≤ ~3×target）
		(existing.platform === "douyin" ||
			existing.chunkPlan.every(
				(block) => block.end - block.start <= 4 * CHUNK_TARGET_BYTES,
			))
	) {
		state = existing;
		state.status = "running";
		// 断点续传：保留进度；部分完成的块由引擎重做并按时间戳回填文本。
		// 旧版状态（无 blockResults）不兼容，走全新任务。
		state = existing;
		state.tabId = input.tabId;
		state.model = input.settings.model;
		state.promptContext =
			state.promptContext ||
			(input.platform === "bilibili"
				? await (deps.fetchPromptContext ?? fetchBilibiliPromptContext)(
						input.bvid,
					)
				: state.promptContext);
		source.adoptResume({
			chunkPlan: state.chunkPlan,
			audioUrl: state.audioUrl,
		});
		await source.refreshAudioUrl();
		state.audioUrl = source.audioUrl || state.audioUrl;
		await deps.storageSet(taskKey, state);
	} else {
		// 先落占位 running 状态：init（取流/计划，长视频数秒）期间浮层即可
		// 显示"启动中"并持续轮询，而不是点击后按钮闪回（历史体验问题）。
		// init 完成后被完整状态覆盖；失败时连同占位一并清理。
		const placeholder: TranscribeTaskState = {
			platform: source.platform,
			targetKey: source.targetKey,
			bvid: input.platform === "douyin" ? input.awemeId : input.bvid,
			cid: input.platform === "douyin" ? 0 : resolvedBiliCid,
			aid: input.platform === "douyin" ? 0 : resolvedBiliAid,
			page: input.platform === "bilibili" ? ((input as any).page ?? 1) : 1,
			durationSec: source.durationSec,
			model: input.settings.model,
			status: "running",
			chunkPlan: [],
			blockResults: [],
			totalSlices: 1,
			completedSlices: 0,
			promptContext: "",
			audioUrl: "",
			tabId: input.tabId,
			createdAt: Date.now(),
		};
		await deps.storageSet(taskKey, placeholder);
		try {
			const plan = await source.planBlocks();
			if (!plan.length) throw new Error("未解析到音频分片");
			state = {
				platform: source.platform,
				targetKey: source.targetKey,
				bvid:
					input.platform === "douyin"
						? input.awemeId
						: input.bvid,
				cid: input.platform === "douyin" ? 0 : resolvedBiliCid,
				aid: input.platform === "douyin" ? 0 : resolvedBiliAid,
				page: input.platform === "bilibili" ? ((input as any).page ?? 1) : 1,
				durationSec:
					source.durationSec ||
					(input.platform === "bilibili"
						? (input as any).durationSec
						: 0),
				model: input.settings.model,
				status: "running",
				chunkPlan: plan,
				blockResults: plan.map(() => null),
				// 初始为估算值，解码后 recomputeProgress 会替换为真实细块数
				totalSlices: Math.max(
					1,
					Math.ceil((source.durationSec || plan.length * 300) / 30),
				),
				completedSlices: 0,
				promptContext: source.promptContext,
				audioUrl: source.audioUrl,
				tabId: input.tabId,
				createdAt: Date.now(),
			};
			if (input.platform === "bilibili" && !state.promptContext) {
				state.promptContext = await (
					deps.fetchPromptContext ?? fetchBilibiliPromptContext
				)(input.bvid);
			}
			await deps.storageSet(taskKey, state);
		} catch (error) {
			logger.warn("Task init failed", { error: String(error) });
			// 清掉占位状态与遗留心跳：否则 alarm 会反复判定任务已死并不断
			// 重试，每次都弹"转写启动失败"通知（历史 bug：通知风暴）
			await deps.storageSet(taskKey, {
				...placeholder,
				status: "failed",
				error: String(error).slice(0, 80),
			});
			await clearHeartbeat(source.targetKey);
			deps.notify(`转写启动失败：${String(error).slice(0, 60)}`);
			return;
		}
	}

	(globalThis as any).chrome?.alarms?.create("transcribe-heartbeat", {
		periodInMinutes: 0.5,
	});

	await runTranscribeEngine(state, source, deps, input.settings);
	}
}
