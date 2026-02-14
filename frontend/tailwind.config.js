/** @type {import('tailwindcss').Config} */
export default {
  // Use a broad glob to ensure Tailwind picks up all className usages (ts/tsx/js/jsx).
  content: ["./index.html", "./src/**/*"],
  theme: { extend: {} },
  plugins: [],
};
