/**
 * Unit tests — ConfirmCreditModal
 * CCM-01 through CCM-11
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ConfirmCreditModal from "@/app/sites/[id]/components/ConfirmCreditModal";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderModal(props: Partial<React.ComponentProps<typeof ConfirmCreditModal>> = {}) {
  const defaults = {
    action: "Refresh Score",
    description: "Re-run your GEO audit",
    cost: 5,
    balance: 20,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };
  return render(<ConfirmCreditModal {...defaults} {...props} />);
}

describe("ConfirmCreditModal", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  // CCM-01: renders cost and balance-after when canAfford=true
  it("CCM-01: renders cost and balance-after when canAfford=true", () => {
    renderModal({ cost: 5, balance: 20 });
    // cost row
    expect(screen.getByText("5 credits")).toBeInTheDocument();
    // balance after = 20 - 5 = 15
    expect(screen.getByText("Balance after: 15 credits")).toBeInTheDocument();
  });

  // CCM-02: Proceed button is enabled when balance >= cost
  it("CCM-02: Proceed button is enabled when balance >= cost", () => {
    renderModal({ cost: 5, balance: 5 });
    const btn = screen.getByRole("button", { name: /proceed/i });
    expect(btn).not.toBeDisabled();
  });

  // CCM-03: Proceed button is disabled and shows "Not enough credits" when balance < cost
  it("CCM-03: Proceed button is disabled and shows 'Not enough credits' when balance < cost", () => {
    renderModal({ cost: 10, balance: 3 });
    const btn = screen.getByRole("button", { name: /not enough credits/i });
    expect(btn).toBeDisabled();
  });

  // CCM-04: clicking Proceed calls onConfirm
  it("CCM-04: clicking Proceed calls onConfirm", () => {
    const onConfirm = vi.fn();
    renderModal({ cost: 5, balance: 20, onConfirm });
    fireEvent.click(screen.getByRole("button", { name: /proceed/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  // CCM-05: clicking Cancel calls onCancel
  it("CCM-05: clicking Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // CCM-06: clicking backdrop calls onCancel (backdrop onClick fires)
  it("CCM-06: clicking backdrop calls onCancel", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    // The backdrop is the fixed overlay div — it's the first sibling of the card inside the portal.
    // We can find it as the element whose onClick is wired to onCancel (the outer fixed div).
    // The easiest selector: the element with position:fixed is the backdrop.
    // Since the modal is portaled into document.body, we query body for the overlay.
    const backdrop = document.body.querySelector<HTMLElement>(
      '[style*="position: fixed"][style*="inset: 0"]'
    );
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // CCM-07: clicking modal card does NOT call onCancel (stopPropagation works)
  it("CCM-07: clicking modal card does NOT call onCancel (stopPropagation)", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    // The inner card is the div with borderRadius:16 — find it by querying inside the backdrop
    const backdrop = document.body.querySelector<HTMLElement>(
      '[style*="position: fixed"][style*="inset: 0"]'
    );
    const card = backdrop!.firstElementChild as HTMLElement;
    fireEvent.click(card);
    expect(onCancel).not.toHaveBeenCalled();
  });

  // CCM-08: skip flag set → component returns null (renders nothing)
  it("CCM-08: skip flag set → component returns null", () => {
    sessionStorage.setItem("skip-credit-confirm", "1");
    const { container } = renderModal();
    // createPortal into document.body, but the component returns null so nothing rendered
    expect(container).toBeEmptyDOMElement();
    // Also verify no modal content is in document.body
    expect(document.body.querySelector('[style*="position: fixed"]')).toBeNull();
  });

  // CCM-09: skip flag set → onConfirm() called on mount
  it("CCM-09: skip flag set → onConfirm() called on mount via useEffect", () => {
    sessionStorage.setItem("skip-credit-confirm", "1");
    const onConfirm = vi.fn();
    renderModal({ onConfirm });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  // CCM-10: checking "Don't ask again" sets sessionStorage["skip-credit-confirm"]="1"
  it('CCM-10: checking "Don\'t ask again" sets sessionStorage flag', () => {
    renderModal();
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(sessionStorage.getItem("skip-credit-confirm")).toBe("1");
  });

  // CCM-11: unchecking removes sessionStorage["skip-credit-confirm"]
  it('CCM-11: unchecking removes sessionStorage flag', () => {
    // Pre-set the flag so we can test removal
    sessionStorage.setItem("skip-credit-confirm", "1");
    // Render without skip so the modal shows (need to clear first, render, then test)
    // We need the modal to be visible to find the checkbox, so temporarily clear the flag
    sessionStorage.removeItem("skip-credit-confirm");
    renderModal();

    const checkbox = screen.getByRole("checkbox");
    // Check it first to set the flag
    fireEvent.click(checkbox);
    expect(sessionStorage.getItem("skip-credit-confirm")).toBe("1");
    // Uncheck to remove it
    fireEvent.click(checkbox);
    expect(sessionStorage.getItem("skip-credit-confirm")).toBeNull();
  });
});
