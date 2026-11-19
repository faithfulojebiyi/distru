// Adapted from carbonme apps/dashboard/src/modules/settings/activity-settings.tsx (FilterButton + its dropdown
// menus), the "Any staff ▾ / Action Any ▾ / Last 7 days ▾" pills of admin-app-mockup 02 and 10.
import type { ReactNode } from 'react';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ops/ui/primitives/dropdown-menu';
import { Span } from '@ops/ui/primitives/text';
import { Box } from '@ops/ui/jsx';

const FilterButton = ({
  label,
  value,
  icon,
  active,
  ...props
}: {
  label?: string;
  value: string;
  icon?: ReactNode;
  active: boolean;
}) => (
  <Button
    {...props}
    variant="soft"
    size="sm"
    fontSize="1"
    fontWeight="400"
    gap="1.5"
    data-filter={label ?? value}
    data-active={active ? '' : undefined}
  >
    {icon}
    {label && <Span color="text.muted">{label}</Span>}
    <Span fontWeight={active ? '500' : '400'}>{value}</Span>
    <Icons.caretDown size={12} />
  </Button>
);

/** One filter as a pill: its label, the chosen value, and a menu of the options. `null` is the "Any" choice. */
export const FilterChip = <T extends string>({
  label,
  icon,
  value,
  options,
  anyLabel = 'Any',
  onChange,
}: {
  label?: string;
  icon?: ReactNode;
  value: T | null;
  options: readonly { value: T; label: string }[];
  anyLabel?: string | null;
  onChange: (value: T | null) => void;
}) => {
  const chosen = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterButton label={label} icon={icon} value={chosen?.label ?? anyLabel ?? ''} active={Boolean(chosen && anyLabel)} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" w="14rem" maxH="20rem" overflowY="auto">
        {anyLabel !== null && (
          <DropdownMenuItem onSelect={() => onChange(null)}>
            <Box w="3" flexShrink="0">{value === null && <Icons.check size={12} />}</Box>
            {anyLabel}
          </DropdownMenuItem>
        )}
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
            <Box w="3" flexShrink="0">{value === option.value && <Icons.check size={12} />}</Box>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The date window every log offers. */
export const DATE_RANGES = [
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { value: 'all', label: 'All time', ms: Number.POSITIVE_INFINITY },
] as const;

export type DateRange = (typeof DATE_RANGES)[number]['value'];

export const isDateRange = (value: unknown): value is DateRange =>
  DATE_RANGES.some((range) => range.value === value);

export const inRange = (iso: string, range: DateRange, now: number) =>
  now - Date.parse(iso) <= (DATE_RANGES.find((item) => item.value === range)?.ms ?? Number.POSITIVE_INFINITY);
