import type { TranscribeSettings } from "../types/types";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
/** 429 单独加大退避并翻倍次数：并发 5 细块转写实测会触发限流抖动，
 * 短退避（1s/2s）不足以等到配额恢复，导致中后段成片失败。 */
const MAX_ATTEMPTS_429 = 5;
/** 网络层失败（TypeError: Failed to fetch）单独加长退避：实测为代理/线路
 * 抖动，持续数十秒到数分钟，1s/2s 的短退避全部撞在同一窗口里。 */
const MAX_ATTEMPTS_NETWORK = 4;

/** 网络层失败识别（供引擎做"连失即暂停"判定）。 */
export function isNetworkFailure(error: unknown): boolean {
	return /failed to fetch|networkerror|load failed/i.test(
		String((error as Error)?.message || error),
	);
}

export interface TranscribeRequestOptions {
	/**
	 * 热词/上下文提示（视频标题、作者、简介关键词）：Qwen3-ASR 支持
	 * contextual prompting，可显著降低术语与人名误识别。端点不认识该字段时
	 * 可能返回 400，客户端会自动摘除 prompt 重试一次并记住，本次会话不再发送。
	 */
	prompt?: string;
}

/** 会话级开关：端点拒绝 prompt 字段后置 false，避免每块都白付一次 400。 */
let promptSupported = true;

function backoffDelayMs(
	attempt: number,
	kind: "rate-limit" | "network" | "server",
): number {
	if (kind === "rate-limit") return 3000 * 2 ** (attempt - 1); // 3s/6s/12s/24s
	if (kind === "network") return 5000 * 2 ** (attempt - 1); // 5s/10s/20s
	return 1000 * 2 ** (attempt - 1); // 1s/2s
}

/**
 * 调用 OpenAI 兼容的 /v1/audio/transcriptions 端点转写音频块。
 */
export async function transcribeAudioBlob(
	audio: ArrayBuffer,
	mime: string,
	filename: string,
	settings: TranscribeSettings,
	options?: TranscribeRequestOptions,
): Promise<string> {
	let lastError = "";
	let attempt = 1;
	while (attempt <= MAX_ATTEMPTS_429) {
		const form = new FormData();
		form.append("model", settings.model);
		const prompt = promptSupported ? options?.prompt?.trim() : "";
		if (prompt) {
			form.append("prompt", prompt);
		}
		form.append("file", new Blob([audio], { type: mime }), filename);
		let response: Response;
		try {
			response = await fetch(
				`${settings.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${settings.apiKey}` },
					body: form,
				},
			);
		} catch (error) {
			lastError = String(error);
			const kind = isNetworkFailure(error) ? "network" : "server";
			const maxAttempts =
				kind === "network" ? MAX_ATTEMPTS_NETWORK : MAX_ATTEMPTS;
			if (attempt < maxAttempts) {
				await new Promise((resolve) =>
					setTimeout(resolve, backoffDelayMs(attempt, kind)),
				);
				attempt += 1;
				continue;
			}
			throw new Error(`转写请求网络失败：${lastError}`);
		}
		if (response.ok) {
			const data = (await response.json()) as { text?: string };
			return data.text || "";
		}
		const body = await response.text().catch(() => "");
		// 端点不认识 prompt 字段（部分 OpenAI 兼容实现严格校验）：摘除重试
		if (response.status === 400 && prompt && promptSupported) {
			promptSupported = false;
			lastError = "HTTP 400 (prompt rejected)";
			continue; // 不消耗 attempt：这是配置适配而非故障重试
		}
		if (!RETRYABLE.has(response.status)) {
			if (response.status === 401 || response.status === 403) {
				throw new Error("API Key 无效或余额不足");
			}
			throw new Error(
				`转写失败（HTTP ${response.status}）：${body.slice(0, 200)}`,
			);
		}
		const isRateLimit = response.status === 429;
		const maxAttempts = isRateLimit ? MAX_ATTEMPTS_429 : MAX_ATTEMPTS;
		lastError = `HTTP ${response.status}`;
		if (attempt >= maxAttempts) break;
		// 服务端 Retry-After（秒）优先于本地退避
		const retryAfter = Number(response.headers.get("retry-after"));
		const delayMs =
			Number.isFinite(retryAfter) && retryAfter > 0
				? Math.min(retryAfter * 1000, 30_000)
				: backoffDelayMs(attempt, isRateLimit ? "rate-limit" : "server");
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		attempt += 1;
	}
	throw new Error(`转写连续失败（${lastError}）`);
}
