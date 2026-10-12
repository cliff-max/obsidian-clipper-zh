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
	/** 首选地址（兼容旧字段引用） */
	url: string;
	/** 全部候选地址：baseUrl + backupUrl 去重。PCDN/mcdn 节点会随机拒绝
	 * Range 请求（实测 403），下载层需在候选间轮换。 */
	urls: string[];
	sizeBytes: number;
	durationSec: number;
	bitrateBps: number;
}

/**
 * 经 wbi 签名 + cookie 注入通道获取 64kbps 音频流地址与体积。
 * transport 可注入直调通道（background 内部使用，消息发给自己不投递）；
 * 默认走 runtime 消息（content script 环境）。
 */
export interface BilibiliAudioTransport {
	/** 匿名 JSON 抓取（wbi keys 的 nav 请求）。 */
	json?: (url: string) => Promise<any>;
	/** cookie 注入 JSON 抓取（playurl）。 */
	jsonWithCookies?: (url: string) => Promise<any>;
}

export async function fetchBilibiliAudioStream(
	input: {
		aid: number;
		bvid: string;
		cid: number;
	},
	transport?: BilibiliAudioTransport,
): Promise<BilibiliAudioStream> {
	const jsonViaMessage = async (u: string) => {
		const r = (await browser.runtime.sendMessage({
			action: "fetchBilibiliJson",
			url: u,
		})) as any;
		if (!r?.success) throw new Error(r?.error || "fetch failed");
		return r.data;
	};
	const json = transport?.json ?? jsonViaMessage;
	const jsonWithCookies =
		transport?.jsonWithCookies ??
		(async (u: string) => {
			const r = (await browser.runtime.sendMessage({
				action: "fetchBilibiliJsonWithCookies",
				url: u,
			})) as any;
			if (!r?.success) throw new Error(r?.error || "fetch failed");
			return r.data;
		});

	const params: Record<string, string> = {
		aid: String(input.aid),
		bvid: input.bvid,
		cid: String(input.cid),
		fnval: "16",
		fnver: "0",
		fourk: "1",
	};
	let url = `https://api.bilibili.com/x/player/wbi/playurl?${new URLSearchParams(params).toString()}`;
	const wbiKeys = await getWbiKeys(json).catch(() => null);
	if (wbiKeys) {
		url = `https://api.bilibili.com/x/player/wbi/playurl?${signWbiQuery(params, wbiKeys)}`;
	}

	const resp = (await jsonWithCookies(url)) as any;
	const data = resp?.data;
	const audios = data?.dash?.audio || [];
	if (!audios.length) throw new Error("无可用音频流");
	const pick =
		audios.find((a: any) => a.id === 30232) ||
		[...audios].sort(
			(l: any, r: any) => (l.bandwidth || 0) - (r.bandwidth || 0),
		)[0];
	const bitrateBps = pick.bandwidth || 64000;
	const durationSec = (data.timelength || 0) / 1000;
	const backupUrls = [
		...(Array.isArray(pick.backupUrl) ? pick.backupUrl : []),
		...(Array.isArray(pick.backup_url) ? pick.backup_url : []),
	].filter((u: unknown) => typeof u === "string" && u.startsWith("http"));
	const urls = [
		...(pick.baseUrl ? [pick.baseUrl] : []),
		...backupUrls,
	]
		.map((u: string) => u.replace(/^\/\//, "https://"))
		.filter((u: string, i: number, arr: string[]) => arr.indexOf(u) === i);
	if (!urls.length) throw new Error("音频流缺少可用地址");
	logger.info("Audio stream resolved", { bitrateBps, durationSec, urls: urls.length });
	return {
		url: urls[0],
		urls,
		sizeBytes: Math.round((durationSec * bitrateBps) / 8),
		durationSec,
		bitrateBps,
	};
}

/**
 * Range 下载音频片段，经 background 代理（Referer 注入 + bilivideo 白名单）。
 * rangeFn 可注入直调实现（background 内部使用）。
 */
export async function downloadAudioRange(
	url: string,
	start: number,
	end: number,
	rangeFn?: (u: string, s: number, e: number) => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
	if (rangeFn) return rangeFn(url, start, end);
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
 * 按 box 链遍历（而非逐字节搜索）扫描 box 结构。
 * 返回所有 moof box 起始偏移 + 链解析停止位置（首个不完整 box 的起点），
 * 供分窗口渐进扫描时衔接下一窗口，避免窗口边界截断 box 造成错位。
 */
export function scanMoofBoxes(
	bytes: Uint8Array,
	from = 0,
	to = bytes.length,
): { offsets: number[]; end: number } {
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
	return { offsets, end: Math.min(pos, to) };
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
	return scanMoofBoxes(bytes, from, to).offsets;
}

/**
 * 解析 init segment 中的 sidx（Segment Index）box，返回全部 fragment 起点
 * 的绝对偏移。头部一次读取即可拿到全文件边界，避免全量下载扫描。
 * 仅支持 version 0/1 的一级 sidx（B 站 fMP4 音频流的标准形态）。
 */
export function parseSidxFragmentOffsets(
	bytes: Uint8Array,
): { offsets: number[]; initEnd: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const to = bytes.length;
	let pos = 0;
	while (pos + 8 <= to) {
		const size = view.getUint32(pos, false);
		if (size < 8 || pos + size > to) break;
		const type = String.fromCharCode(
			bytes[pos + 4],
			bytes[pos + 5],
			bytes[pos + 6],
			bytes[pos + 7],
		);
		if (type !== "sidx") {
			pos += size;
			continue;
		}
		const version = view.getUint8(pos + 8);
		if (version > 1) return null;
		let cursor = pos + 12; // size+type+version+flags
		cursor += 4 + 4; // reference_ID + timescale
		cursor += version === 1 ? 16 : 8; // earliest_presentation_time + first_offset
		if (cursor + 2 > pos + size) return null;
		const referenceCount = view.getUint16(cursor, false);
		cursor += 2;
		const referencesSize = referenceCount * 12;
		if (cursor + referencesSize > pos + size) return null;
		// fragment 锚点 = sidx box 末尾 + first_offset。
		// 字段偏移：size/type(0~7) + version/flags(8~11) + reference_ID(12~15)
		// + timescale(16~19)；v0: EPT(20~23) + first_offset(24~27)；
		// v1: EPT 8 字节(20~27) + first_offset 8 字节(28~35)——音频流规模下
		// 高 32 位恒为 0，读低 32 位足够。
		const firstOffset =
			version === 1
				? view.getUint32(pos + 32, false)
				: view.getUint32(pos + 24, false);
		const anchor = pos + size + firstOffset;
		const offsets: number[] = [];
		let cum = 0;
		for (let i = 0; i < referenceCount; i++) {
			offsets.push(anchor + cum);
			const refSize = view.getUint32(cursor, false) & 0x7fffffff;
			cum += refSize;
			cursor += 12;
		}
		return { offsets, initEnd: pos + size };
	}
	return null;
}

/**
 * 把 fragment 起点聚合成目标字节数的块，64kbps 恒定码率下字节与时长线性对应。
 * initEnd 之前为 init segment（ftyp/moov/sidx），不含 fragment。
 * maxBlockBytes：单块字节硬上限。fragment 稀疏（单个 fragment 超上限）时在
 * fragment 内部按字节硬拆——块边界可能落在 fragment 中间导致解码失败，
 * 由上层按块降级处理，但不能不拆：巨型块解码后超出扩展消息 64MiB 上限。
 */
export function buildChunkPlan(
	moofOffsets: number[],
	totalLength: number,
	initEnd: number,
	targetChunkBytes: number,
	bitrateBps: number,
	maxBlockBytes = 2 * targetChunkBytes,
): AudioChunkPlan[] {
	if (!moofOffsets.length) return [];
	// 先补齐稀疏边界：相邻边界间距超过 maxBlockBytes 的，按 maxBlockBytes 步进插入硬切点
	const dense: number[] = [];
	for (let i = 0; i < moofOffsets.length; i++) {
		const start = moofOffsets[i];
		const end =
			i + 1 < moofOffsets.length ? moofOffsets[i + 1] : totalLength;
		let pos = start;
		while (pos < end) {
			dense.push(pos);
			pos += maxBlockBytes;
		}
	}
	const bytesPerSec = Math.max(1, bitrateBps / 8);
	const plan: AudioChunkPlan[] = [];
	let chunkStart = dense[0];
	for (let i = 0; i < dense.length; i++) {
		const next = i + 1 < dense.length ? dense[i + 1] : totalLength;
		const chunkEnd = next;
		if (
			chunkEnd - chunkStart >= targetChunkBytes ||
			i === dense.length - 1
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
