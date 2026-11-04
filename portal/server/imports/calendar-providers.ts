// What shared server code imports to reach the registered providers: the private seam is loaded first so the
// registry is populated, then the leaf registry is re-exported. In the OpenRhen export the seam is empty.
import "@/server/private/providers";

export {
  calendarSyncAdapterFor,
  providerConnectionHandlers,
  requestCalendarPublish,
  type ProviderConnectionHandlers
} from "./provider-hooks";
