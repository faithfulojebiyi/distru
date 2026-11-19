import { Link, useRouterState } from '@tanstack/react-router';
import { Box, HStack } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@ops/ui/primitives/sidebar';
import { SettingsNav } from '../../settings/settings-nav';
import { UserMenu } from './user-menu';
import { WorkspacePicker } from './workspace-picker';

type NavItem = {
  to: string;
  label: string;
  icon: keyof typeof Icons;
  exact?: boolean;
};

const WORK: NavItem[] = [
  { to: '/', label: 'Overview', icon: 'home', exact: true },
  { to: '/copilot', label: 'Copilot', icon: 'sparkle' },
  { to: '/approvals', label: 'Approvals', icon: 'checkCircle' },
];

const OBSERVE: NavItem[] = [
  { to: '/runs', label: 'Runs', icon: 'activity' },
  { to: '/audit', label: 'Audit log', icon: 'shieldCheck' },
  { to: '/evals', label: 'Evals', icon: 'target' },
];

const SYSTEM: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: 'setting' },
];

const NavGroup = ({
  label,
  items,
  pathname,
}: {
  label?: string;
  items: NavItem[];
  pathname: string;
}) => (
  <SidebarGroup>
    {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
    <SidebarMenu>
      {items.map((item) => {
        const Icon = Icons[item.icon];
        const active = item.exact
          ? pathname === item.to
          : pathname.startsWith(item.to);
        return (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
              <Link to={item.to}>
                <Icon />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  </SidebarGroup>
);

export const AppSidebar = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <HStack
          css={{ '[data-collapsible=icon] &': { justifyContent: 'center' } }}
          gap="2"
          justify="space-between"
          w="full"
        >
          <HStack
            css={{ '[data-collapsible=icon] &': { display: 'none' } }}
            gap="2"
            px="1"
            minW="0"
            flex="1"
          >
            <WorkspacePicker />
          </HStack>
          <SidebarTrigger
            css={{ '[data-collapsible=icon] &': { display: 'none' } }}
            h="7"
            p="0"
            w="7"
          />
        </HStack>
      </SidebarHeader>
      <SidebarContent>
        {/* On a Settings page the sidebar lists its sections instead (carbonme). */}
        {pathname.startsWith('/settings') ? (
          <SettingsNav pathname={pathname} />
        ) : (
          <>
            <NavGroup items={WORK} pathname={pathname} />
            <NavGroup label="Observe" items={OBSERVE} pathname={pathname} />
            <NavGroup items={SYSTEM} pathname={pathname} />
          </>
        )}
      </SidebarContent>
      <SidebarFooter>
        <Box
          css={{
            '[data-collapsible=icon] &': {
              display: 'flex',
              justifyContent: 'center',
            },
            display: 'none',
          }}
        >
          <SidebarTrigger h="7" p="0" w="7" />
        </Box>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
};
