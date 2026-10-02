/**
 * 도움말 역할 분기 테스트 — 각 역할이 자기 안내만 받는지, 안내 문구가 실제 동작과 맞는지.
 *
 * 성격: 단위 테스트(화이트박스 — 세션을 주입해 역할 분기 커버)
 *
 * 왜 필요한가: 안내 문구와 실제 동작이 어긋나면 어르신은 앱이 고장났다고 판단한다
 *   (호출어 문구 ↔ 동작 불일치 실기기 결함 이력, 2026-07-07). 역할이 섞이면
 *   보호자에게 "상세 평가내역을 볼 수 있다"고 안내하는 식의 프라이버시 오안내가 된다.
 *
 * 렌더링: 서버 컴포넌트를 직접 호출해 반환된 엘리먼트 트리에서 텍스트만 수집한다
 *   (react-dom/server는 async 컴포넌트를 renderToStaticMarkup으로 처리하지 못함).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let currentSession: { user: { id: string; screeningMode: string } } | null = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => currentSession) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

let companionName: string | null = "민지";
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn(async () => ({ companionName })) } },
}));

/** JSX 트리에서 보이는 텍스트만 재귀 수집 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as { props?: { children?: unknown } };
  return el.props ? textOf(el.props.children) : "";
}

async function renderHelp(screeningMode: string | null) {
  currentSession = screeningMode ? { user: { id: "u1", screeningMode } } : null;
  vi.resetModules();
  const mod = await import("@/app/help/page");
  return textOf(await (mod.default as () => Promise<unknown>)());
}

beforeEach(() => { companionName = "민지"; });

describe("어르신(user) 안내", () => {
  it("음성 동선 — 시작·호출어·종료·재개가 모두 적혀 있다", async () => {
    const t = await renderHelp("user");
    expect(t).toContain("큰 파란 버튼");
    expect(t).toContain("그만");
    expect(t).toContain("다시 대화하기");
    expect(t).toContain("119");
  });

  it("호출어가 설정한 동반자 이름을 따라간다 — 민지 → \"민지야\"", async () => {
    const t = await renderHelp("user");
    expect(t).toContain("민지야"); // 🔒 종성 없는 이름은 "야" (코드: hasJongseong)
    expect(t).toContain("마음아"); // 유니버설 호출어는 항상 유지
  });

  it("종성 있는 이름은 \"아\" — 수진 → \"수진아\"", async () => {
    companionName = "수진";
    const t = await renderHelp("user");
    expect(t).toContain("수진아");
    expect(t).not.toContain("수진야");
  });

  it("동반자 이름이 없으면 기본값으로 안내한다", async () => {
    companionName = null;
    const { COMPANION_DEFAULTS } = await import("@/lib/chat/constants");
    const t = await renderHelp("user");
    expect(t).toContain(COMPANION_DEFAULTS.name);
  });

  it("하루 분량 종료를 고장으로 오해하지 않게 미리 알린다", async () => {
    const t = await renderHelp("user");
    expect(t).toContain("내일 또 만나");
    expect(t).toContain("고장이 아니");
    // 어르신 화면에 기술·제재 어휘를 쓰지 않는다
    for (const bad of ["제한", "초과", "한도", "토큰", "오류", "API"]) expect(t).not.toContain(bad);
  });

  it("대화 원문이 비공개임을 알린다", async () => {
    const t = await renderHelp("user");
    expect(t).toContain("보이지 않");
  });

  it("전문가·보호자 안내는 섞이지 않는다", async () => {
    const t = await renderHelp("user");
    expect(t).not.toContain("초대 코드");
    expect(t).not.toContain("검진 문항지");
    expect(t).not.toContain("PHQ-9");
  });
});

describe("보호자(guardian) 안내", () => {
  it("연결·알림 절차가 있다", async () => {
    const t = await renderHelp("guardian");
    expect(t).toContain("초대 코드");
    expect(t).toContain("보호자·전문가 연결");
    expect(t).toContain("위급 알림");
  });

  it("볼 수 없는 것을 명시한다 — 동의서 §4 경계와 일치", async () => {
    const t = await renderHelp("guardian");
    // 🔒 "볼 수 있다"고 오안내하면 프라이버시 약속을 깨뜨린다(authz-roles.test.ts가 실제 경계를 고정)
    expect(t).toContain("공개되지 않");
    expect(t).toMatch(/원문/);
    expect(t).toMatch(/상세 평가내역/);
  });

  it("알림이 보조 수단임을 알린다 — 앱에 응급 대응을 의존하지 않게", async () => {
    const t = await renderHelp("guardian");
    expect(t).toContain("119");
    expect(t).toMatch(/응급 대응 수단이 아닙니다/);
  });

  it("어르신용 음성 안내는 섞이지 않는다", async () => {
    const t = await renderHelp("guardian");
    expect(t).not.toContain("마음아");
    expect(t).not.toContain("지금 대화하기");
  });
});

describe("의사(pro) 안내", () => {
  it("검진 절차와 문항지 위치가 있다", async () => {
    const t = await renderHelp("pro");
    expect(t).toContain("검진");
    expect(t).toContain("문항지");
    expect(t).toContain("미채점");
  });

  it("일상 대화 원문은 의사에게도 비공개임을 밝힌다", async () => {
    const t = await renderHelp("pro");
    expect(t).toMatch(/일상 대화 원문은 의사에게도 공개되지 않/);
  });

  it("선별이지 진단이 아님을 명시한다", async () => {
    const t = await renderHelp("pro");
    expect(t).toMatch(/진단이 아/);
  });
});

describe("일반인(general) 안내", () => {
  it("검사 시작 방법과 결과 열람 범위가 있다", async () => {
    const t = await renderHelp("general");
    expect(t).toContain("우울 검사");
    expect(t).toContain("본인만");
  });

  it("인지 선별 비대상임을 밝힌다", async () => {
    const t = await renderHelp("general");
    expect(t).toMatch(/인지 선별 대상이 아/);
  });

  it("환자 관리·검진 안내는 섞이지 않는다", async () => {
    const t = await renderHelp("general");
    expect(t).not.toContain("초대 코드");
    expect(t).not.toContain("문항지");
  });
});

describe("비로그인", () => {
  it("역할 미상은 어르신 안내로 떨어진다 — 빈 화면을 보여주지 않는다", async () => {
    const t = await renderHelp(null);
    expect(t).toContain("119");
    expect(t.length).toBeGreaterThan(100);
  });
});

/**
 * 어르신 마이크 실패 시 텍스트 탈출구가 존재하는가 (2026-10-02 발견).
 *
 * 결함: app/chat/page.tsx의 '글씨로 대화하기' 버튼이 `screeningMode !== "user"`로 감싸져 있어
 *   어르신에게는 **항상** 숨겨져 있었다. 그런데 바로 아래 micDenied 안내문은
 *   "'글씨로 대화하기'를 눌러 텍스트로 대화할 수도 있어요"라고 말한다.
 *   textOnly로 가는 다른 입구('글씨 대화로 전환')는 대화가 시작된 화면 안에 있어,
 *   대화를 시작하지 못하는 이 상태에서는 닿을 수 없다 → 어르신이 앱을 전혀 못 쓴다.
 *   이 제품의 1차 사용자가 그 어르신이고, 마이크 권한 거부는 흔한 실패다.
 */
