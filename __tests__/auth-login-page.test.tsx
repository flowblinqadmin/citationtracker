/**
 * Component tests for app/auth/login/page.tsx — consent UI render path.
 *
 * Validates the three-state machine introduced to fix HP-272 (dead-end
 * `requiresConsent` state on geo/auth/login). Before this fix, verifyOtp
 * succeeded for fresh users but `setRequiresConsent(true)` had no UI to
 * render against, leaving the user staring at the OTP form forever.
 *
 *   LP-1  requiresConsent UI shows after verifyOtp + /api/consent {hasConsent:false}
 *   LP-2  Accept button is disabled until the TOS checkbox is checked
 *   LP-3  Accepting POSTs to /api/consent and navigates to /dashboard
 *   LP-4  redirectTo param is honoured after consent accept (with strict validation)
 *   LP-5  /api/consent POST failure surfaces an error and stays on consent UI
 *   LP-6  ?error=… query param surfaces the actionable message at mount
 *   LP-7  signInWithOtp is called WITHOUT emailRedirectTo (link-prefetch immunity)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockVerifyOtp, mockSignInWithOtp, mockSignOut } = vi.hoisted(() => ({
  mockVerifyOtp: vi.fn(),
  mockSignInWithOtp: vi.fn(),
  mockSignOut: vi.fn().mockResolvedValue({ error: null }),
}));

let searchParamsStore = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsStore,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
      verifyOtp: mockVerifyOtp,
      signOut: mockSignOut,
    },
  }),
}));

const locationAssignments: string[] = [];

beforeEach(() => {
  locationAssignments.length = 0;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() { return locationAssignments[locationAssignments.length - 1] ?? "http://localhost/auth/login"; },
      set href(v: string) { locationAssignments.push(v); },
      origin: "http://localhost",
      pathname: "/auth/login",
      search: "",
    },
  });
  global.fetch = vi.fn() as unknown as typeof fetch;
  searchParamsStore = new URLSearchParams();
  vi.clearAllMocks();
  mockSignOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import LoginPage from "@/app/auth/login/page";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface MockResp { status: number; body: unknown }

function queueFetches(responses: MockResp[]) {
  const queue = [...responses];
  (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error("[test] unexpected extra fetch call");
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  });
}

function flush() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

async function clickEmailSubmit(email: string) {
  fireEvent.change(screen.getByPlaceholderText(/you@yourcompany\.com/i), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /send code/i }));
}

async function clickOtpVerify(code: string) {
  fireEvent.change(screen.getByPlaceholderText(/6-digit code/i), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: /verify code/i }));
}

async function driveToConsentScreen() {
  mockSignInWithOtp.mockResolvedValueOnce({ data: {}, error: null });
  await clickEmailSubmit("user@test.local");
  await screen.findByText(/check your email/i);

  mockVerifyOtp.mockResolvedValueOnce({ data: { session: {} }, error: null });
  // /api/consent GET → hasConsent:false (fresh user)
  queueFetches([{ status: 200, body: { hasConsent: false } }]);

  await clickOtpVerify("123456");
  await screen.findByText(/one last step/i);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/auth/login — consent UI render path", () => {
  it("LP-1: after verifyOtp + hasConsent=false, consent UI replaces OTP UI", async () => {
    render(<LoginPage />);
    await driveToConsentScreen();

    expect(screen.queryByPlaceholderText(/6-digit code/i)).toBeNull();
    expect(screen.getByText(/one last step/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/accept terms of service and eula/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept and continue/i })).toBeInTheDocument();
  });

  it("LP-2: Accept button is disabled until the TOS checkbox is checked", async () => {
    render(<LoginPage />);
    await driveToConsentScreen();

    const acceptBtn = screen.getByRole("button", { name: /accept and continue/i });
    expect(acceptBtn).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/accept terms of service and eula/i));
    expect(acceptBtn).toBeEnabled();
  });

  it("LP-3: clicking Accept POSTs to /api/consent and navigates to /dashboard", async () => {
    render(<LoginPage />);
    await driveToConsentScreen();

    queueFetches([{ status: 200, body: { success: true } }]);

    fireEvent.click(screen.getByLabelText(/accept terms of service and eula/i));
    fireEvent.click(screen.getByRole("button", { name: /accept and continue/i }));

    await waitFor(() => expect(locationAssignments).toContain("/dashboard"));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[0]).toBe("/api/consent");
    expect(lastCall[1].method).toBe("POST");
    expect(JSON.parse(lastCall[1].body as string)).toEqual({ tosAccepted: true });
  });

  it("LP-4: redirectTo param is honoured after consent accept", async () => {
    searchParamsStore = new URLSearchParams({ redirectTo: "/sites/abc123" });
    render(<LoginPage />);
    await driveToConsentScreen();

    queueFetches([{ status: 200, body: { success: true } }]);
    fireEvent.click(screen.getByLabelText(/accept terms of service and eula/i));
    fireEvent.click(screen.getByRole("button", { name: /accept and continue/i }));

    await waitFor(() => expect(locationAssignments).toContain("/sites/abc123"));
  });

  it("LP-4b: malicious redirectTo is rejected — defaults to /dashboard", async () => {
    searchParamsStore = new URLSearchParams({ redirectTo: "//evil.com/steal" });
    render(<LoginPage />);
    await driveToConsentScreen();

    queueFetches([{ status: 200, body: { success: true } }]);
    fireEvent.click(screen.getByLabelText(/accept terms of service and eula/i));
    fireEvent.click(screen.getByRole("button", { name: /accept and continue/i }));

    await waitFor(() => expect(locationAssignments).toContain("/dashboard"));
    expect(locationAssignments).not.toContain("//evil.com/steal");
  });

  it("LP-5: /api/consent POST failure surfaces error and keeps user on consent UI", async () => {
    render(<LoginPage />);
    await driveToConsentScreen();

    queueFetches([{ status: 401, body: { error: "Not authenticated" } }]);

    fireEvent.click(screen.getByLabelText(/accept terms of service and eula/i));
    fireEvent.click(screen.getByRole("button", { name: /accept and continue/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Not authenticated/i);
    expect(screen.getByText(/one last step/i)).toBeInTheDocument();
    expect(locationAssignments).toEqual([]);
  });

  it("LP-6a: ?error=server-misconfigured surfaces an actionable message at mount", async () => {
    searchParamsStore = new URLSearchParams({ error: "server-misconfigured" });
    render(<LoginPage />);
    await flush();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/server configuration issue/i);
  });

  it("LP-6b: ?error=exchange-expired surfaces an actionable message at mount", async () => {
    searchParamsStore = new URLSearchParams({ error: "exchange-expired" });
    render(<LoginPage />);
    await flush();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/sign-in link has expired/i);
  });

  it("LP-6c: ?error=invalid-exchange surfaces an actionable message at mount", async () => {
    searchParamsStore = new URLSearchParams({ error: "invalid-exchange" });
    render(<LoginPage />);
    await flush();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/invalid sign-in link/i);
  });

  it("LP-7: signInWithOtp is called WITHOUT emailRedirectTo (link-prefetch immunity)", async () => {
    render(<LoginPage />);

    mockSignInWithOtp.mockResolvedValueOnce({ data: {}, error: null });
    await clickEmailSubmit("user@test.local");

    await waitFor(() => expect(mockSignInWithOtp).toHaveBeenCalled());
    const callArgs = mockSignInWithOtp.mock.calls[0][0];
    expect(callArgs.email).toBe("user@test.local");
    expect(callArgs.options.shouldCreateUser).toBe(true);
    // Critical: emailRedirectTo must NOT be passed. Including it lets
    // Supabase embed a magic-link {{ .ConfirmationURL }} in the email and
    // email scanners (Gmail/Outlook/corporate gateways) prefetch the URL,
    // consuming the single-use token BEFORE the user types the OTP.
    expect(callArgs.options.emailRedirectTo).toBeUndefined();
  });
});
