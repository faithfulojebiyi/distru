import { emailRecipientDomainsRule } from '@ops/connector-email';
import { BUILTIN_POLICY_RULES, PolicyEngine, type AnyPolicyRule } from '@ops/harness';

/**
 * Every policy rule implementation the app knows: the harness built-ins plus connector-provided
 * rules (`email_recipient_domains` from the email connector). `policy_rule` rows configure them;
 * a row whose key is not here fails closed.
 */
export const APP_POLICY_RULES: readonly AnyPolicyRule[] = [...BUILTIN_POLICY_RULES, emailRecipientDomainsRule];

/** The one engine used by the harness (propose/decide) and by the dry-run helper (review loop, propose tools). */
export const appPolicyEngine = new PolicyEngine(APP_POLICY_RULES);

/** Every action agents may propose: the restock flow is cross-tool (PO → buyer cap → vendor email → hand-off task). */
export const DEFAULT_ALLOWED_ACTIONS = ['distru.purchases.upsert', 'distru_mcp.mutate_product', 'email.send_vendor_po', 'distru.tasks.create'];

/** The mock vendors' purchase-order email domains (distru-mock seed: orders@<vendor name>.com). */
export const DEFAULT_EMAIL_DOMAINS = [
  'humboldtheritagefarms.com',
  'emeraldtrianglegrowers.com',
  'sierraextractsco.com',
  'goldenstateedibles.com',
  'coastalcloudvapes.com',
  'mojaveprerollco.com',
];
