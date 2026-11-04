/** Log level for a worker-triggered portal route's HTTP status: a non-2xx answer is a failure, not news. */
export function triggerResponseLevel(httpStatus: number): "info" | "error" {
  return httpStatus >= 200 && httpStatus < 300 ? "info" : "error";
}

type LogWrite = (stream: "stdout" | "stderr", line: Record<string, unknown>) => void;

/**
 * POST to a portal trigger route and say whether it actually ran. Only a 2xx counts: a 401/403/5xx or a
 * throw returns false (so the caller leaves its last-run time alone) and is logged at error level.
 */
export async function postTrigger(input: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  okMessage: string;
  errorMessage: string;
  failedMessage: string;
  workerId: string;
  write: LogWrite;
}): Promise<boolean> {
  try {
    const response = await input.fetchImpl(input.url, input.init);
    const level = triggerResponseLevel(response.status);
    input.write(level === "error" ? "stderr" : "stdout", {
      level,
      message: level === "error" ? input.errorMessage : input.okMessage,
      workerId: input.workerId,
      httpStatus: response.status
    });
    return level === "info";
  } catch (error) {
    input.write("stderr", {
      level: "error",
      message: input.failedMessage,
      workerId: input.workerId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return false;
  }
}

/** Enqueue leave-by pushes, then drain the outbox whether or not the enqueue worked: the drain does not depend on it. */
export async function runLeaveByPushTick(input: {
  enqueue: () => Promise<void>;
  drain: (() => Promise<void>) | null;
  onEnqueueError: (error: unknown) => void;
}): Promise<void> {
  try {
    await input.enqueue();
  } catch (error) {
    input.onEnqueueError(error);
  }
  if (input.drain) await input.drain();
}
