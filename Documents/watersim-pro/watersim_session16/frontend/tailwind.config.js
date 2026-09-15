/** @type {import('tailwindcss').Config} */
/**
 * Design tokens — the SafeKrit console look, shared with the Capacity Network
 * admin console: near-black primary actions and sidebar, a soft grey ground,
 * white cards with a 20px radius and a soft shadow, a teal accent, and one
 * soft/strong pair per tone (ok / warn / danger).
 *
 * `brand` is kept as a name because every page uses brand-* classes; its
 * values now follow the same palette, so bg-brand-700 is the ink sidebar,
 * text-brand-600 a near-black link, bg-brand-50 the ground and brand-500 the
 * accent.
 */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      colors: {
        ink: { DEFAULT: '#16181d', 2: '#3d434d', 3: '#6b7280' },
        ground: '#f4f5f7',
        card: '#ffffff',
        line: '#e6e8ec',
        accent: { DEFAULT: '#0f9d8f', soft: '#d9f3ef', ink: '#0b6b61' },
        warn: { DEFAULT: '#c77700', soft: '#fff1dc' },
        danger: { DEFAULT: '#c2410c', soft: '#fee9e0' },
        ok: { DEFAULT: '#2f7d4f', soft: '#e0f3e7' },
        star: '#f5a524',
        brand: {
          50:  '#f4f5f7',
          100: '#e6e8ec',
          200: '#d9f3ef',
          300: '#9ad9cf',
          400: '#3fb8a8',
          500: '#0f9d8f',
          600: '#16181d',
          700: '#16181d',
          800: '#0b0c0f',
          900: '#050506',
        },
        teal: {
          500: '#0f9d8f',
          600: '#0b6b61',
        },
      },
      borderRadius: {
        xl: '14px',
        '2xl': '20px',
        '3xl': '28px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(22,24,29,0.04), 0 6px 20px -8px rgba(22,24,29,0.12)',
        bar: '0 -6px 24px -12px rgba(22,24,29,0.25)',
        float: '0 10px 30px -10px rgba(22,24,29,0.35)',
      },
      minHeight: { tap: '44px' },
      minWidth: { tap: '44px' },
    },
  },
  plugins: [],
};
