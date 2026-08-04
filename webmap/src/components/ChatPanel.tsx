// The AI driver: a chat whose tool calls are executed here in the browser
// (src/ai/executeTool.ts) against the same layer store the panel uses. The
// server only holds the key and streams the model; the map never leaves the
// client.

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { CHAT_API } from "../config";
import { executeTool } from "../ai/executeTool";
import { useMapStore } from "../state/mapStore";

// Keep these to things an anonymous visitor can actually do. Flood extent used
// to lead this list, and now that it's in the restricted tier the first thing a
// new user clicked was the one request that can't succeed — the assistant spent
// ~10 tool calls discovering that before substituting a proxy layer.
const SUGGESTIONS = [
  "Show the latest radar imagery over Central Luzon",
  "What data is available over Central Luzon?",
  "Show NDVI in Nueva Ecija for June 2026",
];

// Human-readable one-liner for a tool invocation chip.
function toolChipLabel(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "resolve_region":
      return `Locating “${i.query}”`;
    case "search_catalog":
      return `Searching catalog${i.datetime ? ` · ${i.datetime}` : ""}`;
    case "get_available_dates":
      return `Checking dates · ${i.collection}`;
    case "add_layers":
      return "Adding layers to the map";
    case "remove_layers":
      return "Removing layers";
    case "update_layer":
      return "Adjusting a layer";
    case "set_view":
      return "Flying to the area";
    case "list_collections":
      return "Listing collections";
    default:
      return toolName;
  }
}

export default function ChatPanel() {
  const [input, setInput] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, addToolResult, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: CHAT_API,
      // Ship the live layer-store snapshot with every request (including the
      // automatic continuations after tool results) so the model always sees
      // the current map.
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages, mapState: useMapStore.getState().snapshot() },
      }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: async ({ toolCall }) => {
      const output = await executeTool(toolCall.toolName, toolCall.input);
      addToolResult({
        tool: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        output,
      });
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setInput("");
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="chattab"
        onClick={() => setCollapsed(false)}
        aria-label="Open map assistant"
        title="Open map assistant"
      >
        <span className="chattab-icon" aria-hidden="true">
          💬
        </span>
        <span className="chattab-label">Map assistant</span>
      </button>
    );
  }

  return (
    <div className="panel chatpanel">
      <div className="chathead">
        <h2 className="chattitle">Map assistant</h2>
        <button
          type="button"
          className="chatcollapse"
          onClick={() => setCollapsed(true)}
          aria-label="Minimise map assistant"
          title="Minimise map assistant"
        >
          ‒
        </button>
      </div>
      <div className="chatlog" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chatempty">
            <p>
              Ask for data in plain language - the assistant finds it in the
              catalog and puts it on the map.
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="suggestion"
                onClick={() => submit(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((part, idx) => {
              if (part.type === "text") {
                return (
                  <p className="msgtext" key={idx}>
                    {part.text}
                  </p>
                );
              }
              // Tool invocations (typed `tool-*` or dynamic) render as chips.
              if (
                part.type === "dynamic-tool" ||
                part.type.startsWith("tool-")
              ) {
                const p = part as {
                  type: string;
                  toolName?: string;
                  state: string;
                  input?: unknown;
                };
                const name = p.toolName ?? part.type.replace(/^tool-/, "");
                const done = p.state === "output-available";
                const failed = p.state === "output-error";
                return (
                  <span
                    key={idx}
                    className={`toolchip${failed ? " failed" : ""}`}
                  >
                    {done ? "✓" : failed ? "✗" : "⋯"}{" "}
                    {toolChipLabel(name, p.input)}
                  </span>
                );
              }
              return null;
            })}
          </div>
        ))}
        {busy && <div className="msg assistant thinking">…</div>}
        {error && (
          <div className="msg assistant err">
            Chat error: {error.message}. Is the chat server running (`npm run
            chat`) with OPENROUTER_API_KEY set in the repo-root .env?
          </div>
        )}
      </div>
      <form
        className="chatform"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. show flood data in Pampanga for early June"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
