/**
 * The viewer's "Send for signature" opens e-sign's new-envelope flow with this document
 * preselected, and only for a PDF (e-sign takes PDFs only).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { links } from '@/features/links';
import SendForSignatureButton from '../workstation/SendForSignatureButton';

const CONTACT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function renderButton(mimeType: string) {
  return render(
    <MemoryRouter initialEntries={['/documents']}>
      <Routes>
        <Route path="/documents" element={<SendForSignatureButton contactId={CONTACT} documentId={DOC} mimeType={mimeType} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SendForSignatureButton', () => {
  it('opens a new envelope for the contact, starting from this PDF', () => {
    renderButton('application/pdf');
    fireEvent.click(screen.getByRole('button', { name: /send for signature/i }));
    expect(screen.getByTestId('where').textContent).toBe(links.newEnvelope({ contactId: CONTACT, documentId: DOC }));
    expect(screen.getByTestId('where').textContent).toBe(`/esign/new?contact=${CONTACT}&document=${DOC}`);
  });

  it('is not offered for anything but a PDF', () => {
    for (const mime of ['image/png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream']) {
      const { unmount } = renderButton(mime);
      expect(screen.queryByRole('button', { name: /send for signature/i })).toBeNull();
      unmount();
    }
  });
});
