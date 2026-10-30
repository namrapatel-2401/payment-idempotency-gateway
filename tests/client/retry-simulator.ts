export function simulateRetry(request: { key: string; count: number }) {
  // Client retry simulator — used in E2E scenarios
  return {
    key: request.key,
    attempts: request.count,
    deferred: "needs Docker for real HTTP",
  };
}
