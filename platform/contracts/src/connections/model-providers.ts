import type { SecretName } from "../secrets.js";

/**
 * The model-provider connections mail understanding can use, as data. Portal code knows only this shape: which
 * connection answers a tier, the secret it needs, which model makers it refuses for retention reasons, and the
 * provider-specific words shown to the person. A provider's name appears here and in its connection under
 * `integrations/outbound-proxy/src/connections/<provider>/`, nowhere else in core logic. The portal is handed a
 * descriptor (`PolicyDeps.hosted`, `ModelTransportDeps.providers`), so another provider is a new descriptor, not a
 * change to the call policy.
 */
export type ModelTier = "local" | "hosted";

export interface ModelProviderDescriptor {
  tier: ModelTier;
  /** The outbound proxy connection id the `model_provider.complete` call is sent to. */
  connectionId: string;
  /** What the person calls it; used in card text and error sentences. */
  label: string;
  /** The provider's published data policy, linked from the card (hosted tier). */
  privacyUrl?: string;
  /** The saved key the call needs (hosted tier). Absent for a provider that needs none. */
  secretName?: SecretName;
  /** Body fields this provider takes: the saved address (local tier), the key (hosted), and fixed extras. */
  body: { addressField?: string; keyField?: string; fixed?: Record<string, unknown> };
  /**
   * Model makers whose own retention or training policy applies on this provider, by the lower-case prefix of the
   * model id (`org/model`), with the name to show. Mail is not sent to these.
   */
  refusedOrgs?: Record<string, string>;
  /** The sentence for a refused model; `org` is the display name from `refusedOrgs`. */
  refusalMessage?: (model: string, org: string) => string;
  /** The privacy paragraph the card shows for this provider (hosted tier). */
  privacyNote?: string;
  /** Local tier: what to run when the test cannot reach the saved address (`intro` is the sentence before the commands). */
  startHelp?: (savedUrl: string | null) => { intro: string; lines: string[]; steps: string[] };
  /** Local tier: the field's hint under the address box. */
  addressHint?: string;
}

const LOCAL_PLACEHOLDER = "<this computer's LAN or tailnet IP>";

function localStartHelp(savedUrl: string | null) {
  let host = LOCAL_PLACEHOLDER;
  let port = "11434";
  try {
    if (savedUrl) {
      const parsed = new URL(savedUrl);
      if (parsed.hostname) {
        host = parsed.hostname;
        if (parsed.port) port = parsed.port;
      }
    }
  } catch {
    // An address that does not parse keeps the placeholder.
  }
  return {
    intro:
      "If Ollama is running but cannot be reached from here, it is probably listening only on its own computer. In PowerShell on the Ollama computer run:",
    lines: [
      `[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "${host}:${port}", "User")`,
      `New-NetFirewallRule -DisplayName "Ollama (mail understanding)" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`
    ],
    steps: [
      "Run both lines in PowerShell on the computer that runs Ollama (the second needs an administrator window).",
      "Quit Ollama from the tray icon, then start it again so it picks up the new address.",
      "Then press Test again."
    ]
  };
}

export const LOCAL_MODEL_PROVIDER: ModelProviderDescriptor = {
  tier: "local",
  connectionId: "ollama",
  label: "Ollama",
  body: { addressField: "baseUrl", fixed: { withDigest: false } },
  addressHint: "The IP address and port of the computer that runs Ollama, on this network or your tailnet.",
  startHelp: localStartHelp
};

export const HOSTED_MODEL_PROVIDER: ModelProviderDescriptor = {
  tier: "hosted",
  connectionId: "deepinfra",
  label: "DeepInfra",
  privacyUrl: "https://docs.deepinfra.com/account/data-privacy",
  secretName: "hosted_model_api_key",
  body: { keyField: "apiKey" },
  refusedOrgs: { google: "Google", anthropic: "Anthropic" },
  refusalMessage: (model, org) =>
    `"${model}" is a ${org} model, and DeepInfra says that company's own storage and training policy applies to it, so mail is not sent to it. Pick another model in Settings > Mail understanding (one whose DeepInfra page says Zero retention).`,
  privacyNote:
    "DeepInfra\u2019s published policy is that it does not log request content or keep it after answering, and does not train on it. That is how every request is handled; there is no setting to turn on, in this app or in your DeepInfra account. The exception is Google or Anthropic models, where that company\u2019s own policy applies, so this app refuses to send mail to them."
};

/** The providers the portal uses today, one per tier. The portal receives these; it never names a provider. */
export const MODEL_PROVIDERS: Record<ModelTier, ModelProviderDescriptor> = {
  local: LOCAL_MODEL_PROVIDER,
  hosted: HOSTED_MODEL_PROVIDER
};
