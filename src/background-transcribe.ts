import type { TranscribeSettings } from "./types/types";
import { DEFAULT_TRANSCRIBE_SETTINGS } from "./types/types";
import {
	fetchBilibiliJsonDirect,
	fetchBilibiliJsonWithCookiesDirect,
	fetchBilibiliRangeDirect,
} from "./background-bilibili-fetch";
import { loadSettings } from "./utils/storage-utils";
import { createLogger } from "./utils/logger";
import {
	buildChunkPlan,
	downloadAudioRange,
	fetchBilibiliAudioStream,
	findMoofOffsets,
} from "./utils/bilibili-audio";
import { transcribeAudioBlob } from "./utils/transcribe-client";
import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "./utils/audio-wav-encoder";
import { transcriptCacheKey } from "./utils/bilibili-extractor";

const logger = createLogger("Transcribe");

/** ~5 分钟/块（64kbps → 8000 B/s） */
export const CHUNK_TARGET_BYTES = 5 * 60 * 8000;
const FALLBACK_MODEL = "FunAudioLLM/SenseVoiceSmall";
const MAX_CONCURRENCY = 3;
/** 转写 API 鉴权类失败的固定文案片段（见 transcribe-client）。 */
const AUTH_FAILURE_HINT = "API Key 无效";

/** 页面解码宿主丢失（视频页被关闭/导航），任务应暂停而非静默降级。 */
export class TranscribeHostLostError extends Error {
	constructor(message = "视频页已关闭") {
		super(message);
		this.name = "TranscribeHostLostError";
	}
}

export interface TranscribeChunkResult {
	startSec: number;
	text: string;
}

export interface TranscribeTaskState {
	bvid: string;
	cid: number;
	aid: number;
	durationSec: number;
	model: string;
	status: "running" | "done" | "failed";
	totalChunks: number;
	completedChunks: number;
	chunkResults: Array<TranscribeChunkResult | null>;
	chunkPlan: Array<{
		start: number;
		end: number;
		startSec: number;
		durationSec: number;
	}>;
	audioUrl: string;
	/** 解码宿主页（恢复中断任务时重连）。 */
	tabId?: number;
	error?: string;
	createdAt: number;
}

/** 心跳键前缀：任务循环每块更新时间戳，过期即视为被 SW 休眠杀死。 */
export const TRANSCRIBE_HEARTBEAT_PREFIX = "transcribeHeartbeat:";
/** 心跳超过该时长未更新，判定任务已死，由 alarm 唤醒恢复。 */
export const TRANSCRIBE_HEARTBEAT_STALE_MS = 90 * 1000;

interface TaskDeps {
	fetchStream: typeof fetchBilibiliAudioStream;
	downloadRange: typeof downloadAudioRange;
	fetchPlan: (stream: {
		url: string;
		bitrateBps: number;
		sizeBytes: number;
	}) => Promise<TranscribeTaskState["chunkPlan"]>;
	decodeWav: (audio: ArrayBuffer) => Promise<ArrayBuffer>;
	transcribe: typeof transcribeAudioBlob;
	storageGet: (key: string) => Promise<any>;
	storageSet: (key: string, value: any) => Promise<void>;
	notify: (message: string) => void;
}

type ChunkOutcome = "ok" | "failed" | "host-lost" | "fatal";

function isAuthFailure(error: unknown): boolean {
	return String((error as Error)?.message || error).includes(
		AUTH_FAILURE_HINT,
	);
}

/**
 * 拉取音频头部，扫描 moof 边界生成分块计划；头部无 fragment 时扩拉至 4MB。
 */
