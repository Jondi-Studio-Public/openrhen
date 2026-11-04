"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { CoordinationState, HandoffKind } from "@openrhen/contracts";
import { copyText, formatBytes, label, phaseLabel, type Phase } from "@/features/deliverables/deliverable-model";
import { useCoordination, type CoordinationPrompts } from "@/features/deliverables/use-coordination";
import { createSseParser } from "@/shared/sse";
import { formatZonedTime } from "@/shared/date-format";
import { isVersionConflictError } from "@/shared/use-server-draft";
import type { PortalState, StoredDeliverable } from "@/state/portal-state";

const COLLAPSE_AFTER_LINES = 14;
const COLLAPSE_AFTER_CHARS = 1200;
const PREVIEW_LINES = 8;

type ChatBlock = { kind: "text"; content: string } | { kind: "bullets"; items: string[] };

// Deliberately minimal, not a markdown parser: **bold** spans and "- " lines as bullet lists, and
// nothing else — no headings, links, or code. Good enough that a checklist the assistant writes
// doesn't show its literal asterisks and hyphens.
function chatBlocks(content: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let textLines: string[] = [];
  let bulletItems: string[] = [];
  const flushText = () => {
    if (textLines.length) blocks.push({ kind: "text", content: textLines.join("\n") });
    textLines = [];
  };
  const flushBullets = () => {
    if (bulletItems.length) blocks.push({ kind: "bullets", items: bulletItems });
    bulletItems = [];
  };
  for (const line of content.split("\n")) {
    if (line.startsWith("- ")) {
      flushText();
      bulletItems.push(line.slice(2));
    } else {
      flushBullets();
      textLines.push(line);
    }
  }
  flushText();
  flushBullets();
  return blocks;
}

function chatInline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    )
  );
}

function ChatFormatted({ content }: { content: string }) {
  return (
    <>
      {chatBlocks(content).map((block, index) =>
        block.kind === "bullets" ? (
          <ul key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{chatInline(item)}</li>
            ))}
          </ul>
        ) : (
          <p key={index}>{chatInline(block.content)}</p>
        )
      )}
    </>
  );
}

// A rendered contract checklist can land as a single 60-line message, and unclipped it buried the
// composer below the fold. Long stored turns collapse to a short preview with a line count to expand;
// short turns render exactly as before, a bare <p>. Collapsing is decided on the raw content's line
// count, independent of the light formatting applied to whatever ends up shown.
function ChatText({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const collapsible = lines.length > COLLAPSE_AFTER_LINES || content.length > COLLAPSE_AFTER_CHARS;
  if (!collapsible) return <ChatFormatted content={content} />;
  if (expanded)
    return (
      <>
        <ChatFormatted content={content} />
        <button type="button" className="chat-expand" onClick={() => setExpanded(false)}>
          Show less
        </button>
      </>
    );
  return (
    <>
      <ChatFormatted content={`${lines.slice(0, PREVIEW_LINES).join("\n")}\n…`} />
      <button type="button" className="chat-expand" onClick={() => setExpanded(true)}>
        Show all {lines.length} lines
      </button>
    </>
  );
}

export interface ChatImage {
  filename: string;
  mimeType: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "external";
  content: string;
  attachments: ChatImage[];
  createdAt: string;
  meta?: { kind: HandoffKind; tool: string };
}

/**
 * What undoing the latest applying turn needs, kept in page memory only: the deliverable as it was
 * before the turn's first applied move, and the version after its last. `changed` means a save was
 * refused because something else moved the deliverable since.
 */
interface TurnUndo {
  messageId: string;
  before: StoredDeliverable;
  expectedVersion: number;
  status: "ready" | "working" | "undone" | "changed";
}

const imageDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });

/**
 * The phase-aware workspace conversation: a thread of turns with the assistant and a composer that accepts
 * pasted or attached images alongside text. History is readable in every mode; sending needs the
 * editable session, the same rule as every other workspace edit. The assistant proposes changes in
 * words first; after clear agreement it may add those exact criteria and steps to the side rails.
 */
