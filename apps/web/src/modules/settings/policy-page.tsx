// Adapted from carbonme modules/settings/code-network-settings.tsx (a draft held in state, read-only for members who
// cannot manage it with a note saying so, TagInput for domain lists, RadioGroup rows for a mode, and Discard / Save
// actions that only enable once the draft differs) inside carbonme modules/settings/settings-page.tsx SettingsPanel.
// Rule switches are carbonme's settings Switch rows; the "as evaluated" list is the Approvals policy panel.
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Input } from '@ops/ui/primitives/input';
import { RadioGroup, RadioGroupItem } from '@ops/ui/primitives/radio-group';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Switch } from '@ops/ui/primitives/switch';
import { TagInput } from '@ops/ui/primitives/tag-input';
import { Span } from '@ops/ui/primitives/text';
import { ApiError, apiErrorMessage } from '../../api/errors';
import type {
  PolicyRule,
  PolicyRuleInput,
  PolicyRuleType,
} from '../../api/generated/opsAgentAPI.schemas';
import { PolicyReasons } from '../proposals/components/policy-panel';
import { PolicyBadge } from '../proposals/components/badges';
import { formatDateTime } from '../proposals/proposal-values';
import { useProposal, useProposals } from '../proposals/proposals-api';
import { useMe } from '../session/session-api';
import { usePolicyRules, useUpdatePolicyRules } from './settings-api';
import { SettingsPage, SettingsPanel } from './settings-page';

/** How people read each rule type; unknown types are title-cased from their key. */
const RULE_TITLES: Record<string, string> = {
  max_total_value: 'Maximum proposal total',
  auto_approve_below: 'Auto-approve small changes',
  high_risk_requires_approval: 'High risk needs a human',
  allowed_actions: 'Allowed actions',
  vendor_allowlist: 'Vendor allowlist',
  email_recipient_domains: 'Email recipient domains',
};

const PARAM_LABELS: Record<string, string> = {
  max: 'Maximum total',
  amount: 'Below this total',
  currency: 'Currency',
  max_risk: 'Highest risk allowed',
  actions: 'Actions',
  resources: 'Resources',
  vendorIds: 'Vendor ids',
  domains: 'Domains',
  onViolation: 'When violated',
};

const ENUM_LABELS: Record<string, string> = {
  deny: 'Deny the proposal',
  needs_approval: 'Ask a human',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const titleOf = (key: string) =>
  RULE_TITLES[key] ?? key.split('_').map((word, index) => (index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word)).join(' ');

const labelOf = (key: string) => PARAM_LABELS[key] ?? key.replace(/_/g, ' ');

/** The slice of JSON Schema the rule types use: numbers, strings (maybe an enum), string arrays, booleans. */
const PropertySchema = z.looseObject({
  type: z.string().optional(),
  enum: z.array(z.string()).optional(),
  minimum: z.number().optional(),
  items: z.looseObject({ type: z.string().optional() }).optional(),
});
const ParamsSchema = z.looseObject({
  properties: z.record(z.string(), PropertySchema).optional(),
  required: z.array(z.string()).optional(),
});

type Field =
  | { name: string; kind: 'number'; required: boolean; minimum: number | undefined }
  | { name: string; kind: 'string'; required: boolean }
  | { name: string; kind: 'enum'; required: boolean; options: string[] }
  | { name: string; kind: 'list'; required: boolean }
  | { name: string; kind: 'boolean'; required: boolean };

const fieldsOf = (type: PolicyRuleType | undefined): Field[] => {
  const parsed = ParamsSchema.safeParse(type?.paramsSchema ?? {});
  if (!parsed.success) return [];
  const required = new Set(parsed.data.required ?? []);
  return Object.entries(parsed.data.properties ?? {}).flatMap(([name, prop]): Field[] => {
    const base = { name, required: required.has(name) };
    if (prop.enum?.length) return [{ ...base, kind: 'enum', options: prop.enum }];
    if (prop.type === 'number' || prop.type === 'integer') return [{ ...base, kind: 'number', minimum: prop.minimum }];
    if (prop.type === 'array') return [{ ...base, kind: 'list' }];
    if (prop.type === 'boolean') return [{ ...base, kind: 'boolean' }];
    if (prop.type === 'string') return [{ ...base, kind: 'string' }];
    return [];
  });
};

type Draft = { key: string; enabled: boolean; description: string; params: Record<string, unknown> };

const draftOf = (rules: readonly PolicyRule[]): Draft[] =>
  rules.map((rule) => ({ key: rule.key, enabled: rule.enabled, description: rule.description ?? '', params: { ...rule.params } }));

const inputOf = (draft: readonly Draft[]): PolicyRuleInput[] =>
  draft.map((rule) => ({
    key: rule.key,
    enabled: rule.enabled,
    params: rule.params,
    description: rule.description.trim() ? rule.description.trim() : null,
  }));

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** `invalid_policy` issues by rule key, plus the overall message; anything else is one message. */
const failureOf = (error: unknown): { message: string; issues: Map<string, string[]> } => {
  const issues = new Map<string, string[]>();
  if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'issues' in error.body) {
    const parsed = z.array(z.object({ key: z.string(), message: z.string() })).safeParse(error.body.issues);
    for (const issue of parsed.success ? parsed.data : []) issues.set(issue.key, [...(issues.get(issue.key) ?? []), issue.message]);
  }
  return { message: apiErrorMessage(error), issues };
};

