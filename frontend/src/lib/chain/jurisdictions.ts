/**
 * ISO 3166-1 numeric codes, which is what the registry stores. (Hong Kong is
 * 344; 852 is its telephone code.)
 */
export const JURISDICTIONS: { code: number; en: string; zh: string }[] = [
  { code: 344, en: "Hong Kong", zh: "香港" },
  { code: 702, en: "Singapore", zh: "新加坡" },
  { code: 158, en: "Taiwan", zh: "台湾" },
  { code: 446, en: "Macao", zh: "澳门" },
  { code: 356, en: "India", zh: "印度" },
  { code: 784, en: "United Arab Emirates", zh: "阿联酋" },
  { code: 392, en: "Japan", zh: "日本" },
  { code: 410, en: "South Korea", zh: "韩国" },
  { code: 458, en: "Malaysia", zh: "马来西亚" },
  { code: 764, en: "Thailand", zh: "泰国" },
  { code: 704, en: "Vietnam", zh: "越南" },
  { code: 36, en: "Australia", zh: "澳大利亚" },
  { code: 756, en: "Switzerland", zh: "瑞士" },
  { code: 826, en: "United Kingdom", zh: "英国" },
  { code: 276, en: "Germany", zh: "德国" },
  { code: 398, en: "Kazakhstan", zh: "哈萨克斯坦" },
  { code: 840, en: "United States", zh: "美国" },
  { code: 156, en: "Mainland China", zh: "中国内地" },
];

export function jurisdictionName(code: number, locale: string) {
  const j = JURISDICTIONS.find((x) => x.code === code);
  if (!j) return `ISO ${code}`;
  return locale.startsWith("zh") ? j.zh : j.en;
}
