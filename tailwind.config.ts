import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Base colors
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: {
          DEFAULT: "hsl(var(--surface))",
          hover: "hsl(var(--surface-hover))",
        },
        border: "hsl(var(--border))",
        ring: "hsl(var(--ring))",
        
        // Brand colors
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        
        // Semantic colors
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        error: "hsl(var(--error))",
        info: "hsl(var(--info))",
        
        // Inventory-specific colors
        inventory: {
          increase: "hsl(var(--inventory-increase))",
          decrease: "hsl(var(--inventory-decrease))",
          neutral: "hsl(var(--inventory-neutral))",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "Consolas", "monospace"],
      },
      fontSize: {
        // Display
        "display-lg": ["32px", { lineHeight: "40px", fontWeight: "700", letterSpacing: "-0.02em" }],
        "display": ["28px", { lineHeight: "36px", fontWeight: "700", letterSpacing: "-0.02em" }],
        
        // Headings
        "h1": ["24px", { lineHeight: "32px", fontWeight: "600", letterSpacing: "-0.01em" }],
        "h2": ["20px", { lineHeight: "28px", fontWeight: "600", letterSpacing: "-0.01em" }],
        "h3": ["18px", { lineHeight: "24px", fontWeight: "600" }],
        "h4": ["16px", { lineHeight: "24px", fontWeight: "600" }],
        
        // Body
        "body-lg": ["16px", { lineHeight: "24px", fontWeight: "400" }],
        "body": ["14px", { lineHeight: "20px", fontWeight: "400" }],
        "body-sm": ["13px", { lineHeight: "18px", fontWeight: "400" }],
        
        // UI
        "label": ["12px", { lineHeight: "16px", fontWeight: "500", letterSpacing: "0.01em" }],
        "caption": ["11px", { lineHeight: "16px", fontWeight: "400", letterSpacing: "0.02em" }],
        
        // Numbers
        "metric-lg": ["28px", { lineHeight: "32px", fontWeight: "700" }],
        "metric": ["20px", { lineHeight: "24px", fontWeight: "600" }],
        "number": ["14px", { lineHeight: "20px", fontWeight: "500" }],
      },
      spacing: {
        "0.5": "2px",
        "1": "4px",
        "2": "8px",
        "3": "12px",
        "4": "16px",
        "5": "20px",
        "6": "24px",
        "8": "32px",
        "10": "40px",
        "12": "48px",
        "16": "64px",
        "20": "80px",
        "24": "96px",
      },
      borderRadius: {
        none: "0",
        sm: "0.25rem",
        DEFAULT: "0.5rem",
        md: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.5rem",
        full: "9999px",
        
        // Component-specific
        card: "var(--card-radius)",
        button: "var(--button-radius)",
        input: "var(--input-radius)",
        badge: "var(--badge-radius)",
        avatar: "var(--avatar-radius)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        
        // Component-specific
        card: "var(--card-shadow)",
        "card-hover": "var(--card-hover-shadow)",
        dropdown: "var(--dropdown-shadow)",
        modal: "var(--modal-shadow)",
      },
      animation: {
        "skeleton-pulse": "skeleton-pulse 1.2s ease-in-out infinite",
        "draw-in": "draw-in 1s ease-out forwards",
        "fade-in": "fade-in 150ms ease-out forwards",
        "timer-countdown": "timer-countdown 5s linear forwards",
      },
      keyframes: {
        "skeleton-pulse": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "0.8" },
        },
        "draw-in": {
          to: { strokeDashoffset: "0" },
        },
        "fade-in": {
          to: { opacity: "1" },
        },
        "timer-countdown": {
          from: { width: "100%" },
          to: { width: "0%" },
        },
      },
      transitionTimingFunction: {
        "in": "cubic-bezier(0.4, 0, 1, 1)",
        "out": "cubic-bezier(0, 0, 0.2, 1)",
        "in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
        "bounce": "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
      },
      transitionDuration: {
        "fast": "150ms",
        "normal": "300ms",
        "slow": "500ms",
      },
    },
  },
  plugins: [],
};
export default config;
