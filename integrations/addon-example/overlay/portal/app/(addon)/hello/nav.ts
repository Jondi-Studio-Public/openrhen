import type { NavExtension } from "@/components/nav-extensions";

/** Puts the example page in the Go to palette, after the Now page. */
const nav: NavExtension = {
  id: "example-addon",
  destinations: [
    {
      after: "/",
      items: [{ href: "/hello", label: "Example add-on", where: "You › Add-ons", keywords: "example hello addon" }]
    }
  ]
};

export default nav;