const ParamField = ({
  field,
  value,
  readOnly,
  onChange,
  ruleKey,
}: {
  field: Field;
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
  ruleKey: string;
}) => {
  const id = `policy-${ruleKey}-${field.name}`;
  const label = (
    <Span fontWeight="500" fontSize="1">
      {labelOf(field.name)}
      {field.required ? null : (
        <Span color="text.muted" fontWeight="400">
          {' '}
          (optional)
        </Span>
      )}
    </Span>
  );
  switch (field.kind) {
    case 'number':
      return (
        <styled.label htmlFor={id} display="flex" flexDirection="column" gap="1">
          {label}
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={field.minimum}
            value={typeof value === 'number' ? value : ''}
            readOnly={readOnly}
            disabled={readOnly}
            onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
            maxW="14rem"
            data-policy-param={field.name}
          />
        </styled.label>
      );
    case 'string':
      return (
        <styled.label htmlFor={id} display="flex" flexDirection="column" gap="1">
          {label}
          <Input
            id={id}
            value={typeof value === 'string' ? value : ''}
            readOnly={readOnly}
            disabled={readOnly}
            onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
            maxW="14rem"
            data-policy-param={field.name}
          />
        </styled.label>
      );
    case 'enum':
      return (
        <Flex direction="column" gap="1">
          {label}
          <RadioGroup
            value={typeof value === 'string' ? value : ''}
            onValueChange={(next) => onChange(next)}
            disabled={readOnly}
            aria-label={labelOf(field.name)}
            gap="1"
            display="flex"
            flexWrap="wrap"
            data-policy-param={field.name}
          >
            {field.options.map((option) => (
              <styled.label
                key={option}
                display="flex"
                alignItems="center"
                gap="2"
                px="2.5"
                py="1.5"
                rounded="lg"
                bg={value === option ? 'brand.panel.4' : 'transparent'}
                cursor={readOnly ? 'default' : 'pointer'}
                _hover={readOnly ? undefined : { bg: 'brand.panel.4' }}
              >
                <RadioGroupItem value={option} />
                <Span fontSize="1.5">{ENUM_LABELS[option] ?? option}</Span>
              </styled.label>
            ))}
          </RadioGroup>
        </Flex>
      );
    case 'list': {
      const items = stringList(value);
      return (
        <Flex direction="column" gap="1" data-policy-param={field.name}>
          {label}
          <TagInput
            value={items}
            setValue={(next) => onChange([...new Set(next.map((item) => item.trim()))].filter(Boolean))}
            placeholder="Type a value, then Enter"
            readOnly={readOnly}
          />
          {readOnly && items.length === 0 ? <Span color="text.muted">None</Span> : null}
        </Flex>
      );
    }
    case 'boolean':
      return (
        <HStack gap="2.5" data-policy-param={field.name}>
          <Switch checked={value === true} disabled={readOnly} onCheckedChange={(on) => onChange(on)} aria-label={labelOf(field.name)} />
          {label}
        </HStack>
      );
  }
};

