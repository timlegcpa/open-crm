import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from '@/components/ui/status-pill';
import { StatusBadge } from '@/components/contacts/StatusBadge';

const dotOf = (label: string) => screen.getByText(label).querySelector('[aria-hidden="true"]') as HTMLElement | null;

describe('StatusPill', () => {
  it('draws no dot without a dot class or style', () => {
    render(<StatusPill>Plain</StatusPill>);
    expect(dotOf('Plain')).toBeNull();
  });

  it('paints a stored colour on the dot only, over the fallback class', () => {
    render(
      <StatusPill dotClassName="bg-muted-foreground" dotStyle={{ backgroundColor: '#16a34a' }}>
        Client
      </StatusPill>,
    );
    const dot = dotOf('Client');
    expect(dot).toHaveStyle({ backgroundColor: '#16a34a' });
    expect(dot).toHaveClass('bg-muted-foreground');
    expect(screen.getByText('Client')).not.toHaveStyle({ color: '#16a34a' });
  });
});

describe('StatusBadge', () => {
  it("colours the dot from the status row, and falls back to the neutral dot for a colour that is not #rrggbb", () => {
    render(
      <>
        <StatusBadge statusKey="client" status={{ key: 'client', label: 'Client', colour: '#16a34a', sort_order: 60 }} />
        <StatusBadge statusKey="hot" status={{ key: 'hot', label: 'Hot', colour: 'red; background: url(x)', sort_order: 30 }} />
        <StatusBadge statusKey="gone" status={undefined} />
      </>,
    );
    expect(dotOf('Client')).toHaveStyle({ backgroundColor: '#16a34a' });
    expect(dotOf('Hot')?.getAttribute('style')).toBeNull();
    expect(dotOf('Hot')).toHaveClass('bg-muted-foreground');
    expect(dotOf('gone')).toHaveClass('bg-muted-foreground');
  });
});
