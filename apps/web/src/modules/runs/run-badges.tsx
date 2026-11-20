// Run status as carbonme's tinted ToolRunBadge pill (via the shared Pill in proposals/components/badges.tsx).
import type { RunStatus } from '../../api/generated/opsAgentAPI.schemas';
import { Pill, TONES, type Tone } from '../proposals/components/badges';

const RUN_STATUS: Record<RunStatus, { tone: Tone; label: string }> = {
  running: { tone: TONES.running, label: 'Running' },
  pending: { tone: TONES.running, label: 'Queued' },
  waiting: { tone: TONES.running, label: 'Waiting' },
  suspended: { tone: TONES.waiting, label: 'Needs approval' },
  paused: { tone: TONES.waiting, label: 'Paused' },
  success: { tone: TONES.good, label: 'Done' },
  failed: { tone: TONES.bad, label: 'Failed' },
  tripwire: { tone: TONES.bad, label: 'Stopped by guardrail' },
  bailed: { tone: TONES.muted, label: 'Bailed' },
  canceled: { tone: TONES.muted, label: 'Canceled' },
  skipped: { tone: TONES.muted, label: 'Skipped' },
};

export const RunStatusBadge = ({ status }: { status: RunStatus }) => (
  <Pill
    tone={RUN_STATUS[status].tone}
    label={RUN_STATUS[status].label}
    data-run-status={status}
  />
);

/** The status as a dot (its tone's colour class) and a label, for compact rows such as the sidebar's Runs. */
export const runStatusDot = (status: RunStatus) => ({
  className: RUN_STATUS[status].tone.dot,
  label: RUN_STATUS[status].label,
});
