import Link from "next/link";

/**
 * 개인정보처리방침 (/privacy) — Google Play 등록 필수 URL.
 * 앱의 실제 데이터 처리에 맞춰 작성. ⚠ 게시 전 법률 검토 권장(건강정보 민감정보 처리).
 */
export const metadata = { title: "개인정보처리방침 · 마음이음" };

const UPDATED = "2026년 9월 10일";
const CONTACT = "jongwoo.first@gmail.com";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white px-5 py-8 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm text-[#007bff] hover:underline">← 홈</Link>
        <h1 className="mt-3 text-2xl font-bold text-zinc-900 dark:text-zinc-100">개인정보처리방침</h1>
        <p className="mt-1 text-sm text-zinc-500">마음이음 (제공: FIRST C&D) · 최종 업데이트 {UPDATED}</p>

        <p className="mt-6 leading-relaxed">
          마음이음(이하 &ldquo;서비스&rdquo;)은 어르신이 AI와 음성으로 대화하며 일상과 인지·마음 건강을 함께
          살피도록 돕는 서비스입니다. 본 방침은 서비스가 어떤 개인정보를 수집·이용·보관·보호하는지 설명합니다.
        </p>

        <Section title="1. 수집하는 개인정보 항목">
          <ul className="list-disc space-y-1 pl-5">
            <li><b>계정 정보</b>: 이메일, 비밀번호(암호화 저장), 이름, 나이, 성별</li>
            <li><b>건강·인지 정보(민감정보)</b>: AI와의 대화 내용, 대화에서 도출된 인지 선별 결과·이상 신호, 복약 일정·복용 기록</li>
            <li><b>음성 데이터</b>: 대화 중 마이크로 입력된 음성. 음성은 실시간 인식(텍스트 변환)에만 사용되며 원본 음성 파일은 서버에 보관하지 않습니다.</li>
            <li><b>보호자·연락처 정보</b>: 위급 상황 알림을 위한 보호자 이름·연락처(암호화 저장)</li>
            <li><b>기기·이용 정보</b>: 앱 버전, 알림 토큰(푸시 알림용)</li>
          </ul>
        </Section>

        <Section title="2. 개인정보의 이용 목적">
          <ul className="list-disc space-y-1 pl-5">
            <li>AI 음성 대화 동반 및 일상 돌봄 제공</li>
            <li>인지·마음 건강 상태의 지속적 관찰 및 위급 신호(응급) 감지</li>
            <li>위급 상황 시 보호자에게 알림 발송</li>
            <li>복약 시간 알림 제공</li>
            <li>연결된 보호자·의사에게 결과 요약 또는 상세 평가내역 제공(아래 7항 참고)</li>
          </ul>
        </Section>

        <Section title="3. 제3자 처리 위탁">
          <p className="leading-relaxed">서비스 제공을 위해 아래 사업자에 개인정보 처리를 위탁합니다.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li><b>Google (Gemini API)</b>: 음성 인식 및 AI 대화 생성 처리</li>
            <li><b>Amazon Web Services</b>: 데이터베이스 저장(한국/서울 리전)</li>
            <li><b>Vercel</b>: 애플리케이션 호스팅</li>
          </ul>
          <p className="mt-2 leading-relaxed">위 사업자는 각자의 개인정보 보호정책에 따라 데이터를 처리하며, 서비스는 목적 달성에 필요한 범위에서만 정보를 전달합니다.</p>
        </Section>

        <Section title="4. 보관 및 파기">
          <p className="leading-relaxed">
            개인정보는 회원 탈퇴 시 또는 이용 목적 달성 시 지체 없이 파기합니다. 대화 원문 음성은 저장하지 않으며,
            텍스트로 변환된 대화 기록과 인지 분석 결과는 서비스 이용 기간 동안 보관됩니다. 이용자는 언제든지
            본인 계정의 데이터 삭제를 요청할 수 있습니다.
          </p>
        </Section>

        <Section title="5. 보호 조치">
          <ul className="list-disc space-y-1 pl-5">
            <li>모든 통신은 HTTPS(TLS)로 암호화됩니다.</li>
            <li>보호자 연락처 등 민감 연락처 정보는 AES 방식으로 암호화하여 저장합니다.</li>
            <li>비밀번호는 복호화 불가능한 해시(bcrypt)로 저장됩니다.</li>
            <li>데이터베이스 접근은 최소 권한 원칙에 따라 통제됩니다.</li>
          </ul>
        </Section>

        <Section title="6. 마이크·알림 권한">
          <p className="leading-relaxed">
            음성 대화를 위해 <b>마이크 권한</b>이, 위급·복약 알림을 위해 <b>알림 권한</b>이 필요합니다. 권한은
            해당 기능 사용 시에만 이용되며, 기기 설정에서 언제든 철회할 수 있습니다(철회 시 해당 기능은 제한됩니다).
          </p>
        </Section>

        <Section title="7. 결과 열람 범위 (프라이버시 원칙)">
          <ul className="list-disc space-y-1 pl-5">
            <li><b>어르신 본인</b>: 대화만 하며, 인지 결과는 본인에게 표시하지 않습니다(불안 방지).</li>
            <li><b>연결된 의사</b>: 검진 문답·평가 상세를 열람합니다.</li>
            <li><b>연결된 보호자</b>: 결과 요약과 위급 알림만 받습니다.</li>
            <li><b>일상 대화 원문</b>은 보호자·의사에게 공개되지 않습니다(위급으로 감지된 발화 제외).</li>
          </ul>
          <p className="mt-2 leading-relaxed">보호자·의사 연결은 어르신 본인이 코드를 입력해 동의한 경우에만 이루어집니다.</p>
        </Section>

        <Section title="8. 이용자의 권리">
          <p className="leading-relaxed">
            이용자(또는 법정대리인)는 본인 개인정보의 열람·정정·삭제·처리정지 및 동의 철회를 요청할 수 있습니다.
            요청은 아래 연락처로 접수해 주세요.
          </p>
        </Section>

        <Section title="9. 아동">
          <p className="leading-relaxed">본 서비스는 만 14세 이상을 대상으로 하며, 아동을 대상으로 하지 않습니다.</p>
        </Section>

        <Section title="10. 문의처">
          <p className="leading-relaxed">
            개인정보 관련 문의: <a href={`mailto:${CONTACT}`} className="text-[#007bff] hover:underline">{CONTACT}</a>
          </p>
        </Section>

        <p className="mt-8 text-xs text-zinc-400">
          본 방침은 관련 법령 및 서비스 변경에 따라 개정될 수 있으며, 개정 시 본 페이지를 통해 공지합니다.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      <div className="text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}
