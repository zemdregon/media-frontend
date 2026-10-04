/** 20 px, 1.6 stroke icons from the canvas (UX §4). Always decorative. */
import type { ReactNode } from 'react';

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Icon>
    <path d="M3 9.5 L10 3.5 L17 9.5 V16.5 H3 Z" />
  </Icon>
);
export const MoviesIcon = () => (
  <Icon>
    <rect x="3" y="4" width="14" height="12" rx="1.5" />
    <path d="M6 4 V16 M14 4 V16 M3 8 H6 M3 12 H6 M14 8 H17 M14 12 H17" />
  </Icon>
);
export const ShowsIcon = () => (
  <Icon>
    <rect x="2.5" y="4" width="15" height="10" rx="1.5" />
    <path d="M7 17 H13" />
  </Icon>
);
export const CollectionsIcon = () => (
  <Icon>
    <rect x="5" y="6" width="12" height="11" rx="1.5" />
    <path d="M3 13 V4.5 A1.5 1.5 0 0 1 4.5 3 H13" />
  </Icon>
);
export const ServersIcon = () => (
  <Icon>
    <rect x="3" y="3.5" width="14" height="5.5" rx="1.2" />
    <rect x="3" y="11" width="14" height="5.5" rx="1.2" />
    <path d="M6 6.25 H6.01 M6 13.75 H6.01" />
  </Icon>
);
export const SettingsIcon = () => (
  <Icon>
    <path d="M3 6 H17 M3 14 H17" />
    <circle cx="7" cy="6" r="2" />
    <circle cx="13" cy="14" r="2" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon size={18}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="M13 13 L17 17" />
  </Icon>
);

export function Logo() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="26" height="26" rx="7" stroke="var(--cw-accent)" strokeWidth="2" />
      <path d="M11 8.5 L19.5 14 L11 19.5 Z" fill="var(--cw-accent)" />
    </svg>
  );
}
