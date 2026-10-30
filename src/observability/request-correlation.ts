import { logger } from "../utils/logger.js";
export function bindReqId(reqId?: string) {
  if (reqId) logger.child({ reqId });
}
export function logStructured(
  level: string,
  msg: string,
  meta: Record<string, unknown>,
) {
  (logger as any)[level]({ ...meta, reqId: meta.reqId || "none" }, msg);
}
