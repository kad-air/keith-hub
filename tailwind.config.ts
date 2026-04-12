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
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          raised: "rgb(var(--ink-raised) / <alpha-value>)",
          hover: "rgb(var(--ink-hover) / <alpha-value>)",
        },
        rule: {
          DEFAULT: "rgb(var(--rule) / <alpha-value>)",
          strong: "rgb(var(--rule-strong) / <alpha-value>)",
        },
        cream: {
          DEFAULT: "rgb(var(--cream) / <alpha-value>)",
          dim: "rgb(var(--cream-dim) / <alpha-value>)",
          dimmer: "rgb(var(--cream-dimmer) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          soft: "rgb(var(--accent-soft) / <alpha-value>)",
        },
        cat: {
          podcasts: "rgb(var(--cat-podcasts) / <alpha-value>)",
          music: "rgb(var(--cat-music) / <alpha-value>)",
          books: "rgb(var(--cat-books) / <alpha-value>)",
          film: "rgb(var(--cat-film) / <alpha-value>)",
          reading: "rgb(var(--cat-reading) / <alpha-value>)",
          tech_review: "rgb(var(--cat-tech_review) / <alpha-value>)",
          bluesky: "rgb(var(--cat-bluesky) / <alpha-value>)",
          games: "rgb(var(--cat-games) / <alpha-value>)",
          tv: "rgb(var(--cat-tv) / <alpha-value>)",
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
