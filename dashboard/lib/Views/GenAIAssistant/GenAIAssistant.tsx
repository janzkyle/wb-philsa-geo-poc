// The PhilSA POC GenAI assistant chat panel.
//
// A self-contained floating panel: it snapshots the live dashboard
// (captureDashboardContext) on every send, posts {context, messages} to our
// proxy, and streams the reply back token-by-token. The proxy — never this
// component — holds the OpenRouter key.

import MarkdownIt from "markdown-it";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Terria from "terriajs/lib/Models/Terria";
import { captureDashboardContext } from "../../Models/genai/dashboardContext";
import { genaiProxyUrl } from "../../Models/genai/openrouterConfig";

// The model replies in markdown. Render it — but keep it chat-appropriate:
// `html: false` escapes any raw HTML the model emits (XSS-safe), and tables are
// disabled because a wide grid can't fit a narrow chat panel.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.disable("table");
// Open any links in a new tab, safely.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Split a "| a | b | c |" row into trimmed cells (leading/trailing pipes optional).
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// A GFM table separator row, e.g. `|---|:--:|---:|`.
function isTableSeparator(line: string): boolean {
  if (!line || !line.includes("-")) return false;
  const cells = splitTableRow(line);
  return (
    cells.length > 0 &&
    cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")))
  );
}

// Models sometimes ignore the "no tables" instruction. Disabling markdown-it's
// table rule alone would just leave raw `| … |` pipes on screen, so instead we
// rewrite any GFM table into a nested bullet list (one bullet per row, the first
// column as its bold label) BEFORE rendering. Deterministic — doesn't rely on
// the model behaving.
function flattenTables(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const sep = lines[i + 1];
    const looksLikeTable =
      header.includes("|") &&
      header.trim() !== "" &&
      sep !== undefined &&
      isTableSeparator(sep);
    if (!looksLikeTable) {
      out.push(header);
      continue;
    }
    const headers = splitTableRow(header);
    i += 2; // consume header + separator
    while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
      const cells = splitTableRow(lines[i]);
      const label = cells[0] || "";
      out.push(`- **${label}**`);
      for (let c = 1; c < headers.length; c++) {
        const value = cells[c] ?? "";
        if (value === "") continue;
        const key = headers[c] ? `${headers[c]}: ` : "";
        out.push(`  - ${key}${value}`);
      }
      i++;
    }
    i--; // the for-loop will re-increment
  }
  return out.join("\n");
}

function renderMarkdown(text: string): { __html: string } {
  return { __html: md.render(flattenTables(text)) };
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  terria: Terria;
  isOpen: boolean;
  onClose: () => void;
}

const PHILSA_BLUE = "#1d5285";

// Scoped styling for the markdown the model returns (inline styles can't target
// generated child elements, so this small stylesheet handles them).
const MD_CSS = `
.genai-md { white-space: normal; }
.genai-md > *:first-child { margin-top: 0; }
.genai-md > *:last-child { margin-bottom: 0; }
.genai-md p { margin: 0 0 8px; }
.genai-md ul, .genai-md ol { margin: 0 0 8px; padding-left: 20px; }
.genai-md li { margin: 2px 0; }
.genai-md h1, .genai-md h2, .genai-md h3, .genai-md h4 {
  margin: 10px 0 4px; font-size: 14px; font-weight: 700;
}
.genai-md code {
  background: #eef2f6; padding: 1px 4px; border-radius: 4px;
  font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace;
}
.genai-md pre {
  background: #eef2f6; padding: 8px; border-radius: 6px; overflow-x: auto;
  margin: 0 0 8px;
}
.genai-md pre code { background: none; padding: 0; }
.genai-md a { color: ${PHILSA_BLUE}; }
.genai-md strong { font-weight: 700; }
.genai-md blockquote {
  margin: 0 0 8px; padding-left: 10px; border-left: 3px solid #cdd8e2;
  color: #55697b;
}
`;

const EXPLAIN_PROMPT =
  "Explain what's currently shown on the map — the active layers, what they " +
  "measure, their dates, and what this view tells me.";

