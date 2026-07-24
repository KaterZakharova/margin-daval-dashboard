/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink:   '#0F172A',
        muted: '#475569',
        line:  '#E2E8F0',
        soft:  '#F8FAFC',
        ok:    '#16A34A',
        warn:  '#F59E0B',
        bad:   '#DC2626',
        info:  '#2563EB',
      },
    },
  },
  plugins: [],
};
