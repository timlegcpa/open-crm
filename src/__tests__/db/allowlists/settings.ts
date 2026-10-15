import type { DomainAllowlist } from './types';

/** 0011_control_center. */
export const allowlist: DomainAllowlist = {
  serverRpcs: ['lead_intake_record(text,text,text,text,text,text,text)'],
  publicBuckets: {
    'org-assets':
      'the organization logo, shown by URL in emails and on the sign-in page before anyone signs in; images only, written only by the org-logo function as the server',
  },
};
