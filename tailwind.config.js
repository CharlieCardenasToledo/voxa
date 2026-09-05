/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        voxa: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          500: '#2f80ed',
          600: '#1670e8',
          700: '#1260ca',
          900: '#0f172a',
        },
      },
      boxShadow: {
        soft: '0 12px 40px rgba(15,23,42,.07)',
        card: '0 8px 26px rgba(15,23,42,.05)',
      },
    },
  },
  plugins: [],
};
