import type {
  AuditEvent,
  PolicyOutcome,
} from '../../api/generated/opsAgentAPI.schemas';
import { actorName, formatMoney, formatPath } from '../proposals/proposal-values';
import { TONES, type Tone } from '../proposals/components/badges';
import type { Icons } from '@ops/ui/icons/base';


/** The harness audit event types, each with the verb a person reads and the tone of its marker. */
export const AUDIT_TYPES: Record<
  string,
  { verb: string; label: string; tone: Tone; icon: keyof typeof Icons }
> = {
  'proposal.created': { verb: 'proposed', label: 'Proposed', tone: TONES.info, icon: 'noteAdd' },
  'policy.evaluated': { verb: 'ran policy checks', label: 'Policy evaluated', tone: TONES.muted, icon: 'shieldCheck' },
  'proposal.decided': { verb: 'decided', label: 'Decided', tone: TONES.good, icon: 'userVerified' },
  'proposal.decision_blocked': { verb: 'was blocked by policy', label: 'Decision blocked', tone: TONES.bad, icon: 'ban' },
  'proposal.execution_started': { verb: 'started executing', label: 'Execution started', tone: TONES.running, icon: 'play' },
  'op.executed': { verb: 'wrote', label: 'Write executed', tone: TONES.good, icon: 'database' },
  'op.deduplicated': { verb: 'skipped duplicate write', label: 'Duplicate skipped', tone: TONES.info, icon: 'copyCheck' },
  'op.retry': { verb: 'retried a write', label: 'Write retried', tone: TONES.waiting, icon: 'refresh' },
  'op.verified': { verb: 'verified the write', label: 'Write verified', tone: TONES.good, icon: 'checkCheck' },
  'op.verify_failed': { verb: 'found a mismatch after writing', label: 'Verify failed', tone: TONES.bad, icon: 'warn' },
  'op.failed': { verb: 'failed a write', label: 'Write failed', tone: TONES.bad, icon: 'closeCircle' },
  'proposal.executed': { verb: 'finished executing', label: 'Executed', tone: TONES.good, icon: 'checkCircle' },
  'proposal.failed': { verb: 'failed executing', label: 'Execution failed', tone: TONES.bad, icon: 'alertCircle' },
  'budget.exceeded': { verb: 'hit a run budget', label: 'Budget exceeded', tone: TONES.bad, icon: 'gauge' },
  'proposal.undo_proposed': { verb: 'proposed undoing', label: 'Undo proposed', tone: TONES.waiting, icon: 'undo' },
  'policy.changed': { verb: 'changed a policy rule', label: 'Policy changed', tone: TONES.info, icon: 'shieldCheck' },
  'mcp_token.created': { verb: 'created an MCP token', label: 'MCP token created', tone: TONES.info, icon: 'key' },
  'mcp_token.revoked': { verb: 'revoked an MCP token', label: 'MCP token revoked', tone: TONES.bad, icon: 'ban' },
  'mcp.tool_called': { verb: 'called an MCP tool', label: 'MCP tool called', tone: TONES.muted, icon: 'tools' },
  'trigger.received': { verb: 'received a trigger', label: 'Trigger received', tone: TONES.info, icon: 'lightning' },
  'trigger.rejected': { verb: 'rejected a trigger', label: 'Trigger rejected', tone: TONES.bad, icon: 'unplug' },
};

const FALLBACK: { verb: string; label: string; tone: Tone; icon: keyof typeof Icons } = { verb: 'recorded', label: 'Event', tone: TONES.muted, icon: 'infoCircle' };

export const auditTypeOf = (type: string) => AUDIT_TYPES[type] ?? { ...FALLBACK, label: type };

const str = (value: unknown) => (typeof value === 'string' ? value : null);
const num = (value: unknown) => (typeof value === 'number' ? value : null);

const OUTCOME_WORDS: Record<PolicyOutcome, string> = {
  allow: 'allowed automatically',
  needs_approval: 'needs a human decision',
  deny: 'denied',
};

const opRef = (event: AuditEvent) =>
  event.opIndex === null ? '' : `op #${event.opIndex + 1}`;

/** The verb for this one event: a decision reads "approved" or "rejected", not "decided". */
export const auditVerb = (event: AuditEvent) => {
  if (event.type === 'proposal.decided')
    return event.data.decision === 'reject' ? 'rejected' : 'approved';
  return auditTypeOf(event.type).verb;
};

