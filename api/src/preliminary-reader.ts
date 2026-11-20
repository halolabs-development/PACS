import { sameAccount } from './account-identity';

/**
 * The designated author and reviewer of a Preliminary report are the accounts stored (preDocSub, preReviewerSub); the
 * emails beside them are shown names only. A designation without an account (an older row the member table could not
 * resolve) matches nobody - it is never handed to whoever has that email now (owner-identity.ts).
 */
export function designationMatches(sub: string | null | undefined, caller: { actor: string; sub?: string }): boolean {
  return sameAccount(sub, caller);
}

export function canReadPreliminary(state: any, caller: { actor: string; sub?: string }): boolean {
  return state?.rs !== 'P' || designationMatches(state.preDocSub, caller) || designationMatches(state.preReviewerSub, caller);
}