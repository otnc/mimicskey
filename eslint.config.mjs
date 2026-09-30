import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

// 型チェックは tsc (TypeScript 7 のネイティブ実装、@typescript/native エイリアス) で行う。
// TypeScript 7 は JS API を持たないため、lint に型情報を渡す API としては
// typescript パッケージを @typescript/typescript6 へエイリアスして入れる
// (TypeScript 公式の 6.0 との併用手順と同じ)。
export default defineConfig(
  {
    ignores: ["dist/", "data/", "node_modules/", ".agents/", ".claude/"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
);