/** One line of detail under the sentence, from the event's own data. */
export const auditDetail = (event: AuditEvent): string | null => {
  const data = event.data;
  switch (event.type) {
    case 'proposal.created': {
      const ops = num(data.opCount) ?? 0;
      const total = num(data.totalValue);
      return `${ops} op${ops === 1 ? '' : 's'}${total !== null ? `, ${formatMoney(total)}` : ''}`;
    }
    case 'policy.evaluated': {
      const outcome = str(data.outcome) as PolicyOutcome | null;
      const trigger = data.trigger === 'edit' ? 'After edits: ' : '';
      return outcome ? `${trigger}${OUTCOME_WORDS[outcome] ?? outcome}` : null;
    }
    case 'proposal.decided': {
      const reason = str(data.reason);
      const edited = data.edited === true ? 'with edits' : null;
      return [edited, reason ? `“${reason}”` : null].filter(Boolean).join(' · ') || null;
    }
    case 'proposal.decision_blocked':
      return 'Edited ops were denied by policy; nothing was recorded';
    case 'proposal.execution_started':
      return data.resumed === true ? 'Resumed after an interruption' : null;
    case 'op.executed':
    case 'op.deduplicated': {
      const attempts = num(data.attempts) ?? 1;
      return `${opRef(event)} → record ${str(data.recordId) ?? '?'}${attempts > 1 ? ` after ${attempts} attempts` : ''}`;
    }
    case 'op.verified':
      return `${opRef(event)}: record ${str(data.recordId) ?? '?'} matches the diff`;
    case 'op.verify_failed': {
      const mismatches = Array.isArray(data.mismatches) ? data.mismatches : [];
      const paths = mismatches
        .map((m) => (m && typeof m === 'object' && 'path' in m && Array.isArray(m.path) ? formatPath(m.path) : null))
        .filter(Boolean)
        .slice(0, 3);
      return `${opRef(event)}: ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}${paths.length ? ` (${paths.join(', ')})` : ''}`;
    }
    case 'op.retry': {
      const delay = num(data.delayMs);
      const error = data.error && typeof data.error === 'object' && 'message' in data.error ? str(data.error.message) : null;
      return `${opRef(event)}: attempt ${num(data.attempt) ?? '?'}${delay !== null ? `, waiting ${Math.round(delay)} ms` : ''}${error ? ` · ${error}` : ''}`;
    }
    case 'op.failed':
    case 'proposal.failed': {
      const error = data.error && typeof data.error === 'object' && 'message' in data.error ? str(data.error.message) : null;
      return [event.type === 'op.failed' ? opRef(event) : null, error].filter(Boolean).join(': ') || null;
    }
    case 'proposal.executed': {
      const ops = num(data.opCount) ?? 0;
      return `${ops} op${ops === 1 ? '' : 's'} written and verified`;
    }
    case 'budget.exceeded':
      return `${str(data.dimension) ?? 'budget'}: used ${num(data.used) ?? '?'} of ${num(data.limit) ?? '?'}`;
    case 'proposal.undo_proposed': {
      const ops = Array.isArray(data.opIndexes) ? data.opIndexes.length : 0;
      const kept = Array.isArray(data.notUndoable) ? data.notUndoable.length : 0;
      const reason = str(data.reason);
      return [
        `${ops} op${ops === 1 ? '' : 's'} to reverse`,
        kept ? `${kept} can't be undone` : null,
        reason ? `“${reason}”` : null,
      ].filter(Boolean).join(' · ');
    }
    case 'policy.changed':
      return str(data.key) ? `Rule ${str(data.key)}` : null;
    case 'mcp_token.created': {
      const scopes = Array.isArray(data.scopes) ? data.scopes.filter((s) => typeof s === 'string') : [];
      return `${str(data.name) ?? 'token'}${scopes.length ? ` · ${scopes.join(', ')}` : ''}`;
    }
    case 'mcp_token.revoked':
      return str(data.name);
    case 'mcp.tool_called': {
      const error = str(data.error);
      return [str(data.tool), str(data.intent) ? `“${str(data.intent)}”` : null, data.outcome === 'error' ? `failed${error ? `: ${error}` : ''}` : null]
        .filter(Boolean)
        .join(' · ') || null;
    }
    case 'trigger.received':
      return [str(data.eventName), str(data.source), data.ignored === true ? 'acknowledged, nothing queued' : null].filter(Boolean).join(' · ') || null;
    case 'trigger.rejected':
      return [str(data.source), str(data.reason), str(data.message)].filter(Boolean).join(' · ') || null;
    default:
      return null;
  }
};

/** "Today", "Yesterday" or the date, for grouping rows by day (carbonme activity log). */
export const auditDay = (iso: string, now: Date): string => {
  const day = new Date(iso);
  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

export const auditDays = (
  events: readonly AuditEvent[],
  now: Date,
): { day: string; events: AuditEvent[] }[] => {
  const days: { day: string; events: AuditEvent[] }[] = [];
  for (const event of events) {
    const day = auditDay(event.at, now);
    const last = days.at(-1);
    if (last?.day === day) last.events.push(event);
    else days.push({ day, events: [event] });
  }
  return days;
};

/** "2 min ago" today, the time on earlier days (carbonme activityTime). */
export const auditTime = (iso: string, now: Date): string => {
  const at = new Date(iso);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 12 * 60 && auditDay(iso, now) === 'Today')
    return `${Math.floor(minutes / 60)} h ago`;
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/** The row's sentence as plain text, for the drawer title: "Executor wrote op 11 of the proposal". */
export const auditSentence = (event: AuditEvent, title: string | null): string => {
  const who = actorName(event.actor).split(' ')[0] ?? actorName(event.actor);
  const target =
    event.opIndex !== null
      ? ` op ${event.opIndex + 1} of the proposal`
      : title && event.type === 'proposal.created'
        ? ` ${title}`
        : '';
  return `${who} ${auditVerb(event)}${target}`;
};
