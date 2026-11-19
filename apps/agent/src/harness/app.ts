import { distruErrorClassifier } from '@ops/connector-distru';
import { db } from '../db/client';
import { createAppHarness } from './harness';
import { DrizzlePolicyRuleSource } from './policy-rules';
import { appRegistry } from './registry';

/**
 * The process-wide harness over the app registry: Postgres ports, Distru error classification
 * (429/5xx retryable, Retry-After honoured). Shared by the API routes and the restock workflow.
 */
export const appHarness = createAppHarness({ registry: appRegistry, errors: distruErrorClassifier });

/** Same rule source the harness reads, for policy dry-runs inside the workflow. */
export const appPolicyRules = new DrizzlePolicyRuleSource(db);
