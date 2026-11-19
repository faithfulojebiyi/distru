/**
 * Connector-provided policy rule: recipient-domain allowlist for outgoing email.
 *
 * The harness `PolicyEngine` takes rule implementations at construction, and rules see each op's
 * `payload`, so a connector can ship its own rule. Register it alongside the built-ins:
 *
 * ```ts
 * policyEngine: new PolicyEngine([...BUILTIN_POLICY_RULES, emailRecipientDomainsRule])
 * // policy_rule row: { key: 'email_recipient_domains', params: { domains: ['humboldt.example'] } }
 * ```
 */
import { definePolicyRule, type PolicyFinding } from '@ops/harness';
import { z } from 'zod';
import { domainOf } from './shared';

export const EMAIL_RECIPIENT_DOMAINS_RULE = 'email_recipient_domains';

const Recipients = z.object({ to: z.array(z.string()), cc: z.array(z.string()).default([]) });

export const emailRecipientDomainsRule = definePolicyRule({
  key: EMAIL_RECIPIENT_DOMAINS_RULE,
  description: 'Deny (or require approval for) emails to recipients outside the allowed domains.',
  params: z.object({
    domains: z.array(z.string().min(1)).min(1),
    /** Ops on these resources are checked (default: the email connector's `emails`). */
    resources: z.array(z.string()).default(['emails']),
    onViolation: z.enum(['deny', 'needs_approval']).default('deny'),
  }),
  evaluate(subject, { domains, resources, onViolation }) {
    const allowed = new Set(domains.map((d) => d.toLowerCase().replace(/^@/, '')));
    const findings: PolicyFinding[] = [];
    let checked = 0;
    for (const op of subject.ops) {
      if (!resources.includes(op.resource)) continue;
      checked++;
      const parsed = Recipients.safeParse(op.payload);
      if (!parsed.success) {
        findings.push({ outcome: 'deny', message: `Op #${op.index}: recipients cannot be read (failing closed)` });
        continue;
      }
      for (const addr of [...parsed.data.to, ...parsed.data.cc]) {
        const domain = domainOf(addr);
        // Subdomains of an allowed domain are allowed (mail.humboldt.example ⊂ humboldt.example).
        const ok = [...allowed].some((d) => domain === d || domain.endsWith(`.${d}`));
        if (!ok) findings.push({ outcome: onViolation, message: `Op #${op.index}: recipient ${addr} is outside the allowed domains` });
      }
    }
    if (findings.length) return findings;
    return checked ? [{ outcome: 'pass', message: 'All email recipients are on allowed domains' }] : [];
  },
});
