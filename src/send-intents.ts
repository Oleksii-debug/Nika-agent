import { db, type SendIntent } from './db';

export class SendIntentOwnershipError extends Error {
  readonly jobId: string;

  constructor(jobId: string, detail: string) {
    super(`SEND_INTENT_OWNERSHIP_MISMATCH[${jobId}]: ${detail}`);
    this.name = 'SendIntentOwnershipError';
    this.jobId = jobId;
  }
}

export async function getOrCreateSendIntent(input: {
  jobId?: string;
  agentId: string;
  runId?: string;
  prompt: string;
  baselineUserTurnCount: number;
}): Promise<SendIntent> {
  const promptHash = await hashPrompt(input.prompt);

  if (input.jobId) {
    return db.transaction('rw', db.sendIntents, async () => {
      const existing = await db.sendIntents.where('jobId').equals(input.jobId!).first();
      if (existing) {
        assertIntentOwnership(existing, input, promptHash);
        return existing;
      }

      const intent = createIntent(input, promptHash);
      await db.sendIntents.add(intent);
      return intent;
    });
  }

  const intent = createIntent(input, promptHash);
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

function createIntent(
  input: {
    jobId?: string;
    agentId: string;
    runId?: string;
    prompt: string;
    baselineUserTurnCount: number;
  },
  promptHash: string,
): SendIntent {
  const timestamp = new Date().toISOString();
  const intent: SendIntent = {
    id: crypto.randomUUID(),
    agentId: input.agentId,
    prompt: input.prompt,
    promptHash,
    baselineUserTurnCount: input.baselineUserTurnCount,
    state: 'persisted',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (input.jobId !== undefined) intent.jobId = input.jobId;
  if (input.runId !== undefined) intent.runId = input.runId;
  return intent;
}

function assertIntentOwnership(
  existing: SendIntent,
  input: {
    jobId?: string;
    agentId: string;
    runId?: string;
    prompt: string;
    baselineUserTurnCount: number;
  },
  promptHash: string,
): void {
  const jobId = input.jobId;
  if (!jobId) return;

  if (existing.agentId !== input.agentId) {
    throw new SendIntentOwnershipError(jobId, `agent changed from '${existing.agentId}' to '${input.agentId}'`);
  }
  if (existing.promptHash !== promptHash) {
    throw new SendIntentOwnershipError(jobId, 'prompt payload changed after durable intent creation');
  }
  if (input.runId !== undefined && existing.runId !== input.runId) {
    throw new SendIntentOwnershipError(
      jobId,
      `run changed from '${existing.runId ?? 'missing'}' to '${input.runId}'`,
    );
  }
}
