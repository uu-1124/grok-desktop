import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 18, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return <IconBase {...props}><path d="M3.5 6.5h6l2 2h9v9.25a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75V6.5Z" stroke="currentColor" strokeLinejoin="round"/><path d="M3.5 9h17" stroke="currentColor"/></IconBase>;
}

export function PlusIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round"/></IconBase>;
}

export function SettingsIcon(props: IconProps) {
  return <IconBase {...props}><path d="M9.7 3.8 10.2 2h3.6l.5 1.8c.45.16.88.39 1.27.66l1.78-.5 1.8 3.12-1.3 1.28c.08.46.08.94 0 1.4l1.3 1.28-1.8 3.12-1.78-.5c-.4.28-.82.5-1.27.66l-.5 1.8h-3.6l-.5-1.8a6.6 6.6 0 0 1-1.27-.66l-1.78.5-1.8-3.12 1.3-1.28a7.7 7.7 0 0 1 0-1.4l-1.3-1.28 1.8-3.12 1.78.5c.4-.27.82-.5 1.27-.66Z" stroke="currentColor" strokeLinejoin="round" transform="translate(0 2.95)"/><circle cx="12" cy="12" r="2.35" stroke="currentColor"/></IconBase>;
}

export function PanelIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2" stroke="currentColor"/><path d="M15 4v16" stroke="currentColor"/></IconBase>;
}

export function TerminalIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="4.5" width="18" height="15" rx="2" stroke="currentColor"/><path d="m7 9 3 3-3 3m5.5 0H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/></IconBase>;
}

export function ChatIcon(props: IconProps) {
  return <IconBase {...props}><path d="M5.25 4.5h13.5A2.25 2.25 0 0 1 21 6.75v8.5a2.25 2.25 0 0 1-2.25 2.25H10l-5.5 3v-3.15A2.25 2.25 0 0 1 3 15.25v-8.5A2.25 2.25 0 0 1 5.25 4.5Z" stroke="currentColor" strokeLinejoin="round"/></IconBase>;
}

export function SearchIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="10.75" cy="10.75" r="6.25" stroke="currentColor"/><path d="m15.5 15.5 4 4" stroke="currentColor" strokeLinecap="round"/></IconBase>;
}

export function MoreIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="5" cy="12" r="1.25" fill="currentColor"/><circle cx="12" cy="12" r="1.25" fill="currentColor"/><circle cx="19" cy="12" r="1.25" fill="currentColor"/></IconBase>;
}

export function MenuIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round"/></IconBase>;
}

export function ChevronIcon(props: IconProps) {
  return <IconBase {...props}><path d="m9 6 6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/></IconBase>;
}

export function ArrowUpIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/></IconBase>;
}

export function StopIcon(props: IconProps) {
  return <IconBase {...props}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></IconBase>;
}

export function CloseIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round"/></IconBase>;
}

export function CopyIcon(props: IconProps) {
  return <IconBase {...props}><rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor"/></IconBase>;
}

export function RefreshIcon(props: IconProps) {
  return <IconBase {...props}><path d="M19 7V3m0 0h-4m4 0-3.15 3.15a7 7 0 1 0 1.1 10.85" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/></IconBase>;
}

export function FileIcon(props: IconProps) {
  return <IconBase {...props}><path d="M6 3.5h7l5 5v12H6v-17Z" stroke="currentColor" strokeLinejoin="round"/><path d="M13 3.5v5h5" stroke="currentColor" strokeLinejoin="round"/></IconBase>;
}

export function ImageIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2" stroke="currentColor"/><circle cx="9" cy="9.5" r="1.5" stroke="currentColor"/><path d="m5.5 17 4-4 3 3 2-2 4 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/></IconBase>;
}

export function CheckIcon(props: IconProps) {
  return <IconBase {...props}><path d="m5 12.5 4.25 4.25L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/></IconBase>;
}

export function AlertIcon(props: IconProps) {
  return <IconBase {...props}><path d="m12 3 9 17H3l9-17Z" stroke="currentColor" strokeLinejoin="round"/><path d="M12 9v4m0 3v.01" stroke="currentColor" strokeLinecap="round"/></IconBase>;
}

export function SparkIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 2.5c.45 4.8 2.7 7.05 7.5 7.5-4.8.45-7.05 2.7-7.5 7.5-.45-4.8-2.7-7.05-7.5-7.5 4.8-.45 7.05-2.7 7.5-7.5Z" stroke="currentColor" strokeLinejoin="round"/><path d="M19 15.5c.15 1.65.85 2.35 2.5 2.5-1.65.15-2.35.85-2.5 2.5-.15-1.65-.85-2.35-2.5-2.5 1.65-.15 2.35-.85 2.5-2.5Z" fill="currentColor"/></IconBase>;
}
