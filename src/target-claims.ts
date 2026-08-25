import { db, type DurableTargetClaim, type TargetClaimOwnerKind } from './db';
import { getAgents } from './storage';

export type TargetClaimOwner = {
  ownerKind: TargetClaimOwnerKind;
  ownerId: string;
  operationId: string;
};

export function canonicalTargetKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}`;
  } catch {
    return url.trim();
  }
}

async function resolveTargetKey(targetUrlOrAgentId: string): Promise<string> {
  if (/^https?:\/\//i.test(targetUrlOrAgentId)) return canonicalTargetKey(targetUrlOrAgentId);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const agent = (await getAgents()).find((candidate) => candidate.id === targetUrlOrAgentId);
    if (agent) return canonicalTargetKey(agent.url);
  }
  return canonicalTargetKey(targetUrlOrAgentId);
}

export async function acquireTargetClaim(targetUrlOrAgentId: string, owner: TargetClaimOwner): Promise<boolean> {
  const targetKey = await resolveTargetKey(targetUrlOrAgentId);
  return db.transaction('rw', db.targetClaims, async () => {
    const existing = await db.targetClaims.get(targetKey);
    if (existing) {
      return existing.ownerKind === owner.ownerKind
        && existing.ownerId === owner.ownerId
        && existing.operationId === owner.operationId;
    }

    const now = new Date().toISOString();
    const claim: DurableTargetClaim = {
      targetKey,
      ...owner,
      acquiredAt: now,
      updatedAt: now,
    };
    await db.targetClaims.add(claim);
    return true;
  });
}

export async function releaseTargetClaim(targetUrlOrAgentId: string, owner: TargetClaimOwner): Promise<boolean> {
  const targetKey = await resolveTargetKey(targetUrlOrAgentId);
  return db.transaction('rw', db.targetClaims, async () => {
    const existing = await db.targetClaims.get(targetKey);
    if (!existing) return true;
    if (existing.ownerKind !== owner.ownerKind || existing.ownerId !== owner.ownerId || existing.operationId !== owner.operationId) return false;
    await db.targetClaims.delete(targetKey);
    return true;
  });
}

export async function getTargetClaim(targetUrlOrAgentId: string): Promise<DurableTargetClaim | undefined> {
  return db.targetClaims.get(await resolveTargetKey(targetUrlOrAgentId));
}
