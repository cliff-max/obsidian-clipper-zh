export interface AudioChunkPlan {
	start: number;
	end: number;
	startSec: number;
	durationSec: number;
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
