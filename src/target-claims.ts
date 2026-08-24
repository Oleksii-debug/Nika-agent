import { db, type DurableTargetClaim, type TargetClaimOwnerKind } from './db';

export type TargetClaimOwner = {
  ownerKind: TargetClaimOwnerKind;
  ownerId: string;
  operationId: string;
};

export async function acquireTargetClaim(agentId: string, owner: TargetClaimOwner): Promise<boolean> {
  return db.transaction('rw', db.targetClaims, async () => {
    const existing = await db.targetClaims.get(agentId);
    if (existing) {
      return existing.ownerKind === owner.ownerKind
        && existing.ownerId === owner.ownerId
        && existing.operationId === owner.operationId;
    }

    const now = new Date().toISOString();
    const claim: DurableTargetClaim = {
      agentId,
      ...owner,
      acquiredAt: now,
      updatedAt: now,
    };
    await db.targetClaims.add(claim);
    return true;
  });
}

export async function releaseTargetClaim(agentId: string, owner: TargetClaimOwner): Promise<boolean> {
  return db.transaction('rw', db.targetClaims, async () => {
    const existing = await db.targetClaims.get(agentId);
    if (!existing) return true;
    if (existing.ownerKind !== owner.ownerKind || existing.ownerId !== owner.ownerId || existing.operationId !== owner.operationId) return false;
    await db.targetClaims.delete(agentId);
    return true;
  });
}

export async function getTargetClaim(agentId: string): Promise<DurableTargetClaim | undefined> {
  return db.targetClaims.get(agentId);
}

export async function releaseClaimsForOwner(ownerKind: TargetClaimOwnerKind, ownerId: string): Promise<void> {
  await db.transaction('rw', db.targetClaims, async () => {
    const claims = await db.targetClaims.where('[ownerKind+ownerId]').equals([ownerKind, ownerId]).toArray();
    await db.targetClaims.bulkDelete(claims.map((claim) => claim.agentId));
  });
}
