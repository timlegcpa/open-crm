import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditableField } from '../components/EditableField';

function setup(props: Partial<Parameters<typeof EditableField>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<EditableField type="text" label="City" value="Springfield" onSave={onSave} {...(props as object)} />);
  return onSave;
}

function open(name: RegExp, label: string) {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('textbox', { name: label });
}

async function settle() {
  await act(async () => {});
}

describe('EditableField', () => {
  it('Enter saves once, trimmed, and the blur in the same tick does not save again', async () => {
    const onSave = setup();
    const input = open(/^City:/, 'City');
    fireEvent.change(input, { target: { value: '  Shelbyville ' } });
    // One batch, as in a browser: the focused input blurs before React re-renders it away.
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
    });
    await settle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Shelbyville');
  });

  it('Escape discards the edit, and the blur after it saves nothing', async () => {
    const onSave = setup();
    const input = open(/^City:/, 'City');
    fireEvent.change(input, { target: { value: 'Elsewhere' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.blur(input);
    });
    await settle();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^City: Springfield/ })).toBeInTheDocument();
  });

  it('an unchanged draft never saves', async () => {
    const onSave = setup();
    fireEvent.keyDown(open(/^City:/, 'City'), { key: 'Enter' });
    await settle();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a currency typo aborts rather than clearing the amount', async () => {
    const onSave = setup({ type: 'currency', label: 'Price', value: 100 });
    const input = open(/^Price:/, 'Price');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a typed currency saves the number and a cleared one saves null', async () => {
    const onSave = setup({ type: 'currency', label: 'Price', value: 100 });
    let input = open(/^Price:/, 'Price');
    fireEvent.change(input, { target: { value: '$1,250' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(onSave).toHaveBeenLastCalledWith(1250);
    input = open(/^Price:/, 'Price');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(onSave).toHaveBeenLastCalledWith(null);
  });

  it('Tab then the blur it causes commits once', async () => {
    const onSave = setup();
    const input = open(/^City:/, 'City');
    fireEvent.change(input, { target: { value: 'Springfieldville' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.blur(input);
    fireEvent.blur(input);
    await settle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Springfieldville');
  });
});
