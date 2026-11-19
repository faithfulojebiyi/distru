// Record-page tab strip: @ops/ui Tabs' "underline" variant (carbonme's record tab strip) with the active tab drawn like
// the header's outline action buttons (carbonme Button variant="outline": app surface, hairline border, rounded-lg,
// a subtle shadow) as in Attio's "Emails 73", the underline indicator kept on the bar's rule beneath it.
import type { ComponentProps, ReactNode } from 'react';
import { css } from '@ops/ui/css';
import { Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { TabTrigger, TabsList } from '@ops/ui/primitives/tabs';

/**
 * The full-bleed tab bar: the 1px rule is on this container (padding inside it), so it runs edge to edge of its pane
 * and meets the divider; every bar has this height, so side-by-side bars form one line.
 */
export const RecordTabBar = ({ children, label }: { children: ReactNode; label: string }) => (
  <Flex flexShrink="0" h="11" px={{ base: '4', md: '6' }} borderBottomWidth="1px" borderColor="border.subtle" alignItems="stretch" data-tab-bar="">
    {/* The list drops its own rule and reaches 1px past the bar, so the active underline sits ON the bar's rule. */}
    <TabsList variant="underline" aria-label={label} borderBottomWidth="0" h="calc(100% + 1px)" mb="-1px" w="auto" gap="1">
      {children}
    </TabsList>
  </Flex>
);

const WARN = css({ bg: { base: 'palette.orange.3', _dark: 'palette.amber.3' }, color: 'palette.amber.11' });
const BAD = css({ bg: 'brand.error.3', color: 'text.error' });

/** One tab: icon, label and an optional count pill; the active one is a bordered surface (same size when inactive). */
export const RecordTab = ({
  value,
  icon,
  label,
  count,
  tone = null,
  ...rest
}: {
  value: string;
  icon: keyof typeof Icons;
  label: string;
  /** null while loading: a placeholder keeps the width. */
  count?: number | null;
  /** Tints the count when something needs attention (literal classes: never picked at runtime as tokens). */
  tone?: 'warn' | 'bad' | null;
} & Omit<ComponentProps<typeof TabTrigger>, 'value' | 'children'>) => {
  const Icon = Icons[icon];
  return (
    <TabTrigger
      variant="underline"
      value={value}
      css={{
        // The underline indicator, on the bar's rule (the kit's brand.solid resolves to nothing here).
        '&[data-state=active]': { borderColor: 'text.app' },
        '& [data-tab-pill]': { color: 'text.muted' },
        '&:hover [data-tab-pill]': { bg: 'brand.panel.3' },
        '&[data-state=active] [data-tab-pill]': {
          bg: { base: 'background.app', _dark: 'brand.panel.3' },
          borderColor: 'border.subtle',
          shadow: 'sXs',
          color: 'text.app',
        },
        '&[data-state=active] [data-tab-count]:not([data-tone])': { bg: 'brand.panel.6', color: 'text.label' },
      }}
      {...rest}
    >
      <HStack data-tab-pill="" gap="1.5" h="7" px="2" rounded="lg" borderWidth="1px" borderColor="transparent" transition="background 0.12s">
        <Icon size={14} />
        {label}
        {count !== undefined ? (
          <styled.span
            data-tab-count=""
            data-tone={tone ?? undefined}
            className={tone === 'bad' ? BAD : tone === 'warn' ? WARN : undefined}
            px="1.5"
            minW="6"
            textAlign="center"
            rounded="sm"
            bg="brand.panel.4"
            color="text.muted"
            fontSize="1"
            fontWeight="500"
            fontVariantNumeric="tabular-nums"
          >
            {count ?? '·'}
          </styled.span>
        ) : null}
      </HStack>
    </TabTrigger>
  );
};

/**
 * A nested icon tile (carbonme's icon chips: a grey outer tile around a white inner one with a hairline and a soft
 * shadow). Literal sizes, so Panda generates them: outer 40px, inner 32px, icon 16px; `sm` is 32 / 24 / 14.
 */
export const RecordIcon = ({ icon, size = 'md' }: { icon: keyof typeof Icons; size?: 'md' | 'sm' }) => {
  const Icon = Icons[icon];
  const outer = size === 'md' ? 40 : 32;
  const inner = size === 'md' ? 32 : 24;
  return (
    <Flex
      aria-hidden
      align="center"
      justify="center"
      flexShrink="0"
      rounded="xl"
      bg={{ base: 'brand.panel.4', _dark: 'brand.panel.3' }}
      style={{ width: outer, height: outer, minWidth: outer }}
    >
      <Flex
        align="center"
        justify="center"
        rounded="lg"
        bg={{ base: 'background.app', _dark: 'brand.panel.2' }}
        borderWidth="1px"
        borderColor="border.subtle"
        shadow="sXs"
        color="text.app"
        style={{ width: inner, height: inner }}
      >
        <Icon size={size === 'md' ? 16 : 14} />
      </Flex>
    </Flex>
  );
};