async function fetchChunkPlan(
	stream: {
		url: string;
		bitrateBps: number;
		sizeBytes: number;
	},
	rangeFn?: (u: string, s: number, e: number) => Promise<ArrayBuffer>,
): Promise<TranscribeTaskState["chunkPlan"]> {
	const headBytes = Math.min(512 * 1024, Math.max(1, stream.sizeBytes));
	const head = await downloadAudioRange(
		stream.url,
		0,
		headBytes - 1,
		rangeFn,
	);
	let offsets = findMoofOffsets(new Uint8Array(head));
	if (!offsets.length && stream.sizeBytes > headBytes) {
		const biggerBytes = Math.min(4 * 1024 * 1024, stream.sizeBytes);
		const bigger = await downloadAudioRange(
			stream.url,
			0,
			biggerBytes - 1,
			rangeFn,
		);
		offsets = findMoofOffsets(new Uint8Array(bigger));
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

function defaultDeps(tabId: number): TaskDeps {
	// background 内部一律直调 fetch 模块——runtime.sendMessage 发给自己不投递。
	// 下载 URL 均来自 playurl 响应（可信来源），跳过静态域名白名单：
	// B 站 CDN 域名族谱庞大（mcdn/akamaized/bilivideo.cn…）无法穷举。
	const rangeDirect = (
		url: string,
		start: number,
		end: number,
	): Promise<ArrayBuffer> =>
		fetchBilibiliRangeDirect(url, start, end, { skipAllowList: true });
	return {
		fetchStream: (input: { aid: number; bvid: string; cid: number }) =>
			fetchBilibiliAudioStream(input, {
				json: fetchBilibiliJsonDirect,
				jsonWithCookies: fetchBilibiliJsonWithCookiesDirect,
			}),
		downloadRange: rangeDirect,
		fetchPlan: (stream: {
			url: string;
			bitrateBps: number;
			sizeBytes: number;
		}) => fetchChunkPlan(stream, rangeDirect),
		decodeWav: async (audio) => {
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
						action: "decodeAudioToWav",
						audioBase64,
					},
				)) as any;
			} catch (error) {
				// tabs.sendMessage 拒绝 = 解码宿主（视频页）已丢失
				throw new TranscribeHostLostError(
					`RECEIVER_UNAVAILABLE: ${String(error)}`,
				);
			}
			if (!resp?.success) throw new Error(resp?.error || "页面解码失败");
			if (typeof resp.wavBase64 !== "string") {
				throw new Error("页面解码响应缺少 wavBase64");
			}
			return base64ToArrayBuffer(resp.wavBase64);
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

export function transcribeTaskKey(bvid: string, cid: number): string {
	return `transcribeTask:${bvid}:${cid}`;
}

export async function getTranscribeTaskStatus(
	bvid: string,
	cid: number,
): Promise<TranscribeTaskState | null> {
	if (cid > 0) {
		const bag = await (globalThis as any).chrome?.storage?.session?.get(
			transcribeTaskKey(bvid, cid),
		);
		return bag?.[transcribeTaskKey(bvid, cid)] ?? null;
	}
	// cid 未知（浮层）：先按 bvid 前缀匹配运行中任务，再查成品缓存
	const all = await (globalThis as any).chrome?.storage?.session?.get(null);
	const prefix = `transcribeTask:${bvid}:`;
	for (const [key, value] of Object.entries(all ?? {})) {
		if (key.startsWith(prefix)) return value as TranscribeTaskState;
	}
	const cached = await (globalThis as any).chrome?.storage?.local?.get(null);
	const cachePrefix = `biliTranscript:${bvid}:`;
	for (const key of Object.keys(cached ?? {})) {
		if (key.startsWith(cachePrefix)) {
			return {
				bvid,
				cid: 0,
				aid: 0,
				durationSec: 0,
				model: "",
				status: "done",
				totalChunks: 0,
				completedChunks: 0,
				chunkResults: [],
				chunkPlan: [],
				audioUrl: "",
				createdAt: 0,
			};
		}
	}
	return null;
}

export function assembleTranscript(
	state: TranscribeTaskState,
): TranscribeChunkResult[] {
	return state.chunkResults.map((chunk, index) => {
		if (chunk) return chunk;
		const planStart = state.chunkPlan[index]?.startSec;
		const stepSec = state.durationSec / Math.max(1, state.totalChunks);
		return {
			startSec: Math.round(planStart ?? index * stepSec),
			text: `[第 ${index + 1} 段转写失败]`,
		};
	});
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
		if (!state || state.status !== "running") {
			await session.remove(key);
			continue;
		}
		logger.info("Resuming interrupted transcribe", {
			bvid: state.bvid,
			completed: state.completedChunks,
			total: state.totalChunks,
		});
		const settings = await loadSettings();
		const transcribeSettings =
			settings.transcribe ??
			({ ...DEFAULT_TRANSCRIBE_SETTINGS } as TranscribeSettings);
		await startTranscribeTask({
			bvid: state.bvid,
			aid: state.aid,
			cid: state.cid,
			page: 1,
			durationSec: state.durationSec,
			tabId: state.tabId ?? -1,
			settings: transcribeSettings,
		}).catch((error) => {
			logger.warn("Resume failed", { error: String(error) });
		});
		return; // 一次只恢复一个（alarm 每 30s 会再触发）
	}
}

