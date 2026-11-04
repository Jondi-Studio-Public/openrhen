// What the portal's own code imports to read the extension registry. Importing the seam first
// registers every extension in whichever bundle the reader is in: the server and client graphs are separate, so a
// registration made only in the layout would never reach the browser. The extensions themselves import the
// registry (`portal-extensions.ts`) directly, which keeps the seam free of a cycle.
import "./private/index";
export * from "./portal-extensions";
