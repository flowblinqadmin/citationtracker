"use client";

import { useState, useRef } from "react";
import type { SiteData, TabId } from "../types";
import type { DiscoveredCompetitor, UserCompetitor } from "@/lib/types/citation";

export interface SiteActions {
  // Auth
  handleEmailAuth: (e: React.FormEvent) => Promise<void>;
  email: string;
  setEmail: (v: string) => void;
  authLoading: boolean;
  authError: string | null;
  emailInputRef: React.RefObject<HTMLInputElement | null>;

  // Score
  handleRefreshScore: () => Promise<void>;
  retrying: boolean;
  refreshError: string | null;

  // Citations
  handleScanCitations: () => Promise<void>;
  citationScanActive: boolean;

  // Competitors
  handleMapCompetitors: () => Promise<void>;
  competitorScanActive: boolean;
  handleAddCompetitor: () => Promise<void>;
  handleRemoveCompetitor: (name: string) => Promise<void>;
  addCompetitorName: string;
  setAddCompetitorName: (v: string) => void;
  addCompetitorLoading: boolean;
  addCompetitorError: string | null;
  addCompetitorDomain: string;
  setAddCompetitorDomain: (v: string) => void;
  showDomainInput: boolean;
  setShowDomainInput: (v: boolean) => void;

  // Downloads
  handleDownloadZip: () => Promise<void>;
  downloadError: string | null;
  // NOTE: PDF download stays inline in ActionSidebar (depends on hoveredRail local state)

  // Connection
  handleTestConnection: () => Promise<void>;
  testingConnection: boolean;
  connectionResult: { connected: boolean; detail: string } | null;

  // Other platform
  handleOtherPlatform: () => Promise<void>;
  otherPlatform: string;
  setOtherPlatform: (v: string) => void;
  otherConfig: string;
  otherLoading: boolean;
  otherError: string;
}

