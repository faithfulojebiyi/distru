import { createFileRoute } from '@tanstack/react-router';

import type { ActorKind } from '../../api/generated/opsAgentAPI.schemas';
import { ActorKind as ACTOR_KINDS } from '../../api/generated/opsAgentAPI.schemas';
import { AuditLog, type AuditSearch } from '../../modules/audit/components/audit-log';
import { Page } from '../../modules/layout/components/page';
import { isDateRange } from '../../modules/system/components/filter-chip';

const isActorKind = (value: unknown): value is ActorKind =>
  Object.values(ACTOR_KINDS).includes(value as ActorKind);

const str = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;

export const Route = createFileRoute('/_authed/audit')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    type: str(search.type),
    actor: isActorKind(search.actor) ? search.actor : undefined,
    proposalId: str(search.proposalId),
    outcome: search.outcome === 'succeeded' || search.outcome === 'refused' || search.outcome === 'failed' ? search.outcome : undefined,
    range: isDateRange(search.range) ? search.range : undefined,
    event: str(search.event),
  }),
  component: Audit,
});

function Audit() {
  const search = Route.useSearch();
  return (
    <Page width="wide"
      title="Audit log"
      description="Every proposal, policy check, decision and write, with who, why, and the values before and after. Append-only; nobody can edit it."
    >
      <AuditLog search={search} />
    </Page>
  );
}
