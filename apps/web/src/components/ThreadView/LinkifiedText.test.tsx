import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LinkifiedText } from './LinkifiedText.tsx';

describe('LinkifiedText', () => {
  it('renders a link that opens in a new tab and tells the site nothing', () => {
    render(<LinkifiedText text="Notes at https://example.com/engine today" />);

    const link = screen.getByRole('link', { name: 'https://example.com/engine' });
    expect(link).toHaveAttribute('href', 'https://example.com/engine');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.parentElement).toHaveTextContent('Notes at https://example.com/engine today');
  });

  it('renders anything else as plain text', () => {
    const { container } = render(<LinkifiedText text="javascript:alert(1) <b>bold</b>" />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('javascript:alert(1) <b>bold</b>');
  });
});
