import { describe, expect, it } from 'vitest';
import { links } from '@/features/links';
import {
  bestPortalAccountStatus,
  greetingName,
  hiddenPortalPaths,
  isHiddenPortalPath,
  isInternalTaskLink,
  PORTAL_ACCESS_DOT,
  PORTAL_ACCESS_LABEL,
  readSidebarConfig,
  type PortalAccountStatus,
} from '../lib/portalAccess';

const accounts = (...statuses: PortalAccountStatus[]) => statuses.map((status) => ({ status }));

describe('portal access status', () => {
  it('ranks active over invited over suspended over deactivated, and none for no accounts', () => {
    expect(bestPortalAccountStatus(accounts('deactivated', 'invited', 'active'))).toBe('active');
    expect(bestPortalAccountStatus(accounts('deactivated', 'suspended', 'invited'))).toBe('invited');
    expect(bestPortalAccountStatus(accounts('deactivated', 'suspended'))).toBe('suspended');
    expect(bestPortalAccountStatus(accounts('deactivated'))).toBe('deactivated');
    expect(bestPortalAccountStatus([])).toBe('none');
  });

  it('has a label and a dot for every status, suspended included', () => {
    const all = ['active', 'invited', 'suspended', 'deactivated', 'none'];
    expect(Object.keys(PORTAL_ACCESS_LABEL).sort()).toEqual([...all].sort());
    expect(Object.keys(PORTAL_ACCESS_DOT).sort()).toEqual([...all].sort());
  });
});

describe('task links', () => {
  it('renders only links that stay on this site', () => {
    expect(isInternalTaskLink('/portal/documents')).toBe(true);
    expect(isInternalTaskLink('/')).toBe(true);
    for (const bad of ['//example.com', '/\\example.com', 'https://example.com', 'portal', '', null, undefined, 7]) {
      expect(isInternalTaskLink(bad), String(bad)).toBe(false);
    }
  });
});

describe('hidden sections', () => {
  it('reads only true as hidden', () => {
    expect(readSidebarConfig({ hide_documents: true, hide_messages: 'yes' })).toEqual({ hide_documents: true, hide_messages: false });
    expect(readSidebarConfig(null)).toEqual({ hide_documents: false, hide_messages: false });
  });

  it('closes the section page and everything under it, nothing else', () => {
    const hidden = hiddenPortalPaths({ hide_documents: true, hide_messages: false });
    expect(hidden).toEqual([links.portalDocuments()]);
    expect(isHiddenPortalPath('/portal/documents', hidden)).toBe(true);
    expect(isHiddenPortalPath('/portal/documents/', hidden)).toBe(true);
    expect(isHiddenPortalPath('/portal/documents/abc', hidden)).toBe(true);
    expect(isHiddenPortalPath('/portal/documentsx', hidden)).toBe(false);
    expect(isHiddenPortalPath('/portal/messages', hidden)).toBe(false);
    expect(isHiddenPortalPath('/portal', hidden)).toBe(false);
  });
});

describe('greeting', () => {
  const contact = { first_name: 'Ada', spouse_first_name: 'Charles', spouse_email: 'Charles@Example.com' };
  it("greets the spouse by name when the spouse's address signed in", () => {
    expect(greetingName(contact, 'charles@example.com')).toBe('Charles');
    expect(greetingName(contact, 'ada@example.com')).toBe('Ada');
    expect(greetingName({ ...contact, first_name: '  ' }, 'ada@example.com')).toBeNull();
  });
});
