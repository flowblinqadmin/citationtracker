"use client";

import React, {
  forwardRef,
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useImperativeHandle,
} from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { MessageCircle, X, Send, ChevronDown, Clock, Plus } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";

// ── Design tokens ───────────────────────────────────────────────────────────
const COPPER    = "#c2652a";
const COPPER_BG = "#fff7ed";
const CARD      = "#fff";
const BORDER    = "#e5e5ea";
const TEXT      = "#1d1d1f";
const T2        = "#86868b";
const T3        = "#aeaeb2";
const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ViewContext {
  page: "results" | "dashboard";
  currentTab?: string;
  domain?: string;
  overallScore?: number;
  tier?: "free" | "paid";
  credits?: number;
  pipelineStatus?: string;
  visiblePillarScores?: Array<{ name: string; score: number; priority: string }>;
  visibleRecommendations?: Array<{ rank: number; title: string; priority: string }>;
  expandedPillar?: string;
  expandedRecommendation?: number;
  platformDetected?: string;
}

export interface ChatWidgetSiteData {
  platformDetected?: string;
  lowestPillar?: { name: string; score: number };
  hasIntegrationFailure?: boolean;
}

interface ChatWidgetProps {
  siteId: string;
  token: string;
  viewContext: ViewContext;
  siteData?: ChatWidgetSiteData;
}

interface HistoryConversation {
  id: string;
  preview: string;
  timestamp: string | null;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

export type ChatWidgetHandle = {
  /**
   * Open the panel and seed the textarea with `text`. If `autoSend` is true,
   * dispatches the message immediately; otherwise focuses the textarea so the
   * user can edit before sending.
   */
  openWithSeed: (text: string, autoSend?: boolean) => void;
  /**
   * Show a transient peek bubble above the pill with `text`. Optionally
   * `seedQuery` is the message that gets sent when the bubble is clicked.
   * Respects sessionStorage frequency caps and a 24-hour dismissal.
   */
  showPeek: (text: string, seedQuery?: string) => void;
};

// ── Markdown renderer ───────────────────────────────────────────────────────

function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let codeBlockLines: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      if (codeBlockLines === null) {
        codeBlockLines = [];
      } else {
        elements.push(
          <pre key={`code-${i}`} style={{
            background: "#f0f0f2", padding: "8px 12px", borderRadius: 8,
            fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            overflowX: "auto", margin: "6px 0", whiteSpace: "pre",
          }}>
            <code>{codeBlockLines.join("\n")}</code>
          </pre>
        );
        codeBlockLines = null;
      }
      continue;
    }
    if (codeBlockLines !== null) {
      codeBlockLines.push(line);
      continue;
    }

    if (line.startsWith("### ")) {
      elements.push(<h4 key={i} style={{ fontSize: 13, fontWeight: 700, margin: "8px 0 4px", color: TEXT }}>{renderInline(line.slice(4))}</h4>);
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(<h3 key={i} style={{ fontSize: 14, fontWeight: 700, margin: "10px 0 4px", color: TEXT }}>{renderInline(line.slice(3))}</h3>);
      continue;
    }
    if (/^[-•*]\s/.test(line)) {
      elements.push(
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 2, lineHeight: 1.5 }}>
          <span style={{ color: COPPER, flexShrink: 0 }}>•</span>
          <span>{renderInline(line.replace(/^[-•*]\s/, ""))}</span>
        </div>
      );
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\./)?.[1];
      elements.push(
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 2, lineHeight: 1.5 }}>
          <span style={{ color: COPPER, fontWeight: 600, flexShrink: 0 }}>{num}.</span>
          <span>{renderInline(line.replace(/^\d+\.\s/, ""))}</span>
        </div>
      );
      continue;
    }
    if (!line.trim()) {
      elements.push(<div key={i} style={{ height: 6 }} />);
      continue;
    }
    elements.push(<p key={i} style={{ margin: "2px 0", lineHeight: 1.5 }}>{renderInline(line)}</p>);
  }

  if (codeBlockLines !== null) {
    elements.push(
      <pre key="code-tail" style={{
        background: "#f0f0f2", padding: "8px 12px", borderRadius: 8,
        fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        overflowX: "auto", margin: "6px 0", whiteSpace: "pre",
      }}>
        <code>{codeBlockLines.join("\n")}</code>
      </pre>
    );
  }

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\[(\d+)\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1]) parts.push(<strong key={match.index} style={{ fontWeight: 600 }}>{match[2]}</strong>);
    else if (match[3]) parts.push(<em key={match.index}>{match[4]}</em>);
    else if (match[5]) parts.push(<code key={match.index} style={{ background: "#f0f0f0", padding: "1px 4px", borderRadius: 3, fontSize: "0.9em", fontFamily: "monospace" }}>{match[6]}</code>);
    else if (match[7]) parts.push(<a key={match.index} href={match[9]} target="_blank" rel="noopener noreferrer" style={{ color: COPPER, textDecoration: "underline" }}>{match[8]}</a>);
    else if (match[10]) parts.push(<span key={match.index} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", background: COPPER_BG, color: COPPER, fontSize: 10, fontWeight: 700, width: 16, height: 16, borderRadius: "50%", verticalAlign: "super", margin: "0 1px" }} title={`Source ${match[11]}`}>{match[11]}</span>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? <>{parts}</> : text;
}

