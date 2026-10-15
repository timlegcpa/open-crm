// Drawn-signature PNG validator: the sign function's own module, imported, not copied.
//
// supabase/functions/esign-finalize-envelope/lib/signature-image.ts has no imports and uses
// only web-standard APIs (atob, DecompressionStream), so the exact code the server gates
// with runs in the browser too. Here it only tells a signer what is wrong while they can
// still fix it: the server checks every drawn signature again, and also trial-embeds it.
export * from '../../../../supabase/functions/esign-finalize-envelope/lib/signature-image';
