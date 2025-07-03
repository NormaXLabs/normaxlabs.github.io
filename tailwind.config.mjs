/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: { primary: { 600: '#4f46e5', 700: '#4338ca' } },
    },
  },
  plugins: [],
};
