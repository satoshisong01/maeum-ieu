# -*- coding: utf-8 -*-
"""
마음이음 AI 모델·가격 정책 덱 — 참고 템플릿(커넥티드모빌리티 AWS vs 사내서버)의
디자인 양식을 그대로 쓰고 내용만 교체한다.

레이아웃 재사용 매핑 (1:1)
  ref1 표지          → 표지
  ref2 3카드+푸터    → 01 한눈에 보는 결론
  ref3 표+사이드2    → 02 모델 선정 실측
  ref4 표+사이드1    → 03 최종 모델 배치·턴당 원가
  ref5 4색카드       → 04 타사 사용량 벤치마크
  ref6 표+스탯3      → 05 타사 가격·무료 상한
  ref7 가로막대      → 06 사용량별 월 원가
  ref8 2관점         → 07 가격안 두 가지
  ref9 4블록+흐름    → 08 결론·권장
"""
import copy
from pptx import Presentation
from pptx.util import Emu
from pptx.dml.color import RGBColor
from pptx.util import Pt

SRC = "docs/.pricing-deck-template.pptx"
OUT = "docs/마음이음_AI모델_가격정책_2026-10-01.pptx"
IN = 914400  # EMU per inch


# ── 텍스트 교체 헬퍼 ────────────────────────────────────────────────────────
def set_lines(shape, lines):
    """문단 단위 교체. 첫 run의 서식을 유지하고 나머지 run은 제거한다.
    문단 수가 모자라면 마지막 문단을 복제하고, 남으면 제거한다."""
    tf = shape.text_frame
    while len(tf.paragraphs) < len(lines):
        tf._txBody.append(copy.deepcopy(tf.paragraphs[-1]._p))
    while len(tf.paragraphs) > len(lines):
        tf._txBody.remove(tf.paragraphs[-1]._p)
    for p, line in zip(tf.paragraphs, lines):
        runs = p.runs
        if not runs:
            continue
        runs[0].text = line
        for r in runs[1:]:
            r._r.getparent().remove(r._r)


def set_text(shape, text):
    set_lines(shape, text.split("\n"))


def set_cell(cell, text):
    set_lines(cell, [text])


def trim_rows(table, keep):
    """표 행 수를 keep으로 줄인다(아래에서부터 제거). 마지막 '합계' 행 서식을 쓰려면
    호출 전에 내용을 옮겨둘 것."""
    tbl = table._tbl
    while len(table.rows) > keep:
        tbl.remove(tbl.tr_lst[-2])  # 마지막(합계) 행 서식 보존: 그 위를 지운다


def bar(shape, label_shape, width_in, gap=0.15):
    """가로 막대 너비를 바꾸고 값 라벨을 막대 끝으로 옮긴다."""
    shape.width = Emu(int(width_in * IN))
    if label_shape is not None:
        label_shape.left = Emu(int((shape.left / IN + width_in + gap) * IN))


prs = Presentation(SRC)
S = prs.slides


# ══ 1. 표지 ═══════════════════════════════════════════════════════════════
s = S[0]
sh = {i: x for i, x in enumerate(s.shapes)}
# TextBox 18 = 제목(2문단, 2번째 문단에 강조 run)
title = [x for x in s.shapes if x.has_text_frame and "커넥티드" in x.text_frame.text][0]
tp = title.text_frame.paragraphs
tp[0].runs[0].text = "마음이음 AI 모델 선정 · 가격 정책"
# 2문단: "AWS vs " + "사내 서버"(파랑) + "(온프레미스)" → 강조 run 유지
r2 = tp[1].runs
if len(r2) >= 3:
    r2[0].text = "타사 비교 기반 "
    r2[1].text = "적정 가격 · 사용량"
    r2[2].text = " 산정"
else:
    set_lines(title, ["마음이음 AI 모델 선정 · 가격 정책", "타사 비교 기반 적정 가격 · 사용량 산정"])
for x in s.shapes:
    if not x.has_text_frame:
        continue
    t = x.text_frame.text.strip()
    if t.startswith("2026. 9. 23."):
        set_text(x, "2026. 10. 1.   ㅣ   실측 280시행 · 적응형 30턴 대화   ㅣ   타사 벤치마크 반영")


