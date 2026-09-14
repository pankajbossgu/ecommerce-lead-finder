export default [{ ignores: ['node_modules/', '.vercel/'], languageOptions: { ecmaVersion: 2024, sourceType: 'module' }, rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } }];
