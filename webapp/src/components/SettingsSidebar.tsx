import type { ComponentChildren } from 'preact';

interface SettingsSidebarProps {
  activePath: string;
  children?: ComponentChildren;
}

const NAV_LINKS = [
  { href: '/settings', label: 'General' },
  { href: '/settings/gpu-logs', label: 'GPU Logs' },
  { href: '/settings/smart-tags', label: 'Smart Tags' },
  { href: '/settings/storage', label: 'Storage' },
  { href: '/settings/reprocess', label: 'Reprocess' },
];

export function SettingsSidebar({ activePath, children }: SettingsSidebarProps) {
  return (
    <aside class="sidebar">
      <h3 class="sidebar-heading">Settings</h3>
      <nav class="settings-nav">
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            class={`settings-nav-link${activePath === link.href ? ' settings-nav-link--active' : ''}`}
          >
            {link.label}
          </a>
        ))}
      </nav>
      {children}
    </aside>
  );
}
