/**
 * Payment Toast Tests — PaymentToast component
 *
 * Tests the post-payment toast behavior per ES-003 spec (Task 2, #43).
 * 4 test cases covering:
 *   22. Toast shown when payment=success param present
 *   23. URL cleaned after toast fires
 *   24. No toast when payment param is missing
 *   25. No toast when payment param has wrong value
 *
 * DEPENDENCY: Requires @testing-library/react + jsdom.
 * Install: npm install -D @testing-library/react @testing-library/jest-dom
 *
 * These tests are written BEFORE implementation (test-first).
 * They will FAIL until PaymentToast.tsx is created.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockReplace = vi.fn();
const mockToastSuccess = vi.fn();

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
  useRouter: () => ({
    replace: mockReplace,
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
  },
}));

// ─── Import ─────────────────────────────────────────────────────────────────

import PaymentToast from "@/app/dashboard/PaymentToast";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PaymentToast component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSearchParams = new URLSearchParams();
  });

  // ── Test 22: Toast shown on payment=success ──

  it("shows success toast when payment=success is in URL params", () => {
    currentSearchParams = new URLSearchParams("payment=success");

    render(<PaymentToast />);

    expect(mockToastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/payment successful/i)
    );
  });

  // ── Test 23: URL cleaned after toast ──

  it("cleans payment param from URL after showing toast", () => {
    currentSearchParams = new URLSearchParams("payment=success");

    render(<PaymentToast />);

    // router.replace should be called to remove the payment param
    expect(mockReplace).toHaveBeenCalled();
    const replaceArg = mockReplace.mock.calls[0][0];

    // The cleaned URL should NOT contain "payment"
    if (typeof replaceArg === "string") {
      expect(replaceArg).not.toContain("payment");
    }
  });

  // ── Test 24: No toast without payment param ──

  it("does NOT show toast when payment param is absent", () => {
    currentSearchParams = new URLSearchParams(); // No params

    render(<PaymentToast />);

    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // ── Test 25: No toast with wrong payment value ──

  it("does NOT show toast when payment param has wrong value", () => {
    currentSearchParams = new URLSearchParams("payment=failed");

    render(<PaymentToast />);

    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
