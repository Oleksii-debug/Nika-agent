import { getAgents, saveAgents } from '../../src/storage';
import { listRecoveryCases, recoverSubject, type RecoveryAction, type RecoveryCase } from '../../src/operator-recovery';
import {
  clearAgentQuarantine,
  isHardBlockedChatState,
  listAgentQuarantines,
  quarantineAgent,
} from '../../src/chat-quarantine';
import { inspectAgentState } from '../../src/runtime';
import type { AgentQuarantine } from '../../src/db';
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
const quarantineSelect = $('quarantine-select') as HTMLSelectElement;
const quarantineDetail = $('quarantine-detail');
const quarantineSummary = $('quarantine-summary');
const recoverySelect = $('recovery-select') as HTMLSelectElement;
const recoveryAction = $('recovery-action') as HTMLSelectElement;
const recoveryDetail = $('recovery-detail');
const recoverySummary = $('recovery-summary');

let agents: ChatAgent[] = [];
let quarantines: AgentQuarantine[] = [];
let recoveryCases: RecoveryCase[] = [];

void refresh();
void refreshQuarantines();
void refreshRecovery();

select.addEventListener('change', () => loadSelected());
quarantineSelect.addEventListener('change', () => renderQuarantine());
$('quarantine-refresh').addEventListener('click', () => void refreshQuarantines());
$('quarantine-recheck').addEventListener('click', () => void recheckQuarantine());
recoverySelect.addEventListener('change', () => renderRecoveryCase());
$('recovery-refresh').addEventListener('click', () => void refreshRecovery());
$('recovery-apply').addEventListener('click', () => void applyRecovery());
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

