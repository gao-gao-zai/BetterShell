import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const packageTypeScriptFiles = ['packages/**/*.ts'];
const rootTypeScriptConfigFiles = ['*.config.ts'];

export default tseslint.config(
  {
    ignores: ['**/lib/**', '**/coverage/**', '**/node_modules/**', '.agents/**', 'docs/**'],
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.js'],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: rootTypeScriptConfigFiles,
  })),
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: packageTypeScriptFiles,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: packageTypeScriptFiles,
  })),
  {
    files: packageTypeScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    files: ['packages/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
