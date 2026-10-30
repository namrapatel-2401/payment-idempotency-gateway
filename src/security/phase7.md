// Phase 7 Security — Redis integration deferred (Docker unavailable)
export const DEFERRED_TESTS = [
  "redis-ratelimit-integration",
  "docker-testcontainers-integration",
];
export const securityStatus = "helmet+csrf active; redis rate-limit deferred";