# ══ 2. 01 한눈에 보는 결론 ════════════════════════════════════════════════
s = S[1]
sh = list(s.shapes)
set_text(sh[7], "한눈에 보는 결론")
set_text(sh[9], "핵심 요약")
set_lines(sh[11], ["①", "모델은 확정됐다", "확인 턴만 3.8-flash", "지시 준수 56/56 (100%)", "턴당 9.6원"])
set_lines(sh[12], ["②", "우리는 '말벗' 사용량", "Replika 하루 70건", "클로바 케어콜 주 2회", "상한 없으면 원가 무한"])
set_lines(sh[13], ["③", "권장 가격", "무료 20턴 · 유료 50턴", "월 19,900원", "최악 가정에도 흑자"])
set_text(sh[14], "모델 최적화는 끝났고 남은 변수는 가격 — 업계 무료 상한(50~70건)과 우리 원가(턴당 9.6원)가 가격 하한을 결정한다")


# ══ 3. 02 모델 선정 실측 ══════════════════════════════════════════════════
s = S[2]
sh = list(s.shapes)
set_text(sh[6], "02")
set_text(sh[7], "모델 선정 — 지시 준수 전수 측정")
set_text(sh[9], "5모델 280시행")
tbl = sh[11].table
trim_rows(tbl, 9)
sh[11].top = Emu(int((sh[11].top / IN + 0.13) * IN))
rows = [
    ("모델", "지시 준수  ·  턴당 원가"),
    ("gemini-2.5-flash (기존)", "52/56 (93%)  ·  $0.0045"),
    ("gemini-3.1-flash-lite", "51/56 (91%)  ·  $0.0045"),
    ("gemini-3.5-flash-lite", "50/56 (89%)  ·  $0.0059"),
    ("gemini-3-flash-preview", "52/56 (93%)  ·  $0.0081"),
    ("gemini-3.8-flash (채택)", "56/56 (100%)  ·  $0.0097"),
    ("측정 규모", "5모델 × 7영역 × 8회 = 280시행"),
    ("판정 방법", "LLM 심판 3분류 (수행 / 다른질문 / 미수행)"),
]
for i, (a, b) in enumerate(rows):
    set_cell(tbl.rows[i].cells[0], a)
    set_cell(tbl.rows[i].cells[1], b)
set_cell(tbl.rows[8].cells[0], "채택")
set_cell(tbl.rows[8].cells[1], "gemini-3.8-flash — 인지 확인 턴 전용")
set_lines(sh[12], [
    "가장 중요한 발견",
    "비용 절감이 인지 선별을 껐다",
    "확인 턴 입력 토큰 +45% 지불하고",
    "인지 평가는 0건 — 로그에 실패 없음",
])
set_lines(sh[13], [
    "왜 '지시 준수'로 재는가",
    "문장 품질은 싼 모델도 통과한다",
    "깨지는 건 주입한 지시의 수행이고",
    "기능 누락이라 일반 지표에 안 잡힌다",
])
set_text(sh[14], "전 구간을 올리지 않고 확인 턴 20%만 3.8-flash로 — 비용 증가를 최소화하면서 선별 기능을 되살렸다")


# ══ 4. 03 최종 모델 배치 · 턴당 원가 ══════════════════════════════════════
s = S[3]
sh = list(s.shapes)
set_text(sh[6], "03")
set_text(sh[7], "최종 모델 배치 · 턴당 원가")
set_text(sh[9], "호출 지점별")
tbl = sh[11].table
rows = [
    ("호출 지점", "모델  ·  턴당"),
    ("동반자 — 수다 턴 (80%)", "2.5-flash"),
    ("동반자 — 인지 확인 턴 (20%)", "3.8-flash  ·  동반자 합 $0.0036"),
    ("분석기 1차 (선별 라우팅)", "2.5-flash"),
    ("분석기 정밀 채점", "3.8-flash  ·  분석기 합 $0.0033"),
    ("턴당 합계", "$0.0069  ≈  9.6원"),
]
for i, (a, b) in enumerate(rows):
    set_cell(tbl.rows[i].cells[0], a)
    set_cell(tbl.rows[i].cells[1], b)
