import crypto from 'node:crypto';

let encoderPromise;
const cache = new Map();

// Read dimensions only; never decode pixels or run third-party image parsers.
// Every JPEG segment advances within the supplied bytes, including malformed
// input. Other formats fall back to an explicit media estimate.
export function imageDimensions(b) {
    if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6)))
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
        const type = b.toString('ascii', 12, 16);
        if (type === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
        if (type === 'VP8L' && b[20] === 47) {
            const bits = b.readUInt32LE(21);
            return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
        }
        if (type === 'VP8 ' && b[23] === 157 && b[24] === 1 && b[25] === 42)
            return { width: b.readUInt16LE(26) & 16383, height: b.readUInt16LE(28) & 16383 };
    }
    if (b[0] === 255 && b[1] === 216) {
        let at = 2;
        while (at + 3 < b.length && b[at++] === 255) {
            while (at < b.length && b[at] === 255) at++;
            const marker = b[at++];
            if (marker === 217 || marker === 218) break;
            if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
            if (at + 2 > b.length) break;
            const size = b.readUInt16BE(at);
            if (size < 2 || at + size > b.length) break;
            if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 7)
                return { width: b.readUInt16BE(at + 5), height: b.readUInt16BE(at + 3) };
            at += size;
        }
    }
    throw new Error('Unknown image dimensions');
}

async function encoder() {
    // Load only the required vocabulary, and only on a count request. Starting
    // the router and streaming responses never wait for tokenizer setup.
    encoderPromise ||= Promise.all([
        import('js-tiktoken/lite'), import('js-tiktoken/ranks/o200k_base'),
    ]).then(([{ Tiktoken }, { default: ranks }]) => new Tiktoken(ranks));
    return encoderPromise;
}

// Current GPT vision sizing rules, including screenshots carried in tool results:
// https://developers.openai.com/api/docs/guides/images-vision#model-sizing-behavior
export function imageTokens(width, height, model, detail = 'auto') {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error('Invalid image size');
    const newer = /^gpt-5\.[56]/.test(model);
    const original = detail === 'original' || (detail === 'auto' && newer);
    const low = detail === 'low' && newer;
    const maxDimension = low ? 512 : original ? (/^gpt-5\.6/.test(model) ? 65535 : 6000) : 2048;
    const budget = low || (original && /^gpt-5\.6/.test(model)) ? Infinity
        : original ? 10000 : detail === 'low' ? 6144 : 2500;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    let w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (Math.ceil(w / 32) * Math.ceil(h / 32) > budget) {
        const shrink = Math.sqrt(1024 * budget / (w * h));
        const adjusted = shrink * Math.min(Math.floor(w * shrink / 32) / (w * shrink / 32),
            Math.floor(h * shrink / 32) / (h * shrink / 32));
        w = Math.max(1, Math.floor(w * adjusted));
        h = Math.max(1, Math.floor(h * adjusted));
    }
    return Math.ceil(Math.ceil(w / 32) * Math.ceil(h / 32) * 1.2);
}

export async function estimateOpenAIInput(payload) {
    // Count the translated provider request, not Anthropic-only system identity
    // blocks or transport settings. Opaque reasoning replay and base64 images
    // are not text tokens. Unknown remote image dimensions remain estimated;
    // counting must not fetch arbitrary URLs or decode private reasoning blobs.
    let media = 0;
    const text = JSON.stringify({ instructions: payload.instructions, input: payload.input, tools: payload.tools }, (key, value) => {
        if (key === 'encrypted_content') return undefined;
        if (value?.type === 'input_image') {
            const match = /^data:image\/[^;]+;base64,(.*)$/s.exec(value.image_url || '');
            try {
                if (!match) throw new Error('unknown dimensions');
                const size = imageDimensions(Buffer.from(match[1], 'base64'));
                media += imageTokens(size.width, size.height, payload.model, value.detail);
            } catch { media += 3000; }
            return { type: 'input_image' };
        }
        return value;
    });
    const key = crypto.createHash('sha256').update(payload.model + '\n' + media + '\n' + text).digest('hex');
    if (cache.has(key)) return cache.get(key);
    const enc = await encoder();
    const tokens = enc.encode(text, [], []).length + media;
    // Wire-envelope overhead is estimated; real terminal usage remains the
    // authority after a response. Only hashes and counts are retained here.
    cache.set(key, tokens);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return tokens;
}
