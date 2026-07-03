export interface Benchmark {
  category: string;
  industry_average: number;
  top_performer: number;
}

export const BENCHMARKS: Record<string, Benchmark> = {
  "auto parts": {
    category: "Auto Parts / Powersports",
    industry_average: 35,
    top_performer: 72,
  },
  "automotive": {
    category: "Auto Parts / Powersports",
    industry_average: 35,
    top_performer: 72,
  },
  "powersports": {
    category: "Auto Parts / Powersports",
    industry_average: 35,
    top_performer: 72,
  },
  "health": {
    category: "Health / Supplements",
    industry_average: 28,
    top_performer: 65,
  },
  "supplements": {
    category: "Health / Supplements",
    industry_average: 28,
    top_performer: 65,
  },
  "nutrition": {
    category: "Health / Supplements",
    industry_average: 28,
    top_performer: 65,
  },
  "marine": {
    category: "Marine / Boating",
    industry_average: 22,
    top_performer: 58,
  },
  "boating": {
    category: "Marine / Boating",
    industry_average: 22,
    top_performer: 58,
  },
  "fashion": {
    category: "Fashion / Apparel",
    industry_average: 45,
    top_performer: 80,
  },
  "apparel": {
    category: "Fashion / Apparel",
    industry_average: 45,
    top_performer: 80,
  },
  "home": {
    category: "Home & Garden",
    industry_average: 32,
    top_performer: 68,
  },
  "garden": {
    category: "Home & Garden",
    industry_average: 32,
    top_performer: 68,
  },
  "industrial": {
    category: "Industrial / B2B",
    industry_average: 18,
    top_performer: 52,
  },
  "b2b": {
    category: "Industrial / B2B",
    industry_average: 18,
    top_performer: 52,
  },
};

const DEFAULT_BENCHMARK: Benchmark = {
  category: "General / Other",
  industry_average: 30,
  top_performer: 65,
};

export function getBenchmark(categoryHint?: string | null): Benchmark {
  if (!categoryHint) return DEFAULT_BENCHMARK;
  const lower = categoryHint.toLowerCase();
  for (const [key, benchmark] of Object.entries(BENCHMARKS)) {
    if (lower.includes(key)) return benchmark;
  }
  return DEFAULT_BENCHMARK;
}
