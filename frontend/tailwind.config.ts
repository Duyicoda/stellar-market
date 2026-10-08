import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        stellar: {
          blue: "#3E54CF",
          purple: "#7B61FF",
        },
        theme: {
          bg: "var(--bg-main)",
          "bg-secondary": "var(--bg-secondary)",
          card: "var(--bg-card)",
          border: "var(--border)",
          text: "var(--text-muted)",
          body: "var(--text-body)",
          heading: "var(--text-heading)",
          success: "var(--success)",
          error: "var(--error)",
          warning: "var(--warning)",
          info: "var(--info)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
