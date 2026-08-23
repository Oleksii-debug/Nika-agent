import { getAgents, saveAgents } from '../../src/storage';
import type { AgentRole, ChatAgent } from '../../src/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $('status');
const select = $('agent-select') as HTMLSelectElement;
const form = $('agent-form') as HTMLFormElement;
const idInput = $('agent-id') as HTMLInputElement;
const nameInput = $('agent-name') as HTMLInputElement;
const urlInput = $('agent-url') as HTMLInputElement;
const roleInput = $('agent-role') as HTMLSelectElement;
const promptInput = $('agent-prompt') as HTMLTextAreaElement;
const scheduleKind = $('schedule-kind') as HTMLSelectElement;
const intervalInput = $('interval-minutes') as HTMLInputElement;
const enabledInput = $('agent-enabled') as HTMLInputElement;

let agents: ChatAgent[] = [];

void refresh();

select.addEventListener('change', () => loadSelected());
$('new-agent').addEventListener('click', () => resetEditor());
$('delete-agent').addEventListener('click', () => void deleteSelected());
$('run-agent').addEventListener('click', () => void runSelected());
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveEditor();
});

async function refresh(selectedId?: string): Promise<void> {
  agents = await getAgents();
  select.replaceChildren();
  for (const agent of agents) {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = `${agent.name} — ${agent.role}`;
    select.append(option);
  }
  if (selectedId) select.value = selectedId;
  if (select.value) loadSelected();
  else resetEditor();
}

function loadSelected(): void {
  const agent = agents.find((candidate) => candidate.id === select.value);
  if (!agent) return;
  idInput.value = agent.id;
  nameInput.value = agent.name;
  urlInput.value = agent.url;
  roleInput.value = agent.role;
  promptInput.value = agent.defaultPrompt;
  scheduleKind.value = agent.schedule.kind === 'interval' ? 'interval' : 'manual';
  intervalInput.value = String(agent.schedule.kind === 'interval' ? agent.schedule.minutes : 60);
  enabledInput.checked = agent.enabled;
}

function resetEditor(): void {
  form.reset();
  idInput.value = '';
  roleInput.value = 'developer';
  scheduleKind.value = 'manual';
  intervalInput.value = '60';
  enabledInput.checked = true;
  nameInput.focus();
}

async function saveEditor(): Promise<void> {
  const id = idInput.value || crypto.randomUUID();
  const kind = scheduleKind.value;
  const agent: ChatAgent = {
    id,
    projectId: 'default',
    name: nameInput.value.trim(),
    role: roleInput.value as AgentRole,
    url: urlInput.value.trim(),
    enabled: enabledInput.checked,
    defaultPrompt: promptInput.value,
    schedule: kind === 'interval'
      ? { kind: 'interval', minutes: Math.max(1, Number(intervalInput.value) || 60), enabled: true }
      : { kind: 'manual', enabled: true },
    completion: { waitForIdle: true, timeoutMs: 60 * 60 * 1000, settleMs: 2500 },
    tags: [],
  };

  const index = agents.findIndex((candidate) => candidate.id === id);
  if (index >= 0) agents[index] = agent;
  else agents.push(agent);
  await saveAgents(agents);
  setStatus(`Збережено: ${agent.name}`);
  await refresh(id);
}

async function deleteSelected(): Promise<void> {
  const id = select.value;
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent) return;
  agents = agents.filter((candidate) => candidate.id !== id);
  await saveAgents(agents);
  setStatus(`Видалено: ${agent.name}`);
  await refresh();
}

async function runSelected(): Promise<void> {
  const id = select.value;
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent) {
    setStatus('Спочатку вибери чат.');
    return;
  }
  setStatus(`Запуск: ${agent.name}`);
  const response = await chrome.runtime.sendMessage({ type: 'nika.runAgent', agentId: id }) as { ok: boolean; error?: string };
  setStatus(response.ok ? `Команду надіслано: ${agent.name}` : `Помилка: ${response.error ?? 'невідома'}`);
}

function setStatus(message: string): void {
  status.textContent = message;
}
