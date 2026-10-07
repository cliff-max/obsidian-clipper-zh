import type { TranscribeSettings } from "./types/types";
import { createLogger } from "./utils/logger";
import {
	buildChunkPlan,
	downloadAudioRange,
	fetchBilibiliAudioStream,
	findMoofOffsets,
} from "./utils/bilibili-audio";
import { transcribeAudioBlob } from "./utils/transcribe-client";

const logger = createLogger("Transcribe");

/** ~5 分钟/块（64kbps → 8000 B/s） */
export const CHUNK_TARGET_BYTES = 5 * 60 * 8000;
const FALLBACK_MODEL = "FunAudioLLM/SenseVoiceSmall";

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
	error?: string;
	createdAt: number;
}

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

/**
 * 拉取音频头部，扫描 moof 边界生成分块计划；头部无 fragment 时扩拉至 4MB。
 */
async function fetchChunkPlan(stream: {
	url: string;
	bitrateBps: number;
	sizeBytes: number;
}): Promise<TranscribeTaskState["chunkPlan"]> {
	const headBytes = Math.min(512 * 1024, Math.max(1, stream.sizeBytes));
	const head = await downloadAudioRange(stream.url, 0, headBytes - 1);
	let offsets = findMoofOffsets(new Uint8Array(head));
	if (!offsets.length && stream.sizeBytes > headBytes) {
		const biggerBytes = Math.min(4 * 1024 * 1024, stream.sizeBytes);
		const bigger = await downloadAudioRange(stream.url, 0, biggerBytes - 1);
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
	return {
		fetchStream: fetchBilibiliAudioStream,
		downloadRange: downloadAudioRange,
		fetchPlan: fetchChunkPlan,
		decodeWav: async (audio) => {
			const resp = (await (globalThis as any).chrome?.tabs?.sendMessage?.(
				tabId,
				{ action: "decodeAudioToWav", audio },
			)) as any;
			if (!resp?.success) throw new Error(resp?.error || "页面解码失败");
			return resp.data;
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
	bvid: string,
	cid: number,
): Promise<TranscribeTaskState | null> {
	if (cid > 0) {
		const key = `transcribeTask:${bvid}:${cid}`;
		const bag = await (globalThis as any).chrome?.storage?.session?.get(
			key,
		);
		return bag?.[key] ?? null;
	}
	// cid 未知（浮层）：按 bvid 前缀模糊匹配
	const all = await (globalThis as any).chrome?.storage?.session?.get(null);
	const prefix = `transcribeTask:${bvid}:`;
	for (const [key, value] of Object.entries(all ?? {})) {
		if (key.startsWith(prefix)) return value as TranscribeTaskState;
	}
	return null;
}

export function assembleTranscript(
	state: TranscribeTaskState,
): TranscribeChunkResult[] {
	const stepSec = state.durationSec / Math.max(1, state.totalChunks);
	return state.chunkResults.map(
		(chunk, index) =>
			chunk ?? {
				startSec: Math.round(index * stepSec),
				text: `[第 ${index + 1} 段转写失败]`,
			},
	);
}

export async function startTranscribeTask(
	input: {
		bvid: string;
		aid: number;
		cid: number;
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

	const taskKey = `transcribeTask:${input.bvid}:${input.cid}`;
	const existing = (await deps.storageGet(
		taskKey,
	)) as TranscribeTaskState | null;

	let state: TranscribeTaskState;
	if (
		existing &&
		existing.status === "running" &&
		existing.chunkPlan.length
	) {
		state = existing; // 断点续传
	} else {
		try {
			const stream = await deps.fetchStream({
				aid: input.aid,
				bvid: input.bvid,
				cid: input.cid,
			});
			const plan = await deps.fetchPlan(stream);
			if (!plan.length) throw new Error("未解析到音频分片");
			state = {
				bvid: input.bvid,
				cid: input.cid,
				aid: input.aid,
				durationSec: stream.durationSec || input.durationSec,
				model: input.settings.model,
				status: "running",
				totalChunks: plan.length,
				completedChunks: 0,
				chunkResults: plan.map(() => null),
				chunkPlan: plan,
				audioUrl: stream.url,
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
		periodInMinutes: 0.3,
	});

	const initEnd = state.chunkPlan[0]?.start ?? 0;
	let initBytes: ArrayBuffer | null = null;
	for (let i = 0; i < state.chunkPlan.length; i++) {
		if (state.chunkResults[i]) continue;
		const chunk = state.chunkPlan[i];
		try {
			if (initBytes === null) {
				initBytes =
					initEnd > 0
						? await deps.downloadRange(
								state.audioUrl,
								0,
								initEnd - 1,
							)
						: new ArrayBuffer(0);
			}
			const raw = await deps.downloadRange(
				state.audioUrl,
				chunk.start,
				chunk.end - 1,
			);
			const combined = new Uint8Array(
				initBytes.byteLength + raw.byteLength,
			);
			combined.set(new Uint8Array(initBytes), 0);
			combined.set(new Uint8Array(raw), initBytes.byteLength);
			let text: string;
			try {
				const wav = await deps.decodeWav(combined.buffer);
				text = await deps.transcribe(
					wav,
					"audio/wav",
					`chunk-${i}.wav`,
					input.settings,
				);
			} catch {
				// Qwen3-ASR 仅接受 wav；解码失败降级 SenseVoiceSmall 直传 m4a
				text = await deps.transcribe(
					combined.buffer,
					"audio/mp4",
					`chunk-${i}.m4a`,
					{ ...input.settings, model: FALLBACK_MODEL },
				);
			}
			state.chunkResults[i] = {
				startSec: chunk.startSec,
				text: text.trim(),
			};
		} catch (error) {
			logger.warn(`Chunk ${i} failed`, { error: String(error) });
			state.chunkResults[i] = null;
		}
		state.completedChunks = state.chunkResults.filter(Boolean).length;
		await deps.storageSet(taskKey, state);
	}

	state.status = "done";
	await deps.storageSet(taskKey, state);
	await deps.storageSet(`biliTranscript:${input.bvid}:${input.cid}`, {
		model: state.model,
		chunks: assembleTranscript(state),
		createdAt: Date.now(),
	});
	(globalThis as any).chrome?.alarms?.clear("transcribe-heartbeat");
	deps.notify("AI 转写完成，重新剪藏即可使用");
}
