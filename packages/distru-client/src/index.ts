export { createDistruClient, createDistruClientFromEnv } from './client';
export type { DistruClient, BoundOperations, ListOperation, Page, PaginateOptions } from './client';
export {
  DistruApiError,
  distruFetch,
  distruRequest,
  formatErrorItem,
  parseErrorEnvelope,
  parseRetryAfter,
  resolveUrl,
  bracketArrayParams,
} from './mutator';
export type { DistruClientConfig, DistruErrorItem, DistruRequestOptions, FetchLike } from './mutator';
export {
  buildPurchaseOrder,
  buildPurchaseUpdate,
  keepExistingItemsAndAdd,
  verifyPurchase,
  upsertPurchaseVerified,
  findPurchaseByIdempotencyKey,
  idempotencyMarker,
  extractIdempotencyKey,
  IDEMPOTENCY_LOOKBACK_MS,
} from './purchases';
export type { NewPurchaseOrderInput, PurchaseLineInput, PurchaseMismatch, FindPurchaseByIdempotencyKeyOptions } from './purchases';
/** Unbound generated operations (need `{ distru: config }` in options) and their URL builders. */
export * as operations from './generated/distru';
export * from './generated/model';
