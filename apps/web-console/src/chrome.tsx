import { ReactNode, useState } from 'react';
import { Activity, Database, Menu, Moon, Sun, X } from 'lucide-react';
import { useI18n } from './i18n';

export function Brand({ inverted = false }: { inverted?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex h-8 w-8 items-center justify-center border ${inverted ? 'border-white/30 bg-white/10 text-white' : 'border-foreground/15 bg-primary text-primary-foreground'}`}
      >
        <Database className="h-4 w-4" />
      </div>
      <span className={`font-display text-sm font-semibold tracking-tight ${inverted ? 'text-white' : 'text-foreground'}`}>Dbase Warden</span>
    </div>
  );
}

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  function toggle() {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('dbase-theme', next ? 'dark' : 'light');
    setDark(next);
  }
  return [dark, toggle];
}

export function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />;
}

export function MobileNav({
  open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button className="absolute inset-0 bg-foreground/30" aria-label={t("Close menu")} onClick={onClose} />
      <div className="absolute inset-y-0 left-0 flex w-[min(100%,20rem)] flex-col border-r border-foreground/10 bg-background">
        <div className="flex items-center justify-between border-b border-border px-4 py-4">
          <Brand />
          <button onClick={onClose} aria-label={t("Close")}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">{children}</div>
      </div>
    </div>
  );
}

export function MenuButton({
  onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button className="border border-transparent p-2 md:hidden" aria-label={t("Open menu")} onClick={onClick}>
      <Menu className="h-5 w-5" />
    </button>
  );
}

export function StatusDot({ ok }: { ok: boolean | null }) {
  if (ok === null) return <Activity className="h-3.5 w-3.5 text-muted-foreground" />;
  return <span className={`inline-block h-2 w-2 ${ok ? 'bg-teal-600' : 'bg-destructive'}`} />;
}
