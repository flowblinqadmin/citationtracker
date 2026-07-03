"use client";

import { useState, useEffect } from "react";

export function useIsEmbedded(): boolean {
  const [embedded, setEmbedded] = useState(false);

  useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      // Cross-origin iframe access throws - means we ARE embedded
      setEmbedded(true);
    }
  }, []);

  return embedded;
}
