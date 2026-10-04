import { createContext, ReactNode, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface EnvironmentRecord {
  id: string;
  name: string;
  description: string;
}

interface EnvState {
  id: string;
  setId: (id: string) => void;
  environments: EnvironmentRecord[];
}

const EnvContext = createContext<EnvState>({ id: '', setId: () => undefined, environments: [] });

export function EnvProvider({ children }: { children: ReactNode }) {
  const environments = useQuery({ queryKey: ['environments'], queryFn: () => api<EnvironmentRecord[]>('/api/v1/environments') });
  const stored = sessionStorage.getItem('dbase_env') ?? '';
  const selected = environments.data?.some((environment) => environment.id === stored) ? stored : (environments.data?.[0]?.id ?? '');

  function setId(id: string) {
    sessionStorage.setItem('dbase_env', id);
    window.location.reload();
  }

  return <EnvContext.Provider value={{ id: selected, setId, environments: environments.data ?? [] }}>{children}</EnvContext.Provider>;
}

export function useEnvironment(): EnvState {
  return useContext(EnvContext);
}

export function inEnvironment<T extends { environmentId?: string | null }>(rows: T[] | undefined, environmentId: string): T[] {
  if (!environmentId) return rows ?? [];
  return (rows ?? []).filter((row) => row.environmentId === environmentId);
}