sh[11].top = Emu(int((sh[11].top / IN + 0.13) * IN))
set_text(sh[12], "※ 적응형 30턴 대화 실측 · 환율 1,390원 기준 · 서버 TTS 비용 별도")
sh[13].fill.solid(); sh[13].fill.fore_color.rgb = RGBColor(0xEE, 0xF3, 0xFC)
set_lines(sh[13], [
    "적용한 최적화",
    "· 확인 턴만 상위 모델",
    "· 분석기 3.5→3.8 (정확도↑ 단가 ½)",
    "· 도메인별 프로토콜 슬라이싱 −7%",
    "· 암묵 캐시 적중 42% (입력 90% 할인)",
    "· 측정 오류 4건 교정 후 확정",
])
# 제목이 본문보다 흐려 위계가 뒤집혀 있었다 -> 다른 카드와 같은 파랑으로
for _r in sh[13].text_frame.paragraphs[0].runs:
    _r.font.color.rgb = RGBColor(0x2F, 0x6F, 0xD6)
set_text(sh[14], "⚠ 3.8-flash 도입가는 2026-12-31 종료 — 2027년 턴당 약 14.6원으로 오른다 (연말 전 재검토 필요)")


# ══ 5. 04 타사 사용량 벤치마크 ════════════════════════════════════════════
s = S[4]
sh = list(s.shapes)
set_text(sh[6], "04")
set_text(sh[7], "타사 AI 말벗 · 돌봄 사용량")
set_text(sh[9], "실사용 벤치마크")
set_text(sh[12], "Replika")
set_lines(sh[13], ["· 하루 약 70건", "· 세션 15분 (일부 2시간)", "· 유료 $19.99 / 월"])
set_text(sh[15], "Character.AI")
set_lines(sh[16], ["· 세션 17.4분", "· 하루 3.2세션", "· 유료 $9.99 / 월"])
set_text(sh[18], "클로바 케어콜")
set_lines(sh[19], [
    "· 주 2회 안부 전화",
    "· 통화당 약 1분 15초",
    "· 지자체 B2G · 5만명",
    "· 응답률 96%",
])
sh[21].fill.solid(); sh[21].fill.fore_color.rgb = RGBColor(0xA8, 0x79, 0x00)
set_text(sh[21], "효돌 (돌봄인형)")
set_lines(sh[22], ["· 상시 거치형 (횟수 무제한)", "· 대화+복약+인지퀴즈", "· 118개 지자체 5,800대", "· 만족도 80.1%"])
set_text(sh[23], "사용 패턴은 말벗 앱(70건/일), 수익 모델은 돌봄 서비스 — 이 조합이 가격 설계의 핵심 제약이다")


# ══ 6. 05 타사 가격 · 무료 상한 ═══════════════════════════════════════════
s = S[5]
sh = list(s.shapes)
set_text(sh[6], "05")
set_text(sh[7], "타사 가격 · 무료 상한")
set_text(sh[9], "업계 관행")
tbl = sh[11].table
sh[11].top = Emu(int((sh[11].top / IN + 0.13) * IN))
rows = [
    ("서비스", "무료 상한  ·  유료"),
    ("Talkie", "하루 50건"),
    ("Chai", "하루 약 70건 · $13.99"),
    ("Character.AI", "무제한 · $9.99"),
    ("Replika", "소형 모델 · $19.99"),
    ("마음이음 (제안)", "무료 20턴 · 유료 50턴 / 19,900원"),
]
for i, (a, b) in enumerate(rows):
    set_cell(tbl.rows[i].cells[0], a)
    set_cell(tbl.rows[i].cells[1], b)
