import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // DESIGN.md §4: lib/notify.ts is the single SweetAlert2 gateway.
    // Direct `sweetalert2` imports anywhere else are banned.
    ignores: ["lib/notify.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "sweetalert2",
              message: "Import notify from '@/lib/notify' instead of using sweetalert2 directly.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
