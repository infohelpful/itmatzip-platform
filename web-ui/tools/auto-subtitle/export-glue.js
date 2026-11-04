/**
 * Auto Subtitle 내보내기 페이지(export.html) — 광고 자리 2곳(진행 카드 위, 안내 아래)만 채운다.
 * 진행 카드와 실제 내보내기는 app/auto-subtitle.js(React)가 맡는다.
 */
import { showAdSense } from "../common/adsense.js?v=8";

void showAdSense("downloadTop", "#axp-ad-top");
void showAdSense("downloadBottom", "#axp-ad-bottom");