export function ChatPanel({
  deliverableId,
  phase,
  editable,
  dirty = false,
  reloadKey = 0,
  timezone,
  deliverable,
  onApplied,
  onUndo,
  onCoordination
}: {
  deliverableId: string;
  phase: Phase;
  editable: boolean;
  /** True while the workspace holds an unsaved draft; assistant edits are withheld so a later save cannot erase them. */
  dirty?: boolean;
  /**
   * Bumped by the workspace when something outside the composer writes to the thread — attaching a
   * source appends its notice server-side — so the history is re-read instead of silently trailing.
   */
  reloadKey?: number;
  timezone: string;
  /** The deliverable as the page holds it now; read when a turn's first move applies, to keep what an undo restores. */
  deliverable?: StoredDeliverable | null;
  /** Receives the fresh server state after the assistant applies an agreed addition to the workspace. */
  onApplied?: (state: PortalState) => void;
  /** Saves the deliverable back as it was, against the version the turn left it at; rejects if that version has moved on. */
  onUndo?: (before: StoredDeliverable, expectedVersion: number) => Promise<void>;
  /** Called when coordination state or prompts change, e.g. to swap to a handed-off overview. */
  onCoordination?: (coordination: CoordinationState | null, prompts: CoordinationPrompts | null) => void;
}) {
  const {
    messages: loadedMessages,
    coordination,
    prompts,
    error: loadError
  } = useCoordination(deliverableId, reloadKey);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ file: File; dataUrl: string }[]>([]);
  const [sending, setSending] = useState(false);
  /** The assistant's turn so far, rendered live while the reply streams. Empty means thinking. */
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState("");
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const [undo, setUndo] = useState<TurnUndo | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const deliverableRef = useRef(deliverable);
  useEffect(() => {
    deliverableRef.current = deliverable;
  }, [deliverable]);
  const phaseCopy = {
    Breakdown: {
      description: "Define what done means and turn it into a workable plan.",
      empty: "Paste the brief or a rubric screenshot, or ask me to shape the completion criteria and steps.",
      placeholder: "Plan this deliverable with the Breakdown assistant…"
    },
    "Carry out": {
      description: "Work through the plan together and show me progress as you go.",
      empty: "Ask what to do next, paste a progress screenshot, or tell me which planned step you have finished.",
      placeholder: "Work with the assistant — paste progress images…"
    },
    Review: {
      description: "Audit the finished work against every agreed requirement.",
      empty: "Show me the finished work or submission evidence and I’ll check it criterion by criterion.",
      placeholder: "Ask the Review assistant to check the completed work…"
    }
  }[phase];
  // "Do the work assistant" reads badly, so the doing stage's helper is simply the working assistant.
  const assistantName = phase === "Carry out" ? "Working assistant" : `${phase} assistant`;

  // The thread follows what the coordination hook last loaded, including the first load.
  const [shownLoaded, setShownLoaded] = useState<typeof loadedMessages | undefined>(undefined);
  if (shownLoaded !== loadedMessages) {
    setShownLoaded(loadedMessages);
    setMessages(loadedMessages);
  }

  useEffect(() => {
    onCoordination?.(coordination, prompts);
  }, [coordination, prompts, onCoordination]);

  // Pinned to the latest turn, like any chat: new content scrolls the thread, not the page.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, sending, streamText]);

  async function addFiles(files: File[]) {
    const accepted = files.filter((file) => file.type.startsWith("image/"));
    if (!accepted.length) return;
    try {
      const loaded = await Promise.all(accepted.map(async (file) => ({ file, dataUrl: await imageDataUrl(file) })));
      setImages((current) => [...current, ...loaded].slice(0, 4));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the image.");
    }
  }

  async function copyHandoffPrompt() {
    if (!prompts) return;
    const ok = await copyText(prompts.handoff);
    if (ok) {
      setCopyFallback(false);
      setCopyConfirmed(true);
      setTimeout(() => setCopyConfirmed(false), 2500);
    } else {
      setCopyConfirmed(false);
      setCopyFallback(true);
    }
  }

  async function undoTurn() {
    if (!undo || !onUndo) return;
    setUndo({ ...undo, status: "working" });
    try {
      await onUndo(undo.before, undo.expectedVersion);
      setUndo({ ...undo, status: "undone" });
    } catch (cause) {
      const changed = isVersionConflictError(cause);
      setUndo({ ...undo, status: changed ? "changed" : "ready" });
      if (!changed) setError(cause instanceof Error ? cause.message : "The changes could not be undone.");
    }
  }

  async function send() {
    const content = text.trim();
    if ((!content && !images.length) || sending) return;
    setSending(true);
    setStreamText("");
    setError("");
    let turnBefore: StoredDeliverable | null = null;
    let turnVersion: number | null = null;
    try {
      const response = await fetch(`/api/deliverables/${encodeURIComponent(deliverableId)}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: content,
          images: images.map(({ file, dataUrl }) => ({
            filename: file.name || "pasted-image",
            mimeType: file.type,
            dataUrl
          })),
          allowEdits: !dirty
        })
      });
      // Validation failures still come back as plain JSON; only an accepted turn streams.
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "The assistant request failed.");
      }
      let failure = "";
      let finished = false;
      const parse = createSseParser((data) => {
        const event = JSON.parse(data) as {
          kind: string;
          text?: string;
          messages?: ChatMessage[];
          error?: string;
          state?: PortalState;
        };
        if (event.kind === "delta" && event.text) setStreamText((current) => current + event.text);
        else if (event.kind === "applied" && event.state) {
          // The page has not seen this turn's first move yet, so what it holds is the pre-turn deliverable.
          turnBefore ??= deliverableRef.current ?? null;
          turnVersion = event.state.deliverables.find((item) => item.id === deliverableId)?.version ?? null;
          onApplied?.(event.state);
        } else if (event.kind === "done" && event.messages) {
          // Both in one handler so React commits them together: the stored turn replaces the live
          // bubble in a single frame instead of doubling it for one.
          setMessages((current) => [...(current ?? []), ...event.messages!]);
          setStreamText("");
          const reply = event.messages.filter((item) => item.role === "assistant").at(-1);
          if (reply && turnBefore && turnVersion !== null)
            setUndo({ messageId: reply.id, before: turnBefore, expectedVersion: turnVersion, status: "ready" });
          finished = true;
        } else if (event.kind === "error") failure = event.error ?? "The assistant request failed.";
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
      parse(decoder.decode());
      if (failure) throw new Error(failure);
      if (!finished) throw new Error("The reply stream ended early.");
      setText("");
      setImages([]);
    } catch (cause) {
      // The user's turn is stored before the model is called, so on failure the history is the
      // truth worth showing — reload it rather than leaving the composer looking unsent.
      setError(cause instanceof Error ? cause.message : "The assistant request failed.");
      try {
        const response = await fetch(`/api/deliverables/${encodeURIComponent(deliverableId)}/chat`);
        const payload = (await response.json()) as { messages?: ChatMessage[] };
        if (payload.messages) {
          setMessages(payload.messages);
          setText("");
          setImages([]);
        }
      } catch {
        /* keep the composer content for a manual retry */
      }
    } finally {
      setSending(false);
      setStreamText("");
    }
  }

  return (
    <div className="workspace-coordination-stack">
      {prompts && (
        <section className="handoff-offer" aria-label="Coordinate in a desktop AI">
          <div className="handoff-offer-copy">
            <span className="chat-assistant-mark" aria-hidden="true">
              ↗
            </span>
            <div>
              <strong>Coordinate in a desktop AI</strong>
              <p>
                Hand this deliverable to a desktop AI coordinator — it reads the real files and works the plan directly.
              </p>
            </div>
          </div>
          <div className="handoff-offer-actions">
            <button type="button" onClick={() => void copyHandoffPrompt()}>
              Copy the handoff prompt
            </button>
            {copyConfirmed && (
              <span role="status" className="chat-copy-status">
                Copied the prompt.
              </span>
            )}
          </div>
          {copyFallback && (
            <div className="chat-copy-fallback">
              <p className="microcopy">Clipboard copy failed — select the text below and copy it manually.</p>
              <textarea
                aria-label="Handoff prompt"
                readOnly
                value={prompts?.handoff ?? ""}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          )}
        </section>
      )}
      <div
        className={`chat-panel chat-panel-${phase.toLocaleLowerCase().replace(" ", "-")}`}
        aria-label={`${assistantName} conversation (backup)`}
      >
        <header className="chat-panel-header">
          <span className="chat-assistant-mark" aria-hidden="true">
            ✦
          </span>
          <div>
            <strong>{assistantName}</strong>
            <p>{phaseCopy.description}</p>
          </div>
          <div className="chat-header-actions">
            <span className="chat-phase-badge">{phaseLabel(phase)}</span>
            {prompts && (
              <span
                className="chat-fallback-badge"
                title="Your own AI app, offered above, is the main way to work on this. This chat is the backup."
              >
                Backup
              </span>
            )}
          </div>
        </header>
        <div className="chat-thread" ref={threadRef}>
          {messages === null && <p className="microcopy">Loading the conversation…</p>}
          {messages?.length === 0 && !error && !loadError && <p className="chat-empty">{phaseCopy.empty}</p>}
          {messages?.map((message) =>
            message.role === "external" ? (
              <div className="chat-message external" key={message.id}>
                <small className="chat-external-meta">
                  {message.meta?.kind === "drop_off" && message.content
                    ? `Summary from ${message.meta.tool} · ${formatZonedTime(message.createdAt, timezone)}`
                    : `${message.meta?.tool ?? "External tool"} · ${label(message.meta?.kind ?? "note")} · ${formatZonedTime(message.createdAt, timezone)}`}
                </small>
                {message.content && <ChatText content={message.content} />}
              </div>
            ) : (
              <div className={`chat-message ${message.role}`} key={message.id}>
                {message.attachments.length > 0 && (
                  <div className="chat-message-images">
                    {message.attachments.map((attachment, index) => (
                      <img src={attachment.dataUrl} alt={attachment.filename} key={index} />
                    ))}
                  </div>
                )}
                {message.content && <ChatText content={message.content} />}
                {undo?.messageId === message.id && !sending && !dirty && onUndo && (
                  <>
                    {(undo.status === "ready" || undo.status === "working") && (
                      <button
                        type="button"
                        className="chat-expand"
                        disabled={undo.status === "working"}
                        onClick={() => void undoTurn()}
                      >
                        Undo these changes
                      </button>
                    )}
                    {undo.status === "undone" && (
                      <p role="status" className="microcopy">
                        Changes undone.
                      </p>
                    )}
                    {undo.status === "changed" && (
                      <p role="status" className="microcopy">
                        The deliverable changed since, so these changes can’t be undone.
                      </p>
                    )}
                  </>
                )}
              </div>
            )
          )}
          {sending &&
            (streamText ? (
              <div className="chat-message assistant streaming">
                <ChatFormatted content={streamText} />
              </div>
            ) : (
              <div className="chat-message assistant pending">Thinking…</div>
            ))}
        </div>
        {(error || loadError) && (
          <p role="alert" className="error chat-error">
            {error || loadError}
          </p>
        )}
        {editable ? (
          <div className="chat-composer">
            {images.length > 0 && (
              <div className="chat-attachment-row">
                {images.map(({ file, dataUrl }, index) => (
                  <span className="chat-attachment" key={index}>
                    <img src={dataUrl} alt={file.name || "pasted image"} />
                    <small>{formatBytes(file.size)}</small>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name || "pasted image"}`}
                      onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              aria-label="Message the assistant"
              rows={2}
              maxLength={8000}
              value={text}
              placeholder={phaseCopy.placeholder}
              disabled={sending}
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                const files = [...event.clipboardData.items]
                  .filter((item) => item.kind === "file")
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => Boolean(file));
                if (files.length) {
                  event.preventDefault();
                  void addFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="chat-composer-row">
              <label className="file-picker">
                Add image
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  disabled={sending}
                  onChange={(event) => {
                    void addFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
              </label>
              <button type="button" disabled={sending || (!text.trim() && !images.length)} onClick={() => void send()}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        ) : (
          <p className="microcopy chat-readonly-note">Start the deliverable from Now to talk to the assistant.</p>
        )}
      </div>
    </div>
  );
}
