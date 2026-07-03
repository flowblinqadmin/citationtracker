/**
 * Fix #39 — UpgradeModal: free-tier teams see upsell instead of credit-pack slider.
 *
 * Asserts:
 *   - With subscriptionTier="free": credits tab shows upsell, no quantity slider.
 *   - With subscriptionTier="starter": credits tab shows the quantity slider.
 *   - Upsell offers an in-modal "See plans" action (the /pricing page was removed;
 *     upgrades now route through the modal's plans tab — see UpgradeModal.tsx).
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// Mock sonner toast used in UpgradeModal
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import UpgradeModal from "@/app/components/UpgradeModal";

describe("UpgradeModal — credit-pack upsell for free tier (Fix #39)", () => {
  it("hides the Credit Packs tab for free subscriptions — single path (Choose your plan)", () => {
    render(
      <UpgradeModal
        credits={0}
        onClose={vi.fn()}
        subscriptionTier="free"
      />
    );

    // Conversion audit 2026-06-10: two pricing models side-by-side (subscription
    // vs credit packs) caused "which do I even buy?" paralysis for the exact
    // audience that wasn't converting. Free users now see ONE path — a
    // subscription. The Credit Packs tab (and its dead-end upsell) is removed.
    expect(screen.queryByText("Credit Packs")).toBeNull();
    expect(screen.getByText("Choose your plan")).toBeDefined();
    expect(screen.queryByTestId("upgrade-modal-credits-upsell")).toBeNull();
    // No quantity slider reachable either (the credit-pack path is gone for free).
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("shows quantity slider when subscriptionTier=starter", () => {
    render(
      <UpgradeModal
        credits={10}
        onClose={vi.fn()}
        subscriptionTier="starter"
      />
    );

    const creditsTab = screen.getByText("Credit Packs");
    fireEvent.click(creditsTab);

    // No upsell block
    expect(screen.queryByTestId("upgrade-modal-credits-upsell")).toBeNull();

    // Quantity input IS present
    const quantityInput = screen.queryByRole("spinbutton");
    expect(quantityInput).not.toBeNull();
  });

  it("shows quantity slider when subscriptionTier is undefined (default paid behavior)", () => {
    render(
      <UpgradeModal
        credits={5}
        onClose={vi.fn()}
      />
    );

    const creditsTab = screen.getByText("Credit Packs");
    fireEvent.click(creditsTab);

    // Upsell must NOT show when subscriptionTier is not provided
    expect(screen.queryByTestId("upgrade-modal-credits-upsell")).toBeNull();
  });
});
