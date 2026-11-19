import { Box, HStack } from '@ops/ui/jsx';

import { authClient, useSession } from '../../../lib/auth-client';
import { Icons } from '@ops/ui/icons/base';
import { Avatar, AvatarFallback } from '@ops/ui/primitives/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ops/ui/primitives/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@ops/ui/primitives/sidebar';
import { Text } from '@ops/ui/primitives/text';
import { useTheme } from '@ops/ui/primitives/theme';

const initials = (value: string) =>
  value
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
const THEMES = [
  { icon: 'sun', label: 'Light', value: 'light' },
  { icon: 'moon', label: 'Dark', value: 'dark' },
  { icon: 'device', label: 'System', value: 'system' },
] as const;

/** Signs out, then loads the sign-in page afresh: like a reload, that drops the cached session, the query cache and
 * the open screens together, so none of them refetches as signed out and the next sign-in goes straight in. */
const signOut = async () => {
  await authClient.signOut();

  window.location.replace('/sign-in');
};

export const UserMenu = () => {
  const { data: session } = useSession();
  const { setTheme, theme } = useTheme();
  const { isMobile } = useSidebar();
  const name = session?.user.name || session?.user.email || 'Account';

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              css={{
                '[data-collapsible=icon] &': {
                  h: '8',
                  justifyContent: 'center',
                  mx: 'auto',
                  p: '0',
                  w: '8',
                },
              }}
              gap="2"
              h="9"
              p="0"
            >
              <Avatar radius="md" size={1}>
                <AvatarFallback
                  bg="brand.primary.9"
                  color="brand.primary.1"
                  fontSize="1"
                  fontWeight="600"
                >
                  {initials(name)}
                </AvatarFallback>
              </Avatar>
              <Box
                css={{ '[data-collapsible=icon] &': { display: 'none' } }}
                flex="1"
                minW="0"
                overflow="hidden"
                textAlign="left"
              >
                <Text
                  fontSize="1"
                  fontWeight="500"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                >
                  {name}
                </Text>
                <Text color="text.muted" fontSize="0.75rem" textTransform="capitalize">
                  {String(session?.user.role ?? 'operator')}
                </Text>
              </Box>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            css={{ minW: '15rem' }}
            side={isMobile ? 'bottom' : 'right'}
          >
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            {THEMES.map((option) => {
              const ThemeIcon = Icons[option.icon];
              return (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={() => setTheme(option.value)}
                >
                  <HStack gap="2" justify="space-between" w="full">
                    <HStack gap="2">
                      <ThemeIcon size={14} />
                      <Text fontSize="1">{option.label}</Text>
                    </HStack>
                    {theme === option.value ? <Icons.check size={14} /> : null}
                  </HStack>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <HStack gap="2">
                <Icons.logout size={14} />
                <Text fontSize="1">Sign out</Text>
              </HStack>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
