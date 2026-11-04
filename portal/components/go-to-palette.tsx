"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useModalFocus } from "@/shared/use-modal-focus";
import { closeGoTo, openGoTo, useGoToOpen } from "@/shared/use-go-to";
import { openCaptureSheet } from "@/shared/use-capture-sheet";
import { searchPalette, type Destination } from "./app-nav-tabs";
import { SearchIcon } from "./icons";
import styles from "./go-to-palette.module.css";

/**
 * Ctrl K (Cmd K on a Mac): one box over every page and setting, so the rail only has to list the five
 * places. Arrow keys move, Enter opens, Escape closes. The list is `destinations` in app-nav-tabs, the
 * same table the tab highlighting reads.
 */
export function GoToPalette() {
  const open = useGoToOpen();

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openGoTo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Mounted only while open, so each opening starts from an empty box.
  return open ? <GoToDialog /> : null;
}

function GoToDialog() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = searchPalette(query);
  const selected = results[Math.min(index, results.length - 1)];
  const selectedId = selected ? `${listId}-${Math.max(results.indexOf(selected), 0)}` : undefined;
  // Arrow keys move the highlight through a list taller than the box, so keep it in sight.
  useEffect(() => {
    if (selectedId) document.getElementById(selectedId)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);
  const { onKeyDown: trapKeys } = useModalFocus({
    active: true,
    trapRef: dialogRef,
    initialFocusRef: fieldRef,
    onClose: closeGoTo
  });

  const go = (item: Destination) => {
    closeGoTo();
    // Next tick, once the palette has handed focus back: the sheet then remembers the real trigger as
    // its opener, and Escape returns there rather than to the palette's unmounted input.
    if (item.action) setTimeout(() => openCaptureSheet(item.action!), 0);
    else router.push(item.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex(
        (current) => (Math.min(current, results.length - 1) + step + results.length) % Math.max(results.length, 1)
      );
      return;
    }
    // Enter that commits an IME composition is not a choice.
    if (event.key === "Enter" && selected && !event.nativeEvent.isComposing) {
      event.preventDefault();
      go(selected);
      return;
    }
    trapKeys(event);
  };

  return (
    <div className={styles.scrim} onMouseDown={(event) => event.target === event.currentTarget && closeGoTo()}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        onKeyDown={onKeyDown}
      >
        <div ref={fieldRef} className={styles.field}>
          <SearchIcon size={20} />
          <input
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={selectedId}
            aria-label="Go to"
            placeholder="Go to a page, or capture something"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>
        <ul className={styles.list} id={listId} role="listbox" aria-label="Places">
          {results.map((item, at) => (
            <li
              key={item.href}
              id={`${listId}-${at}`}
              role="option"
              aria-selected={item === selected}
              className={styles.option}
              onMouseMove={() => setIndex(results.indexOf(item))}
              onClick={() => go(item)}
            >
              <span className={styles.label}>{item.label}</span>
              <span className={styles.where}>{item.where}</span>
            </li>
          ))}
          {results.length === 0 && <li className={styles.empty}>Nothing called that. Try a page or setting name.</li>}
        </ul>
        <p className={styles.foot}>
          <span>↑ ↓ to move</span>
          <span>Enter to open</span>
        </p>
      </div>
    </div>
  );
}
