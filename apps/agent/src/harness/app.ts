import { db } from '../db/client';
import { createAppHarness } from './harness';
import { appPolicyEngine } from './policy';
import { DrizzlePolicyRuleSource } from './policy-rules';
import { appConnectors, appErrorClassifier } from './registry';

/**
 * The process-wide harness: Postgres ports, the app policy engine (built-ins + connector rules),
 * error classification routed per connector, and the *current* registry (read through a getter, so
 * it follows registry rebuilds when the MCP connector connects or its tools change). Shared by the
 * API routes and the restock workflow.
 */
export const appHarness = createAppHarness({ registry: () => appConnectors.registry, errors: appErrorClassifier, policyEngine: appPolicyEngine });

/** Same rule source the harness reads, for policy dry-runs inside the workflow. */
export const appPolicyRules = new DrizzlePolicyRuleSource(db);