// Pull assistant text out of one OpenRouter SSE `data:` payload.
function deltaFromSSE(jsonStr: string): string {
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed?.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

const GenAIAssistant: React.FC<Props> = ({ terria, isOpen, onClose }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages, loading]);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || loading) {
        return;
      }
      setError(undefined);
      setInput("");

      const history: ChatMessage[] = [
        ...messages,
        { role: "user", content: question }
      ];
      // Add the user turn plus an empty assistant turn we stream into.
      setMessages([...history, { role: "assistant", content: "" }]);
      setLoading(true);

      try {
        const context = captureDashboardContext(terria);
        const res = await fetch(genaiProxyUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context, messages: history })
        });

        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(
            detail?.error || `Request failed (HTTP ${res.status}).`
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistant = "";

        // Parse the SSE stream line-by-line, appending deltas as they arrive.
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) {
              continue;
            }
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              continue;
            }
            assistant += deltaFromSSE(data);
            const soFar = assistant;
            setMessages((prev) => {
              const next = prev.slice();
              next[next.length - 1] = { role: "assistant", content: soFar };
              return next;
            });
          }
        }

        if (!assistant) {
          throw new Error("The model returned an empty response.");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(
          `${msg} — check that the GenAI proxy is running (genai-proxy/server.js).`
        );
        // Drop the empty assistant bubble we optimistically added.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last && last.role === "assistant" && last.content === ""
            ? prev.slice(0, -1)
            : prev;
        });
      } finally {
        setLoading(false);
      }
    },
    [loading, messages, terria]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div style={styles.panel} aria-label="GenAI assistant">
      <style>{MD_CSS}</style>
      <div style={styles.header}>
        <span style={styles.title}>Dashboard Assistant</span>
        <button
          type="button"
          style={styles.iconBtn}
          onClick={onClose}
          title="Close"
          aria-label="Close assistant"
        >
          ×
        </button>
      </div>

      <div ref={scrollRef} style={styles.transcript}>
        {messages.length === 0 && !loading ? (
          <div style={styles.empty}>
            Ask about the layers you have on the map, or start with{" "}
            <strong>Explain this view</strong>. Answers are grounded in the
            metadata of what&apos;s currently displayed.
          </div>
        ) : null}

        {messages.map((m, i) =>
          m.role === "assistant" ? (
            <div key={i} style={{ ...styles.bubble, ...styles.aiBubble }}>
              {m.content ? (
                <div
                  className="genai-md"
                  dangerouslySetInnerHTML={renderMarkdown(m.content)}
                />
              ) : loading && i === messages.length - 1 ? (
                "…"
              ) : (
                ""
              )}
            </div>
          ) : (
            <div key={i} style={{ ...styles.bubble, ...styles.userBubble }}>
              {m.content}
            </div>
          )
        )}
      </div>

      {error ? <div style={styles.error}>{error}</div> : null}

      <div style={styles.controls}>
        <button
          type="button"
          style={styles.explainBtn}
          onClick={() => send(EXPLAIN_PROMPT)}
          disabled={loading}
        >
          Explain this view
        </button>
        <div style={styles.inputRow}>
          <input
            type="text"
            style={styles.input}
            placeholder="Ask a question about this view…"
            value={input}
            disabled={loading}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                send(input);
              }
            }}
          />
          <button
            type="button"
            style={styles.sendBtn}
            onClick={() => send(input)}
            disabled={loading || input.trim().length === 0}
          >
            {loading ? "…" : "Send"}
          </button>
        </div>
        <div style={styles.disclaimer}>
          Proof of concept — not for navigation, emergency response, or precise
          analysis.
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "fixed",
    bottom: 180,
    right: 16,
    width: 360,
    maxWidth: "calc(100vw - 32px)",
    height: 520,
    maxHeight: "calc(100vh - 160px)",
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    borderRadius: 10,
    boxShadow: "0 8px 30px rgba(0,0,0,0.28)",
    zIndex: 1000,
    fontFamily: "'Segoe UI', Roboto, Helvetica, sans-serif",
    overflow: "hidden"
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    background: PHILSA_BLUE,
    color: "#fff"
  },
  title: { fontWeight: 700, fontSize: 15 },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    fontSize: 22,
    lineHeight: 1,
    cursor: "pointer",
    padding: 0,
    width: 24,
    height: 24
  },
  transcript: {
    flex: 1,
    overflowY: "auto",
    padding: 14,
    background: "#f4f7fa"
  },
  empty: { color: "#5a6b7b", fontSize: 13, lineHeight: 1.5 },
  bubble: {
    padding: "8px 12px",
    borderRadius: 12,
    marginBottom: 10,
    fontSize: 13.5,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxWidth: "88%"
  },
  userBubble: {
    background: PHILSA_BLUE,
    color: "#fff",
    marginLeft: "auto",
    borderBottomRightRadius: 3
  },
  aiBubble: {
    background: "#fff",
    color: "#1b2a38",
    border: "1px solid #dce4ec",
    borderBottomLeftRadius: 3
  },
  error: {
    background: "#fdecea",
    color: "#8a1c12",
    fontSize: 12.5,
    padding: "8px 14px",
    borderTop: "1px solid #f5c6c0"
  },
  controls: {
    padding: 12,
    borderTop: "1px solid #e2e8ee",
    background: "#fff"
  },
  explainBtn: {
    width: "100%",
    padding: "8px 10px",
    marginBottom: 8,
    background: "#eaf1f8",
    color: PHILSA_BLUE,
    border: `1px solid ${PHILSA_BLUE}`,
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer"
  },
  inputRow: { display: "flex", gap: 8 },
  input: {
    flex: 1,
    padding: "8px 10px",
    border: "1px solid #c4d0dc",
    borderRadius: 8,
    fontSize: 13,
    outline: "none"
  },
  sendBtn: {
    padding: "8px 14px",
    background: PHILSA_BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer"
  },
  disclaimer: {
    marginTop: 8,
    fontSize: 10.5,
    color: "#8496a6",
    lineHeight: 1.4
  }
};

export default GenAIAssistant;
