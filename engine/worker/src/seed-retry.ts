/** Runs `attempt`, retrying with a short backoff, so a worker that starts before the portal answers still seeds. */
export async function withSeedRetry<T>(attempt: () => Promise<T>): Promise<T> {
  const delaysMs = [1_000, 2_000, 4_000];
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (index >= delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[index]));
    }
  }
}
