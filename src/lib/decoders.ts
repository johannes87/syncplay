// Every device must turn the same file into the same samples at the same
// timestamps, or they drift apart by the difference.
//
// Measured with the browsers' WebCodecs decoders on identical packets:
//  - AAC, Opus and PCM: identical timing, so we use the browser's decoder.
//  - MP3: Safari drops the 529-sample (12 ms) decoder delay, Chrome doesn't.
//  - FLAC: Safari fails to decode it.
//  - Vorbis: Firefox outputs no audio.
// For MP3, FLAC and Vorbis we therefore use the same WebAssembly decoder on
// every device. The decoders are only downloaded when such a file is played.

import { AudioSample, CustomAudioDecoder, registerDecoder, type AudioCodec, type EncodedPacket } from 'mediabunny';

interface Decoded {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
}

interface WasmDecoder {
    ready: Promise<void>;
    decodeFrames(frames: Uint8Array[]): Decoded | Promise<Decoded>;
    free(): void;
}

abstract class WasmAudioDecoder extends CustomAudioDecoder {
    #decoder: WasmDecoder | null = null;

    protected abstract create(): Promise<WasmDecoder>;

    async init() {
        this.#decoder = await this.create();
        await this.#decoder.ready;
    }

    async decode(packet: EncodedPacket) {
        const { channelData, samplesDecoded, sampleRate } = await this.#decoder!.decodeFrames([packet.data]);
        if (!samplesDecoded) return;
        const planar = new Float32Array(samplesDecoded * channelData.length);
        for (const [i, channel] of channelData.entries()) {
            planar.set(channel.subarray(0, samplesDecoded), i * samplesDecoded);
        }
        this.onSample(
            new AudioSample({
                data: planar,
                format: 'f32-planar',
                numberOfChannels: channelData.length,
                sampleRate,
                timestamp: packet.timestamp,
            }),
        );
    }

    flush() {}

    close() {
        this.#decoder?.free();
    }
}

class Mp3Decoder extends WasmAudioDecoder {
    static supports(codec: AudioCodec) {
        return codec === 'mp3';
    }

    protected async create() {
        const { MPEGDecoder } = await import('mpg123-decoder');
        // No gapless trimming: timestamps must map to frames the same way everywhere.
        return new MPEGDecoder({ enableGapless: false });
    }
}

class FlacDecoder extends WasmAudioDecoder {
    static supports(codec: AudioCodec) {
        return codec === 'flac';
    }

    protected async create() {
        const { FLACDecoder } = await import('@wasm-audio-decoders/flac');
        return new FLACDecoder();
    }
}

/**
 * The identification and setup headers from a WebCodecs Vorbis description: the byte 2,
 * the lengths of the first two headers (each a run of 255s plus a final byte), then the
 * identification, comment and setup headers.
 */
function vorbisHeaders(description: AllowSharedBufferSource | undefined) {
    if (!description) throw new Error('The Vorbis headers are missing');
    const bytes = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description);
    let at = 1;
    const lengths = [0, 0];
    for (const i of [0, 1]) {
        while (bytes[at] === 255) lengths[i] += bytes[at++];
        lengths[i] += bytes[at++];
    }
    const identification = bytes.subarray(at, at + lengths[0]);
    const setup = bytes.subarray(at + lengths[0] + lengths[1]);
    return { identification, setup };
}

class VorbisDecoder extends WasmAudioDecoder {
    static supports(codec: AudioCodec) {
        return codec === 'vorbis';
    }

    protected async create() {
        const { OggVorbisDecoder } = await import('@wasm-audio-decoders/ogg-vorbis');
        const decoder = new OggVorbisDecoder();
        const { identification, setup } = vorbisHeaders(this.config.description);
        // The decoder wants Ogg pages, but only reads these fields of them. It takes the
        // headers from the first pages it sees.
        const page = (data: Uint8Array, packets: Uint8Array[]) => ({
            data,
            codecFrames: packets.map((packet) => ({ data: packet, header: { vorbisSetup: setup } })),
        });
        let pages = [page(identification, [])];
        return {
            ready: decoder.ready,
            decodeFrames(frames: Uint8Array[]) {
                pages.push(page(new Uint8Array(), frames));
                const decoded = decoder.decodeOggPages(
                    pages as unknown as Parameters<typeof decoder.decodeOggPages>[0],
                );
                pages = [];
                return decoded;
            },
            free: () => decoder.free(),
        };
    }
}

let registered = false;

export function registerDecoders() {
    if (registered) return;
    registered = true;
    registerDecoder(Mp3Decoder);
    registerDecoder(FlacDecoder);
    registerDecoder(VorbisDecoder);
}
