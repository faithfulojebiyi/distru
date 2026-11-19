export { headsetConnector } from './connector';
export { createHeadsetContext, createHeadsetContextFromEnv, resolveProducts, label, type HeadsetCtx } from './shared';
export {
  createHeadsetClient,
  createHeadsetClientFromEnv,
  HeadsetApiError,
  DEFAULT_HEADSET_BASE_URL,
  type HeadsetClient,
  type HeadsetClientConfig,
  type FetchLike,
  type TrendRow,
  type SellThroughRow,
  type Mover,
  type Product,
  type Store,
} from './client';
export {
  blendDemandSignal,
  classifyRetailSignal,
  classifyOosTrend,
  BLEND,
  SIGNAL_THRESHOLDS,
  MIN_UNITS_4W,
  RetailSignalSchema,
  OosTrendSchema,
  RecommendationSchema,
  type BlendInput,
  type BlendResult,
  type RetailSignal,
  type OosTrend,
  type Recommendation,
} from './signal';
export {
  retailTrendsTool,
  retailSellThroughTool,
  topMoversTool,
  demandSignalTool,
  RetailTrendsOutput,
  SellThroughOutput,
  TopMoversOutput,
  DemandSignalOutput,
} from './tools';
