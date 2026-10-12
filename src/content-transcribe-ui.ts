import browser from "./utils/browser-polyfill";
import { getMessage } from "./utils/i18n";
import {
	TRANSCRIBE_NEED_EVENT,
	TRANSCRIBE_NEED_PREFIX,
	isBilibiliVideoUrl,
	parseBilibiliUrl,
} from "./utils/bilibili-extractor";
import {
	DOUYIN_TRANSCRIBE_NEED_PREFIX,
	findCurrentFeedAwemeId,
	hasPlayingDouyinVideo,
	isDouyinFeedUrl,
	isDouyinUserUrl,
	isDouyinVideoUrl,
	parseDouyinUrl,
} from "./utils/douyin-extractor";
import { createLogger } from "./utils/logger";

const logger = createLogger("TranscribeUi");

const PANEL_ID = "obsidian-clipper-transcribe-panel";
const POLL_INTERVAL_MS = 3000;

type PanelTarget =
	| { platform: "bilibili"; bvid: string; page: number; targetKey: string }
	| { platform: "douyin"; awemeId: string; targetKey: string };

/**
 * 视频页右下角浮层：AI 转写入口与进度（shadow DOM 隔离）。
 * B 站与抖音共用；仅对"剪藏时确认无字幕"的视频显示（读 extractor 写入的
 * 标记），有字幕轨或已有转写的视频不显示。抖音 feed 页也挂载（用户正在
 * 观看的视频即目标），否则 feed 页剪藏提示"可 AI 转写"却找不到入口。
 */
export function initTranscribeUi(): void {
	if (!isPanelSupportedUrl(location.href)) return;
	const mount = () => {
		void renderPanel();
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mount, { once: true });
	} else {
		mount();
	}
	// 剪藏刚确认"无字幕"（标记变化）：无需刷新页面，浮层立即重挂
	window.addEventListener(TRANSCRIBE_NEED_EVENT, mount);
	// SPA 切视频：URL 变化时重挂
	let lastHref = location.href;
	setInterval(() => {
		if (location.href !== lastHref) {
			lastHref = location.href;
			if (isPanelSupportedUrl(location.href)) {
				mount();
			}
		}
	}, 1500);
}

function isPanelSupportedUrl(url: string): boolean {
	return (
		isBilibiliVideoUrl(url) ||
		isDouyinVideoUrl(url) ||
		isDouyinFeedUrl(url) ||
		isDouyinUserUrl(url)
	);
}

function resolvePanelTarget(): PanelTarget | null {
	if (isBilibiliVideoUrl(location.href)) {
		const parsed = parseBilibiliUrl(location.href);
		if (!parsed.bvid) return null;
		// cid 在浮层侧未知：状态查询按 bvid 前缀匹配（见 getTranscribeTaskStatus）
		return {
			platform: "bilibili",
			bvid: parsed.bvid,
			page: parsed.page,
			targetKey: parsed.bvid,
		};
	}
	if (isDouyinVideoUrl(location.href)) {
		const { awemeId } = parseDouyinUrl(location.href);
		if (!awemeId) return null;
		return {
			platform: "douyin",
			awemeId,
			targetKey: `dy:${awemeId}`,
		};
	}
	// 抖音 feed 页 / UP 主主页模态播放：目标为当前正在观看的视频
	let awemeId = "";
	if (isDouyinUserUrl(location.href)) {
		if (!hasPlayingDouyinVideo(document)) return null;
		try {
			awemeId = new URL(location.href).searchParams.get("modal_id") || "";
		} catch {
			awemeId = "";
		}
	} else if (isDouyinFeedUrl(location.href)) {
		awemeId = "";
	}
	if (!awemeId) {
		awemeId = findCurrentFeedAwemeId(document) || "";
	}
	if (!awemeId) return null;
	return {
		platform: "douyin",
		awemeId,
		targetKey: `dy:${awemeId}`,
	};
}

async function fetchStatus(targetKey: string): Promise<any> {
	try {
		const resp = (await browser.runtime.sendMessage({
			action: "getTranscribeStatus",
			targetKey,
		})) as any;
		if (!resp?.success) return null;
		return resp.status ? resp : null;
	} catch {
		return null;
	}
}

/** 是否存在"剪藏时确认无字幕"的标记（B 站按 bvid 前缀，抖音按 awemeId）。 */
async function hasTranscribeNeed(target: PanelTarget): Promise<boolean> {
	try {
		const all = (await browser.storage.local.get(null)) as Record<
			string,
			unknown
		>;
		const prefix =
			target.platform === "bilibili"
				? `${TRANSCRIBE_NEED_PREFIX}${target.bvid}:`
				: `${DOUYIN_TRANSCRIBE_NEED_PREFIX}${target.awemeId}`;
		return Object.keys(all).some((key) => key.startsWith(prefix));
	} catch {
		return false;
	}
}

async function renderPanel(): Promise<void> {
	document.getElementById(PANEL_ID)?.remove();
	const target = resolvePanelTarget();
	if (!target) return;

	// 有运行中任务或已完成的转写 → 显示（进度/完成态）
	let state = await fetchStatus(target.targetKey);
	if (!state) {
		// 无任务：仅对剪藏时确认无字幕的视频显示入口
		const needed = await hasTranscribeNeed(target);
		if (!needed) {
			logger.info("Panel hidden: subtitles available or not clipped yet");
			return;
		}
	}

	const host = document.createElement("div");
	host.id = PANEL_ID;
	const shadow = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = `
		.box{position:fixed;right:20px;bottom:140px;z-index:2147483646;background:#1e1e1e;color:#eee;
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
			// init 期间（计划未就绪）显示"启动中"，避免 0/0 的怪异进度
			box.textContent = currentState.starting
				? getMessage("transcribePanelStarting")
				: getMessage("transcribePanelRunning", [
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
		state = await fetchStatus(target.targetKey);
		render(state);
	};

	const start = () => {
		// 点击后立即进入"启动中"态：init 阶段（取流/建计划）可能数秒，
		// 此前显示"…"且状态未就绪会被误渲染回按钮，看起来像点击无效闪烁
		render({ status: "running", starting: true });
		const message =
			target.platform === "douyin"
				? { action: "startDouyinTranscribe", awemeId: target.awemeId }
				: {
						action: "startBilibiliTranscribe",
						bvid: target.bvid,
						aid: 0,
						cid: 0,
						page: target.page,
						durationSec: 0,
					};
		void browser.runtime
			.sendMessage(message)
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
	logger.info("Panel mounted", { target });
}
