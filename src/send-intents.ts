import { db, type SendIntent } from './db';

export async function getOrCreateSendIntent(input: {
  jobId?: string;
  agentId: string;
  runId?: string;
  prompt: string;
  baselineUserTurnCount: number;
}): Promise<SendIntent> {
  if (input.jobId) {
    const existing = await db.sendIntents.where('jobId').equals(input.jobId).first();
    if (existing) return existing;
  }

  const timestamp = new Date().toISOString();
  const intent: SendIntent = {
    id: crypto.randomUUID(),
    agentId: input.agentId,
    prompt: input.prompt,
    promptHash: await hashPrompt(input.prompt),
    baselineUserTurnCount: input.baselineUserTurnCount,
    state: 'persisted',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (input.jobId !== undefined) intent.jobId = input.jobId;
  if (input.runId !== undefined) intent.runId = input.runId;
  await db.sendIntents.add(intent);
  return intent;
}

export async function setSendIntentState(
  id: string,
  state: SendIntent['state'],
  detail?: string,
): Promise<void> {
  const intent = await db.sendIntents.get(id);
  if (!intent) throw new Error(`SEND_INTENT_MISSING: ${id}`);
  const timestamp = new Date().toISOString();
  intent.state = state;
  intent.updatedAt = timestamp;
  if (detail === undefined) delete intent.detail;
  else intent.detail = detail;
  if (state === 'confirmed') intent.confirmedAt = timestamp;
  await db.sendIntents.put(intent);
}

export async function getSendIntentForJob(jobId: string): Promise<SendIntent | undefined> {
  return db.sendIntents.where('jobId').equals(jobId).first();
}

export async function hashPrompt(value: string): Promise<string> {
  const normalized = value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
