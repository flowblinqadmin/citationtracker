export interface CurrencyInfo {
  code: string;    // INR, EUR, GBP, USD
  symbol: string;  // ₹, €, £, $
  rate: number;    // units of this currency per 1 USD
  locale: string;  // for Intl.NumberFormat
}

export const USD: CurrencyInfo = { code: "USD", symbol: "$", rate: 1, locale: "en-US" };

const TLD_MAP: Record<string, CurrencyInfo> = {
  in:    { code: "INR", symbol: "₹",   rate: 83,    locale: "en-IN" },
  uk:    { code: "GBP", symbol: "£",   rate: 0.79,  locale: "en-GB" },
  de:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "de-DE" },
  fr:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "fr-FR" },
  it:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "it-IT" },
  es:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "es-ES" },
  nl:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "nl-NL" },
  at:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "de-AT" },
  be:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "nl-BE" },
  ie:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "en-IE" },
  pt:    { code: "EUR", symbol: "€",   rate: 0.92,  locale: "pt-PT" },
  ca:    { code: "CAD", symbol: "CA$", rate: 1.36,  locale: "en-CA" },
  au:    { code: "AUD", symbol: "A$",  rate: 1.52,  locale: "en-AU" },
  jp:    { code: "JPY", symbol: "¥",   rate: 149,   locale: "ja-JP" },
  br:    { code: "BRL", symbol: "R$",  rate: 4.97,  locale: "pt-BR" },
  mx:    { code: "MXN", symbol: "MX$", rate: 17.1,  locale: "es-MX" },
  sg:    { code: "SGD", symbol: "S$",  rate: 1.34,  locale: "en-SG" },
  nz:    { code: "NZD", symbol: "NZ$", rate: 1.63,  locale: "en-NZ" },
  za:    { code: "ZAR", symbol: "R",   rate: 18.5,  locale: "en-ZA" },
  ae:    { code: "AED", symbol: "AED", rate: 3.67,  locale: "ar-AE" },
  sa:    { code: "SAR", symbol: "SAR", rate: 3.75,  locale: "ar-SA" },
};

export function detectCurrency(merchantUrl: string): CurrencyInfo {
  try {
    const url = merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`;
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.endsWith(".co.uk")) return TLD_MAP["uk"];
    const parts = hostname.split(".");
    const tld = parts[parts.length - 1] ?? "";
    return TLD_MAP[tld] ?? USD;
  } catch {
    return USD;
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", INR: "₹", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$",
  JPY: "¥", BRL: "R$", MXN: "MX$", SGD: "S$", NZD: "NZ$",
  ZAR: "R", AED: "AED", SAR: "SAR",
};

/** Get the symbol for an ISO currency code (falls back to the code itself) */
export function currencyCodeToSymbol(code: string): string {
  return CURRENCY_SYMBOLS[code.toUpperCase()] ?? code;
}

/** Format a USD amount into local currency for display */
export function fmtLocal(usdAmount: number, currency: CurrencyInfo): string {
  const local = usdAmount * currency.rate;
  const s = currency.symbol;

  // INR: use lakh/crore notation
  if (currency.code === "INR") {
    if (local >= 1_00_00_000) {  // >= 1 crore
      return `${s}${(local / 1_00_00_000).toFixed(1)} Cr`;
    }
    if (local >= 1_00_000) {     // >= 1 lakh
      return `${s}${(local / 1_00_000).toFixed(1)} L`;
    }
    return `${s}${Math.round(local).toLocaleString("en-IN")}`;
  }

  // JPY: no decimals
  if (currency.code === "JPY") {
    if (local >= 1_000_000_000) return `${s}${(local / 1_000_000_000).toFixed(1)}B`;
    if (local >= 1_000_000) return `${s}${(local / 1_000_000).toFixed(1)}M`;
    if (local >= 1_000) return `${s}${Math.round(local / 1_000)}K`;
    return `${s}${Math.round(local)}`;
  }

  // Everything else: standard K/M
  if (local >= 1_000_000) return `${s}${(local / 1_000_000).toFixed(1)}M`;
  if (local >= 1_000) return `${s}${Math.round(local / 1_000)}K`;
  return `${s}${Math.round(local)}`;
}