const RuleCard = ({
  rule,
  type,
  readOnly,
  issues,
  update,
  remove,
}: {
  rule: Draft;
  type: PolicyRuleType | undefined;
  readOnly: boolean;
  issues: string[];
  update: (rule: Draft) => void;
  remove: () => void;
}) => {
  const fields = fieldsOf(type);
  return (
    <Flex
      direction="column"
      gap="3"
      px="4"
      py="3.5"
      rounded="lg"
      bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
      opacity={rule.enabled ? undefined : '0.75'}
      data-policy-rule={rule.key}
      aria-invalid={issues.length ? true : undefined}
    >
      <HStack gap="3" alignItems="flex-start">
        <Switch
          mt="0.5"
          checked={rule.enabled}
          disabled={readOnly}
          onCheckedChange={(on) => update({ ...rule, enabled: on })}
          aria-label={`${titleOf(rule.key)} enabled`}
          data-policy-enabled={rule.key}
        />
        <Flex direction="column" gap="0.5" flex="1" minW="0">
          <HStack gap="2" flexWrap="wrap">
            <Span fontWeight="600" fontSize="1.5">
              {titleOf(rule.key)}
            </Span>
            <styled.code fontFamily="mono" fontSize="1" color="text.muted">
              {rule.key}
            </styled.code>
          </HStack>
          <Span color="text.muted">{type?.description ?? 'This rule type is no longer offered by the engine.'}</Span>
        </Flex>
        {readOnly ? null : (
          <Button size="xs" variant="ghost" onClick={remove} aria-label={`Remove ${titleOf(rule.key)}`}>
            <Icons.trash size={13} />
          </Button>
        )}
      </HStack>
      {fields.length > 0 ? (
        <Flex direction="column" gap="3" pl={{ md: '11' }}>
          {fields.map((field) => (
            <ParamField
              key={field.name}
              field={field}
              ruleKey={rule.key}
              value={rule.params[field.name]}
              readOnly={readOnly}
              onChange={(value) => {
                const params = { ...rule.params };
                if (value === undefined) delete params[field.name];
                else params[field.name] = value;
                update({ ...rule, params });
              }}
            />
          ))}
        </Flex>
      ) : null}
      <Box pl={{ md: '11' }}>
        <styled.label display="flex" flexDirection="column" gap="1">
          <Span fontWeight="500" fontSize="1">
            Note{' '}
            <Span color="text.muted" fontWeight="400">
              (shown in policy reasons)
            </Span>
          </Span>
          <Input
            value={rule.description}
            readOnly={readOnly}
            disabled={readOnly}
            maxLength={500}
            onChange={(event) => update({ ...rule, description: event.target.value })}
            placeholder="Why this rule exists"
          />
        </styled.label>
      </Box>
      {issues.map((issue) => (
        <HStack key={issue} gap="2" alignItems="flex-start" color="text.error" fontSize="1" role="alert" pl={{ md: '11' }} data-policy-issue={rule.key}>
          <Icons.alertCircle size={13} flexShrink="0" mt="0.5" />
          <span>{issue}</span>
        </HStack>
      ))}
    </Flex>
  );
};

