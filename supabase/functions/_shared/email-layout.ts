// The one email layout: an HTML part and its plain-text twin, rendered from the
// organization identity (organization.ts) and a list of content blocks. No name, colour
// or address is written here; all of it comes from org_profile.
//
// Content is blocks, not HTML, so every string is escaped on the way in and a caller
// cannot inject markup: headings, paragraphs (newlines kept), bullet lists, one or more
// buttons (http or https links only) and small notes. Group email adds an unsubscribe
// link to the footer of both parts.

import type { OrgIdentity } from './organization.ts';

export function escapeHtml(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type EmailBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'note'; text: string };

export interface EmailContent {
  /** Preview text some inboxes show beside the subject. */
  preheader?: string;
  blocks: readonly EmailBlock[];
  /** Group email: an unsubscribe link in both footers. */
  unsubscribeUrl?: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#18181b';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** An http(s) URL, normalised. Anything else (javascript:, data:, a bare path) throws. */
export function safeLinkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('email link is not an absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('email link must be http or https');
  return parsed.href;
}

const lines = (value: string) => escapeHtml(value).replace(/\r?\n/g, '<br>');

function blockHtml(block: EmailBlock, color: string): string {
  switch (block.kind) {
    case 'heading':
      return `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#18181b;">${escapeHtml(block.text)}</h1>`;
    case 'paragraph':
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">${lines(block.text)}</p>`;
    case 'list':
      return `<ul style="margin:0 0 16px;padding:0 0 0 20px;font-size:15px;line-height:1.6;color:#3f3f46;">${block.items
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`;
    case 'button':
      return `<p style="margin:24px 0;"><a href="${escapeHtml(safeLinkUrl(block.url))}" style="display:inline-block;background-color:${color};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px;">${escapeHtml(block.label)}</a></p>`;
    case 'note':
      return `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#71717a;">${lines(block.text)}</p>`;
  }
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'note':
      return block.text;
    case 'list':
      return block.items.map((item) => `- ${item}`).join('\n');
    case 'button':
      return `${block.label}: ${safeLinkUrl(block.url)}`;
  }
}

export function renderEmail(org: OrgIdentity, content: EmailContent): RenderedEmail {
  const color = org.brandColor && HEX_COLOR.test(org.brandColor) ? org.brandColor : DEFAULT_COLOR;
  const name = escapeHtml(org.displayName);
  const footerName = org.legalName ?? org.displayName;
  const unsubscribe = content.unsubscribeUrl ? safeLinkUrl(content.unsubscribeUrl) : null;
  let logo = '';
  if (org.logoUrl) {
    const src = safeLinkUrl(org.logoUrl);
    if (src.startsWith('https:')) {
      logo = `<img src="${escapeHtml(src)}" alt="${name}" height="48" style="display:block;height:48px;width:auto;margin:0 0 12px;border:0;">`;
    }
  }

  const footer = [
    escapeHtml(footerName),
    org.postalAddress ? lines(org.postalAddress) : '',
    unsubscribe ? `<a href="${escapeHtml(unsubscribe)}" style="color:#71717a;">Unsubscribe</a>` : '',
  ]
    .filter(Boolean)
    .join('<br>');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${name}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background-color:#f4f4f5;">',
    content.preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(content.preheader)}</div>`
      : '',
    `<div style="max-width:560px;margin:0 auto;padding:32px 16px;font-family:${FONT};color:#18181b;">`,
    `<div style="margin:0 0 20px;">${logo}<div style="font-size:16px;font-weight:600;color:${color};">${name}</div></div>`,
    '<div style="background-color:#ffffff;border:1px solid #e4e4e7;border-radius:8px;padding:28px 24px;">',
    ...content.blocks.map((block) => blockHtml(block, color)),
    '</div>',
    `<div style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#71717a;">${footer}</div>`,
    '</div>',
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n');

  const textFooter = [footerName, org.postalAddress ?? '', unsubscribe ? `Unsubscribe: ${unsubscribe}` : '']
    .filter(Boolean)
    .join('\n');
  const text = [org.displayName, ...content.blocks.map(blockText), `--\n${textFooter}`].join('\n\n');

  return { html, text };
}
