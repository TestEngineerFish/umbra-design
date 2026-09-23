/** 皮肤 token 与 ui/_ds-tool/tokens.css 同一套（--tool-*），这里只把它们挂成 Tailwind 颜色名，浅深两份靠 CSS 变量切换 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--tool-bg)", panel: "var(--tool-panel)", panel2: "var(--tool-panel-2)", panel3: "var(--tool-panel-3)",
        border: "var(--tool-border)", borderStrong: "var(--tool-border-strong)", text: "var(--tool-text)", text2: "var(--tool-text-2)",
        muted: "var(--tool-muted)", hover: "var(--tool-hover)", accent: "var(--tool-accent)", accentSoft: "var(--tool-accent-soft)",
        onAccent: "var(--tool-on-accent)", ok: "var(--tool-ok)", warn: "var(--tool-warn)", err: "var(--tool-err)", canvas: "var(--tool-canvas)",
      },
      fontFamily: { sans: "var(--tool-sans)", mono: "var(--tool-mono)" },
      borderRadius: { sm: "var(--tool-radius-sm)", DEFAULT: "var(--tool-radius)", lg: "var(--tool-radius-lg)" },
    },
  },
  plugins: [],
};