/** The editable rule set: approvers change it, operators read it. Save replaces the whole set (PUT). */
const RulesEditor = ({ canManage }: { canManage: boolean }) => {
  const rules = usePolicyRules();
  const update = useUpdatePolicyRules();
  const [draft, setDraft] = useState<Draft[]>([]);

  useEffect(() => {
    if (rules.data) setDraft(draftOf(rules.data.items));
  }, [rules.data]);

  const types = useMemo(() => new Map((rules.data?.available ?? []).map((type) => [type.key, type])), [rules.data]);
  const saved = useMemo(() => JSON.stringify(inputOf(draftOf(rules.data?.items ?? []))), [rules.data]);

  if (rules.isPending) return <Skeleton h="64" rounded="xl" />;
  if (rules.isError)
    return (
      <SettingsPanel title="Rules" data-policy-rules="">
        <Span color="text.muted" fontSize="1.5" role="alert">
          Could not load the policy rules.{' '}
          <styled.button type="button" textDecoration="underline" onClick={() => void rules.refetch()}>
            Try again
          </styled.button>
        </Span>
      </SettingsPanel>
    );

  const changed = JSON.stringify(inputOf(draft)) !== saved;
  const failure = update.isError ? failureOf(update.error) : null;
  const unused = (rules.data.available ?? []).filter((type) => !draft.some((rule) => rule.key === type.key));
  const readOnly = !canManage || update.isPending;

  return (
    <SettingsPanel
      title="Rules"
      description="Deterministic checks the harness runs on every proposal before a human sees it. Agents cannot change them; every save is audited as policy.changed."
      data-policy-rules=""
    >
      {!canManage && (
        <Span color="text.muted" data-policy-read-only="">
          Only approvers can change policy rules.
        </Span>
      )}
      <Flex direction="column" gap="1.5">
        {draft.map((rule, index) => (
          <RuleCard
            key={rule.key}
            rule={rule}
            type={types.get(rule.key)}
            readOnly={readOnly}
            issues={failure?.issues.get(rule.key) ?? []}
            update={(next) => setDraft(draft.map((item, at) => (at === index ? next : item)))}
            remove={() => setDraft(draft.filter((_, at) => at !== index))}
          />
        ))}
        {draft.length === 0 ? (
          <Span color="text.muted" fontSize="1.5">
            No rules: every proposal needs a human decision.
          </Span>
        ) : null}
      </Flex>
      {canManage && unused.length > 0 ? (
        <Flex direction="column" gap="1.5" data-policy-add="">
          <Span fontWeight="500">Add a rule</Span>
          <HStack gap="1.5" flexWrap="wrap">
            {unused.map((type) => (
              <Button
                key={type.key}
                size="xs"
                variant="soft"
                disabled={readOnly}
                title={type.description}
                onClick={() => setDraft([...draft, { key: type.key, enabled: true, description: '', params: {} }])}
              >
                <Icons.add size={12} />
                {titleOf(type.key)}
              </Button>
            ))}
          </HStack>
        </Flex>
      ) : null}
      {failure ? (
        <HStack gap="2" alignItems="flex-start" px="3" py="2.5" rounded="lg" bg="brand.error.3" color="text.error" fontSize="1.5" role="alert" data-policy-failure="">
          <Icons.warn size={14} flexShrink="0" mt="0.5" />
          <span>
            {failure.issues.size > 0
              ? `Not saved: ${[...failure.issues.values()].flat().length} problem${[...failure.issues.values()].flat().length === 1 ? '' : 's'} in the rules above.`
              : failure.message}
          </span>
        </HStack>
      ) : null}
      {canManage ? (
        <HStack gap="2" justify="flex-end">
          <Button
            variant="soft"
            disabled={!changed || update.isPending}
            onClick={() => {
              update.reset();
              setDraft(draftOf(rules.data.items));
            }}
          >
            Discard
          </Button>
          <Button disabled={!changed || update.isPending} onClick={() => update.mutate({ rules: inputOf(draft) })} data-policy-save="">
            {update.isPending ? <Icons.loading size={13} /> : null}
            Save
          </Button>
        </HStack>
      ) : null}
    </SettingsPanel>
  );
};

/** The newest proposal's evaluation: every configured rule reports on every proposal, so this lists them all. */
const LatestEvaluation = ({ proposalId }: { proposalId: string }) => {
  const proposal = useProposal(proposalId);

  if (proposal.isPending) return <Skeleton h="40" rounded="lg" />;

  if (!proposal.data)
    return (
      <styled.p color="text.muted" fontSize="1.5">
        Could not load the latest proposal.
      </styled.p>
    );

  return (
    <Flex direction="column" gap="3">
      <HStack gap="2" fontSize="1" color="text.muted" flexWrap="wrap">
        <span>Applied to</span>
        <Link to="/approvals/$proposalId" params={{ proposalId }}>
          <styled.span color="text.app" fontWeight="500" _hover={{ textDecoration: 'underline' }}>
            {proposal.data.title ?? 'the latest proposal'}
          </styled.span>
        </Link>
        <span>· {formatDateTime(proposal.data.createdAt)}</span>
        <PolicyBadge outcome={proposal.data.policy.outcome} />
      </HStack>
      <PolicyReasons reasons={proposal.data.policy.reasons} />
    </Flex>
  );
};

/** Settings → Policy rules: the editable rule set, then how it judged the newest proposal. */
export const PolicyPage = () => {
  const me = useMe();
  const proposals = useProposals();
  const latest = proposals.data?.[0];

  return (
    <SettingsPage
      title="Policy rules"
      description="Deterministic rules the harness runs on every proposal before a human sees it. Agents cannot change them."
    >
      {me.isPending ? <Skeleton h="64" rounded="xl" /> : <RulesEditor canManage={me.data?.canApprove ?? false} />}
      <SettingsPanel
        title="Last evaluation"
        description="How the rules in force judged the newest proposal."
        data-policy-latest=""
      >
        {proposals.isPending ? (
          <Skeleton h="40" rounded="lg" />
        ) : latest ? (
          <LatestEvaluation proposalId={latest.id} />
        ) : (
          <styled.p color="text.muted" fontSize="1.5">
            No proposals yet. Start a restock run and the rules show here once the first proposal is evaluated.
          </styled.p>
        )}
      </SettingsPanel>
    </SettingsPage>
  );
};
