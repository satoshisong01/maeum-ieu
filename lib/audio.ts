/**
 * Gemini TTS는 헤더 없는 raw PCM (24kHz, 16-bit, mono)을 base64로 반환한다.
 * 브라우저 <audio>가 재생하려면 WAV 헤더(RIFF)를 부착해야 한다.
 */

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/** 24kHz/16-bit/mono PCM Buffer를 WAV 형식 Buffer로 감싼다. */
export function pcmToWav(pcm: Buffer): Buffer {
  const byteRate = (SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);                      // PCM chunk size
  header.writeUInt16LE(1, 20);                       // PCM format
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
