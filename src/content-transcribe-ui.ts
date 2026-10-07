import browser from "./utils/browser-polyfill";
import { getMessage } from "./utils/i18n";
import {
	isBilibiliVideoUrl,
	parseBilibiliUrl,
} from "./utils/bilibili-extractor";
import { createLogger } from "./utils/logger";

const logger = createLogger("TranscribeUi");

const PANEL_ID = "obsidian-clipper-transcribe-panel";
const POLL_INTERVAL_MS = 3000;
/** 等待播放器控制栏就绪以检测 CC 字幕按钮的轮询上限。 */
const CC_PROBE_TIMEOUT_MS = 15000;
const CC_PROBE_INTERVAL_MS = 1000;

/**
 * B 站视频页右下角浮层：AI 转写入口与进度（shadow DOM 隔离）。
 * 有 CC 字幕选项的视频不显示（已有字幕无需转写）。
 */
export function initTranscribeUi(): void {
	if (!isBilibiliVideoUrl(location.href)) return;
	const mount = () => {
		void renderPanel();
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mount, { once: true });
	} else {
		mount();
	}
	// SPA 切集：URL 变化时重挂
	let lastHref = location.href;
	setInterval(() => {
		if (location.href !== lastHref) {
			lastHref = location.href;
			if (isBilibiliVideoUrl(location.href)) {
				mount();
			}
		}
	}, 1500);
}

async function fetchStatus(bvid: string): Promise<any> {
	try {
		const resp = (await browser.runtime.sendMessage({
			action: "getBilibiliTranscribeStatus",
			bvid,
			cid: 0,
		})) as any;
		if (!resp?.success) return null;
		return resp.status ? resp : null;
	} catch {
		return null;
	}
}

/** 等待播放器控制栏并检测 CC 字幕按钮；超时视为无字幕。 */
function waitForCcButtonDecision(): Promise<boolean> {
	return new Promise((resolve) => {
		const started = Date.now();
		const probe = () => {
			const player = document.querySelector(
				".bpx-player-container, #bilibili-player, .bpx-player",
			);
			if (player) {
				// 控制栏已渲染：有 CC 按钮即有字幕轨
				const controls = document.querySelector(
					".bpx-player-control-bottom",
				);
				if (controls) {
					resolve(!!document.querySelector(".bpx-player-ctrl-sub"));
					return;
				}
			}
			if (Date.now() - started >= CC_PROBE_TIMEOUT_MS) {
				resolve(false);
				return;
			}
			setTimeout(probe, CC_PROBE_INTERVAL_MS);
		};
		probe();
	});
}

async function renderPanel(): Promise<void> {
	document.getElementById(PANEL_ID)?.remove();
	const parsed = parseBilibiliUrl(location.href);
	if (!parsed.bvid) return;

	// 已有成品缓存或运行中任务 → 始终显示（含"已有 AI 转写"状态）
	let state = await fetchStatus(parsed.bvid);
	if (!state) {
		// 无缓存任务：有 CC 字幕选项的视频不显示浮层
		const hasCc = await waitForCcButtonDecision();
		if (hasCc) {
			logger.info("Panel hidden: subtitle track available");
			return;
		}
	}

	const host = document.createElement("div");
	host.id = PANEL_ID;
	const shadow = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = `
		.box{position:fixed;right:20px;bottom:80px;z-index:2147483646;background:#1e1e1e;color:#eee;
			border-radius:10px;padding:10px 14px;font:13px/1.5 system-ui,sans-serif;
			box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:260px}
		button{background:#7c5cff;color:#fff;border:0;border-radius:6px;padding:6px 12px;
			cursor:pointer;font-size:13px}
		button:hover{background:#8d73ff}
		.done{color:#7ada7a}
		.error{color:#ff8f8f}
	`;
	const box = document.createElement("div");
	box.className = "box";
	shadow.append(style, box);

	const render = (currentState: any) => {
		box.innerHTML = "";
		box.classList.remove("done", "error");
		if (currentState?.status === "done") {
			box.classList.add("done");
			box.textContent = getMessage("transcribePanelDone");
			return;
		}
		if (currentState?.status === "failed") {
			box.classList.add("error");
			box.textContent = getMessage("transcribePanelFailed");
			const retry = document.createElement("button");
			retry.textContent = "↻";
			retry.title = getMessage("transcribePanelButton");
			retry.addEventListener("click", () => start());
			box.appendChild(retry);
			return;
		}
		if (currentState?.status === "running") {
			box.textContent = getMessage("transcribePanelRunning", [
				String(currentState.completedChunks ?? 0),
				String(currentState.totalChunks ?? 0),
			]);
			setTimeout(() => {
				void poll();
			}, POLL_INTERVAL_MS);
			return;
		}
		const btn = document.createElement("button");
		btn.textContent = getMessage("transcribePanelButton");
		btn.addEventListener("click", () => start());
		box.appendChild(btn);
	};

	const poll = async () => {
		state = await fetchStatus(parsed.bvid!);
		render(state);
	};

	const start = () => {
		box.textContent = "…";
		void browser.runtime
			.sendMessage({
				action: "startBilibiliTranscribe",
				bvid: parsed.bvid,
				aid: 0,
				cid: 0,
				page: parsed.page,
				durationSec: 0,
			})
			.then(async (resp: any) => {
				if (resp?.success === false) {
					// 后台前置校验失败（如 key 未配置）：浮层直接展示原因
					box.classList.add("error");
					box.textContent = resp.error || "转写启动失败";
					return;
				}
				await poll();
			})
			.catch(async (error: unknown) => {
				box.classList.add("error");
				box.textContent = String((error as Error)?.message || error);
			});
	};

	render(state);
	document.documentElement.appendChild(host);
	logger.info("Panel mounted", { bvid: parsed.bvid });
}
