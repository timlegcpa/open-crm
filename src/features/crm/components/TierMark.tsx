import { cn } from '@/lib/utils';
import { isClientTier, TIER_COLOR, TIER_INK } from '../lib/tiers';

/**
 * A contact's tier as a small square badge: the letter on its tier-list colour. Drawn in
 * the record header only; the contact list rows carry no tier. Nothing for an unranked
 * contact.
 */
export function TierMark({ tier, className }: { tier: string | null | undefined; className?: string }) {
  if (!isClientTier(tier)) return null;
  return (
    <span
      role="img"
      aria-label={`${tier} tier`}
      title={`${tier} tier`}
      style={{ backgroundColor: TIER_COLOR[tier], color: TIER_INK }}
      className={cn('inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm text-[11px] font-bold leading-none', className)}
    >
      {tier}
    </span>
  );
}
