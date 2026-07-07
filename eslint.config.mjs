import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    // CommonJS config files legitimately use require().
    "tailwind.config.js",
    "postcss.config.js",
    "next.config.js",
  ]),
]);

export default eslintConfig;