set_text(sh[12], "→ 마음이음 제안은 업계 하단 — 무료 20턴 · 유료 50턴")
set_lines(sh[13], ["업계 무료 상한", "하루 50~70건", "Talkie 50 · Chai 70"])
set_lines(sh[14], ["업계 유료 가격", "$9.99 ~ $19.99", "월 14,000~28,000원"])
set_lines(sh[15], ["우리 실측 — 표본 부족", "하루 26턴", "실사용 6계정 · 8일분 (p75 34)"])
set_text(sh[16], "※ 타사는 대화 모델만 돌리지만 우리는 매 턴 인지 분석기가 함께 돈다 — 같은 턴 수라도 원가가 높다. 타사의 '건'은 사용자 메시지 1건으로 우리 '턴'과 같은 단위다. ⚠ 우리 수치는 표본이 8 사용자-일(6계정)에 불과하다 — 이전 집계(중앙값 15턴)는 자동화 테스트 계정 311개가 실사용자로 섞여 있었고, 걸러내니 전체 발화의 97%가 테스트였다(2026-10-02 정정). 따라서 상한은 우리 데이터가 아니라 업계 벤치마크를 근거로 정해야 한다.")


# ══ 7. 06 사용량별 월 원가 ════════════════════════════════════════════════
s = S[6]
sh = list(s.shapes)
set_text(sh[6], "06")
set_text(sh[7], "사용량별 1인 월 원가")
set_text(sh[9], "턴당 9.6원 기준")
set_lines(sh[12], ["하루 70턴", "Replika 실사용 평균"])
# 막대1의 2행만 제목 서식이라 캡션으로 안 읽혔다 -> 2·3행과 같은 회색 소형으로
for _r in sh[12].text_frame.paragraphs[1].runs:
    _r.font.bold = False; _r.font.size = Pt(12); _r.font.color.rgb = RGBColor(0x85, 0x85, 0x85)
set_text(sh[14], "20,160원")
set_lines(sh[15], ["하루 50턴", "Talkie 무료 상한"])
set_text(sh[17], "14,400원")
set_lines(sh[18], ["하루 20턴", "권장 무료 상한"])
set_text(sh[20], "5,760원")
# 막대 길이 재계산 — 최대값(20,200원)을 6.0inch에 맞춘다
scale = 6.0 / 20160
bar(sh[13], sh[14], 20160 * scale)
bar(sh[16], sh[17], 14400 * scale)
bar(sh[19], sh[20], 5760 * scale)
sh[21].top = Emu(int((sh[21].top / IN - 0.25) * IN))
set_text(sh[21], "Play 수수료 15%를 뗀 수령액이 이 원가를 넘어야 한다 — 가격의 하한선을 결정하는 수치")


# ══ 8. 07 가격안 두 가지 ══════════════════════════════════════════════════
s = S[7]
sh = list(s.shapes)
set_text(sh[6], "07")
set_text(sh[7], "가격안 — 두 가지 시나리오")
set_text(sh[9], "월 단위 수지")
set_text(sh[12], "최대 원가 — 동반자")
set_text(sh[14], "최대 원가 — 분석기")

s8 = 7.0 / 20000  # 1원당 inch

# 안 A
set_text(sh[16], "안 A · 보급형 (월 9,900원 / 하루 30턴)")
set_text(sh[17], "→ 진입 쉬움, 최악 가정에선 −225원 (≈ 손익분기)")
set_lines(sh[19], ["수령액", "9,900원 − 수수료 15%"])
bar(sh[20], sh[21], 8415 * s8)
set_text(sh[21], "8,415원")
set_lines(sh[22], ["최대 원가", "하루 30턴 × 30일"])
set_text(sh[23], "4,458")
set_text(sh[24], "4,182")
sh[23].width = Emu(int(4458 * s8 * IN))
sh[24].left = Emu(int((sh[23].left / IN + 4458 * s8) * IN))
sh[24].width = Emu(int(4182 * s8 * IN))
sh[25].left = Emu(int((sh[24].left / IN + 4182 * s8 + 0.15) * IN))
set_text(sh[25], "8,640원")

