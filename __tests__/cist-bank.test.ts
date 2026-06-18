/** CIST 문항 뱅크 무결성 — 배점·음성 시행 플래그·가이드 렌더 단일 출처 검증 */
import { describe, it, expect } from "vitest";
import { CIST_ITEMS, VOICE_MAX_POINTS, renderProtocolForGuide, CIST_DOMAIN_ORDER } from "@/lib/screening/cist-bank";

describe("CIST 문항 뱅크", () => {
  it("음성 시행 만점 = 29점 (시공간 제외)", () => {
    expect(VOICE_MAX_POINTS).toBe(29);
  });
  it("시공간(구성)은 음성 미시행(voice=false)", () => {
    const vs = CIST_ITEMS.filter((i) => i.domain === "visuospatial");
    expect(vs.length).toBeGreaterThan(0);
    expect(vs.every((i) => !i.voice)).toBe(true);
  });
  it("모든 항목의 domain이 도메인 순서에 정의됨", () => {
    const known = new Set(CIST_DOMAIN_ORDER.map((d) => d.domain));
    expect(CIST_ITEMS.every((i) => known.has(i.domain))).toBe(true);
  });
  it("모든 항목에 근거 도구(source)와 채점 기준(scoring) 존재", () => {
    expect(CIST_ITEMS.every((i) => i.source.length > 0 && i.scoring.length > 0)).toBe(true);
  });
  it("가이드 렌더: 음성 영역 포함, 시공간 제외", () => {
    const g = renderProtocolForGuide();
    expect(g).toContain("시간 지남력");
    expect(g).toContain("동물 이름");
    expect(g).not.toContain("시계를 그리고"); // 시공간 음성 미시행은 가이드에서 제외
  });
});
