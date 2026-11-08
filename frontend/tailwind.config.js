/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b1220",
        panel: "#111c2e",
        line: "#22324a",
        cyan: "#57d9ff",
        mint: "#6ee7b7",
        amber: "#fbbf24",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(87,217,255,.14), 0 18px 60px rgba(0,0,0,.22)",
      },
    },
  },
  plugins: [],
};
