/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      keyframes: {
        "power-fade-up": {
          "0%": { opacity: "0", transform: "translateY(12px) scale(0.97)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "power-glow": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "0.8" },
        },
        "power-shimmer": {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "power-fade-up": "power-fade-up 0.5s cubic-bezier(0.16,1,0.3,1) both",
        "power-glow": "power-glow 3s ease-in-out infinite",
        "power-shimmer": "power-shimmer 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
