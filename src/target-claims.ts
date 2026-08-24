import { db, type DurableTargetClaim, type TargetClaimOwnerKind } from './db';

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

export async function acquireTargetClaim(targetUrl: string, owner: TargetClaimOwner): Promise<boolean> {
  const targetKey = canonicalTargetKey(targetUrl);
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

export async function releaseTargetClaim(targetUrl: string, owner: TargetClaimOwner): Promise<boolean> {
  const targetKey = canonicalTargetKey(targetUrl);
  return db.transaction('rw', db.targetClaims, async () => {
    const existing = await db.targetClaims.get(targetKey);
    if (!existing) return true;
    if (existing.ownerKind !== owner.ownerKind || existing.ownerId !== owner.ownerId || existing.operationId !== owner.operationId) return false;
    await db.targetClaims.delete(targetKey);
    return true;
  });
}

export async function getTargetClaim(targetUrl: string): Promise<DurableTargetClaim | undefined> {
  return db.targetClaims.get(canonicalTargetKey(targetUrl));
}

export async function releaseClaimsForOwner(ownerKind: TargetClaimOwnerKind, ownerId: string): Promise<void> {
  await db.transaction('rw', db.targetClaims, async () => {
    const claims = await db.targetClaims.where('[ownerKind+ownerId]').equals([ownerKind, ownerId]).toArray();
    await db.targetClaims.bulkDelete(claims.map((claim) => claim.targetKey));
  });
}
