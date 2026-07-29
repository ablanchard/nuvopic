import type { ComponentChildren } from 'preact';
import {
  GPU_LOGS_PATH,
  REPROCESS_PATH,
  SETTINGS_PATH,
  SMART_TAGS_PATH,
  STORAGE_PATH,
} from '../routes';

interface SettingsSidebarProps {
  activePath: string;
  children?: ComponentChildren;
}

const NAV_LINKS = [
  { href: SETTINGS_PATH, label: 'General' },
  { href: GPU_LOGS_PATH, label: 'GPU Logs' },
  { href: SMART_TAGS_PATH, label: 'Smart Tags' },
  { href: STORAGE_PATH, label: 'Storage' },
  { href: REPROCESS_PATH, label: 'Reprocess' },
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
