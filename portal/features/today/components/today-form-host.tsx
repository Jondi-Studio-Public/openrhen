"use client";

import type { ReactNode } from "react";
import { Sheet } from "@/components/sheet";

/**
 * Where a Today editor lives. On a phone the form rises in a sheet — opened from a launcher button
 * or the moment an item is picked for editing — so the page itself stays a list of what today
 * holds. On a desk the same form sits inline in the structure panel, where it always was. The form
 * inside is the same component either way; only its container changes.
 */
export function TodayFormHost({
  phone,
  open,
  title,
  onClose,
  children
}: {
  phone: boolean;
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!phone) return <>{children}</>;
  return (
    <Sheet open={open} onClose={onClose} title={title} className="today-form-sheet">
      {children}
    </Sheet>
  );
}
