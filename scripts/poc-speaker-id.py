# -*- coding: utf-8 -*-
"""
화자식별 PoC 2단계 — 성문 등록·대조 정확도 실측 (SpeechBrain ECAPA-TDNN).

구조(관찰자 모드와 동일):
  등록: 화자별 enroll_*.wav 임베딩 평균 → 성문(voiceprint)
  대조: 각 test_*.wav 임베딩을 전체 성문과 코사인 유사도 비교 → 최고 유사도 화자로 판정
출력: 식별 정확도, 본인/타인 유사도 분포, 권장 임계값(수락/거부 마진).

사용: python scripts/poc-speaker-id.py <audioDir>
"""
import sys
import glob
import os

import torch
import torchaudio

# Windows: speechbrain 기본 SYMLINK 전략이 관리자 권한 없이는 WinError 1314 — COPY로 강제
import speechbrain.utils.fetching as _sbf
_orig_link = _sbf.link_with_strategy
_sbf.link_with_strategy = lambda src, dst, strategy: _orig_link(src, dst, _sbf.LocalStrategy.COPY)

from speechbrain.inference.speaker import EncoderClassifier

AUDIO_DIR = sys.argv[1]

model = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=os.path.join(AUDIO_DIR, "_model"),
)

def embed(path):
    wav, sr = torchaudio.load(path)
    if sr != 16000:
        wav = torchaudio.functional.resample(wav, sr, 16000)
    with torch.no_grad():
        e = model.encode_batch(wav)
    return torch.nn.functional.normalize(e.squeeze(0).squeeze(0), dim=0)

dirs = sorted(d for d in os.listdir(AUDIO_DIR) if os.path.isdir(os.path.join(AUDIO_DIR, d)) and not d.startswith("_"))
# 실제 화자 = 성우: Google TTS의 같은 알파벳(Neural2-A/Wavenet-A)은 같은 성우 — 1차 실측에서
# 오식별 전부가 같은 알파벳 쌍이었고 유사도가 소수점까지 동일(0.904/0.904)함이 증거.
# 폴더 끝 알파벳으로 그룹핑해 진짜 화자 단위로 등록·채점한다.
def true_speaker(d):
    return d.rsplit("-", 1)[-1]

speakers = sorted(set(true_speaker(d) for d in dirs))
print(f"디렉터리 {len(dirs)}개 -> 실제 화자(성우) {len(speakers)}명: {', '.join(speakers)}\n")

# 1) 등록 — 성문 생성 (같은 성우의 클립 통합)
prints = {}
for s in speakers:
    paths = []
    for d in dirs:
        if true_speaker(d) == s:
            paths.extend(sorted(glob.glob(os.path.join(AUDIO_DIR, d, "enroll_*.wav"))))
    embs = [embed(p) for p in paths]
    prints[s] = torch.nn.functional.normalize(torch.stack(embs).mean(dim=0), dim=0)
    print(f"등록 완료: 화자 {s} (클립 {len(embs)}개)")

# 2) 대조 — 테스트 클립 식별
cos = torch.nn.CosineSimilarity(dim=0)
correct = 0
total = 0
same_scores = []
diff_scores = []
print("\n[테스트 클립별 판정]")
for d in dirs:
    s = true_speaker(d)
    for p in sorted(glob.glob(os.path.join(AUDIO_DIR, d, "test_*.wav"))):
        e = embed(p)
        scores = {name: float(cos(e, vp)) for name, vp in prints.items()}
        best = max(scores, key=scores.get)
        ok = best == s
        correct += ok
        total += 1
        same_scores.append(scores[s])
        diff_scores.extend(v for k, v in scores.items() if k != s)
        mark = "O" if ok else "X"
        print(f"  {mark} {d}/{os.path.basename(p)} -> {best} (본인 {scores[s]:.3f} / 최고타인 {max(v for k, v in scores.items() if k != s):.3f})")

same_min = min(same_scores)
diff_max = max(diff_scores)
print(f"\n===== 결과 =====")
print(f"식별 정확도: {correct}/{total} ({100*correct/total:.1f}%)")
print(f"본인 유사도: 최소 {same_min:.3f} / 평균 {sum(same_scores)/len(same_scores):.3f}")
print(f"타인 유사도: 최대 {diff_max:.3f} / 평균 {sum(diff_scores)/len(diff_scores):.3f}")
margin = same_min - diff_max
print(f"판별 마진(본인최소-타인최대): {margin:+.3f} {'-> 임계값 ' + format((same_min+diff_max)/2, '.2f') + ' 권장' if margin > 0 else '-> 분포 겹침: 세션단위 집계 필요'}")
