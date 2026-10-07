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

/**
 * B 站视频页右下角浮层：AI 转写入口与进度（shadow DOM 隔离）。
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

async function renderPanel(): Promise<void> {
	document.getElementById(PANEL_ID)?.remove();
	const parsed = parseBilibiliUrl(location.href);
	if (!parsed.bvid) return;

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
		.hint{color:#999;font-size:12px;margin-top:4px}
	`;
	const box = document.createElement("div");
	box.className = "box";
	shadow.append(style, box);

	const render = (state: any, cached: boolean) => {
		box.innerHTML = "";
		if (cached || state?.status === "done") {
			box.classList.add("done");
			box.textContent = cached
				? `${getMessage("transcribePanelCached")} · ${getMessage("transcribePanelDone")}`
				: getMessage("transcribePanelDone");
			return;
		}
		if (state?.status === "running") {
			box.classList.remove("done");
			box.textContent = getMessage("transcribePanelRunning", [
				String(state.completedChunks ?? 0),
				String(state.totalChunks ?? 0),
			]);
			setTimeout(() => {
				void poll(render);
			}, POLL_INTERVAL_MS);
			return;
		}
		box.classList.remove("done");
		const btn = document.createElement("button");
		btn.textContent = getMessage("transcribePanelButton");
		btn.addEventListener("click", () => {
			btn.disabled = true;
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
				.then(() => poll(render))
				.catch(() => poll(render));
		});
		box.appendChild(btn);
	};

	const poll = async (cb: (state: any, cached: boolean) => void) => {
		const state = await fetchStatus(parsed.bvid!);
		cb(state, false);
	};

	const initial = await fetchStatus(parsed.bvid);
	render(initial, false);
	document.documentElement.appendChild(host);
	logger.info("Panel mounted", { bvid: parsed.bvid });
}
