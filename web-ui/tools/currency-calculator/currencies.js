/** ISO 4217 통화 + 로케일 매핑. */

export const REGION_CURRENCY = {
  KR: "KRW",
  US: "USD",
  JP: "JPY",
  CN: "CNY",
  TW: "TWD",
  HK: "HKD",
  SG: "SGD",
  GB: "GBP",
  EU: "EUR",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  NL: "EUR",
  AU: "AUD",
  CA: "CAD",
  CH: "CHF",
  NZ: "NZD",
  IN: "INR",
  TH: "THB",
  VN: "VND",
  ID: "IDR",
  MY: "MYR",
  PH: "PHP",
  AE: "AED",
  SA: "SAR",
  TR: "TRY",
  BR: "BRL",
  MX: "MXN",
  RU: "RUB",
  PL: "PLN",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  ZA: "ZAR",
};

/**
 * @typedef {{ code: string, name: string, country: string, region: string, digits: number }} Currency
 */

/** @type {Currency[]} */
export const CURRENCIES = [
  { code: "KRW", name: "대한민국 원", country: "대한민국", region: "kr", digits: 0 },
  { code: "USD", name: "미국 달러", country: "미국", region: "us", digits: 2 },
  { code: "JPY", name: "일본 엔", country: "일본", region: "jp", digits: 0 },
  { code: "EUR", name: "유로", country: "유럽연합", region: "eu", digits: 2 },
  { code: "CNY", name: "중국 위안", country: "중국", region: "cn", digits: 2 },
  { code: "GBP", name: "영국 파운드", country: "영국", region: "gb", digits: 2 },
  { code: "AUD", name: "호주 달러", country: "호주", region: "au", digits: 2 },
  { code: "CAD", name: "캐나다 달러", country: "캐나다", region: "ca", digits: 2 },
  { code: "CHF", name: "스위스 프랑", country: "스위스", region: "ch", digits: 2 },
  { code: "SGD", name: "싱가포르 달러", country: "싱가포르", region: "sg", digits: 2 },
  { code: "HKD", name: "홍콩 달러", country: "홍콩", region: "hk", digits: 2 },
  { code: "TWD", name: "신 타이완 달러", country: "대만", region: "tw", digits: 2 },
  { code: "THB", name: "타이 밧", country: "태국", region: "th", digits: 2 },
  { code: "VND", name: "베트남 동", country: "베트남", region: "vn", digits: 0 },
  { code: "IDR", name: "인도네시아 루피아", country: "인도네시아", region: "id", digits: 0 },
  { code: "MYR", name: "말레이시아 링깃", country: "말레이시아", region: "my", digits: 2 },
  { code: "PHP", name: "필리핀 페소", country: "필리핀", region: "ph", digits: 2 },
  { code: "INR", name: "인도 루피", country: "인도", region: "in", digits: 2 },
  { code: "NZD", name: "뉴질랜드 달러", country: "뉴질랜드", region: "nz", digits: 2 },
  { code: "AED", name: "아랍에미리트 디르함", country: "UAE", region: "ae", digits: 2 },
  { code: "SAR", name: "사우디 리얄", country: "사우디아라비아", region: "sa", digits: 2 },
  { code: "TRY", name: "튀르키예 리라", country: "튀르키예", region: "tr", digits: 2 },
  { code: "BRL", name: "브라질 헤알", country: "브라질", region: "br", digits: 2 },
  { code: "MXN", name: "멕시코 페소", country: "멕시코", region: "mx", digits: 2 },
  { code: "RUB", name: "러시아 루블", country: "러시아", region: "ru", digits: 2 },
  { code: "PLN", name: "폴란드 즈워티", country: "폴란드", region: "pl", digits: 2 },
  { code: "SEK", name: "스웨덴 크로나", country: "스웨덴", region: "se", digits: 2 },
  { code: "NOK", name: "노르웨이 크로네", country: "노르웨이", region: "no", digits: 2 },
  { code: "DKK", name: "덴마크 크로네", country: "덴마크", region: "dk", digits: 2 },
  { code: "ZAR", name: "남아프리카 랜드", country: "남아프리카", region: "za", digits: 2 },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

/** @param {string} code */
export function getCurrency(code) {
  return BY_CODE.get(String(code || "").toUpperCase()) || null;
}

export function detectCurrency() {
  try {
    const locale = navigator.language || Intl.NumberFormat().resolvedOptions().locale || "ko-KR";
    let region = "";
    if (typeof Intl.Locale === "function") {
      const loc = new Intl.Locale(locale);
      region = (loc.maximize && loc.maximize().region) || loc.region || "";
    }
    if (!region) {
      const parts = String(locale).replace("_", "-").split("-");
      region = (parts[1] || parts[0] || "").toUpperCase();
    }
    const mapped = REGION_CURRENCY[String(region).toUpperCase()];
    if (mapped && BY_CODE.has(mapped)) return mapped;
  } catch {
    /* ignore */
  }
  return "KRW";
}

/** @param {string} base */
export function defaultTargets(base) {
  const presets = {
    KRW: ["USD", "JPY", "EUR"],
    USD: ["KRW", "EUR", "JPY"],
    JPY: ["KRW", "USD", "EUR"],
    EUR: ["USD", "KRW", "GBP"],
    CNY: ["KRW", "USD", "JPY"],
  };
  return (presets[base] || ["USD", "EUR", "KRW"]).filter((c) => c !== base);
}

/** @param {string} base */
export function defaultAmount(base) {
  if (base === "KRW" || base === "VND" || base === "IDR") return 100000;
  if (base === "JPY") return 10000;
  return 100;
}

/** @param {string} region */
export function flagSrc(region, width = 80) {
  const id = String(region || "").toLowerCase();
  return `https://flagcdn.com/w${width}/${id}.png`;
}

/** @param {Currency | null} meta */
export function regionLabel(meta) {
  return String(meta && meta.region ? meta.region : "").toUpperCase();
}

/** 본문용: 글자(KR/US/EU) 너비에 맞춰 그 위에 국기 */
export function flagStackHtml(meta, extraClass = "") {
  if (!meta) return "";
  const code = regionLabel(meta);
  const src = flagSrc(meta.region, 80);
  const src2x = flagSrc(meta.region, 160);
  return `<span class="fx-flag-stack ${extraClass}">
    <img class="fx-flag-img" src="${src}" srcset="${src} 1x, ${src2x} 2x" alt="${code}" width="36" height="24">
    <span class="fx-flag-code">${code}</span>
  </span>`;
}

/** 팝업 목록용: 항목 왼쪽 국기 */
export function flagInlineHtml(meta) {
  if (!meta) return "";
  const code = regionLabel(meta);
  const src = flagSrc(meta.region, 40);
  const src2x = flagSrc(meta.region, 80);
  return `<img class="picker-flag" src="${src}" srcset="${src} 1x, ${src2x} 2x" alt="${code}" width="28" height="20">`;
}
