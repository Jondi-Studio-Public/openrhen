import { redirect } from "next/navigation";

/** The Import centre lives in the Inbox's Calendar & imports room now; the old address keeps working. */
export default function ImportPage() {
  redirect("/inbox/calendar");
}
