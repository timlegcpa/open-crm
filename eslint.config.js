import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";
import pluginJsxA11y from "eslint-plugin-jsx-a11y";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    // Top-level ignores so eslint . never descends into build/coverage output.
    ignores: ["coverage/**", "dist/**", "node_modules/**", "supabase/functions/**"],
  },
  {
    files: [
      "src/components/**/*.{js,mjs,cjs,jsx,ts,tsx}",
      "src/pages/**/*.{js,mjs,cjs,jsx,ts,tsx}",
      "src/api/**/*.{js,ts}",
      "src/schemas/**/*.{js,ts}",
      "src/hooks/**/*.{js,ts,jsx,tsx}",
      "src/Layout.{jsx,tsx}",
    ],
    ignores: ["src/lib/**/*", "src/components/ui/**/*", "tests/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
      "@typescript-eslint": tsPlugin,
      "jsx-a11y": pluginJsxA11y,
    },
    rules: {
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='limit'][arguments.0.value>1000]",
          message: ".limit(N>1000) is silently capped at 1000 by PostgREST. Use fetchAllPaged() from @/lib/pagedFetch instead.",
        },
        {
          // Supabase throws plain objects (PostgrestError and friends), so this
          // ternary takes the fallback branch on the most common error in the app.
          selector:
            "ConditionalExpression[test.operator='instanceof'][test.right.name='Error'] MemberExpression[property.name='message']",
          message:
            "`x instanceof Error ? x.message : ...` misses Supabase's plain-object errors (PostgrestError etc.) and falls through to the fallback. Use getErrorMessage(err, fallback) from @/lib/errors.",
        },
      ],
    },
  },
];
