"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

const CARD = "#fff";
const TEXT = "#1d1d1f";

export default function DashboardFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const current = searchParams.get("q") ?? "";

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const q = e.target.value;
      startTransition(() => {
        const params = new URLSearchParams(searchParams.toString());
        if (q) params.set("q", q);
        else params.delete("q");
        router.replace(`?${params.toString()}`, { scroll: false });
      });
    },
    [router, searchParams],
  );

  return (
    <input
      type="text"
      placeholder="Filter domains..."
      defaultValue={current}
      onChange={handleChange}
      style={{
        border: "1px solid rgba(194, 101, 42, 0.2)",
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 13,
        background: CARD,
        color: TEXT,
        outline: "none",
        width: 220,
      }}
    />
  );
}
