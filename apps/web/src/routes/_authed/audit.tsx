import { createFileRoute } from '@tanstack/react-router';

import type { ActorKind } from '../../api/generated/opsAgentAPI.schemas';
import { ActorKind as ACTOR_KINDS } from '../../api/generated/opsAgentAPI.schemas';
import { AuditLog, type AuditSearch } from '../../modules/audit/components/audit-log';
import { Page } from '../../modules/layout/components/page';

const isActorKind = (value: unknown): value is ActorKind =>
  Object.values(ACTOR_KINDS).includes(value as ActorKind);

const str = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;

export const Route = createFileRoute('/_authed/audit')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    type: str(search.type),
    actor: isActorKind(search.actor) ? search.actor : undefined,
    proposalId: str(search.proposalId),
  }),
  component: Audit,
});

function Audit() {
  const search = Route.useSearch();
  return (
    <Page
      title="Audit log"
      description="Every proposal, policy check, decision and write, newest first. Append-only."
    >
      <AuditLog search={search} />
    </Page>
  );
}
