/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';

import URI from 'vscode-uri';
import { createConnection, ProposedFeatures, InitializeParams, TextDocumentSyncKind, WorkspaceFolder, ServerCapabilities, TextDocument, TextDocumentPositionParams, TextDocumentIdentifier } from 'vscode-languageserver';

import { SipDatabase } from './sipDatabase';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);
let database: SipDatabase | undefined;

connection.onInitialize((params: InitializeParams) => {
	let defaultCapabilities: ServerCapabilities = {
		textDocumentSync: TextDocumentSyncKind.None
	};
	let folders: WorkspaceFolder[] | null = params.workspaceFolders;
	if (!folders || folders.length !== 1) {
		return {
			capabilities: defaultCapabilities
		};
	}
	let sipFile: string = path.join(URI.parse(folders[0].uri).fsPath, 'sip.json');
	if (!fs.existsSync(sipFile)) {
		return {
			capabilities: defaultCapabilities
		};
	}
	try {
		database = new SipDatabase(sipFile);
		database.load();
		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.None,
				documentSymbolProvider: true,
				foldingRangeProvider: true,
				hoverProvider: true,
				definitionProvider: true,
				referencesProvider: true
			}
		};
	} catch (error) {
		return {
			capabilities: defaultCapabilities
		};
	}
});

connection.onInitialized(() => {
});

connection.onDocumentSymbol((params) => {
	if (!database) {
		return null;
	}
	return database.documentSymbols(getUri(params.textDocument));
});

connection.onFoldingRanges((params) => {
	if (!database) {
		return null;
	}
	return database.foldingRanges(getUri(params.textDocument));
});


connection.onHover((params) => {
	if (!database) {
		return null;
	}
	return database.hover(getUri(params.textDocument), params.position);
});

connection.onDefinition((params) => {
	if (!database) {
		return null;
	}
	return database.definitions(getUri(params.textDocument), params.position);
});

connection.onReferences((params) => {
	if (!database) {
		return null;
	}
	return database.references(getUri(params.textDocument), params.position, params.context);
});

function getUri(textDocument: TextDocumentIdentifier): string {
	return URI.parse(textDocument.uri).toString(true);
}

connection.listen();