describe("어르신 마이크 실패 탈출구", () => {
  it("micDenied면 어르신에게도 '글씨로 대화하기'가 보인다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/chat/page.tsx", "utf-8");
    // 🔒 `screeningMode !== "user" &&`로 되돌아가면 어르신이 다시 막다른 길에 갇힌다
    expect(src).toMatch(/\(screeningMode !== "user" \|\| micDenied\) && \(/);
    // '모드 선택 화면' 블록만 본다 — 대화 중 '글씨 대화로 전환'은 별개이고, 거기선 어르신도
    //   "또는 글씨로 입력하세요." 입력창을 쓸 수 있어 막다른 길이 아니다.
    const selectIdx = src.indexOf("음성으로 대화하기");
    expect(selectIdx).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, selectIdx - 1500), selectIdx + 1500);
    expect(block, "모드 선택 화면의 텍스트 버튼이 user에게 무조건 숨겨지면 안 된다")
      .not.toMatch(/\{screeningMode !== "user" && \(/);
  });

  it("안내문이 가리키는 버튼이 같은 화면에 실재한다", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/chat/page.tsx", "utf-8");
    const guideIdx = src.indexOf("를 눌러 텍스트로 대화할 수도 있어요");
    expect(guideIdx).toBeGreaterThan(-1);
    // 안내문과 버튼이 같은 '모드 선택 화면' 블록 안에 있어야 한다 — 버튼이 먼저 나온다
    const btnIdx = src.lastIndexOf("글씨로 대화하기", guideIdx);
    expect(btnIdx, "안내문보다 앞에 버튼이 있어야 한다").toBeGreaterThan(-1);
    // 그 버튼이 user 모드에서도 렌더될 조건인지
    const gateIdx = src.lastIndexOf("screeningMode !== \"user\"", btnIdx);
    expect(src.slice(gateIdx, btnIdx)).toContain("micDenied");
  });
});
