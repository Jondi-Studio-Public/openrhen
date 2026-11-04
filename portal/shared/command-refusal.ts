import type { AgentCall } from "@openrhen/contracts";

/**
 * A command the server answered with a refusal (a 4xx body of `{ error, nextCall?, currentVersion?, validValues? }`).
 * It is still an `Error` with the server's own sentence as its message, so every caller that shows `.message` is
 * unchanged; a caller that can act on a refusal (the close button's "Close all" sheet) reads the rest.
 */
export class CommandRefusal extends Error {
  readonly status: number;
  readonly currentVersion: number | undefined;
  readonly nextCall: AgentCall | undefined;
  readonly validValues: Record<string, string[]> | undefined;

  constructor(
    message: string,
    details: {
      status: number;
      currentVersion?: number | undefined;
      nextCall?: AgentCall | undefined;
      validValues?: Record<string, string[]> | undefined;
    }
  ) {
    super(message);
    this.name = "CommandRefusal";
    this.status = details.status;
    this.currentVersion = details.currentVersion;
    this.nextCall = details.nextCall;
    this.validValues = details.validValues;
  }
}
