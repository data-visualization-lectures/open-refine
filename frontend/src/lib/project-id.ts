export function createProjectName(userId: string): string {
  const ts = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `${userId}_${ts}_${random}`;
}
