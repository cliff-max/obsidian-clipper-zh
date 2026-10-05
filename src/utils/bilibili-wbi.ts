/**
 * B 站 wbi 接口签名。
 *
 * wbi 签名算法参考社区文档 bilibili-API-collect：
 * nav 接口取 img/sub key → 查表重排得 mixin key →
 * 参数排序过滤后追加 wts → query + mixin key 取 MD5 得 w_rid。
 */

type FetchJson = (url: string) => Promise<any>;

export interface WbiKeys {
	imgKey: string;
	subKey: string;
}

/** key 轮换周期约一天，缓存略短于一天。 */
const WBI_KEYS_TTL_MS = 20 * 60 * 60 * 1000;

let wbiKeysCache: (WbiKeys & { fetchedAt: number }) | null = null;

/** 官方混淆重排表。 */
const MIXIN_KEY_ENC_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
	27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
	37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
	22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

/**
 * 获取 wbi keys（带缓存）。获取失败返回 null，调用方应回退到无签名接口。
 */
export async function getWbiKeys(fetchJson: FetchJson): Promise<WbiKeys | null> {
	if (wbiKeysCache && Date.now() - wbiKeysCache.fetchedAt < WBI_KEYS_TTL_MS) {
		const { fetchedAt, ...keys } = wbiKeysCache;
		return keys;
	}

	const response = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
	const imgUrl: string | undefined = response?.data?.wbi_img?.img_url;
	const subUrl: string | undefined = response?.data?.wbi_img?.sub_url;
	const imgKey = extractKeyFromUrl(imgUrl);
	const subKey = extractKeyFromUrl(subUrl);
	if (!imgKey || !subKey) {
		return null;
	}

	wbiKeysCache = { imgKey, subKey, fetchedAt: Date.now() };
	return { imgKey, subKey };
}

/** 仅测试用：清空缓存。 */
export function resetWbiKeysCache(): void {
	wbiKeysCache = null;
}

/**
 * 对参数签名，返回可直接拼接的 query string（含 wts 与 w_rid）。
 * `nowMs` 仅测试注入用，默认当前时间。
 */
export function signWbiQuery(params: Record<string, string>, keys: WbiKeys, nowMs: number = Date.now()): string {
	const mixinKey = getMixinKey(keys.imgKey + keys.subKey);
	const wts = Math.round(nowMs / 1000);
	const chrFilter = /[!'()*]/g;
	const signedParams: Record<string, string> = { ...params, wts: String(wts) };
	const query = Object.keys(signedParams)
		.sort()
		.map((key) => {
			const value = signedParams[key].replace(chrFilter, '');
			return `${key}=${encodeURIComponent(value)}`;
		})
		.join('&');
	return `${query}&w_rid=${md5(query + mixinKey)}`;
}

function extractKeyFromUrl(url: string | undefined): string {
	if (!url) return '';
	const filename = url.split('/').pop() || '';
	return filename.replace(/\.\w+$/, '');
}

function getMixinKey(orig: string): string {
	return MIXIN_KEY_ENC_TAB
		.map((index) => orig.charAt(index))
		.join('')
		.slice(0, 32);
}

/**
 * 纯 JS MD5（RFC 1321，UTF-8 输入），避免为签名引入依赖。
 */
export function md5(input: string): string {
	const message = utf8Bytes(input);
	const bitLength = message.length * 8;
	message.push(0x80);
	while (message.length % 64 !== 56) {
		message.push(0);
	}
	// 64 位长度低 32 位（wbi 签名输入远小于 2^32 字节）
	for (let i = 0; i < 4; i++) {
		message.push((bitLength >>> (i * 8)) & 0xff);
	}
	message.push(0, 0, 0, 0);

	const s = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
	];
	const k = new Array<number>(64);
	for (let i = 0; i < 64; i++) {
		k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
	}

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	const rotateLeft = (x: number, c: number) => (x << c) | (x >>> (32 - c));

	for (let chunkStart = 0; chunkStart < message.length; chunkStart += 64) {
		const m = new Array<number>(16);
		for (let i = 0; i < 16; i++) {
			const offset = chunkStart + i * 4;
			m[i] = message[offset] | (message[offset + 1] << 8) | (message[offset + 2] << 16) | (message[offset + 3] << 24);
		}

		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;

		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			f = (f + a + k[i] + m[g]) >>> 0;
			a = d;
			d = c;
			c = b;
			b = (b + rotateLeft(f, s[i])) >>> 0;
		}

		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}

	return [a0, b0, c0, d0]
		.map((word) => {
			let hex = '';
			for (let i = 0; i < 4; i++) {
				hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
			}
			return hex;
		})
		.join('');
}

function utf8Bytes(input: string): number[] {
	const bytes: number[] = [];
	for (let i = 0; i < input.length; i++) {
		let code = input.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
			const next = input.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i++;
			}
		}
		if (code < 0x80) {
			bytes.push(code);
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		} else {
			bytes.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f)
			);
		}
	}
	return bytes;
}
