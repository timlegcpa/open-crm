// Sending one e-signature email: rendered in the one layout, from the organization's
// sender name, replying to its public contact address when one is set (else outbound's
// EMAIL_REPLY_TO). A send that throws (a provider not set up in production) counts as
// failed: an email is never the step that fails a signing action.

import { renderEmail } from '../../_shared/email-layout.ts';
import type { Logger } from '../../_shared/log.ts';
import type { OrgIdentity } from '../../_shared/organization.ts';
import type { EmailMessage, SendResult } from '../../_shared/outbound.ts';
import type { EsignDb } from './db.ts';
import type { DraftEmail } from './emails.ts';
import { loadOrgContactEmail } from './settings.ts';

export interface MailDeps {
  db: EsignDb;
  loadOrg(): Promise<OrgIdentity>;
  sendEmail(message: EmailMessage): Promise<SendResult>;
}

export interface Mailer {
  org: OrgIdentity;
  send(
    to: string,
    draft: DraftEmail,
    extra?: Pick<EmailMessage, 'idempotencyKey' | 'tags' | 'attachments'>,
  ): Promise<SendResult['status']>;
}

export async function createMailer(deps: MailDeps, log: Logger): Promise<Mailer> {
  const org = await deps.loadOrg();
  let replyTo: string | null = null;
  try {
    replyTo = await loadOrgContactEmail(deps.db);
  } catch (err) {
    log.error('contact email read failed; using the default reply-to', err);
  }
  return {
    org,
    async send(to, draft, extra = {}) {
      try {
        const rendered = renderEmail(org, draft.content);
        const result = await deps.sendEmail({
          to,
          subject: draft.subject,
          html: rendered.html,
          text: rendered.text,
          fromName: org.senderName,
          ...(replyTo ? { replyTo } : {}),
          ...extra,
        });
        if (result.status !== 'sent') log.warn('email not sent', { status: result.status });
        return result.status;
      } catch (err) {
        log.error('email send threw', err);
        return 'failed';
      }
    },
  };
}
