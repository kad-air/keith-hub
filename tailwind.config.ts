import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0c0a08",
          raised: "#15120e",
          hover: "#1c1813",
        },
        rule: {
          DEFAULT: "#2a2418",
          strong: "#3a3322",
        },
        cream: {
          DEFAULT: "#f5efe1",
          dim: "#8a7f6c",
          dimmer: "#5a5145",
        },
        accent: {
          DEFAULT: "#d44a3f",
          soft: "#3d1a16",
        },
        cat: {
          podcasts: "#5fa888",
          music: "#a47ec0",
          film: "#d4a04a",
          reading: "#c8b89a",
          bluesky: "#7ba8c9",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "Cambria", "serif"],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      letterSpacing: {
        kicker: "0.14em",
      },
      animation: {
        "fade-in-up": "fadeInUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) backwards",
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
      },
      keyframes: {
        fadeInUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
