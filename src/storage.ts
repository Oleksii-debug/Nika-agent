import type { ChatAgent, ExecutionLog, WorkflowDefinition } from './types';

const KEYS = {
  agents: 'nika.agents',
  workflows: 'nika.workflows',
  logs: 'nika.logs',
} as const;

export async function getAgents(): Promise<ChatAgent[]> {
  const data = await chrome.storage.local.get(KEYS.agents);
  return (data[KEYS.agents] as ChatAgent[] | undefined) ?? [];
}

export async function saveAgents(agents: ChatAgent[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.agents]: agents });
}

export async function getWorkflows(): Promise<WorkflowDefinition[]> {
  const data = await chrome.storage.local.get(KEYS.workflows);
  return (data[KEYS.workflows] as WorkflowDefinition[] | undefined) ?? [];
}

export async function saveWorkflows(workflows: WorkflowDefinition[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.workflows]: workflows });
}

export async function appendLog(entry: Omit<ExecutionLog, 'id' | 'timestamp'>): Promise<void> {
  const data = await chrome.storage.local.get(KEYS.logs);
  const logs = (data[KEYS.logs] as ExecutionLog[] | undefined) ?? [];
  logs.push({
    ...entry,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
  const capped = logs.slice(-5000);
  await chrome.storage.local.set({ [KEYS.logs]: capped });
}

export async function getLogs(): Promise<ExecutionLog[]> {
  const data = await chrome.storage.local.get(KEYS.logs);
  return (data[KEYS.logs] as ExecutionLog[] | undefined) ?? [];
}