/** 解析视频信息：cid 未知时经 view API，多 P 视频按 page 参数取对应分 P。 */
async function resolveVideoInfo(
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
		deps.notify("未找到视频信息，无法开始转写");
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

export async function startTranscribeTask(
	input: {
		bvid: string;
		aid: number;
		cid: number;
		page?: number;
		durationSec: number;
		tabId: number;
		settings: TranscribeSettings;
	},
	externalDeps?: Partial<TaskDeps>,
): Promise<void> {
	const deps: TaskDeps = { ...defaultDeps(input.tabId), ...externalDeps };

	if (!input.settings.apiKey) {
		deps.notify("未配置 SiliconFlow API Key，请到设置 → AI 转写中填写");
		return;
	}

	const resolved = await resolveVideoInfo(
		{
			bvid: input.bvid,
			aid: input.aid,
			cid: input.cid,
			page: input.page ?? 1,
		},
		deps,
	);
	if (!resolved) return;
	const cid = resolved.cid;
	const aid = resolved.aid;

	const cacheKey = transcriptCacheKey(input.bvid, cid);
	const cached = await deps.storageGet(cacheKey);
	if (cached?.chunks?.length) {
		deps.notify("该视频已有 AI 转写字幕，重新剪藏即可使用");
		return;
	}

	const taskKey = transcribeTaskKey(input.bvid, cid);
	const existing = (await deps.storageGet(
		taskKey,
	)) as TranscribeTaskState | null;

	let state: TranscribeTaskState;
	if (
		existing &&
		existing.status === "running" &&
		existing.chunkPlan.length
	) {
		// 断点续传：保留块进度，但刷新签名音频 URL（可能已过期）
		state = existing;
		state.tabId = input.tabId;
		try {
			const fresh = await deps.fetchStream({
				aid,
				bvid: input.bvid,
				cid,
			});
			state.audioUrl = fresh.url;
			await deps.storageSet(taskKey, state);
		} catch (error) {
			logger.warn("Resume stream refresh failed", {
				error: String(error),
			});
		}
	} else {
		try {
			const stream = await deps.fetchStream({
				aid,
				bvid: input.bvid,
				cid,
			});
			const plan = await deps.fetchPlan(stream);
			if (!plan.length) throw new Error("未解析到音频分片");
			state = {
				bvid: input.bvid,
				cid,
				aid,
				durationSec: stream.durationSec || input.durationSec,
				model: input.settings.model,
				status: "running",
				totalChunks: plan.length,
				completedChunks: 0,
				chunkResults: plan.map(() => null),
				chunkPlan: plan,
				audioUrl: stream.url,
				tabId: input.tabId,
				createdAt: Date.now(),
			};
			await deps.storageSet(taskKey, state);
		} catch (error) {
			logger.warn("Task init failed", { error: String(error) });
			deps.notify(`转写启动失败：${String(error)}`);
			return;
		}
	}

	(globalThis as any).chrome?.alarms?.create("transcribe-heartbeat", {
		periodInMinutes: 0.5,
	});

	const initEnd = state.chunkPlan[0]?.start ?? 0;
	// 并发 worker 共享 init segment：单一 promise 缓存避免竞态重复下载
	let initPromise: Promise<ArrayBuffer> | null = null;
	const getInitBytes = (): Promise<ArrayBuffer> => {
		if (!initPromise) {
			initPromise = (async () =>
				initEnd > 0
					? await deps.downloadRange(state.audioUrl, 0, initEnd - 1)
					: new ArrayBuffer(0))();
			initPromise.catch(() => {
				initPromise = null;
			});
		}
		return initPromise;
	};

	const runChunk = async (i: number): Promise<ChunkOutcome> => {
		const chunk = state.chunkPlan[i];
		try {
			const init = await getInitBytes();
			const raw = await deps.downloadRange(
				state.audioUrl,
				chunk.start,
				chunk.end - 1,
			);
			const combined = new Uint8Array(init.byteLength + raw.byteLength);
			combined.set(new Uint8Array(init), 0);
			combined.set(new Uint8Array(raw), init.byteLength);
			let wav: ArrayBuffer;
			let decodeFailed = false;
			try {
				wav = await deps.decodeWav(combined.buffer);
			} catch (error) {
				if (error instanceof TranscribeHostLostError) throw error;
				decodeFailed = true;
				wav = combined.buffer;
			}
			let text: string;
			if (decodeFailed) {
				// 仅"解码失败"降级 SenseVoiceSmall 直传 m4a（Qwen3-ASR 只接受 wav）
				text = await deps.transcribe(
					combined.buffer,
					"audio/mp4",
					`chunk-${i}.m4a`,
					{ ...input.settings, model: FALLBACK_MODEL },
				);
			} else {
				// wav 上传失败（429 耗尽/5xx/401）不降级，落到外层 catch
				text = await deps.transcribe(
					wav,
					"audio/wav",
					`chunk-${i}.wav`,
					input.settings,
				);
			}
			state.chunkResults[i] = {
				startSec: chunk.startSec,
				// SenseVoice 等引擎输出的音乐/事件标记不属于语音内容
				text: text.replace(/[🎼🎵🎶]/gu, "").trim(),
			};
			return "ok";
		} catch (error) {
			if (error instanceof TranscribeHostLostError) {
				logger.warn(`Chunk ${i} host lost`, { error: String(error) });
				return "host-lost";
			}
			if (isAuthFailure(error)) {
				logger.warn(`Chunk ${i} auth failure`, {
					error: String(error),
				});
				return "fatal";
			}
			logger.warn(`Chunk ${i} failed`, { error: String(error) });
			state.chunkResults[i] = null;
			return "failed";
		}
	};

	// 并发 3 的 worker pool
	let nextIndex = state.chunkResults.findIndex((r) => !r);
	let stopped: ChunkOutcome | null = null;
	const heartbeatKey = `${TRANSCRIBE_HEARTBEAT_PREFIX}${input.bvid}:${cid}`;
	const persistProgress = async () => {
		state.completedChunks = state.chunkResults.filter(Boolean).length;
		await deps.storageSet(taskKey, state);
		// 心跳：alarm 唤醒时据此判断任务是否已被 SW 休眠杀死
		await (globalThis as any).chrome?.storage?.session?.set({
			[heartbeatKey]: Date.now(),
		});
	};
	await persistProgress();
	const worker = async () => {
		while (!stopped) {
			const i = nextIndex;
			nextIndex++;
			if (i === undefined || i >= state.chunkPlan.length) return;
			if (state.chunkResults[i]) continue;
			const outcome = await runChunk(i);
			await persistProgress();
			if (outcome === "host-lost" || outcome === "fatal") {
				stopped = outcome;
			}
		}
	};
	await Promise.all(Array.from({ length: MAX_CONCURRENCY }, () => worker()));

	if (stopped === "host-lost") {
		state.status = "failed";
		state.error = "视频页已关闭";
		await deps.storageSet(taskKey, state);
		(globalThis as any).chrome?.alarms?.clear("transcribe-heartbeat");
		await (globalThis as any).chrome?.storage?.session?.remove(
			heartbeatKey,
		);
		deps.notify(
			"视频页已关闭，转写已暂停；请打开视频页后重新点击转写以续传",
		);
		return;
	}
	if (stopped === "fatal") {
		state.status = "failed";
		state.error = "API Key 无效或余额不足";
		await deps.storageSet(taskKey, state);
		(globalThis as any).chrome?.alarms?.clear("transcribe-heartbeat");
		await (globalThis as any).chrome?.storage?.session?.remove(
			heartbeatKey,
		);
		deps.notify("转写失败：API Key 无效或余额不足，请到设置中检查");
		return;
	}

	const completed = state.chunkResults.filter(Boolean).length;
	if (completed === 0) {
		// 全部失败：不写成品缓存，避免占位符污染剪藏
		state.status = "failed";
		state.error = "全部音频块转写失败";
		await deps.storageSet(taskKey, state);
		(globalThis as any).chrome?.alarms?.clear("transcribe-heartbeat");
		await (globalThis as any).chrome?.storage?.session?.remove(
			heartbeatKey,
		);
		deps.notify("转写失败：所有音频块均未成功，请稍后重试");
		return;
	}

	state.status = "done";
	await deps.storageSet(taskKey, state);
	await deps.storageSet(cacheKey, {
		model: state.model,
		chunks: assembleTranscript(state),
		createdAt: Date.now(),
	});
	(globalThis as any).chrome?.alarms?.clear("transcribe-heartbeat");
	deps.notify("AI 转写完成，重新剪藏即可使用");
}
