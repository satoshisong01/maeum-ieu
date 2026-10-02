/**
 * Dockerfile **문법** 검증 — Docker 없이 파싱을 확인한다.
 *
 * 이 테스트가 없어서 실제로 **빌드 불가능한 Dockerfile을 커밋했다**(2026-10-02).
 *
 * 무슨 일이 있었나: `ENV NEXT_TELEMETRY_DISABLED=1   # 설명...` 처럼 **인자와 같은 줄**에
 *   주석을 달았다. `#`은 줄의 첫 글자일 때만 주석이라 이건 ENV의 인자가 되고
 *   ("can't find = in #"), 아래 줄 `BUILD_STANDALONE=1`은 연속 표시가 없어
 *   **명령어 없는 고아 줄** → "unknown instruction"이 됐다.
 *   그런데 dockerfile-contract.test.ts의 계약 13건은 전부 **텍스트 grep**이라 모두 녹색이었다 —
 *   `BUILD_STANDALONE=1`이라는 문자열이 파일 어딘가에 있기만 하면 통과했기 때문이다.
 *   내가 가이드 F5("양쪽 다 통과하는 테스트")로 적어둔 함정에 내가 빠졌고,
 *   이 환경에 Docker가 없어 실빌드로도 못 잡았다.
 *
 * 그래서 **최소 파서**를 직접 돌린다. 완전한 Dockerfile 파서는 아니지만
 * "명령어로 시작하지 않는 논리 줄"은 반드시 잡는다 — 그게 실제로 당한 실패 모드다.
 *
 * 파싱 순서는 Docker와 같게 맞췄다: **주석 줄을 먼저 제거**하고 그 다음 연속(\)을 잇는다.
 * (순서를 반대로 하면 합법인 파일을 불법으로 잘못 신고한다 — 이 테스트를 처음 쓸 때 그렇게 틀렸다.)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";

const INSTRUCTIONS = new Set([
  "FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY",
  "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL",
  "HEALTHCHECK", "SHELL",
]);

/** `#`이 줄 첫 글자(선행 공백 허용)일 때만 주석이다 — 이 한 줄이 이번 결함의 전부였다 */
const isComment = (l: string) => l.trim().startsWith("#");
/** 줄 끝이 백슬래시면 다음 줄도 같은 논리 줄 */
const continues = (l: string) => l.endsWith("\\");

let raw: string[] = [];
beforeAll(async () => {
  raw = (await readFile("Dockerfile", "utf-8")).split("\n").map((l) => l.replace(/\s+$/, ""));
});

/** Docker와 같은 순서로 논리 줄을 만든다: 주석 제거 → 연속 결합 */
function logicalLines(): string[] {
  const body = raw.filter((l) => !isComment(l) && l.trim() !== "");
  const out: string[] = [];
  let buf = "";
  for (const line of body) {
    buf += continues(line) ? line.slice(0, -1) + " " : line;
    if (!continues(line)) { out.push(buf); buf = ""; }
  }
  if (buf) out.push(buf);          // 백슬래시로 끝난 미완결 — 아래 테스트가 잡는다
  return out;
}

describe("파싱 가능한가", () => {
  it("모든 논리 줄이 유효한 명령어로 시작한다", () => {
    const problems = logicalLines()
      .map((l, i) => ({ head: l.trim().split(/\s+/)[0].toUpperCase(), l, i }))
      .filter(({ head }) => !INSTRUCTIONS.has(head))
      .map(({ l }) => l.trim().slice(0, 70));
    // 🔒 여기 걸리면 `docker build`가 "unknown instruction"으로 거부한다
    expect(problems, `명령어로 시작하지 않는 줄:\n${problems.join("\n")}`).toEqual([]);
  });

  it("마지막 줄이 미완결 연속으로 끝나지 않는다", () => {
    const last = raw.filter((l) => l.trim() !== "").at(-1) ?? "";
    expect(continues(last), "파일이 백슬래시로 끝나면 파싱이 깨진다").toBe(false);
  });
});

describe("인자와 같은 줄의 `#` — 이번 결함의 직접 원인", () => {
  /** RUN은 셸이 `#`을 주석으로 처리하므로 제외. 나머지는 `#`이 인자로 들어가 깨진다. */
  const ARG_SENSITIVE = /^(ENV|ARG|LABEL|EXPOSE|USER|WORKDIR|STOPSIGNAL|COPY|ADD)\s/i;

  it("ENV·ARG·COPY 류에 줄 중간 주석이 없다", () => {
    const bad = logicalLines()
      .filter((l) => ARG_SENSITIVE.test(l.trim()) && l.includes("#"))
      .map((l) => l.trim().slice(0, 70));
    // 🔒 `ENV FOO=1  # 설명` 은 주석이 아니라 인자다 → "can't find = in #"
    expect(bad, `인자 줄에 # 포함:\n${bad.join("\n")}`).toEqual([]);
  });
});

describe("사내 규칙 — 연속 블록 안에 주석 줄을 두지 않는다", () => {
  it("`\\` 다음 줄이 주석이 아니다", () => {
    const bad: string[] = [];
    for (let i = 0; i < raw.length - 1; i++) {
      if (continues(raw[i]) && isComment(raw[i + 1])) bad.push(`${i + 2}행`);
    }
    // ⚠ 이건 Docker **사양상은 합법**이다(연속 블록 안의 단독 주석 줄은 파서가 제거한다).
    //    그래도 금지하는 이유: 합법인 이 형태와 불법인 "인자와 같은 줄의 #"이 한 글자 차이라
    //    이미 한 번 혼동해 빌드를 깨뜨렸다. 설명은 명령 **위**에 두면 둘 다 생기지 않는다.
    expect(bad, `연속 줄 사이의 주석: ${bad.join(", ")} — 설명을 명령 위로 옮길 것`).toEqual([]);
  });
});

describe("스테이지 참조", () => {
  it("COPY --from이 실재하는 스테이지를 가리킨다", () => {
    const df = raw.join("\n");
    const stages = [...df.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]);
    expect(stages.length, "멀티스테이지가 아니다").toBeGreaterThanOrEqual(2);
    for (const m of df.matchAll(/COPY\s+--from=(\S+)/g)) {
      // 🔒 오타 난 스테이지 이름은 실제 빌드 전까지 드러나지 않는다
      expect(stages, `알 수 없는 스테이지: ${m[1]}`).toContain(m[1]);
    }
  });
});

describe("ENV가 **실제로 설정하는** 키", () => {
  /** 논리 줄(주석 제거·연속 결합 완료)에서 ENV가 세우는 키만 뽑는다 */
  function envKeys(): Set<string> {
    const keys = new Set<string>();
    for (const l of logicalLines()) {
      if (!/^ENV\s/i.test(l.trim())) continue;
      for (const m of l.matchAll(/([A-Z_][A-Z0-9_]*)=/g)) keys.add(m[1]);
    }
    return keys;
  }

  it.each(["BUILD_STANDALONE", "KEEP_ALIVE_TIMEOUT", "NODE_ENV", "PORT", "HOSTNAME"])(
    "%s 가 ENV로 설정된다", (k) => {
      // 🔒 "문자열이 파일 어딘가에 있다"와 "ENV로 설정된다"는 다르다 — 그 차이에 당했다
      expect([...envKeys()]).toContain(k);
    });
});
