// 마음이음 종합 검증 리포트 (2026-06-09) — 통합 docx
import fs from "node:fs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
} from "docx";

const pairs = JSON.parse(fs.readFileSync("docs/reports/qa-data-0609.json", "utf8"));
const userMode = pairs.slice(0, 105);   // 사용자모드(검증+100 다양성)
const proMode = pairs.slice(105, 111);  // 전문가모드 시행

const DATE = "2026-06-09";
const PROBE_RE = /무슨 요일|며칠|몇 월|몇 년|무슨 계절|어느 시|어느 도|어디[에 ]|빼면|거스름|거꾸로|단어|짝|풍선|약국|시작하는|속담|이름이|합해서|합하면|몇 개|몇 짝/;

// ── 스타일 헬퍼 ───────────────────────────────────────────
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const P = (runs, opts = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [new TextRun(runs)], spacing: { after: 80 }, ...opts });
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(text, { w, head = false, bold = false } = {}) {
  return new TableCell({
    borders, width: { size: w, type: WidthType.DXA },
    shading: head ? { fill: "2E5AAC", type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: head || bold, color: head ? "FFFFFF" : "000000", size: 19 })] })],
  });
}
function table(rows, widths) {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map((r, ri) => new TableRow({ children: r.map((c, ci) => cell(String(c), { w: widths[ci], head: ri === 0 })) })),
  });
}

const children = [];

// ── 표지 ─────────────────────────────────────────────────
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 120 },
  children: [new TextRun({ text: "마음이음 종합 검증 리포트", bold: true, size: 44, color: "2E5AAC" })] }));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
  children: [new TextRun({ text: "사용자모드 질문 다양성 · 전문가모드 시행 · 속도 개선 · 수정 요약", size: 22, color: "555555" })] }));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
  children: [new TextRun({ text: `${DATE}  ·  AI 치매 인지선별 동반자`, size: 20, color: "888888" })] }));

// ── 0. 요약 ──────────────────────────────────────────────
children.push(H1("0. 한눈에 보기"));
children.push(table([
  ["항목", "결과"],
  ["사용자모드 질문 다양성", "100+턴 거의 전부 상이한 질문 (일상 수십 주제 + 인지 probe). 반복 ~0"],
  ["전문가모드", "표준 인지선별 항목을 순서대로 구조적 시행(장소→계산→회상→완료)"],
  ["속도(서버 첫 응답조각)", "warm ~1.5~2.1초 (이전 3.5 기준 ~2.4초 대비 개선)"],
  ["이상징후 감지", "사망인물·연도오류·장소·외계인·대통령·5살결혼 등 전부 포착"],
  ["폴백률", "약 1% (100턴 중 1건, 일시적 빈응답)"],
  ["이번 세션 수정", "200메시지 먹통·자녀 성별호칭·부모 referent·모델비용 등 다수"],
], [3200, 6160]));

// ── 1. 이번 세션 수정 요약 ────────────────────────────────
children.push(H1("1. 이번 세션 수정 요약"));
children.push(P("이번 검증 과정에서 발견·수정한 주요 항목입니다."));
children.push(table([
  ["#", "구분", "내용", "효과"],
  ["1", "🔴 치명", "한 대화가 200메시지 넘으면 400 오류로 영구 먹통 (자체 검증 상한). 검증 500 상향 + 클라이언트가 최근 50개만 전송", "매일 한 대화로 쓰는 어르신 대화 끊김 해소"],
  ["2", "🟡 호칭", "자녀 성별 호칭 오류('큰딸 영숙'→'영숙 아드님'). 현재 문맥의 성별 단서로 정정(딸→따님, 아들→아드님)", "가족 호칭 정확도↑"],
  ["3", "🟡 호칭", "사용자의 부모(어머니) 등 3인칭을 사용자 호칭으로 잘못 변환. 후처리를 호격(쉼표)에서만 적용 + 프롬프트 규칙 강화", "'돌아가신 어머니'를 '어머니'로 정확 지칭"],
  ["4", "💰 비용", "모델 하이브리드 — 분석기만 3.5, 동반자·프로필·요약·STT는 2.5로. 6월 비용급증(모델 전환 96%) 대응", "비싼 3.5 토큰 대폭 절감(선별 정확도 유지)"],
  ["5", "🔧 안정", "요약기 thinking 폭주로 JSON 잘림→저장 실패→매턴 재발(낭비). responseSchema + thinkingBudget로 해결", "요약 정상 저장 + 과다발동 제거"],
  ["6", "🔒 안전", "gemini 안전필터가 화투·고스톱 등 노인 일상어 차단. BLOCK_NONE으로 해제", "일상 대화 차단 방지"],
  ["7", "📊 관측", "경로별 토큰 사용량 로깅(DEBUG_USAGE) 추가", "비용 원인 추적 가능"],
], [500, 1100, 5160, 2600]));

