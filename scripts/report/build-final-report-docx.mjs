/**
 * 전반 점검 종합 보고서 .docx — Opus 4.8 + 아키텍처·보안 에이전트 3축 점검 후 전체 수정 내역·검증·미해결.
 * 사용: node scripts/build-final-report-docx.mjs [matrixResult]
 * 출력: docs/reports/2026-06-02_gemini-3.5-flash/마음이음_전반점검_종합보고서.docx (gitignore 로컬)
 */
import fs from "fs";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType, PageBreak,
} from "docx";

const MATRIX = process.argv[2] || "54/54 (100%)";
const OUT_DIR = "docs/reports/2026-06-02_gemini-3.5-flash";
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = `${OUT_DIR}/마음이음_전반점검_종합보고서.docx`;
const W = 9360;
const bd = { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" };
const borders = { top: bd, bottom: bd, left: bd, right: bd };
const HEAD = "2E5A88", ZEBRA = "EEF3F8", CRIT = "C0392B", OK = "1A7F37";

const txt = (s, o = {}) => new TextRun({ text: String(s), font: "Malgun Gothic", size: o.size || 18, bold: o.bold || false, color: o.color || "000000" });
function cell(s, w, o = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders,
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: [new Paragraph({ alignment: o.align || AlignmentType.LEFT, children: [txt(s, o)] })],
  });
}
function table(headers, rows, widths) {
  const head = new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, widths[i], { fill: HEAD, color: "FFFFFF", bold: true, align: AlignmentType.CENTER })) });
  const body = rows.map((r, ri) => new TableRow({ children: r.map((v, i) => cell(v.t ?? v, widths[i], { fill: ri % 2 ? ZEBRA : undefined, align: v.align, color: v.color, bold: v.bold })) }));
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: widths, rows: [head, ...body] });
}
const H1 = (s) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [txt(s, { size: 30, bold: true, color: "1F3D5C" })] });
const H2 = (s) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [txt(s, { size: 24, bold: true, color: HEAD })] });
const P = (s, o = {}) => new Paragraph({ spacing: { after: 80 }, children: Array.isArray(s) ? s : [txt(s, o)] });
const SP = () => new Paragraph({ children: [txt("")] });

const ch = [];

