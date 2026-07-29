/**
 * 화자식별 PoC 1단계 — 한국어 화자 6명분 오디오 생성 (Cloud TTS).
 * 화자별: 등록용 3클립 + 테스트용 4클립(속도·피치 변형 포함 — 동일 화자 내 변이 모사).
 * 출력: <outDir>/<voice>/{enroll|test}_N.wav (LINEAR16 16kHz)
 * 사용: node scripts/poc-speaker-gen-audio.mjs <outDir>
 */
import "dotenv/config";
import textToSpeech from "@google-cloud/text-to-speech";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
if (!OUT) { console.error("outDir 필요"); process.exit(1); }

// 같은 알파벳(Neural2-A vs Wavenet-A)은 동일 성우 기반일 수 있어 의도적으로 섞음 — 유사 목소리 변별의 적대 케이스
const VOICES = ["ko-KR-Neural2-A", "ko-KR-Neural2-B", "ko-KR-Neural2-C", "ko-KR-Wavenet-A", "ko-KR-Wavenet-C", "ko-KR-Standard-B"];

const ENROLL_TEXTS = [
  "우리 손주가 어제 놀러 와서 같이 저녁을 먹었어요. 김치찌개를 끓였는데 아주 맛있게 먹더라고요.",
  "요즘 무릎이 좀 시큰거려서 병원에 다녀왔어요. 의사 선생님이 가볍게 걷는 운동을 하라고 하셨어요.",
  "옛날에 시장에서 장사할 때는 새벽 네 시에 일어나서 준비를 했지요. 그때는 몸이 참 튼튼했어요.",
];
const TEST_TEXTS = [
  "오늘 날씨가 참 좋아서 마당에 나가 화분에 물을 줬어요.",
  "점심에 국수를 삶아 먹었는데 간이 좀 싱거웠던 것 같아요.",
  "저녁 드라마 시작할 시간이 다 되어 가네요. 그거 보는 재미로 살아요.",
  "약 먹을 시간을 자꾸 잊어버려서 달력에 크게 표시를 해 두었어요.",
];
// 동일 화자 내 변이(컨디션·말투 변화 모사): 테스트 클립마다 다른 속도·피치
const TEST_VARIANTS = [
  { speakingRate: 1.0, pitch: 0 },
  { speakingRate: 0.85, pitch: -2 },
  { speakingRate: 1.15, pitch: 2 },
  { speakingRate: 0.95, pitch: 1 },
];

const client = new textToSpeech.TextToSpeechClient();
async function synth(voice, text, opts, path) {
  const [res] = await client.synthesizeSpeech({
    input: { text },
    voice: { languageCode: "ko-KR", name: voice },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 16000, speakingRate: opts.speakingRate, pitch: opts.pitch },
  });
  writeFileSync(path, Buffer.from(res.audioContent));
}

for (const v of VOICES) {
  const dir = join(OUT, v);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < ENROLL_TEXTS.length; i++) {
    await synth(v, ENROLL_TEXTS[i], { speakingRate: 1.0, pitch: 0 }, join(dir, `enroll_${i}.wav`));
  }
  for (let i = 0; i < TEST_TEXTS.length; i++) {
    await synth(v, TEST_TEXTS[i], TEST_VARIANTS[i], join(dir, `test_${i}.wav`));
  }
  console.log(`${v}: 등록 ${ENROLL_TEXTS.length} + 테스트 ${TEST_TEXTS.length} 생성`);
}
console.log("완료:", OUT);
