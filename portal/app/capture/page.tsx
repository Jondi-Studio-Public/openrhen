import { redirect } from "next/navigation";

/** Capture lives in the Inbox's Captured room now; the old address lands there. */
export default function CapturePage() {
  redirect("/inbox/captured");
}
