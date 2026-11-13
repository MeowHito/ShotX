import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GoogleAnalytics, gtagSnippet } from './google-analytics';

describe('GoogleAnalytics (ADR 0017)', () => {
  it('renders one nonced script that configures the property and loads gtag.js', () => {
    const { container } = render(<GoogleAnalytics id="G-YK90K2DDPX" nonce="abc" />);
    const script = container.querySelector('script');
    expect(script?.nonce || script?.getAttribute('nonce')).toBe('abc');
    expect(script?.textContent).toContain('gtag(\'config\', "G-YK90K2DDPX");');
    expect(script?.textContent).toContain(
      '\'https://www.googletagmanager.com/gtag/js?id=\' + encodeURIComponent("G-YK90K2DDPX")',
    );
  });

  it('sets up the dataLayer before gtag.js arrives, and quotes the id as data', () => {
    const snippet = gtagSnippet('G-YK90K2DDPX');
    expect(snippet.indexOf('window.dataLayer')).toBeLessThan(snippet.indexOf('appendChild'));
    expect(snippet).toContain('s.async = true;');
    // The id is JSON-quoted, never spliced in as code.
    expect(gtagSnippet('G-ABCD')).not.toContain("'G-ABCD'");
  });
});
