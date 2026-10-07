import browser from "./browser-polyfill";
import { createLogger } from "./logger";
import { getWbiKeys, signWbiQuery } from "./bilibili-wbi";

const logger = createLogger("BilibiliAudio");

export interface AudioChunkPlan {
	start: number;
	end: number;
	startSec: number;
	durationSec: number;
}

export interface BilibiliAudioStream {
	url: string;
	sizeBytes: number;
	durationSec: number;
	bitrateBps: number;
}

/**
 * 经 wbi 签名 + cookie 注入通道获取 64kbps 音频流地址与体积。
 */
export async function fetchBilibiliAudioStream(input: {
	aid: number;
	bvid: string;
	cid: number;
}): Promise<BilibiliAudioStream> {
	const params: Record<string, string> = {
		aid: String(input.aid),
		bvid: input.bvid,
		cid: String(input.cid),
		fnval: "16",
		fnver: "0",
		fourk: "1",
	};
	let url = `https://api.bilibili.com/x/player/wbi/playurl?${new URLSearchParams(params).toString()}`;
	const wbiKeys = await getWbiKeys(async (u: string) => {
		const r = (await browser.runtime.sendMessage({
			action: "fetchBilibiliJson",
			url: u,
		})) as any;
		if (!r?.success) throw new Error(r?.error || "fetch failed");
		return r.data;
	}).catch(() => null);
	if (wbiKeys) {
		url = `https://api.bilibili.com/x/player/wbi/playurl?${signWbiQuery(params, wbiKeys)}`;
	}

	const resp = (await browser.runtime.sendMessage({
		action: "fetchBilibiliJsonWithCookies",
		url,
	})) as any;
	if (!resp?.success) throw new Error(resp?.error || "playurl 请求失败");
	const data = resp.data?.data;
	const audios = data?.dash?.audio || [];
	if (!audios.length) throw new Error("无可用音频流");
	const pick =
		audios.find((a: any) => a.id === 30232) ||
		[...audios].sort(
			(l: any, r: any) => (l.bandwidth || 0) - (r.bandwidth || 0),
		)[0];
	const bitrateBps = pick.bandwidth || 64000;
	const durationSec = (data.timelength || 0) / 1000;
	logger.info("Audio stream resolved", { bitrateBps, durationSec });
	return {
		url: (pick.baseUrl || "").replace(/^\/\//, "https://"),
		sizeBytes: Math.round((durationSec * bitrateBps) / 8),
		durationSec,
		bitrateBps,
	};
}

/**
 * Range 下载音频片段，经 background 代理（Referer 注入 + bilivideo 白名单）。
 */
export async function downloadAudioRange(
	url: string,
	start: number,
	end: number,
): Promise<ArrayBuffer> {
	const resp = (await browser.runtime.sendMessage({
		action: "fetchBilibiliRange",
		url,
		rangeStart: start,
		rangeEnd: end,
	})) as any;
	if (!resp?.success) throw new Error(resp?.error || "音频分块下载失败");
	return resp.data as ArrayBuffer;
}

/**
 * 按 box 链遍历（而非逐字节搜索）返回所有 moof box 起始偏移，
 * 避免 mdat 载荷中的伪 moof 魔数造成误判。
 */
export function findMoofOffsets(
	bytes: Uint8Array,
	from = 0,
	to = bytes.length,
): number[] {
	const offsets: number[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = from;
	while (pos + 8 <= to) {
		const size = view.getUint32(pos, false);
		if (size < 8 || pos + size > to) break;
		const type = String.fromCharCode(
			bytes[pos + 4],
			bytes[pos + 5],
			bytes[pos + 6],
			bytes[pos + 7],
		);
		if (type === "moof") offsets.push(pos);
		pos += size;
	}
	return offsets;
}

/**
 * 把 fragment 起点聚合成目标字节数的块，64kbps 恒定码率下字节与时长线性对应。
 * initEnd 之前为 init segment（ftyp/moov/sidx），不含 fragment。
 */
export function buildChunkPlan(
	moofOffsets: number[],
	totalLength: number,
	initEnd: number,
	targetChunkBytes: number,
	bitrateBps: number,
): AudioChunkPlan[] {
	if (!moofOffsets.length) return [];
	const bytesPerSec = Math.max(1, bitrateBps / 8);
	const plan: AudioChunkPlan[] = [];
	let chunkStart = moofOffsets[0];
	for (let i = 0; i < moofOffsets.length; i++) {
		const next =
			i + 1 < moofOffsets.length ? moofOffsets[i + 1] : totalLength;
		const chunkEnd = next;
		if (
			chunkEnd - chunkStart >= targetChunkBytes ||
			i === moofOffsets.length - 1
		) {
			plan.push({
				start: chunkStart,
				end: chunkEnd,
				startSec: (chunkStart - initEnd) / bytesPerSec,
				durationSec: (chunkEnd - chunkStart) / bytesPerSec,
			});
			chunkStart = chunkEnd;
		}
	}
	return plan;
}
