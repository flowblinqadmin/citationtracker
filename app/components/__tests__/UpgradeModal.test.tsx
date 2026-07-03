// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import UpgradeModal from "@/app/components/UpgradeModal";

// Mock config with new pricing values
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    SUBSCRIPTION_TIERS: {
      free:    { name: "Free",    price: 0,   pages: 20,   maxFrequency: "manual", maxAuditPages: 20,  maxCompetitors: 0  },
      starter: { name: "Starter", price: 99,  pages: 1000, maxFrequency: "weekly", maxAuditPages: 100, maxCompetitors: 2  },
      growth:  { name: "Growth",  price: 199, pages: 3000, maxFrequency: "daily",  maxAuditPages: 500, maxCompetitors: 5  },
      pro:     { name: "Pro",     price: 349, pages: 7000, maxFrequency: "daily",  maxAuditPages: null, maxCompetitors: 10 },
    },
    UPFRONT_PRICES: {
      starter: { quarterly: 249,  annual: null  },
      growth:  { quarterly: 499,  annual: null  },
      pro:     { quarterly: null, annual: 2999  },
    },
    ANNUAL_DISCOUNT: 0.20,
  };
});

// Mock fetch to avoid network calls
global.fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ checkoutUrl: "https://stripe.test" }) });

describe("UpgradeModal", () => {
  const onClose = vi.fn();
  beforeEach(() => vi.clearAllMocks());

  it("renders three plan cards", () => {
    render(<UpgradeModal onClose={onClose} />);
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText("Growth")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
  });

  it("shows monthly prices by default", () => {
    render(<UpgradeModal onClose={onClose} />);
    expect(screen.getByText("$99")).toBeInTheDocument();
    expect(screen.getByText("$199")).toBeInTheDocument();
    expect(screen.getByText("$349")).toBeInTheDocument();
  });

  it("shows quarterly prices after clicking Quarterly", () => {
    render(<UpgradeModal onClose={onClose} />);
    fireEvent.click(screen.getByText("Quarterly"));
    expect(screen.getByText("$249")).toBeInTheDocument();
    expect(screen.getByText("$499")).toBeInTheDocument();
  });

  it("shows annual price for Pro after clicking Annual", () => {
    render(<UpgradeModal onClose={onClose} />);
    fireEvent.click(screen.getByText("Annual"));
    expect(screen.getByText("$2,999")).toBeInTheDocument();
  });

  it("Starter plan is spotlighted with copper border (#b45309), not blue", () => {
    // Conversion audit 2026-06-10: the spotlight moved from Growth to STARTER
    // ("Best to start") — the goal is the FIRST conversion, not ARPU, so the
    // cheapest entry tier is highlighted, not the middle tier.
    const { container } = render(<UpgradeModal onClose={onClose} />);
    const cards = container.querySelectorAll("[data-plan]");
    const starterCard = Array.from(cards).find(c => c.getAttribute("data-plan") === "starter");
    expect(starterCard).toBeTruthy();
    const style = (starterCard as HTMLElement).style.border;
    // jsdom normalizes hex to rgb(180, 83, 9) — accept either form
    const hasCopper = style.includes("#b45309") || style.includes("rgb(180, 83, 9)");
    const hasBlue = style.includes("#2563eb") || style.includes("rgb(37, 99, 235)");
    expect(hasCopper).toBe(true);
    expect(hasBlue).toBe(false);
  });

  it("shows competitor count in feature bullets", () => {
    render(<UpgradeModal onClose={onClose} />);
    expect(screen.getByText(/2 competitors/i)).toBeInTheDocument();
    expect(screen.getByText(/5 competitors/i)).toBeInTheDocument();
    expect(screen.getByText(/10 competitors/i)).toBeInTheDocument();
  });

  it("shows audit page cap in feature bullets", () => {
    render(<UpgradeModal onClose={onClose} />);
    expect(screen.getByText(/100 pages\/audit/i)).toBeInTheDocument();
    expect(screen.getByText(/500 pages\/audit/i)).toBeInTheDocument();
    expect(screen.getByText(/unlimited pages\/audit/i)).toBeInTheDocument();
  });

  it("closes when backdrop is clicked", () => {
    render(<UpgradeModal onClose={onClose} />);
    // Close button
    fireEvent.click(screen.getByText("×"));
    expect(onClose).toHaveBeenCalled();
  });
});
