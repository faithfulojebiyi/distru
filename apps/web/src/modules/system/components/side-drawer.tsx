// Adapted from carbonme apps/admin/src/ui/side-drawer.tsx: the admin's full-height, borderless right-hand drawer
// (title, when, a Close button, then the content) and its DrawerFact. Ops Agent additions: an optional `actions` slot
// beside Close (prev/next stepping), a `width`, and `onKeyDown` so a caller can bind keys while the drawer has focus.
import { css } from '@ops/ui/css';
import { Button } from '@ops/ui/primitives/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@ops/ui/primitives/sheet';
import type { KeyboardEvent, ReactNode } from 'react';

/** A label over its value, for the facts grid at the top of a drawer. */
export const DrawerFact = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className={css({ display: 'grid', alignContent: 'start', gap: '0.5', minW: '0' })}>
    <dt className={css({ color: 'text.muted', fontSize: '1' })}>{label}</dt>
    <dd className={css({ fontSize: '1.5', overflowWrap: 'anywhere', minW: '0' })}>
      {children}
    </dd>
  </div>
);

/** The admin's right-hand drawer: full height, borderless, a title and when, a Close button, then the content. */
export const SideDrawer = ({
  open,
  onClose,
  title,
  description,
  actions,
  width = '36rem',
  onKeyDown,
  children,
  ...rest
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode | null;
  actions?: ReactNode;
  width?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) => (
  <Sheet
    open={open}
    onOpenChange={(next) => {
      if (!next) onClose();
    }}
  >
    <SheetContent
      side="right"
      border="none"
      display="grid"
      alignContent="start"
      gap="5"
      h="100dvh"
      m="0"
      maxW="100vw"
      overflowY="auto"
      overflowX="hidden"
      p="6"
      roundedLeft="0"
      roundedRight="0"
      style={{ width }}
      _dark={{ outline: 'none' }}
      onKeyDown={onKeyDown}
      {...rest}
    >
      <header
        className={css({
          alignItems: 'start',
          display: 'flex',
          gap: '3',
          justifyContent: 'space-between',
        })}
      >
        <div className={css({ display: 'grid', gap: '1', minW: '0' })}>
          <SheetTitle lineHeight="1.4">{title}</SheetTitle>
          {description ? (
            <SheetDescription fontSize="1.5" fontWeight="normal">
              {description}
            </SheetDescription>
          ) : null}
        </div>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '1', flexShrink: '0' })}>
          {actions}
          <Button variant="ghost" size="xs" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>
      {children}
    </SheetContent>
  </Sheet>
);
