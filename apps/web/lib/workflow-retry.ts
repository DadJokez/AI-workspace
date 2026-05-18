export interface RetrySourceRun {
  id: string;
  status: string;
  error: string | null;
}

export function canRetryWorkflowRun(status: string): boolean {
  return status === "failed" || status === "canceled";
}

export function buildWorkflowRunInputs({
  prompt,
  retrySource,
  retryRequestedAt,
}: {
  prompt: string;
  retrySource?: RetrySourceRun | null;
  retryRequestedAt?: Date;
}): Record<string, unknown> {
  if (!retrySource) return { prompt };
  return {
    prompt,
    retryOfRunId: retrySource.id,
    retryOfStatus: retrySource.status,
    retryOfError: retrySource.error,
    retryRequestedAt: (retryRequestedAt ?? new Date()).toISOString(),
  };
}
