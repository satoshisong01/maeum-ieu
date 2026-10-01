/**
 * 업로드된(최신) 안드로이드 앱 버전.
 *
 * ⚠️ 새 APK를 빌드해 public/maeum-app.apk 를 교체할 때 이 값을 함께 올려야 함.
 *    그리고 RN 앱(MaeumApp/App.jsx의 APP_VERSION + android/app/build.gradle versionName)도 동일하게 맞출 것.
 *    설치된 앱이 이 값보다 낮으면 로그인 화면에서 "업데이트" 안내가 표시됨.
 */
export const LATEST_APP_VERSION = "1.0.3";

/**
 * 구독 결제(Play Billing)를 지원하는 최소 앱 버전.
 *
 * 왜 따로 두나: 이전 버전 앱은 PURCHASE_SUBSCRIPTION 메시지를 처리하지 못해 결제 버튼이
 *   아무 반응 없이 멈춘 것처럼 보인다. 구매 버튼은 이 버전 이상에서만 노출한다.
 *   ⚠️ 결제 기능이 포함된 APK/AAB를 올릴 때 이 값을 그 버전으로 맞출 것.
 */
export const MIN_BILLING_APP_VERSION = "1.1.0";

/** a < b 인지(semver 단순 비교). 설치된 앱이 최신보다 낮을 때만 업데이트 안내. */
export function isOlderVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}
