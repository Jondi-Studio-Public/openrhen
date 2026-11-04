import { redirect } from "next/navigation";

/** More became You; the old address lands there. */
export default function MorePage() {
  redirect("/you");
}