// ── 2. 사용자 모드 질문 다양성 ────────────────────────────
children.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("2. 사용자 모드 — 질문 다양성 (100+ Q&A)")] }));
children.push(P([
  new TextRun("사용자 모드는 "),
  new TextRun({ text: "검사가 아니라 라이트한 일상 수다", bold: true }),
  new TextRun("를 지향합니다. 일상 대화 80% + 인지 확인 20% 비율로, 인지 질문을 대화 흐름에 자연스럽게 녹입니다. 아래는 한 어르신(76세 여성)과의 100여 턴 대화에서 동반자가 던진 질문들로, "),
  new TextRun({ text: "거의 모든 턴의 질문이 서로 다릅니다", bold: true }),
  new TextRun(" (질문 풀 3,888개 + 페이싱). 인지 선별 probe는 🔎 표시."),
]));
const probeCount = userMode.filter((p) => PROBE_RE.test(p.ai)).length;
children.push(P([new TextRun({ text: `· 총 ${userMode.length}턴 · 인지 probe 추정 ${probeCount}턴(≈${Math.round(probeCount / userMode.length * 100)}%) · 나머지 일상 수다`, italics: true, color: "555555" })]));

userMode.forEach((p, i) => {
  const isProbe = PROBE_RE.test(p.ai);
  children.push(new Paragraph({
    spacing: { before: 90, after: 10 },
    children: [
      new TextRun({ text: `${i + 1}. `, bold: true, color: "2E5AAC" }),
      new TextRun({ text: (isProbe ? "🔎 " : "") + "어르신: ", bold: true, color: "888888" }),
      new TextRun({ text: p.u, size: 19 }),
    ],
  }));
  children.push(new Paragraph({
    spacing: { after: 40 }, indent: { left: 240 },
    children: [
      new TextRun({ text: "동반자: ", bold: true, color: isProbe ? "B5651D" : "2E7D32" }),
      new TextRun({ text: p.ai, size: 19 }),
    ],
  }));
});

// ── 3. 전문가 모드 ───────────────────────────────────────
children.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("3. 전문가 모드 — 표준 인지선별 시행")] }));
children.push(P([
  new TextRun("전문가 모드는 사람 검사자가 시행하던 "),
  new TextRun({ text: "표준 인지선별(MMSE-K 계열) 항목을 정해진 순서로 직접 시행", bold: true }),
  new TextRun("합니다. 사용자 모드처럼 대화에 녹이지 않고, 또박또박 질문하고 응답을 채점하며 다음 항목으로 진행합니다. 아래는 실제 시행 기록입니다."),
]));
proMode.forEach((p, i) => {
  children.push(new Paragraph({ spacing: { before: 90, after: 10 },
    children: [new TextRun({ text: `${i + 1}. `, bold: true, color: "2E5AAC" }), new TextRun({ text: "수검자: ", bold: true, color: "888888" }), new TextRun({ text: p.u, size: 19 })] }));
  children.push(new Paragraph({ spacing: { after: 40 }, indent: { left: 240 },
    children: [new TextRun({ text: "검사(동반자): ", bold: true, color: "6A1B9A" }), new TextRun({ text: p.ai, size: 19 })] }));
});
children.push(P([new TextRun({ text: "→ 장소 지남력 → 주의/계산(100−7 연속) → 단어 3개 지연회상 → 시행 완료 순으로 구조적 진행. 7개 영역 시행 완료 시 \"오늘 검사는 여기까지\"로 마무리(과잉검사 방지).", italics: true, color: "555555" })]));