function getMessageText(msg: { content?: string; parts?: Array<{ type: string; text?: string }> }): string {
  if (msg.parts?.length) return msg.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!).join("");
  return msg.content ?? "";
}

// ── Suggested questions (dynamic, based on view + site data) ────────────────

function buildSuggestions(
  viewContext: ViewContext,
  siteData: ChatWidgetSiteData | undefined,
): string[] {
  const out: string[] = [];

  if (viewContext.page === "dashboard") {
    return ["How do credits work?", "How do I run a bulk audit?", "What do my scores mean?"];
  }

  if (viewContext.currentTab === "setup" && siteData?.platformDetected) {
    out.push(`How do I install on ${siteData.platformDetected}?`);
  }
  if (siteData?.hasIntegrationFailure) {
    out.push("Why isn't my llms.txt verified?");
  }
  if (siteData?.lowestPillar) {
    out.push(`Why is my ${siteData.lowestPillar.name} pillar low?`);
  }

  out.push("What should I fix first?");
  return out.slice(0, 3);
}

// ── Peek bubble session storage ─────────────────────────────────────────────

const PEEK_COUNT_KEY = "cleo:peek:count";
const PEEK_LAST_KEY = "cleo:peek:lastShownAt";
const PEEK_DISMISSED_KEY = "cleo:peek:dismissedAt";
const PEEK_MAX_PER_SESSION = 3;
const PEEK_MIN_INTERVAL_MS = 30_000;
const PEEK_DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

function canShowPeek(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const dismissedAt = Number(sessionStorage.getItem(PEEK_DISMISSED_KEY) ?? 0);
    if (dismissedAt && Date.now() - dismissedAt < PEEK_DISMISS_TTL_MS) return false;

    const count = Number(sessionStorage.getItem(PEEK_COUNT_KEY) ?? 0);
    if (count >= PEEK_MAX_PER_SESSION) return false;

    const lastShown = Number(sessionStorage.getItem(PEEK_LAST_KEY) ?? 0);
    if (lastShown && Date.now() - lastShown < PEEK_MIN_INTERVAL_MS) return false;

    return true;
  } catch {
    return false;
  }
}

function recordPeekShown() {
  if (typeof window === "undefined") return;
  try {
    const count = Number(sessionStorage.getItem(PEEK_COUNT_KEY) ?? 0) + 1;
    sessionStorage.setItem(PEEK_COUNT_KEY, String(count));
    sessionStorage.setItem(PEEK_LAST_KEY, String(Date.now()));
  } catch { /* ignore */ }
}

