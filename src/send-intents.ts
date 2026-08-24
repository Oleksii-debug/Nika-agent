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

  const now = new Date().toISOString();
  const intent: SendIntent = {
    id: crypto.randomUUID(),
    jobId: input.jobId,
    agentId: input.agentId,
    runId: input.runId,
    prompt: input.prompt,
    promptHash: await hashPrompt(input.prompt),
    baselineUserTurnCount: input.baselineUserTurnCount,
    state: 'persisted',
    createdAt: now,
    updatedAt: now,
  };
  await db.sendIntents.add(intent);
  return intent;
}

export async function setSendIntentState(
  id: string,
  state: SendIntent['state'],
  detail?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.sendIntents.update(id, {
    state,
    detail,
    updatedAt: now,
    ...(state === 'confirmed' ? { confirmedAt: now } : {}),
  });
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
