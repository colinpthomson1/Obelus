/** @vitest-environment jsdom */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Goose } from './Goose';

describe('Goose', () => {
  it('renders the exact five-beat Cadyn geometry as a decorative, theme-aware mark', () => {
    const { container } = render(<Goose className="size-5" />);
    const svg = container.querySelector('svg');
    const beats = Array.from(container.querySelectorAll('rect'));

    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveClass('size-5');
    expect(svg?.querySelector('g')).toHaveClass('fill-[#1F171F]', 'dark:fill-[#FFFFEB]');
    expect(beats).toHaveLength(5);
    expect(
      beats.map((beat) =>
        ['x', 'y', 'width', 'height', 'rx', 'transform'].map((attribute) =>
          beat.getAttribute(attribute)
        )
      )
    ).toEqual([
      ['15.96', '4.15', '2.25', '4.4', '1.13', 'rotate(42 17.09 6.35)'],
      ['18.25', '11.64', '2.25', '4.4', '1.13', 'rotate(104 19.37 13.84)'],
      ['12.71', '17.17', '2.25', '4.4', '1.13', 'rotate(166 13.84 19.37)'],
      ['5.22', '14.89', '2.25', '4.4', '1.13', 'rotate(228 6.35 17.09)'],
      ['2.88', '6.34', '2.25', '5.5', '1.13', 'rotate(290 4.01 9.09)'],
    ]);
    expect(beats[4]).toHaveAttribute('fill', '#F26A50');
  });
});
