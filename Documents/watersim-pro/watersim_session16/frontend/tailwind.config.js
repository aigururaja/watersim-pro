/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#EBF4FF',
          100: '#D6E8FF',
          200: '#ADCFFF',
          300: '#85B6FF',
          400: '#5C9DFF',
          500: '#2E75B6',
          600: '#1F5A99',
          700: '#1F4E79',
          800: '#163A5C',
          900: '#0D2540',
        },
        teal: {
          500: '#107C6A',
          600: '#0D6457',
        }
      },
    },
  },
  plugins: [],
};
