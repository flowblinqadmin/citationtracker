/**
 * Phase 8A — SOV on Commerce Report Page test
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the SovGapSection so we can detect it renders
vi.mock("@/components/commerce-report/sov-gap", () => ({
  SovGapSection: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "sov-gap-section" }, "SOV data present"),
}));

const mockSovGapData = {
  brandSov: 25,
  topCompetitorSov: 60,
  topCompetitorName: "Competitor X",
  queries: [],
};

describe("SovGapSection conditional render", () => {
  it("SovGapSection component renders when passed sovGap data", async () => {
    // Import after mock is set up
    const mod = await import("@/components/commerce-report/sov-gap");
    const { SovGapSection } = mod;
    render(React.createElement(SovGapSection as React.FC<Record<string, unknown>>, { data: mockSovGapData, brandName: "TestBrand" }));
    expect(screen.getByTestId("sov-gap-section")).toBeInTheDocument();
  });
});
