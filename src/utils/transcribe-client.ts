import type { TranscribeSettings } from "../types/types";

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
	let lastError = "";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const form = new FormData();
		form.append("model", settings.model);
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
			if (attempt < MAX_ATTEMPTS) continue;
			throw new Error(`转写请求网络失败：${lastError}`);
		}
		if (response.ok) {
			const data = (await response.json()) as { text?: string };
			return data.text || "";
		}
		const body = await response.text().catch(() => "");
		if (!RETRYABLE.has(response.status)) {
			if (response.status === 401 || response.status === 403) {
				throw new Error("API Key 无效或余额不足");
			}
			throw new Error(
				`转写失败（HTTP ${response.status}）：${body.slice(0, 200)}`,
			);
		}
		lastError = `HTTP ${response.status}`;
		if (attempt < MAX_ATTEMPTS) {
			await new Promise((resolve) =>
				setTimeout(resolve, 1000 * 2 ** (attempt - 1)),
			);
		}
	}
	throw new Error(`转写连续失败（${lastError}）`);
}
