import { loadSettings, saveSettings } from "../utils/storage-utils";
import { DEFAULT_TRANSCRIBE_SETTINGS } from "../types/types";

/**
 * 「AI 转写」设置区块：SiliconFlow API Key / 模型 / 端点。
 */
export function initTranscribeSettings(): void {
	const apiKey = document.querySelector(
		"#transcribe-api-key",
	) as HTMLInputElement | null;
	const model = document.querySelector(
		"#transcribe-model",
	) as HTMLSelectElement | null;
	const baseUrl = document.querySelector(
		"#transcribe-base-url",
	) as HTMLInputElement | null;
	if (!apiKey || !model || !baseUrl) return;

	void (async () => {
		const settings = await loadSettings();
		const t = settings.transcribe ?? DEFAULT_TRANSCRIBE_SETTINGS;
		apiKey.value = t.apiKey;
		model.value = t.model;
		baseUrl.value = t.baseUrl;
	})();

	const persist = async () => {
		const settings = await loadSettings();
		settings.transcribe = {
			...DEFAULT_TRANSCRIBE_SETTINGS,
			apiKey: apiKey.value.trim(),
			model: model.value,
			baseUrl:
				baseUrl.value.trim() || DEFAULT_TRANSCRIBE_SETTINGS.baseUrl,
		};
		await saveSettings(settings);
	};
	apiKey.addEventListener("change", persist);
	model.addEventListener("change", persist);
	baseUrl.addEventListener("change", persist);
}
