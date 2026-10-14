import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CopyValue } from '@/components/ui/copy-value';
import { NO_VALUE_TEXT } from '@/lib/format';

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyValue', () => {
  it('makes the value itself the one button, with no separate copy control', () => {
    render(<CopyValue value="ada@example.com" label="email" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Copy email: ada@example.com');
    expect(buttons[0]).toHaveTextContent('ada@example.com');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('copies the value on click and shows the green check only once the copy landed', async () => {
    render(<CopyValue value="ada@example.com" label="email" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(writeText).toHaveBeenCalledWith('ada@example.com');
    const copied = await screen.findByText('Copied');
    expect(copied.parentElement?.querySelector('svg')).toHaveClass('text-success');
  });

  it('shows no check when the browser refuses the copy', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<CopyValue value="ada@example.com" label="email" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(writeText).toHaveBeenCalled();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('copies the raw value while showing a formatted one', async () => {
    render(
      <CopyValue value="5550100001" label="phone">
        (555) 010-0001
      </CopyValue>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy phone: 5550100001' }));
    });
    expect(writeText).toHaveBeenCalledWith('5550100001');
  });

  it('copying inside a clickable row does not also click the row', async () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <CopyValue value="ada@example.com" label="email" />
      </div>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(rowClick).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', '  ', '-', '–', '—'])('renders %j as the no-value glyph, never a button', (value) => {
    render(<CopyValue value={value} label="email" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(NO_VALUE_TEXT)).toBeInTheDocument();
  });
});
