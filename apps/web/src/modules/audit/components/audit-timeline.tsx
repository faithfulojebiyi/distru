import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Span } from '@ops/ui/primitives/text';
import type { AuditEvent } from '../../../api/generated/opsAgentAPI.schemas';
import { actorName, formatDateTime, formatTime } from '../../proposals/proposal-values';
import { auditDetail, auditTypeOf, auditVerb } from '../audit-values';

/**
 * A proposal's audit trail, oldest first, as a vertical timeline: a tinted marker per event on a
 * rail, the actor and verb, and one line of detail from the event's data. With `onOpen`, each event
 * opens the audit drawer (./audit-drawer.tsx), as rows of the audit log do.
 */
export const AuditTimeline = ({
  events,
  selected = null,
  onOpen,
}: {
  events: readonly AuditEvent[];
  selected?: string | null;
  onOpen?: (event: AuditEvent) => void;
}) => (
  <styled.ol listStyle="none" m="0" p="0" position="relative" data-testid="audit-timeline">
    {events.map((event, index) => {
      const type = auditTypeOf(event.type);
      const Icon = Icons[type.icon];
      const detail = auditDetail(event);
      const last = index === events.length - 1;
      return (
        <styled.li
          key={event.id}
          display="grid"
          gridTemplateColumns="1.5rem minmax(0, 1fr)"
          columnGap="3"
          position="relative"
          pb={last ? '0' : '4'}
          data-audit-event={event.type}
          data-audit-event-id={event.id}
        >
          {!last && (
            <Box
              position="absolute"
              left="calc(0.75rem - 0.5px)"
              top="7"
              bottom="0.5"
              w="1px"
              bg="brand.panel.6"
            />
          )}
          <Flex
            align="center"
            justify="center"
            w="6"
            h="6"
            rounded="full"
            className={type.tone.className}
            title={type.label}
          >
            <Icon size={12} />
          </Flex>
          <Flex
            direction="column"
            gap="0.5"
            minW="0"
            pt="0.5"
            px="1.5"
            mx="-1.5"
            pb="1"
            mb="-1"
            rounded="md"
            cursor={onOpen ? 'pointer' : undefined}
            bg={selected === event.id ? { base: 'brand.panel.4', _dark: 'brand.panel.5' } : undefined}
            _hover={onOpen ? { bg: { base: 'brand.panel.4', _dark: 'brand.panel.5' } } : undefined}
            role={onOpen ? 'button' : undefined}
            tabIndex={onOpen ? 0 : undefined}
            aria-label={onOpen ? `View details: ${actorName(event.actor)} ${auditVerb(event)}` : undefined}
            onClick={onOpen ? () => onOpen(event) : undefined}
            onKeyDown={
              onOpen
                ? (key) => {
                    if (key.key === 'Enter' || key.key === ' ') {
                      key.preventDefault();
                      onOpen(event);
                    }
                  }
                : undefined
            }
          >
            <HStack gap="2" justify="space-between" alignItems="baseline" minW="0">
              <Span fontSize="1.5" minW="0">
                <Span fontWeight="500">{actorName(event.actor)}</Span> {auditVerb(event)}
              </Span>
              <Span
                color="text.muted"
                fontSize="1"
                flexShrink="0"
                fontVariantNumeric="tabular-nums"
                title={formatDateTime(event.at)}
              >
                {formatTime(event.at)}
              </Span>
            </HStack>
            {detail ? (
              <Span color="text.muted" fontSize="1" overflowWrap="anywhere">
                {detail}
              </Span>
            ) : null}
          </Flex>
        </styled.li>
      );
    })}
  </styled.ol>
);

export const AuditTimelineSkeleton = () => (
  <Flex direction="column" gap="4" aria-busy="true">
    {Array.from({ length: 4 }, (_, index) => (
      <HStack key={index} gap="3" alignItems="flex-start">
        <Skeleton w="6" h="6" rounded="full" />
        <Flex direction="column" gap="1.5" flex="1">
          <Skeleton h="3" w="60%" rounded="md" />
          <Skeleton h="2.5" w="40%" rounded="md" />
        </Flex>
      </HStack>
    ))}
  </Flex>
);
