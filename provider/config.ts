export interface ProviderConfig {
  port: number;
  failureRate: number; // 0.0 to 1.0
  timeoutRate: number; // 0.0 to 1.0
  minLatencyMs: number;
  maxLatencyMs: number;
}

export const providerConfig: ProviderConfig = {
  port: parseInt(process.env.PROVIDER_PORT || '3001', 10),
  failureRate: parseFloat(process.env.PROVIDER_FAILURE_RATE || '0.1'),
  timeoutRate: parseFloat(process.env.PROVIDER_TIMEOUT_RATE || '0.1'),
  minLatencyMs: parseInt(process.env.PROVIDER_MIN_LATENCY_MS || '100', 10),
  maxLatencyMs: parseInt(process.env.PROVIDER_MAX_LATENCY_MS || '500', 10),
};