export function useSiteActions(
  siteId: string,
  token: string | null,
  site: SiteData | null,
  setSite: React.Dispatch<React.SetStateAction<SiteData | null>>,
  setToken: React.Dispatch<React.SetStateAction<string | null>>,
  setActiveTab: (tab: TabId) => void,
  poll: () => Promise<void>,
  setDiscoveredCompetitors: React.Dispatch<React.SetStateAction<DiscoveredCompetitor[]>>,
  setUserCompetitors: React.Dispatch<React.SetStateAction<UserCompetitor[]>>,
  setCompetitorBlocklist: React.Dispatch<React.SetStateAction<string[]>>,
): SiteActions {
  const [retrying, setRetrying] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [citationScanActive, setCitationScanActive] = useState(false);
  const [competitorScanActive, setCompetitorScanActive] = useState(false);
  const [addCompetitorName, setAddCompetitorName] = useState("");
  const [addCompetitorLoading, setAddCompetitorLoading] = useState(false);
  const [addCompetitorError, setAddCompetitorError] = useState<string | null>(null);
  const [addCompetitorDomain, setAddCompetitorDomain] = useState("");
  const [showDomainInput, setShowDomainInput] = useState(false);
  const [email, setEmail] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ connected: boolean; detail: string } | null>(null);
  const [otherPlatform, setOtherPlatform] = useState("");
  const [otherConfig, setOtherConfig] = useState("");
  const [otherLoading, setOtherLoading] = useState(false);
  const [otherError, setOtherError] = useState("");

  // ── Email gate auth ───────────────────────────────────────────────────────────
  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json() as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setAuthError(
          data.error === "Email does not match"
            ? "That email doesn't match our records for this report."
            : "Something went wrong. Try again."
        );
        emailInputRef.current?.focus();
        return;
      }
      sessionStorage.setItem(`geo-token-${siteId}`, data.token);
      setToken(data.token);
    } catch {
      setAuthError("Network error. Please try again.");
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Download handler (fetch-based, no <a download> JSON file bug) ────────────
  async function handleDownloadZip() {
    if (!token) return;
    try {
      const res = await fetch(`/api/sites/${siteId}/download-report?token=${token}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Download failed" }));
        setDownloadError(data.error ?? "Download failed");
        setTimeout(() => setDownloadError(null), 4000);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${site?.domain ?? "report"}-geo-audit.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await poll();
    } catch {
      setDownloadError("Download failed");
      setTimeout(() => setDownloadError(null), 4000);
    }
  }

  // ── Action handlers ───────────────────────────────────────────────────────────
  async function handleRefreshScore() {
    if (!token || retrying) return;
    setRetrying(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/regenerate?token=${token}`, { method: "POST" });
      if (res.status === 202) {
        setSite((prev) => prev ? { ...prev, pipelineStatus: "queued" } : prev);
        await poll();
      } else if (res.status === 402) {
        setRefreshError("Not enough credits");
        setTimeout(() => setRefreshError(null), 4000);
      } else if (res.status === 409) {
        setRefreshError("Scan already in progress");
        setTimeout(() => setRefreshError(null), 4000);
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setRefreshError(data.error ?? "Failed to start — try again");
        setTimeout(() => setRefreshError(null), 4000);
      }
    } catch { /* ignore */ } finally { setRetrying(false); }
  }

  async function handleScanCitations() {
    if (!token || citationScanActive) return;
    setCitationScanActive(true);
    setActiveTab("overview");
    try {
      const res = await fetch(`/api/sites/${siteId}/citation-check?token=${token}`, { method: "POST" });
      if (!res.ok || !res.body) { setCitationScanActive(false); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
      }
      // Stream complete — refresh site data (including credit balance)
      await poll();
    } catch { /* ignore */ } finally {
      setCitationScanActive(false);
    }
  }

  async function handleMapCompetitors() {
    if (!token || competitorScanActive) return;
    setCompetitorScanActive(true);
    try {
      const res = await fetch(`/api/sites/${siteId}/competitor-discovery?token=${token}`, { method: "POST" });
      if (!res.ok || !res.body) { setCompetitorScanActive(false); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6)) as {
              type: string;
              competitors?: DiscoveredCompetitor[];
              creditsUsed?: number;
              slotsRemaining?: number;
            };
            if (evt.type === "complete" && evt.competitors) {
              setDiscoveredCompetitors(evt.competitors);
              setSite((prev) => prev
                ? { ...prev, credits: prev.credits - (evt.creditsUsed ?? 2) }
                : prev
              );
            }
          } catch { /* ignore malformed */ }
        }
      }
      await poll();
    } finally {
      setCompetitorScanActive(false);
    }
  }

  async function handleAddCompetitor() {
    const name = addCompetitorName.trim();
    if (!name || addCompetitorLoading) return;
    setAddCompetitorLoading(true);
    setAddCompetitorError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "add", name, domain: addCompetitorDomain.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setAddCompetitorError(data.error); return; }
      setUserCompetitors(data.userCompetitors);
      setDiscoveredCompetitors(data.discoveredCompetitors);
      setCompetitorBlocklist(data.blocklist);
      setAddCompetitorName("");
      setAddCompetitorDomain("");
      setShowDomainInput(false);
    } catch { setAddCompetitorError("Network error"); }
    finally { setAddCompetitorLoading(false); }
  }

  async function handleRemoveCompetitor(name: string) {
    try {
      const res = await fetch(`/api/sites/${siteId}/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "remove", name }),
      });
      const data = await res.json();
      if (res.ok) {
        setUserCompetitors(data.userCompetitors);
        setDiscoveredCompetitors(data.discoveredCompetitors);
        setCompetitorBlocklist(data.blocklist);
      }
    } catch { /* ignore */ }
  }

  async function handleTestConnection() {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/verify-connection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setConnectionResult({ connected: data.connected, detail: data.detail });
    } catch {
      setConnectionResult({ connected: false, detail: "Failed to test connection. Please try again." });
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleOtherPlatform() {
    setOtherLoading(true);
    setOtherError("");
    setOtherConfig("");
    try {
      const res = await fetch("/api/integration-instructions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: otherPlatform.trim(), siteId }),
      });
      if (!res.ok) throw new Error("Failed to generate instructions");
      const data = await res.json();
      setOtherConfig(data.instructions);
    } catch (err: unknown) {
      setOtherError(err instanceof Error ? err.message : "Failed to generate instructions");
    } finally {
      setOtherLoading(false);
    }
  }

  return {
    // Auth
    handleEmailAuth,
    email,
    setEmail,
    authLoading,
    authError,
    emailInputRef,

    // Score
    handleRefreshScore,
    retrying,
    refreshError,

    // Citations
    handleScanCitations,
    citationScanActive,

    // Competitors
    handleMapCompetitors,
    competitorScanActive,
    handleAddCompetitor,
    handleRemoveCompetitor,
    addCompetitorName,
    setAddCompetitorName,
    addCompetitorLoading,
    addCompetitorError,
    addCompetitorDomain,
    setAddCompetitorDomain,
    showDomainInput,
    setShowDomainInput,

    // Downloads
    handleDownloadZip,
    downloadError,

    // Connection
    handleTestConnection,
    testingConnection,
    connectionResult,

    // Other platform
    handleOtherPlatform,
    otherPlatform,
    setOtherPlatform,
    otherConfig,
    otherLoading,
    otherError,
  };
}
