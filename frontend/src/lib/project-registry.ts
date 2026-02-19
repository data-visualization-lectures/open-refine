type ProjectRecord = {
  ownerId: string;
  projectName: string;
  createdAt: number;
  lastAccessAt: number;
};

type RegistryStore = {
  records: Map<string, ProjectRecord>;
};

declare global {
  var __openRefineRegistry__: RegistryStore | undefined;
}

function getStore(): RegistryStore {
  // For production, replace this with a durable store (e.g. Supabase table).
  if (!globalThis.__openRefineRegistry__) {
    globalThis.__openRefineRegistry__ = { records: new Map() };
  }
  return globalThis.__openRefineRegistry__;
}

export function registerProject(projectId: string, ownerId: string, projectName: string): void {
  const now = Date.now();
  getStore().records.set(projectId, {
    ownerId,
    projectName,
    createdAt: now,
    lastAccessAt: now
  });
}

export function removeProject(projectId: string): void {
  getStore().records.delete(projectId);
}

export function touchProject(projectId: string): void {
  const record = getStore().records.get(projectId);
  if (!record) {
    return;
  }
  record.lastAccessAt = Date.now();
  getStore().records.set(projectId, record);
}

export function projectBelongsTo(projectId: string, ownerId: string): boolean {
  const record = getStore().records.get(projectId);
  return Boolean(record && record.ownerId === ownerId);
}

export function listStaleProjectIds(maxAgeHours: number): string[] {
  const staleIds: string[] = [];
  const threshold = Date.now() - maxAgeHours * 60 * 60 * 1000;
  for (const [projectId, record] of getStore().records.entries()) {
    if (record.lastAccessAt <= threshold) {
      staleIds.push(projectId);
    }
  }
  return staleIds;
}
