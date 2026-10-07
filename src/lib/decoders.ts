// Every device must turn the same file into the same samples at the same
// timestamps, or they drift apart by the difference.
//
// Measured with Chrome and Safari's WebCodecs decoders on identical packets:
//  - AAC, Opus, Vorbis and PCM: identical timing, so we use the browser's decoder.
//  - MP3: Safari drops the 529-sample (12 ms) decoder delay, Chrome doesn't.
//  - FLAC: Safari fails to decode it.
// For MP3 and FLAC we therefore use the same WebAssembly decoder on every
// device. The decoders are only downloaded when such a file is played.

import { type AudioCodec, AudioSample, CustomAudioDecoder, type EncodedPacket, registerDecoder } from 'mediabunny';

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
        channelData.forEach((channel, i) => planar.set(channel.subarray(0, samplesDecoded), i * samplesDecoded));
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

let registered = false;

export function registerDecoders() {
    if (registered) return;
    registered = true;
    registerDecoder(Mp3Decoder);
    registerDecoder(FlacDecoder);
}
