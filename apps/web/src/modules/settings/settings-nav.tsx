// Adapted from carbonme modules/settings/settings-nav.tsx.
import { Link } from '@tanstack/react-router';

import { Icons } from '@ops/ui/icons/base';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@ops/ui/primitives/sidebar';

/** The Settings sections, in the order the sidebar lists them. */
const SETTINGS_SECTIONS = [
  { to: '/settings/connectors', label: 'Connectors', icon: 'integrations' },
  { to: '/settings/policy', label: 'Policy rules', icon: 'shieldCheck' },
  { to: '/settings/mcp', label: 'MCP access', icon: 'tools' },
] as const;

const SettingsSection = ({
  section,
  pathname,
}: {
  section: (typeof SETTINGS_SECTIONS)[number];
  pathname: string;
}) => {
  const Icon = Icons[section.icon];

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname.startsWith(section.to)}
        tooltip={section.label}
      >
        <Link to={section.to} data-settings-section={section.label}>
          <Icon />
          <span>{section.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/** On a Settings page the sidebar lists its sections, with a way back to the app. */
export const SettingsNav = ({ pathname }: { pathname: string }) => (
  <>
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Back to the app">
            <Link to="/" data-settings-back="">
              <Icons.arrowLeft />
              <span>Back</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>

    <SidebarGroup>
      <SidebarGroupLabel>Settings</SidebarGroupLabel>
      <SidebarMenu>
        {SETTINGS_SECTIONS.map((section) => (
          <SettingsSection
            key={section.to}
            section={section}
            pathname={pathname}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>

  </>
);