function recordPeekDismissed() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(PEEK_DISMISSED_KEY, String(Date.now()));
  } catch { /* ignore */ }
}

// ── Component ───────────────────────────────────────────────────────────────

const ChatWidget = forwardRef<ChatWidgetHandle, ChatWidgetProps>(function ChatWidget(
  { siteId, token, viewContext, siteData },
  ref,
) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryConversation[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [peek, setPeek] = useState<{ text: string; seedQuery?: string } | null>(null);
  const [conversationId] = useState(() =>
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36),
  );
  const isMobile = useMediaQuery(768);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(
    () => buildSuggestions(viewContext, siteData),
    [viewContext, siteData],
  );
  const welcomeMessage = viewContext.page === "results"
    ? "Hi, I'm Cleo! I can help you understand your audit results and implement improvements on your website. What would you like to know?"
    : "Hi, I'm Cleo! I can help you navigate the dashboard, understand your audits, and answer questions about GEO. What can I help with?";

  const viewContextRef = useRef(viewContext);
  viewContextRef.current = viewContext;

  const transport = useMemo(() => new DefaultChatTransport({
    api: `/api/chatbot?siteId=${siteId}`,
    headers: { Authorization: `Bearer ${token}` },
    body: { conversationId },
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { messages, viewContext: viewContextRef.current, conversationId },
    }),
  }), [siteId, token, conversationId]);

  const { messages, sendMessage, status, setMessages } = useChat({
    transport,
    messages: [
      { id: "welcome", role: "assistant", parts: [{ type: "text", text: welcomeMessage }] } as UIMessage,
    ],
  });

  const isStreaming = status === "streaming" || status === "submitted";

  // Imperative API for parent components (SitePageClient) ─────────────────
  useImperativeHandle(ref, () => ({
    openWithSeed: (text: string, autoSend = false) => {
      setIsOpen(true);
      setPeek(null);
      if (autoSend) {
        // Defer to ensure the panel is mounted before dispatching.
        setTimeout(() => sendMessage({ text }), 50);
      } else {
        setInput(text);
        setTimeout(() => inputRef.current?.focus(), 200);
      }
    },
    showPeek: (text: string, seedQuery?: string) => {
      if (isOpen) return;
      if (!canShowPeek()) return;
      recordPeekShown();
      setPeek({ text, seedQuery });
    },
  }), [sendMessage, isOpen]);

  // Fetch conversation history when panel opens
  const fetchHistory = useCallback(async () => {
    if (historyLoaded) return;
    try {
      const res = await fetch(`/api/chatbot?siteId=${siteId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(data.conversations ?? []);
      }
    } catch { /* ignore */ }
    setHistoryLoaded(true);
  }, [siteId, token, historyLoaded]);

  useEffect(() => {
    if (isOpen && !historyLoaded) fetchHistory();
  }, [isOpen, historyLoaded, fetchHistory]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isStreaming]);

  useEffect(() => {
    if (isOpen && inputRef.current && !showHistory) setTimeout(() => inputRef.current?.focus(), 300);
  }, [isOpen, showHistory]);

  // Hide peek bubble whenever the panel opens
  useEffect(() => {
    if (isOpen) setPeek(null);
  }, [isOpen]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    setInput("");
    sendMessage({ text: input.trim() });
  };

  const handleSuggestion = (text: string) => {
    if (isStreaming) return;
    sendMessage({ text });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handlePeekClick = () => {
    if (!peek) return;
    setIsOpen(true);
    if (peek.seedQuery) {
      setTimeout(() => sendMessage({ text: peek.seedQuery! }), 50);
    }
    setPeek(null);
  };

  const handlePeekDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    recordPeekDismissed();
    setPeek(null);
  };

  const restoreConversation = (conv: HistoryConversation) => {
    const restored = conv.messages.map((m, i) => ({
      id: `restored-${i}`,
      role: m.role,
      parts: [{ type: "text" as const, text: m.text }],
    } as UIMessage));
    setMessages(restored);
    setShowHistory(false);
  };

  const startNewConversation = () => {
    setMessages([{ id: "welcome", role: "assistant", parts: [{ type: "text", text: welcomeMessage }] } as UIMessage]);
    setShowHistory(false);
  };

  const showSuggestions = messages.length <= 1 && !showHistory;
  const hasHistory = history.length > 0;

  return (
    <>
      {/* Peek bubble (above the pill, only when panel is closed) */}
      <AnimatePresence>
        {!isOpen && peek && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            onClick={handlePeekClick}
            data-testid="cleo-peek"
            style={{
              position: "fixed", bottom: 80, right: 24,
              maxWidth: 280, padding: "12px 14px",
              background: CARD, border: `1px solid ${BORDER}`,
              borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.10)",
              zIndex: 9999, fontFamily: FONT_STACK, cursor: "pointer",
              fontSize: 13, lineHeight: 1.4, color: TEXT,
            }}
          >
            <button
              type="button"
              onClick={handlePeekDismiss}
              aria-label="Dismiss"
              style={{
                position: "absolute", top: 6, right: 6,
                background: "none", border: "none", cursor: "pointer",
                color: T3, padding: 2, display: "flex",
              }}
            >
              <X size={12} />
            </button>
            <div style={{ paddingRight: 16 }}>{peek.text}</div>
            <div style={{ fontSize: 11, color: COPPER, marginTop: 6, fontWeight: 500 }}>
              Click to ask Cleo →
            </div>
            {/* Tail pointing to the pill */}
            <div style={{
              position: "absolute", bottom: -6, right: 30,
              width: 12, height: 12, background: CARD,
              borderRight: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`,
              transform: "rotate(45deg)",
            }} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pill button — labeled "Ask Cleo" when closed, icon-only when open */}
      <motion.button
        onClick={() => setIsOpen(!isOpen)}
        data-testid="cleo-pill"
        style={{
          position: "fixed", bottom: 24, right: 24,
          height: isOpen ? 44 : 44,
          minWidth: isOpen ? 44 : undefined,
          padding: isOpen ? 0 : "0 18px",
          borderRadius: 28,
          background: `linear-gradient(135deg, ${COPPER}, #a04f1e)`,
          color: "#fff", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          zIndex: 9998, fontFamily: FONT_STACK,
          fontSize: 14, fontWeight: 600,
        }}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        aria-label={isOpen ? "Close chat" : "Ask Cleo"}
      >
        {isOpen ? <X size={18} /> : (
          <>
            <MessageCircle size={16} />
            <span>Ask Cleo</span>
          </>
        )}
      </motion.button>

      {/* Chat panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            style={{
              position: "fixed", bottom: isMobile ? 0 : 78, right: isMobile ? 0 : 24,
              width: isMobile ? "100%" : 400, height: isMobile ? "85vh" : 520,
              borderRadius: isMobile ? "16px 16px 0 0" : 16, background: CARD,
              boxShadow: "0 8px 32px rgba(0,0,0,0.12)", border: `1px solid ${BORDER}`,
              display: "flex", flexDirection: "column", overflow: "hidden",
              zIndex: 9998, fontFamily: FONT_STACK,
            }}
          >
            {/* Header */}
            <div style={{
              padding: "14px 16px", borderBottom: `1px solid ${BORDER}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: COPPER_BG, flexShrink: 0,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34c759" }} />
                <span style={{ fontWeight: 600, fontSize: 14, color: TEXT }}>Cleo</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {hasHistory && (
                  <button
                    onClick={() => setShowHistory(!showHistory)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: showHistory ? COPPER : T2, padding: 4, display: "flex" }}
                    aria-label="Conversation history"
                    title="Past conversations"
                  >
                    <Clock size={16} />
                  </button>
                )}
                {messages.length > 1 && (
                  <button
                    onClick={startNewConversation}
                    style={{ background: "none", border: "none", cursor: "pointer", color: T2, padding: 4, display: "flex" }}
                    aria-label="New conversation"
                    title="New conversation"
                  >
                    <Plus size={16} />
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: T2, padding: 4, display: "flex" }}
                  aria-label="Close chat"
                >
                  <ChevronDown size={18} />
                </button>
              </div>
            </div>

            {/* History panel */}
            {showHistory ? (
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
                <div style={{ padding: "8px 16px", fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Recent Conversations
                </div>
                {history.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => restoreConversation(conv)}
                    style={{
                      width: "100%", textAlign: "left", background: "none", border: "none",
                      padding: "10px 16px", cursor: "pointer", borderBottom: `1px solid ${BORDER}`,
                      fontFamily: FONT_STACK, transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = COPPER_BG)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                  >
                    <div style={{ fontSize: 13, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {conv.preview}
                    </div>
                    <div style={{ fontSize: 11, color: T3, marginTop: 2 }}>
                      {conv.timestamp ? new Date(conv.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                      {" · "}{conv.messages.filter((m) => m.role === "user").length} messages
                    </div>
                  </button>
                ))}
                {history.length === 0 && (
                  <div style={{ padding: "20px 16px", fontSize: 13, color: T3, textAlign: "center" }}>
                    No past conversations yet.
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Messages */}
                <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                  {messages.map((msg) => {
                    const text = getMessageText(msg);
                    if (!text) return null;
                    return (
                      <div key={msg.id} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                        <div style={{
                          maxWidth: "85%", padding: "10px 14px",
                          borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                          background: msg.role === "user" ? COPPER : "#f0f0f2",
                          color: msg.role === "user" ? "#fff" : TEXT,
                          fontSize: 13, lineHeight: 1.5, wordBreak: "break-word",
                        }}>
                          {msg.role === "assistant" ? renderMarkdown(text) : text}
                        </div>
                      </div>
                    );
                  })}

                  {isStreaming && (
                    <div style={{ display: "flex", justifyContent: "flex-start" }}>
                      <div style={{ padding: "10px 14px", borderRadius: "14px 14px 14px 4px", background: "#f0f0f2", display: "flex", gap: 4 }}>
                        {[0, 1, 2].map((i) => (
                          <motion.div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: T2 }}
                            animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }} />
                        ))}
                      </div>
                    </div>
                  )}

                  {showSuggestions && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      {suggestions.map((s) => (
                        <button key={s} onClick={() => handleSuggestion(s)} disabled={isStreaming}
                          style={{
                            background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10,
                            padding: "8px 12px", fontSize: 13, color: COPPER,
                            cursor: isStreaming ? "not-allowed" : "pointer", textAlign: "left",
                            fontFamily: FONT_STACK, transition: "background 0.15s",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = COPPER_BG)}
                          onMouseLeave={(e) => (e.currentTarget.style.background = CARD)}
                        >{s}</button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Input */}
                <div style={{ padding: "10px 12px", borderTop: `1px solid ${BORDER}`, display: "flex", gap: 8, alignItems: "flex-end", flexShrink: 0 }}>
                  <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                    placeholder="Ask about your audit..." disabled={isStreaming} rows={1}
                    style={{
                      flex: 1, resize: "none", border: `1px solid ${BORDER}`, borderRadius: 10,
                      padding: "10px 12px", fontSize: 13, fontFamily: FONT_STACK, outline: "none",
                      maxHeight: 80, lineHeight: 1.4, color: TEXT, background: "#fafafa",
                    }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = COPPER)}
                    onBlur={(e) => (e.currentTarget.style.borderColor = BORDER)}
                  />
                  <button type="button" onClick={handleSend} disabled={!input.trim() || isStreaming}
                    style={{
                      width: 36, height: 36, borderRadius: "50%",
                      background: input.trim() && !isStreaming ? COPPER : "#e5e5ea",
                      color: "#fff", border: "none",
                      cursor: input.trim() && !isStreaming ? "pointer" : "not-allowed",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0, transition: "background 0.15s",
                    }}
                  >
                    <Send size={16} />
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});

export default ChatWidget;