async function refreshQuarantines(): Promise<void> {
  try {
    quarantines = await listAgentQuarantines();
    quarantineSelect.replaceChildren();
    for (const item of quarantines) {
      const agent = agents.find((candidate) => candidate.id === item.agentId);
      const option = document.createElement('option');
      option.value = item.agentId;
      option.textContent = `${agent?.name ?? item.agentId} — ${quarantineLabel(item)}`;
      quarantineSelect.append(option);
    }
    quarantineSummary.textContent = quarantines.length
      ? `Призупинено чатів: ${quarantines.length}.`
      : 'Немає чатів, призупинених через стан ChatGPT.';
    renderQuarantine();
  } catch (error) {
    setStatus(`Помилка списку призупинених чатів: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectedQuarantine(): AgentQuarantine | undefined {
  return quarantines.find((item) => item.agentId === quarantineSelect.value);
}

function renderQuarantine(): void {
  quarantineDetail.replaceChildren();
  const item = selectedQuarantine();
  if (!item) return;
  const agent = agents.find((candidate) => candidate.id === item.agentId);
  const lines = [
    `Чат: ${agent?.name ?? item.agentId}.`,
    `Причина: ${quarantineLabel(item)}.`,
    `Режим: ${item.mode === 'manual' ? 'потрібна ручна перевірка' : 'автоматична пауза'}.`,
    item.resumeAt ? `Автоматичне відновлення не раніше: ${new Date(item.resumeAt).toLocaleString()}.` : '',
    item.detail ? `Деталі: ${item.detail}` : '',
    item.pageUrl ? `Сторінка: ${item.pageUrl}` : '',
  ].filter(Boolean);
  for (const text of lines) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    quarantineDetail.append(paragraph);
  }
}

async function recheckQuarantine(): Promise<void> {
  const item = selectedQuarantine();
  if (!item) {
    setStatus('Немає призупиненого чату для перевірки.');
    return;
  }
  const agent = agents.find((candidate) => candidate.id === item.agentId);
  if (!agent) {
    setStatus('Конфігурацію цього чату не знайдено.');
    return;
  }
  setStatus(`Перевірка стану: ${agent.name}`);
  try {
    const evidence = await inspectAgentState(agent);
    if (isHardBlockedChatState(evidence.state) || evidence.blockerKind) {
      await quarantineAgent(agent.id, evidence);
      setStatus(`Чат досі призупинений: ${evidence.visibleError ?? evidence.blockerKind ?? evidence.state}.`);
    } else {
      await clearAgentQuarantine(agent.id);
      setStatus(`Блокування знято: ${agent.name}. Наступний дозволений запуск знову може працювати.`);
    }
  } catch (error) {
    setStatus(`Не вдалося безпечно перевірити чат: ${error instanceof Error ? error.message : String(error)}`);
  }
  await refreshQuarantines();
}

function quarantineLabel(item: AgentQuarantine): string {
  switch (item.blockerKind) {
    case 'login': return 'потрібен вхід';
    case 'rate_limit': return 'ліміт запитів';
    case 'verification': return 'перевірка людини';
    case 'access': return 'доступ заблоковано';
    case 'page_error': return 'помилка сторінки';
  }
}

async function refreshRecovery(): Promise<void> {
  try {
    recoveryCases = await listRecoveryCases();
    recoverySelect.replaceChildren();
    for (const item of recoveryCases) {
      const option = document.createElement('option');
      option.value = `${item.kind}:${item.id}`;
      option.textContent = `${item.kind === 'job' ? 'Завдання' : 'Сценарій'} — ${item.title}`;
      recoverySelect.append(option);
    }
    recoverySummary.textContent = recoveryCases.length
      ? `Потребують перевірки: ${recoveryCases.length}.`
      : 'Немає випадків, які потребують ручного відновлення.';
    renderRecoveryCase();
  } catch (error) {
    setStatus(`Помилка відновлення: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectedRecovery(): RecoveryCase | undefined {
  const value = recoverySelect.value;
  return recoveryCases.find((item) => `${item.kind}:${item.id}` === value);
}

function renderRecoveryCase(): void {
  const item = selectedRecovery();
  recoveryAction.replaceChildren();
  recoveryDetail.replaceChildren();
  if (!item) return;

  const lines = [
    `Стан: ${item.state}.`,
    item.detail ? `Причина: ${item.detail}` : '',
    item.intent ? `Стан відправлення: ${item.intent.state}.` : 'Збереженого відправлення немає.',
    `Утримуваних цілей: ${item.claims.length}.`,
    ...item.blockers.map((blocker) => `Блокування: ${blocker}`),
  ].filter(Boolean);
  for (const text of lines) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    recoveryDetail.append(paragraph);
  }

  for (const action of item.allowedActions) {
    const option = document.createElement('option');
    option.value = action;
    option.textContent = recoveryActionLabel(action);
    recoveryAction.append(option);
  }
}

async function applyRecovery(): Promise<void> {
  const item = selectedRecovery();
  const action = recoveryAction.value as RecoveryAction;
  if (!item || !action) {
    setStatus('Немає доступної дії відновлення.');
    return;
  }
  try {
    await recoverSubject(item.kind, item.id, action);
    setStatus(`Дію «${recoveryActionLabel(action)}» виконано.`);
    await refreshRecovery();
  } catch (error) {
    setStatus(`Дію заблоковано: ${error instanceof Error ? error.message : String(error)}`);
    await refreshRecovery();
  }
}

function recoveryActionLabel(action: RecoveryAction): string {
  switch (action) {
    case 'mark_confirmed': return 'Позначити підтвердженим';
    case 'mark_absent_retry': return 'Підтвердити відсутність і дозволити повтор';
    case 'cancel': return 'Скасувати безпечним способом';
    case 'release_if_safe': return 'Звільнити ціль, якщо це безпечно';
  }
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
  await refreshQuarantines();
}

async function deleteSelected(): Promise<void> {
  const id = select.value;
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent) return;
  agents = agents.filter((candidate) => candidate.id !== id);
  await saveAgents(agents);
  await clearAgentQuarantine(id);
  setStatus(`Видалено: ${agent.name}`);
  await refresh();
  await refreshQuarantines();
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
  await refreshQuarantines();
  await refreshRecovery();
}

function setStatus(message: string): void {
  status.textContent = message;
}