# 안 B
set_text(sh[27], "안 B · 표준형 (월 19,900원 / 하루 50턴)")
set_text(sh[28], "→ Replika 동급 가격 · 최악 가정에도 +2,515원 흑자")
set_lines(sh[30], ["수령액", "19,900원 − 수수료 15%"])
bar(sh[31], sh[32], 16915 * s8)
set_text(sh[32], "16,915원")
set_lines(sh[33], ["최대 원가", "하루 50턴 × 30일"])
set_text(sh[34], "7,430")
set_text(sh[35], "6,970")
sh[34].width = Emu(int(7430 * s8 * IN))
sh[35].left = Emu(int((sh[34].left / IN + 7430 * s8) * IN))
sh[35].width = Emu(int(6970 * s8 * IN))
sh[36].left = Emu(int((sh[35].left / IN + 6970 * s8 + 0.15) * IN))
set_text(sh[36], "14,400원")
set_text(sh[37], "※ '최대 원가'는 상한을 매일 끝까지 쓰는 최악 가정. 정정된 실측 중앙값(하루 26턴, 표본 8일)이면 원가 7,488원으로 두 안 모두 흑자지만 안 A의 여유는 927원뿐이다. "
                 "안 A는 사용량이 늘수록 적자로 돌아서고, 안 B는 상한까지 써도 2026년 단가에선 흑자다. "
                 "⚠ 2027년 단가(턴당 14.6원)에서는 안 B의 최대 원가가 21,900원이 되어 역전된다 — 연말 전 모델 재검토가 이 가격의 전제다.")


# ══ 9. 08 결론 · 권장 ═════════════════════════════════════════════════════
s = S[8]
sh = list(s.shapes)
set_text(sh[6], "08")
set_text(sh[7], "결론 · 권장")
set_text(sh[9], "판단")
sh[12].fill.solid(); sh[12].fill.fore_color.rgb = RGBColor(0x3E, 0x7E, 0xE7)
set_lines(sh[13], ["모델", "확정 — 확인 턴 3.8-flash · 턴당 9.6원"])
_tf = sh[13].text_frame
for _r in _tf.paragraphs[0].runs: _r.font.color.rgb = RGBColor(0x3F, 0x80, 0xED)
for _r in _tf.paragraphs[1].runs:
    _r.font.color.rgb = RGBColor(0x11, 0x11, 0x11); _r.font.bold = True
set_lines(sh[16], ["무료 상한", "하루 20턴 — 업계(50~70) 하단 · 자체 표본 부족"])
set_lines(sh[19], ["유료", "월 19,900원 · 하루 50턴 — 최악에도 흑자"])
set_lines(sh[22], ["런칭 전략", "보급형(9,900원 · 30턴) 프로모션 → 표준형 전환"])
set_text(sh[23], "① 가격 확정  →  ② Play 구독 상품 생성  →  ③ 서비스 계정 · RTDN  →  ④ 라이선스 테스터 실결제  →  ⑤ 유료 전환 ON")


# ══ 10. 09 원가 추가 절감 — 실측 A/B ═══════════════════════════════════════
#   덱을 만든 뒤 수행한 실측(2026-10-01)을 결론으로 덧붙인다. ref2(3카드+푸터) 레이아웃 재사용.
s = S[9]
sh = list(s.shapes)
set_text(sh[6], "09")
set_text(sh[7], "원가 추가 절감 — 실측 A/B")
set_text(sh[9], "측정 완료")
set_text(sh[10], "10")   # 복제 원본(2p)의 쪽번호가 남아 있었다
set_lines(sh[11], [
    "①",
    "안 쓰던 캐시가 있었다",
    "구현은 돼 있었지만",
    "한 번도 켠 적이 없었다",
    "입력 적중 18% → 86%",
])
set_lines(sh[12], [
    "②",
    "토큰 비용 −17%",
    "동일 6턴 A/B 실측",
    "턴당 10원 → 8원",
    "모델·프롬프트 동일 = 품질 동일",
])
set_lines(sh[13], [
    "③",
    "단, 조건부다",
    "저장·생성료를 반영하면",
    "손익분기 10분당 3.4턴",
    "서버리스 공유 수정이 선행",
])
set_text(sh[14], "품질을 건드리지 않고 원가를 더 낮출 여지가 있다 — 남은 레버 7건(분석기 thinking·2단 라우팅·일 1회 배치 등)은 품질 검증 통과분만 적용")

prs.save(OUT)
print("saved:", OUT)