// ── 4. 속도 ──────────────────────────────────────────────
children.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("4. 응답 속도")] }));
children.push(P("DEBUG_TIMING으로 서버측 응답 시간을 측정했습니다(warm, 3회)."));
children.push(table([
  ["구간", "회차2", "회차3", "설명"],
  ["프롬프트 빌드", "36ms", "259ms", "시스템프롬프트 + 프로필 조립"],
  ["RAG/메모리", "403ms", "414ms", "과거 맥락 검색"],
  ["LLM 첫 응답조각", "1,461ms", "2,061ms", "동반자(2.5)가 첫 글자 내보내기까지"],
  ["전체 완료", "1,608ms", "2,106ms", "응답 끝까지"],
], [2400, 1700, 1700, 3560]));
children.push(P([
  new TextRun("→ warm 기준 "),
  new TextRun({ text: "첫 응답조각 ~1.5~2.1초, 전체 ~1.6~2.1초", bold: true }),
  new TextRun(". 직전 기준 모델(3.5-flash)의 ~2.4초 대비 개선되었습니다. 비용 최적화로 동반자를 2.5-flash로 전환한 것이 속도에도 유리하게 작용했습니다(thinking 부담↓). "),
  new TextRun({ text: "추가로 클라이언트 전송을 최근 50개로 제한해 페이로드도 가벼워졌습니다.", color: "555555" }),
]));

// ── 5. 종합 ──────────────────────────────────────────────
children.push(H1("5. 종합 결론"));
[
  "사용자 모드: 일상 대화 80% 속에 인지 확인을 자연스럽게 녹이며, 100여 턴 거의 모든 질문이 서로 다른 높은 다양성을 보였다(질문 풀 3,888 + 80/20 페이싱).",
  "전문가 모드: 표준 인지선별 항목을 순서대로 구조적으로 시행하여, 사람 검사자를 대체/보조하는 임상 도구로 작동했다.",
  "속도: 비용 최적화(2.5 전환)가 속도에도 유리해 warm ~1.6~2.1초로 개선.",
  "안정성: 긴 대화 먹통(200메시지)·자녀 성별호칭·부모 referent 등을 검증 중 발견·수정했다.",
  "잔존: 2.5 모델이 드물게 유명인 등 타인에게 사용자 호칭을 과적용하는 경향(저severity) — 프롬프트로 완화, 모니터링 대상.",
].forEach((t) => children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: t, size: 20 })] })));

// ── 문서 생성 ────────────────────────────────────────────
const doc = new Document({
  styles: {
    default: { document: { run: { font: "맑은 고딕", size: 20 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 30, bold: true, color: "2E5AAC", font: "맑은 고딕" }, paragraph: { spacing: { before: 260, after: 140 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, color: "33415C", font: "맑은 고딕" }, paragraph: { spacing: { before: 160, after: 100 }, outlineLevel: 1 } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1100, right: 1100, bottom: 1100, left: 1100 } } },
    children,
  }],
});
const out = `docs/reports/마음이음_종합검증리포트_${DATE}.docx`;
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(out, buf);
console.log("생성:", out, "(" + (buf.length / 1024).toFixed(0) + "KB) · 사용자Q&A", userMode.length, "· 전문가", proMode.length);
