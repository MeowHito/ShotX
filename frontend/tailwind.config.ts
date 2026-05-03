import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f5f3ff',
          500: '#7c3aed',
          600: '#6d28d9',
          950: '#120a2a',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};

export default config;
