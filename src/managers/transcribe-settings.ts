import { loadSettings, saveSettings } from "../utils/storage-utils";
import { DEFAULT_TRANSCRIBE_SETTINGS } from "../types/types";

const PERSIST_DEBOUNCE_MS = 500;

/**
 * 「AI 转写」设置区块：SiliconFlow API Key / 模型 / 端点。
 * 用 input + 防抖保存（change 仅失焦触发，用户填完即切页会丢输入）。
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

	let timer: ReturnType<typeof setTimeout> | null = null;
	const persist = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			void (async () => {
				const settings = await loadSettings();
				settings.transcribe = {
					...DEFAULT_TRANSCRIBE_SETTINGS,
					apiKey: apiKey.value.trim(),
					model: model.value,
					baseUrl:
						baseUrl.value.trim() ||
						DEFAULT_TRANSCRIBE_SETTINGS.baseUrl,
				};
				await saveSettings(settings);
			})();
		}, PERSIST_DEBOUNCE_MS);
	};
	apiKey.addEventListener("input", persist);
	model.addEventListener("change", persist);
	baseUrl.addEventListener("input", persist);
	window.addEventListener("beforeunload", () => {
		if (timer) clearTimeout(timer);
		// 离开页面前立即落盘未防抖的输入
		void (async () => {
			const settings = await loadSettings();
			settings.transcribe = {
				...DEFAULT_TRANSCRIBE_SETTINGS,
				apiKey: apiKey.value.trim(),
				model: model.value,
				baseUrl:
					baseUrl.value.trim() || DEFAULT_TRANSCRIBE_SETTINGS.baseUrl,
			};
			await saveSettings(settings);
		})();
	});
}