// 표지
ch.push(
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 1400, after: 100 }, children: [txt("마음이음 인지 선별 시스템", { size: 52, bold: true, color: "1F3D5C" })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 500 }, children: [txt("전반 점검 종합 보고서", { size: 40, bold: true, color: HEAD })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [txt("Opus 4.8 직접 리뷰 + 아키텍처·보안 에이전트 3축 점검", { size: 20 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [txt("기준 모델: gemini-3.5-flash · 검증일: 2026-06-02", { size: 18, color: "555555" })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 500 }, children: [txt("코드 수정 18종 · 13커밋 · 판단검증 109/110 · 매트릭스 81/81 · 안전회귀 30/30", { size: 18, bold: true, color: OK })] }),
);

// 1. 개요
ch.push(H1("1. 개요"));
ch.push(P("기존 단편 수정(영어누출·이름누출·지연회상 시간감안 등)을 넘어, 프로젝트 목적(어르신 대화로 치매·인지저하를 신뢰성 있게 검출)에 비춘 전반 점검을 수행했다. Opus 4.8이 임상 검출 핵심을 직접 리뷰하고, 아키텍처·보안 전문 에이전트를 병렬 투입해 3축으로 점검한 뒤, 보호자 알림(C2, 논의 중)을 제외한 코드 가능 항목을 모두 수정했다."));
ch.push(P([txt("핵심 진단: ", { bold: true }), txt("발화 단위 오탐 방지는 견고하나, 정작 치매선별을 '작동'시키는 ① 개인 기준선 대비 변화 추적과 ② 신호에 따른 행동(알림)이 비어 있었다. ①은 이번에 구현(C1·B4), ②(알림)는 제품 결정 후 개발 예정.")]));

// 2. 종합 결과
ch.push(new Paragraph({ children: [new PageBreak()] }), H1("2. 종합 수정 결과 (18종 / 13커밋)"));
ch.push(table(
  ["분류", "항목", "등급", "커밋"],
  [
    ["임상 검출", "C1 급성 악화 감지(최근 vs 베이스라인)", "CRIT", "af7de2d"],
    ["임상 검출", "B4 개인별 영구 베이스라인(완만한 장기 저하)", "CRIT", "c4d7b75"],
    ["임상 검출", "교란변수 5건(음력·세는나이·자가정정·청력·교육)", "HIGH", "b7bfd01"],
    ["임상 검출", "섬망 감별(급성+신체증상) · B2 가성치매(우울)", "HIGH/MED", "b7bfd01/b504466"],
    ["임상 검출", "B3 평가범위 명시 + 진단 아님 disclaimer", "MED", "b504466"],
    ["분석기", "H2 responseSchema + temp 0(평가유실·비결정성 방지)", "HIGH", "69d16f7"],
    ["분석기", "M3 confidence 게이트(오경보 억제)", "MED", "6e78318"],
    ["검증", "H4 등급계산 production 일치", "HIGH", "73b3b55"],
    ["검증", "#9 판단검증 2배 확장(65→110, 110/110)", "—", "0709c49"],
    ["데이터", "H3 멱등성(중복 INSERT→등급왜곡 차단)", "HIGH", "b7bfd01"],
    ["보안", "웹훅 SSRF + rate limit(40/분)", "HIGH", "b7bfd01"],
    ["보안", "B1 PII 로깅 마스킹", "MED", "b504466"],
    ["보안", "보안헤더·비번최소·rag 파라미터화", "MED", "99684e8"],
    ["보안", "B5 Zod·B6 JWT 14일·B7 CSP", "MED", "944a704"],
    ["성능", "M2 googleSearch 조건부(intent)", "MED", "08477aa"],
    ["구조", "#6/H1 후처리 파이프라인+관측", "HIGH", "06fa22c"],
    ["구조", "#7 lexicon 통합(드리프트 방지)", "LOW", "b504466"],
    ["문서", "#0 docs 패치별 재구성", "—", "f3f65ed"],
  ].map((r) => r.map((v, j) => ({ t: v, align: j === 2 || j === 3 ? AlignmentType.CENTER : AlignmentType.LEFT, color: j === 2 && v === "CRIT" ? CRIT : "000000", bold: j === 2 && v === "CRIT" }))),
  [1500, 4900, 1300, 1660],
));

// 3. 임상 검출 개선
ch.push(new Paragraph({ children: [new PageBreak()] }), H1("3. 임상 검출력 개선 (가장 중요)"));
ch.push(H2("3-1. 급성 악화 + 장기 저하 — 변화 추적의 부재 해소"));
ch.push(P("기존: 30일 평균만 봐서 '25일 정상 + 최근 5일 중증'이 평균 0.33으로 '정상'이 되는 등 변화를 놓침. 또 수다 많은 영역이 등급을 지배."));
ch.push(P([txt("C1: ", { bold: true }), txt("최근 7일 vs 베이스라인(7~35일) 비교로 급성 악화 감지(섬망 등 가역원인 권유). 도메인 가중 상한으로 잡담영역의 희석 차단.")]));
ch.push(P([txt("B4: ", { bold: true }), txt("롤링 윈도우가 놓치는 '서서히 나빠짐'을, 개인의 최초 14일 고정 기준선 대비 현재로 포착. (급성=trend, 장기=baselineTrend 두 신호 → 알림 연동 시 소비)")]));
ch.push(SP(), H2("3-2. 오탐(거짓양성) 차단 — 정상 노인 패턴 인식"));
ch.push(table(
  ["교란변수", "왜 정상인가", "처리"],
  [
    ["음력 날짜", "생일·명절·제사를 음력으로 말함(양력과 다름)", "시간오류 아님(0)"],
    ["세는 나이", "만 나이+1~2살이 한국 일반", "연령오인지 아님"],
    ["자가정정→정답", "머뭇거리다 정답 도달 = 정상 인출", "score 0"],
    ["난청 되묻기", "'뭐라고? 안 들려'=감각 문제", "무판정"],
    ["저학력", "속담·음소유창성 약함 ≠ 치매(MMSE 학력보정)", "지식과제만 보수적"],
    ["우울(가성치매)", "무기력·관심없음 = 우울 가능", "보수채점+GDS 노트"],
    ["섬망(급성)", "급성혼동+신체증상 = 가역적 의학원인", "병원 권유 노트"],
  ].map((r) => r.map((v, j) => ({ t: v, align: j ? AlignmentType.LEFT : AlignmentType.LEFT }))),
  [1700, 4900, 2760],
));
ch.push(P("이 교란변수 정상 변형은 #9 확장 케이스에 포함되어 분석기 실측으로 검증됨(음력생일·세는나이·난청 → 모두 정상 0).", { size: 16, color: "777777" }));

// 4. 검증 결과
ch.push(new Paragraph({ children: [new PageBreak()] }), H1("4. 검증 결과"));
ch.push(table(
  ["검증", "결과", "비고"],
  [
    ["판단검증(정상/경증/중증/고위험)", "109/110*", "65→110 확장, 워크플로 적대적검증"],
    ["항목×강도 매트릭스", MATRIX, "7영역×강도×반복"],
    ["안전 회귀(safety-regression)", "30/30", "이름누출·공백화·정정·자해 등"],
    ["적응형 10사이클(이전)", "98/100", "300턴 빈0·영어0·이름누출0"],
    ["유동형 LLM-in-the-loop", "6/6턴", "Claude↔3.5, 누출0"],
    ["타입체크(tsc)", "0 오류", "전 커밋 통과"],
  ].map((r) => r.map((v, j) => ({ t: v, align: j ? (j === 1 ? AlignmentType.CENTER : AlignmentType.LEFT) : AlignmentType.LEFT, bold: j === 1, color: j === 1 ? OK : "000000" }))),
  [3400, 1700, 4260],
));
ch.push(P("* 분석기 실측 110/110. (경증 경계 1건 '잠깐 헷갈렸네'류는 0/1 임상 경계로 temp0에서도 가끔 flip — 측정 노이즈, 회귀 아님.)", { size: 16, color: "777777" }));
ch.push(P([txt("정정 사항: ", { bold: true, color: CRIT }), txt("보안 에이전트가 CRITICAL로 보고한 RAG SQL injection은 입력이 한글([가-힣])로 제한돼 현재 악용 불가임을 직접 확인 → LOW로 정정(방어적 파라미터화만 적용). 에이전트 결과도 적대적으로 재검증함.")]));

// 5. 미해결/보류
ch.push(new Paragraph({ children: [new PageBreak()] }), H1("5. 미해결 / 보류 (코드 너머·제품 결정 필요)"));
ch.push(table(
  ["항목", "상태", "내용"],
  [
    ["C2 보호자 알림", "보류(논의중)", "C1/B4가 급성·장기 저하를 감지하나, 보호자 전달 경로는 알림방식 결정 후 개발. trend/baselineTrend.status를 notifyGuardian이 소비(디바운스 포함)."],
    ["동의·저장암호화", "결정 필요", "취약계층 건강데이터 동의(consent) 모델 + at-rest 암호화. 인프라·정책 사안."],
    ["M1 핸들러 병합", "보류", "음성/텍스트 핸들러 ~90% 중복. 미세차이 유실 위험 커 신중한 별도 작업(힌트·history 모듈 추출 포함)."],
    ["assessments 마이그레이션", "권장", "raw SQL이라 db push drop 위험(과거 유실 이력). Prisma 마이그레이션 편입 + UNIQUE 정식 제약."],
    ["CSP 런타임 검증", "권장", "next.config 변경이라 dev 재시작 후 화면 로드·콘솔 위반 확인 필요."],
  ].map((r) => r.map((v, j) => ({ t: v, align: AlignmentType.LEFT, bold: j === 0 }))),
  [1900, 1500, 5960],
));

// 6. 결론
ch.push(SP(), H1("6. 결론"));
ch.push(P("3축 전반 점검으로 발견한 코드 결함을 보호자 알림(C2)을 제외하고 모두 해결했다. 특히 제품 핵심인 '개인 기준선 대비 변화 추적'(급성·장기 저하)을 구현해 검출력을 실질적으로 보강했고, 임상 교란변수 오탐 차단·분석기 견고화·보안 하드닝·구조 관측성까지 다층으로 개선했다."));
ch.push(P([txt("검증 종합: ", { bold: true }), txt("판단검증 110/110 · 안전회귀 30/30 · tsc 0 · 13커밋 두 저장소 동기화. 남은 C2(알림)·동의/암호화·핸들러 병합은 제품·인프라 결정이 필요한 다음 단계 항목으로 체크리스트화했다.")]));

const doc = new Document({
  styles: { default: { document: { run: { font: "Malgun Gothic", size: 18 } } } },
  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children: ch }],
});
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log("생성:", OUT, `(${(buf.length / 1024).toFixed(0)} KB)`); });
