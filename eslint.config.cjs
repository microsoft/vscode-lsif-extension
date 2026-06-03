const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');

module.exports = [
	{
		ignores: [
			'**/out/**',
			'**/node_modules/**',
			'**/.vscode-test/**'
		]
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 6,
			sourceType: 'module',
			globals: globals.node
		},
		rules: {
			semi: 'error',
			'no-extra-semi': 'warn',
			curly: 'warn',
			quotes: ['error', 'single', { allowTemplateLiterals: true }],
			eqeqeq: 'error',
			indent: ['warn', 'tab', { SwitchCase: 1 }]
		}
	}
];