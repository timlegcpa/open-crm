// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderEmail, safeLinkUrl } from '../../../supabase/functions/_shared/email-layout';
import type { OrgIdentity } from '../../../supabase/functions/_shared/organization';

const ORG: OrgIdentity = {
  displayName: 'Example Co',
  legalName: 'Example Company LLC',
  senderName: 'Example Team',
  postalAddress: '1 Main St\nSpringfield',
  logoUrl: 'https://cdn.example.test/logo.png',
  brandColor: '#1d4ed8',
};
const HOSTILE = '<script>alert("x")</script> & \'q\'';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters and tolerates empty input', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('safeLinkUrl', () => {
  it('accepts http and https, refuses everything else', () => {
    expect(safeLinkUrl('https://crm.example.test/invite?t=abc')).toBe('https://crm.example.test/invite?t=abc');
    expect(safeLinkUrl('http://localhost:5173/x')).toBe('http://localhost:5173/x');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '/relative', 'mailto:a@example.test', '']) {
      expect(() => safeLinkUrl(bad)).toThrow(TypeError);
    }
  });
});

describe('renderEmail', () => {
  const content = {
    preheader: 'Your invitation',
    blocks: [
      { kind: 'heading' as const, text: 'Welcome' },
      { kind: 'paragraph' as const, text: 'Line one\nLine two' },
      { kind: 'list' as const, items: ['Upload documents', 'Sign agreements'] },
      { kind: 'button' as const, label: 'Set up your account', url: 'https://crm.example.test/invite?t=abc&x=1' },
      { kind: 'note' as const, text: 'This link expires in 7 days.' },
    ],
  };

  it('renders the identity, every block, and the footer from org_profile', () => {
    const { html } = renderEmail(ORG, content);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Example Co</title>');
    expect(html).toContain('Your invitation');
    expect(html).toContain('>Welcome</h1>');
    expect(html).toContain('Line one<br>Line two');
    expect(html).toContain('<li>Upload documents</li><li>Sign agreements</li>');
    expect(html).toContain('href="https://crm.example.test/invite?t=abc&amp;x=1"');
    expect(html).toContain('background-color:#1d4ed8');
    expect(html).toContain('<img src="https://cdn.example.test/logo.png" alt="Example Co"');
    expect(html).toContain('Example Company LLC<br>1 Main St<br>Springfield');
    expect(html).not.toContain('Unsubscribe');
  });

  it('writes the plain-text twin with the same content', () => {
    const { text } = renderEmail(ORG, { ...content, unsubscribeUrl: 'https://crm.example.test/unsubscribe?t=1' });
    expect(text).toBe(
      [
        'Example Co',
        'Welcome',
        'Line one\nLine two',
        '- Upload documents\n- Sign agreements',
        'Set up your account: https://crm.example.test/invite?t=abc&x=1',
        'This link expires in 7 days.',
        '--\nExample Company LLC\n1 Main St\nSpringfield\nUnsubscribe: https://crm.example.test/unsubscribe?t=1',
      ].join('\n\n'),
    );
  });

  it('escapes every caller and identity string, so no markup gets through', () => {
    const hostileOrg: OrgIdentity = { ...ORG, displayName: HOSTILE, legalName: HOSTILE, postalAddress: HOSTILE };
    const { html } = renderEmail(hostileOrg, {
      preheader: HOSTILE,
      blocks: [
        { kind: 'heading', text: HOSTILE },
        { kind: 'paragraph', text: HOSTILE },
        { kind: 'list', items: [HOSTILE] },
        { kind: 'button', label: HOSTILE, url: 'https://crm.example.test/' },
        { kind: 'note', text: HOSTILE },
      ],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"x")');
    expect(html.match(/&lt;script&gt;/g)?.length).toBe(11);
  });

  it('refuses a button or unsubscribe link that is not http(s)', () => {
    expect(() => renderEmail(ORG, { blocks: [{ kind: 'button', label: 'Go', url: 'javascript:alert(1)' }] })).toThrow(TypeError);
    expect(() => renderEmail(ORG, { blocks: [], unsubscribeUrl: 'javascript:alert(1)' })).toThrow(TypeError);
  });

  it('falls back to a neutral colour and no logo when the identity carries unusable values', () => {
    const { html } = renderEmail({ ...ORG, brandColor: 'red;background:url(x)', logoUrl: 'http://insecure.example.test/l.png' }, content);
    expect(html).not.toContain('red;background');
    expect(html).toContain('background-color:#18181b');
    expect(html).not.toContain('<img');
  });

  it('uses the display name in the footer when there is no legal name or address', () => {
    const { html, text } = renderEmail({ ...ORG, legalName: null, postalAddress: null }, { blocks: [] });
    expect(html).toContain('color:#71717a;">Example Co</div>');
    expect(text.endsWith('--\nExample Co')).toBe(true);
  });
});
