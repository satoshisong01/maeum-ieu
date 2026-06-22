/** FCM 실발송 검증 — .env의 FCM_SERVICE_ACCOUNT로 테스트 토픽에 1건 발송. 자격증명 값은 로그에 안 남김. */
import "dotenv/config";
import { sendEmergencyPush, isFcmConfigured, userTopic } from "../../lib/notify/push-fcm";

async function main() {
  console.log("FCM configured(env 인식):", isFcmConfigured());
  const testUserId = "fcmverify_" + "test";
  console.log("발송 토픽:", userTopic(testUserId));
  const r = await sendEmergencyPush([testUserId], {
    title: "🚨 [검증] 위급 알림 테스트",
    body: "FCM 발송 경로 검증용 메시지입니다.",
    level: 3,
    category: "medical_acute",
  });
  console.log("결과:", r);
  if (r.sent > 0) console.log("✅ FCM 발송 성공 — 자격증명·발송 경로 정상");
  else console.log("❌ 발송 실패 — 위 reason/로그 확인");
}
main().catch((e) => console.error("ERROR:", (e as Error).message)).finally(() => process.exit(0));
